import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getTelegramStateDirectory } from './instancePaths.js';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

export type TelegramDirectMessagePolicy = 'pairing' | 'allowlist' | 'disabled';

interface PendingPairing {
	readonly senderId: string;
	readonly chatId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly replies?: number;
}

interface TelegramAccess {
	readonly dmPolicy: TelegramDirectMessagePolicy;
	readonly allowFrom: readonly string[];
	readonly groups: Readonly<Record<string, unknown>>;
	readonly pending: Readonly<Record<string, PendingPairing>>;
	readonly [key: string]: unknown;
}

export interface TelegramAccessStatus {
	readonly policy: TelegramDirectMessagePolicy;
	readonly allowedSenders: readonly string[];
	readonly pendingPairings: readonly {
		readonly code: string;
		readonly senderId: string;
		readonly expiresAt: number;
	}[];
	readonly groupCount: number;
}

export class TelegramAccessStore {
	private readonly stateDirectory: string;
	private readonly accessFile: string;

	constructor(home: string, channel: string) {
		this.stateDirectory = getTelegramStateDirectory(home, channel);
		this.accessFile = join(this.stateDirectory, 'access.json');
	}

	async status(): Promise<TelegramAccessStatus> {
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

	async setPolicy(policy: TelegramDirectMessagePolicy): Promise<void> {
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
		change: (access: TelegramAccess) => Promise<{ readonly access: TelegramAccess; readonly value: T }>,
	): Promise<T> {
		return withFileLock(this.accessFile, async () => {
			const changed = await change(await this.read());
			await writeFileAtomic(this.accessFile, `${JSON.stringify(changed.access, undefined, 2)}\n`);
			return changed.value;
		});
	}

	private async read(): Promise<TelegramAccess> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.accessFile, 'utf8'));
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return defaultAccess();
			}
			throw new Error(`Failed to read Telegram access state ${this.accessFile}`, { cause: error });
		}
		return parseAccess(value, this.accessFile);
	}
}

function parseAccess(value: unknown, path: string): TelegramAccess {
	if (!isRecord(value)
		|| !isPolicy(value['dmPolicy'])
		|| !isStringArray(value['allowFrom'])
		|| !isRecord(value['groups'])
		|| !isRecord(value['pending'])) {
		throw new Error(`Invalid Telegram access state ${path}`);
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
			throw new Error(`Invalid pending Telegram pairing in ${path}`);
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

function defaultAccess(): TelegramAccess {
	return {
		dmPolicy: 'pairing',
		allowFrom: [],
		groups: {},
		pending: {},
	};
}

function isPolicy(value: unknown): value is TelegramDirectMessagePolicy {
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
		throw new Error(`Invalid Telegram sender ID '${senderId}'`);
	}
}

function validatePairingCode(code: string): void {
	if (!/^[0-9a-f]{6}$/i.test(code)) {
		throw new Error(`Invalid Telegram pairing code '${code}'`);
	}
}
