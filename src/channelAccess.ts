import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPluginStateDirectory } from './instancePaths.js';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

export type AccessPluginName = 'discord' | 'telegram';
export type DirectMessagePolicy = 'pairing' | 'allowlist' | 'disabled';

interface PendingPairing {
	readonly senderId: string;
	readonly chatId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly replies?: number;
}

interface ChannelAccess {
	readonly dmPolicy: DirectMessagePolicy;
	readonly allowFrom: readonly string[];
	readonly groups: Readonly<Record<string, unknown>>;
	readonly pending: Readonly<Record<string, PendingPairing>>;
	readonly [key: string]: unknown;
}

export interface ChannelAccessStatus {
	readonly policy: DirectMessagePolicy;
	readonly allowedSenders: readonly string[];
	readonly pendingPairings: readonly {
		readonly code: string;
		readonly senderId: string;
		readonly expiresAt: number;
	}[];
	readonly groupCount: number;
}

export class ChannelAccessStore {
	private readonly stateDirectory: string;
	private readonly accessFile: string;

	constructor(home: string, channel: string, plugin: AccessPluginName) {
		this.stateDirectory = getPluginStateDirectory(home, channel, plugin);
		this.accessFile = join(this.stateDirectory, 'access.json');
	}

	async status(): Promise<ChannelAccessStatus> {
		const access = await this.read();
		return {
			policy: access.dmPolicy,
			allowedSenders: [...access.allowFrom],
			pendingPairings: Object.entries(access.pending)
				.map(([code, pending]) => ({
					code,
					senderId: pending.senderId,
					expiresAt: pending.expiresAt,
				}))
				.sort((a, b) => a.expiresAt - b.expiresAt),
			groupCount: Object.keys(access.groups).length,
		};
	}

	async pair(code: string): Promise<string> {
		validatePairingCode(code);
		const pending = await withFileLock(this.accessFile, async () => {
			const access = await this.read();
			const pending = access.pending[code];
			if (!pending || pending.expiresAt < Date.now()) {
				throw new Error(`Pairing code '${code}' was not found or has expired`);
			}
			validateSenderId(pending.senderId);
			const pendingPairings = { ...access.pending };
			delete pendingPairings[code];
			const allowFrom = [...new Set([...access.allowFrom, pending.senderId])];
			await writeFileAtomic(this.accessFile, `${JSON.stringify({
				...access,
				allowFrom,
				pending: pendingPairings,
			}, undefined, 2)}\n`);
			return pending;
		});
		const approvedDirectory = join(this.stateDirectory, 'approved');
		await mkdir(approvedDirectory, { recursive: true });
		await writeFileAtomic(join(approvedDirectory, pending.senderId), pending.chatId);
		return pending.senderId;
	}

	async deny(code: string): Promise<void> {
		validatePairingCode(code);
		await this.update(async access => {
			if (!access.pending[code]) {
				throw new Error(`Pairing code '${code}' was not found`);
			}
			const pending = { ...access.pending };
			delete pending[code];
			return {
				value: undefined,
				access: { ...access, pending },
			};
		});
	}

	async setPolicy(policy: DirectMessagePolicy): Promise<void> {
		await this.update(async access => ({
			value: undefined,
			access: { ...access, dmPolicy: policy },
		}));
	}

	async allow(senderId: string): Promise<void> {
		validateSenderId(senderId);
		await this.update(async access => ({
			value: undefined,
			access: {
				...access,
				allowFrom: [...new Set([...access.allowFrom, senderId])],
			},
		}));
	}

	async remove(senderId: string): Promise<void> {
		validateSenderId(senderId);
		await this.update(async access => ({
			value: undefined,
			access: {
				...access,
				allowFrom: access.allowFrom.filter(candidate => candidate !== senderId),
			},
		}));
	}

	private async update<T>(
		change: (access: ChannelAccess) => Promise<{ readonly access: ChannelAccess; readonly value: T }>,
	): Promise<T> {
		return withFileLock(this.accessFile, async () => {
			const changed = await change(await this.read());
			await writeFileAtomic(this.accessFile, `${JSON.stringify(changed.access, undefined, 2)}\n`);
			return changed.value;
		});
	}

	private async read(): Promise<ChannelAccess> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.accessFile, 'utf8'));
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return defaultAccess();
			}
			throw new Error(`Failed to read channel access state ${this.accessFile}`, { cause: error });
		}
		return parseAccess(value, this.accessFile);
	}
}

function parseAccess(value: unknown, path: string): ChannelAccess {
	if (!isRecord(value)
		|| !isPolicy(value['dmPolicy'])
		|| !isStringArray(value['allowFrom'])
		|| !isRecord(value['groups'])
		|| !isRecord(value['pending'])) {
		throw new Error(`Invalid channel access state ${path}`);
	}
	const pending: Record<string, PendingPairing> = {};
	for (const [code, entry] of Object.entries(value['pending'])) {
		if (!/^[0-9a-f]{6}$/i.test(code)
			|| !isRecord(entry)
			|| typeof entry['senderId'] !== 'string'
			|| typeof entry['chatId'] !== 'string'
			|| typeof entry['createdAt'] !== 'number'
			|| typeof entry['expiresAt'] !== 'number'
			|| (entry['replies'] !== undefined && typeof entry['replies'] !== 'number')) {
			throw new Error(`Invalid pending pairing in ${path}`);
		}
		pending[code] = {
			senderId: entry['senderId'],
			chatId: entry['chatId'],
			createdAt: entry['createdAt'],
			expiresAt: entry['expiresAt'],
			...(entry['replies'] !== undefined ? { replies: entry['replies'] } : {}),
		};
	}
	return {
		...value,
		dmPolicy: value['dmPolicy'],
		allowFrom: [...new Set(value['allowFrom'])],
		groups: { ...value['groups'] },
		pending,
	};
}

function defaultAccess(): ChannelAccess {
	return {
		dmPolicy: 'pairing',
		allowFrom: [],
		groups: {},
		pending: {},
	};
}

function isPolicy(value: unknown): value is DirectMessagePolicy {
	return value === 'pairing' || value === 'allowlist' || value === 'disabled';
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}

function validateSenderId(senderId: string): void {
	if (!/^\d+$/.test(senderId)) {
		throw new Error(`Invalid sender ID '${senderId}'`);
	}
}

function validatePairingCode(code: string): void {
	if (!/^[0-9a-f]{6}$/i.test(code)) {
		throw new Error(`Invalid pairing code '${code}'`);
	}
}

export function isAccessPluginName(value: string): value is AccessPluginName {
	return value === 'discord' || value === 'telegram';
}
