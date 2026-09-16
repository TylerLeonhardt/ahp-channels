import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { sanitizeErrorSummary } from './channelHealth.js';
import type { ChannelBindingTarget, ResolvedChannelBinding } from './sessionCatalog.js';
import { getInstanceRoot } from './instancePaths.js';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

const HANDOFF_VERSION = 1;

export type ChannelHandoffState = 'pending' | 'applied' | 'failed' | 'cancelled';

export interface ChannelHandoffSource {
	readonly actualHost: string;
	readonly host?: string;
	readonly session: string;
	readonly chat?: string;
	readonly resolvedChat: string;
}

export interface ChannelHandoffRecord {
	readonly requestId: string;
	readonly state: ChannelHandoffState;
	readonly requestedAt: string;
	readonly updatedAt: string;
	readonly source: ChannelHandoffSource;
	readonly target: ChannelBindingTarget;
	readonly resolvedTarget: ResolvedChannelBinding;
	readonly recovery?: 'source';
	readonly error?: string;
}

const BindingTargetSchema = z.strictObject({
	host: z.string().min(1).optional(),
	session: z.string().min(1),
	chat: z.string().min(1).optional(),
});

const ResolvedBindingSchema = z.strictObject({
	preferredHost: z.string().min(1).optional(),
	actualHost: z.string().min(1),
	fallback: z.boolean(),
	session: z.string().min(1),
	chat: z.string().min(1),
	warnings: z.array(z.string()),
});

const HandoffRecordSchema = z.strictObject({
	version: z.literal(HANDOFF_VERSION),
	requestId: z.string().uuid(),
	state: z.enum(['pending', 'applied', 'failed', 'cancelled']),
	requestedAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	source: z.strictObject({
		actualHost: z.string().min(1),
		host: z.string().min(1).optional(),
		session: z.string().min(1),
		chat: z.string().min(1).optional(),
		resolvedChat: z.string().min(1),
	}),
	target: BindingTargetSchema,
	resolvedTarget: ResolvedBindingSchema,
	recovery: z.literal('source').optional(),
	error: z.string().min(1).optional(),
});

export const ChannelHandoffRecordSchema = HandoffRecordSchema.omit({ version: true });

export class FileChannelHandoffStore {
	constructor(private readonly home: string) { }

	async read(name: string): Promise<ChannelHandoffRecord | undefined> {
		const path = this.path(name);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, 'utf8'));
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return undefined;
			}
			throw new Error(`Failed to read channel handoff state ${path}`, { cause: error });
		}
		const parsed = HandoffRecordSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(`Invalid channel handoff state ${path}: ${z.prettifyError(parsed.error)}`);
		}
		return withoutVersion(parsed.data);
	}

	async write(name: string, record: ChannelHandoffRecord): Promise<void> {
		const path = this.path(name);
		const parsed = ChannelHandoffRecordSchema.parse(record);
		await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify({
			version: HANDOFF_VERSION,
			...parsed,
		}, undefined, 2)}\n`));
	}

	async clear(name: string): Promise<void> {
		const path = this.path(name);
		await withFileLock(path, () => rm(path, { force: true }));
	}

	private path(name: string): string {
		return join(getInstanceRoot(this.home, name), 'handoff.json');
	}
}

export function failedHandoff(
	record: ChannelHandoffRecord,
	error: unknown,
	recovery = false,
): ChannelHandoffRecord {
	const { recovery: _recovery, ...current } = record;
	return {
		...current,
		state: 'failed',
		updatedAt: new Date().toISOString(),
		...(recovery ? { recovery: 'source' as const } : {}),
		error: sanitizeErrorSummary(error instanceof Error ? error.message : String(error)),
	};
}

function withoutVersion(value: z.infer<typeof HandoffRecordSchema>): ChannelHandoffRecord {
	const { version: _version, ...record } = value;
	return record;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
