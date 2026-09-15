import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

const HEALTH_VERSION = 1;

export const ChannelFailureStageSchema = z.enum([
	'agent-host-discovery',
	'agent-host-connection',
	'session-resolution',
	'plugin-integrity',
	'plugin-loading',
	'mcp-startup',
	'mcp-exit',
	'retry-scheduling',
	'retry-exhausted',
]);

export type ChannelFailureStage = z.infer<typeof ChannelFailureStageSchema>;
export type ChannelHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'stopped';

export interface ChannelFailure {
	readonly stage: ChannelFailureStage;
	readonly summary: string;
	readonly failedAt: string;
	readonly guidance: string;
}

export interface ChannelRetry {
	readonly attempt: number;
	readonly state: 'scheduled' | 'exhausted';
	readonly nextRetryAt?: string;
}

export interface PersistedChannelHealth {
	readonly failure: ChannelFailure;
	readonly retry?: ChannelRetry;
}

export type ChannelHealth = {
	readonly state: Extract<ChannelHealthState, 'healthy' | 'stopped'>;
	readonly failure?: never;
	readonly retry?: never;
} | {
	readonly state: Extract<ChannelHealthState, 'degraded' | 'unhealthy'>;
	readonly failure: ChannelFailure;
	readonly retry?: ChannelRetry;
};

const FailureSchema = z.strictObject({
	stage: ChannelFailureStageSchema,
	summary: z.string().min(1),
	failedAt: z.iso.datetime(),
	guidance: z.string().min(1),
});

const RetrySchema = z.discriminatedUnion('state', [
	z.strictObject({
		attempt: z.number().int().positive(),
		state: z.literal('scheduled'),
		nextRetryAt: z.iso.datetime(),
	}),
	z.strictObject({
		attempt: z.number().int().nonnegative(),
		state: z.literal('exhausted'),
	}),
]);

const PersistedHealthSchema = z.strictObject({
	version: z.literal(HEALTH_VERSION),
	failure: FailureSchema,
	retry: RetrySchema.optional(),
});

export class ChannelOperationError extends Error {
	constructor(
		readonly stage: ChannelFailureStage,
		message: string,
		readonly guidance: string = recoveryGuidance(stage),
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export class FileChannelHealthStore {
	constructor(private readonly home: string) { }

	async read(name: string): Promise<PersistedChannelHealth | undefined> {
		const path = this.path(name);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, 'utf8'));
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return undefined;
			}
			throw new Error(`Failed to read channel health state ${path}`, { cause: error });
		}
		const parsed = PersistedHealthSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(`Invalid channel health state ${path}: ${z.prettifyError(parsed.error)}`);
		}
		return {
			failure: parsed.data.failure,
			...(parsed.data.retry ? { retry: parsed.data.retry } : {}),
		};
	}

	async write(name: string, health: PersistedChannelHealth): Promise<void> {
		const path = this.path(name);
		await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify({
			version: HEALTH_VERSION,
			...health,
		}, undefined, 2)}\n`));
	}

	async clear(name: string): Promise<void> {
		const path = this.path(name);
		await withFileLock(path, () => rm(path, { force: true }));
	}

	private path(name: string): string {
		return join(this.home, 'instances', name, 'health.json');
	}
}

export function failureFromError(error: unknown, failedAt = new Date().toISOString()): ChannelFailure {
	const operationError = error instanceof ChannelOperationError
		? error
		: new ChannelOperationError('mcp-startup', errorMessage(error), undefined, { cause: error });
	return {
		stage: operationError.stage,
		summary: sanitizeErrorSummary(operationError.message),
		failedAt,
		guidance: operationError.guidance,
	};
}

export function recoveryGuidance(stage: ChannelFailureStage): string {
	switch (stage) {
		case 'agent-host-discovery':
			return 'Start VS Code with Agent Host enabled, then restart the channel.';
		case 'agent-host-connection':
			return 'Confirm the selected Agent Host is running and reachable, then restart the channel.';
		case 'session-resolution':
			return 'Check the configured session and chat URIs, then switch or restart the channel.';
		case 'plugin-integrity':
			return 'Reinstall or upgrade the plugin to restore its verified installation, then restart the channel.';
		case 'plugin-loading':
			return 'Check the plugin manifest and MCP configuration, then reinstall or upgrade the plugin.';
		case 'mcp-startup':
			return 'Run the plugin setup skill in the target session, then wait for retry or restart the channel.';
		case 'mcp-exit':
			return 'Inspect daemon and plugin logs; the daemon will retry the channel automatically.';
		case 'retry-scheduling':
			return 'Restart the daemon to resume automatic channel recovery.';
		case 'retry-exhausted':
			return 'Resolve the reported failure, then restart the channel to reset retries.';
	}
}

export function sanitizeErrorSummary(message: string): string {
	const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || 'Unknown error';
	return firstLine
		.replace(/([?&](?:access_?token|api_?key|key|password|secret|token)=)[^&#\s]+/gi, '$1[redacted]')
		.replace(/\b((?:access_?token|api_?key|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
