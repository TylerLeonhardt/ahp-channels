import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getTelegramStateDirectory } from '../src/instancePaths.js';
import { TelegramAccessStore } from '../src/telegramAccess.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('TelegramAccessStore', () => {
	it('pairs and manages allowlisted senders while preserving plugin settings', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-telegram-'));
		temporaryDirectories.push(home);
		const state = getTelegramStateDirectory(home, 'personal');
		await mkdir(state, { recursive: true });
		await writeFile(join(state, 'access.json'), JSON.stringify({
			dmPolicy: 'pairing',
			allowFrom: [],
			groups: {},
			pending: {
				abc123: {
					senderId: '123',
					chatId: 'chat',
					createdAt: Date.now(),
					expiresAt: Date.now() + 60_000,
				},
			},
			ackReaction: '👍',
		}));
		const access = new TelegramAccessStore(home, 'personal');

		assert.equal(await access.pair('abc123'), '123');
		await access.setPolicy('allowlist');
		await access.allow('456');
		await access.remove('123');
		const status = await access.status();
		const stored = JSON.parse(await readFile(join(state, 'access.json'), 'utf8')) as {
			readonly ackReaction?: string;
		};

		assert.deepEqual({
			status,
			approval: await readFile(join(state, 'approved', '123'), 'utf8'),
			ackReaction: stored.ackReaction,
		}, {
			status: {
				policy: 'allowlist',
				allowedSenders: ['456'],
				pendingPairings: [],
				groupCount: 0,
			},
			approval: 'chat',
			ackReaction: '👍',
		});
	});

	it('rejects missing and expired pairing codes', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-telegram-'));
		temporaryDirectories.push(home);
		const state = getTelegramStateDirectory(home, 'personal');
		await mkdir(state, { recursive: true });
		await writeFile(join(state, 'access.json'), JSON.stringify({
			dmPolicy: 'pairing',
			allowFrom: [],
			groups: {},
			pending: {
				dead00: {
					senderId: '123',
					chatId: 'chat',
					createdAt: 0,
					expiresAt: 1,
				},
			},
		}));
		const access = new TelegramAccessStore(home, 'personal');

		await assert.rejects(access.pair('ffffff'), /not found or has expired/);
		await assert.rejects(access.pair('dead00'), /not found or has expired/);
		await assert.rejects(access.pair('../bad'), /Invalid Telegram pairing code/);
	});
});
