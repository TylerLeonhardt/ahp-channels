import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelEvent } from './channelPrompt.js';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

const JOURNAL_VERSION = 1;
const MAX_PENDING_EVENTS = 1000;
const MAX_DELIVERED_EVENTS = 5000;
const MAX_EVENT_BYTES = 1024 * 1024;

export interface JournaledChannelEvent {
	readonly id: string;
	readonly event: ChannelEvent;
	readonly receivedAt: string;
	readonly stableIdentity: boolean;
}

interface DeliveredEvent {
	readonly id: string;
	readonly deliveredAt: string;
}

interface JournalData {
	readonly version: typeof JOURNAL_VERSION;
	readonly pending: readonly JournaledChannelEvent[];
	readonly delivered: readonly DeliveredEvent[];
}

export interface ChannelEventJournal {
	enqueue(source: string, event: ChannelEvent): Promise<JournaledChannelEvent | undefined>;
	pending(): Promise<readonly JournaledChannelEvent[]>;
	markDelivered(ids: readonly string[]): Promise<void>;
}

export class FileChannelEventJournal implements ChannelEventJournal {
	private readonly path: string;

	constructor(home: string, channel: string) {
		this.path = join(home, 'instances', channel, 'events.json');
	}

	async enqueue(source: string, event: ChannelEvent): Promise<JournaledChannelEvent | undefined> {
		if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
			throw new Error(`Channel event exceeds the ${MAX_EVENT_BYTES}-byte journal limit`);
		}
		return withFileLock(this.path, async () => {
			const data = await this.read();
			const identity = eventIdentity(source, event);
			if (data.pending.some(candidate => candidate.id === identity.id)
				|| data.delivered.some(candidate => candidate.id === identity.id)) {
				return undefined;
			}
			if (data.pending.length >= MAX_PENDING_EVENTS) {
				throw new Error(`Channel event journal has reached its ${MAX_PENDING_EVENTS}-event pending limit`);
			}
			const journaled: JournaledChannelEvent = {
				id: identity.id,
				event: cloneEvent(event),
				receivedAt: new Date().toISOString(),
				stableIdentity: identity.stable,
			};
			await this.write({
				...data,
				pending: [...data.pending, journaled],
			});
			return journaled;
		});
	}

	async pending(): Promise<readonly JournaledChannelEvent[]> {
		return (await this.read()).pending.map(event => ({
			...event,
			event: cloneEvent(event.event),
		}));
	}

	async markDelivered(ids: readonly string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		await withFileLock(this.path, async () => {
			const data = await this.read();
			const deliveredIds = new Set(ids);
			const newlyDelivered = data.pending
				.filter(event => deliveredIds.has(event.id))
				.map(event => ({
					id: event.id,
					deliveredAt: new Date().toISOString(),
				}));
			if (newlyDelivered.length === 0) {
				return;
			}
			const delivered = [...data.delivered, ...newlyDelivered]
				.slice(-MAX_DELIVERED_EVENTS);
			await this.write({
				...data,
				pending: data.pending.filter(event => !deliveredIds.has(event.id)),
				delivered,
			});
		});
	}

	private async read(): Promise<JournalData> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.path, 'utf8'));
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return emptyJournal();
			}
			throw new Error(`Failed to read channel event journal ${this.path}`, { cause: error });
		}
		return parseJournal(value, this.path);
	}

	private write(data: JournalData): Promise<void> {
		return writeFileAtomic(this.path, `${JSON.stringify(data, undefined, 2)}\n`);
	}
}

export function readJournalEventId(meta: Readonly<Record<string, unknown>> | undefined): string | undefined {
	const value = meta?.['ahpChannels.eventId'];
	return typeof value === 'string' ? value : undefined;
}

export function withJournalEventId(
	meta: Readonly<Record<string, unknown>> | undefined,
	id: string,
): Record<string, unknown> {
	return {
		...meta,
		'ahpChannels.eventId': id,
	};
}

function eventIdentity(source: string, event: ChannelEvent): { readonly id: string; readonly stable: boolean } {
	const meta = event.meta ?? {};
	const stableParts = stableIdentityParts(meta);
	if (!stableParts) {
		return { id: randomUUID(), stable: false };
	}
	const digest = createHash('sha256')
		.update(source)
		.update('\0')
		.update(stableParts.join('\0'))
		.digest('hex');
	return { id: digest, stable: true };
}

function stableIdentityParts(meta: Readonly<Record<string, string>>): readonly string[] | undefined {
	for (const key of ['event_id', 'update_id']) {
		if (meta[key]) {
			return [key, meta[key]];
		}
	}
	if (meta['message_id']) {
		for (const scope of ['chat_id', 'channel_id', 'thread_id']) {
			if (meta[scope]) {
				return [scope, meta[scope], 'message_id', meta['message_id']];
			}
		}
	}
	return undefined;
}

function parseJournal(value: unknown, path: string): JournalData {
	if (!isRecord(value)
		|| value['version'] !== JOURNAL_VERSION
		|| !Array.isArray(value['pending'])
		|| !Array.isArray(value['delivered'])) {
		throw new Error(`Invalid channel event journal ${path}`);
	}
	return {
		version: JOURNAL_VERSION,
		pending: value['pending'].map(item => parsePending(item, path)),
		delivered: value['delivered'].map(item => parseDelivered(item, path)),
	};
}

function parsePending(value: unknown, path: string): JournaledChannelEvent {
	if (!isRecord(value)
		|| typeof value['id'] !== 'string'
		|| typeof value['receivedAt'] !== 'string'
		|| typeof value['stableIdentity'] !== 'boolean'
		|| !isRecord(value['event'])
		|| typeof value['event']['content'] !== 'string'
		|| !isOptionalStringRecord(value['event']['meta'])) {
		throw new Error(`Invalid pending event in channel journal ${path}`);
	}
	return {
		id: value['id'],
		receivedAt: value['receivedAt'],
		stableIdentity: value['stableIdentity'],
		event: {
			content: value['event']['content'],
			...(value['event']['meta'] ? { meta: { ...value['event']['meta'] } } : {}),
		},
	};
}

function parseDelivered(value: unknown, path: string): DeliveredEvent {
	if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['deliveredAt'] !== 'string') {
		throw new Error(`Invalid delivered event in channel journal ${path}`);
	}
	return {
		id: value['id'],
		deliveredAt: value['deliveredAt'],
	};
}

function emptyJournal(): JournalData {
	return {
		version: JOURNAL_VERSION,
		pending: [],
		delivered: [],
	};
}

function cloneEvent(event: ChannelEvent): ChannelEvent {
	return {
		content: event.content,
		...(event.meta ? { meta: { ...event.meta } } : {}),
	};
}

function isOptionalStringRecord(value: unknown): value is Record<string, string> | undefined {
	return value === undefined || (isRecord(value) && Object.values(value).every(item => typeof item === 'string'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
