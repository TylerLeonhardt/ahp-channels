import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ChannelAccessStore, type AccessPluginName } from '../src/channelAccess.js';
import { getPluginStateDirectory } from '../src/instancePaths.js';

const temporaryDirectories: string[] = [];
const accessPlugins: readonly AccessPluginName[] = ['discord', 'telegram'];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ChannelAccessStore', () => {
	for (const plugin of accessPlugins) {
		it(`pairs and manages ${plugin} senders while preserving plugin settings`, async () => {
			const home = await mkdtemp(join(tmpdir(), `ahp-channels-${plugin}-`));
			temporaryDirectories.push(home);
			const state = getPluginStateDirectory(home, 'personal', plugin);
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
			const access = new ChannelAccessStore(home, 'personal', plugin);

			assert.equal(await access.pair('abc123'), '123');
			await access.setPolicy('allowlist');
			await access.allow('456');
			await access.remove('123');
			const status = await access.status();
			const stored: unknown = JSON.parse(await readFile(join(state, 'access.json'), 'utf8'));

			assert.deepEqual({
				status,
				approval: await readFile(join(state, 'approved', '123'), 'utf8'),
				ackReaction: readAckReaction(stored),
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
	}

	it('rejects missing and expired pairing codes', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-telegram-'));
		temporaryDirectories.push(home);
		const state = getPluginStateDirectory(home, 'personal', 'telegram');
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
		const access = new ChannelAccessStore(home, 'personal', 'telegram');

		await assert.rejects(access.pair('ffffff'), /not found or has expired/);
		await assert.rejects(access.pair('dead00'), /not found or has expired/);
		await assert.rejects(access.pair('../bad'), /Invalid pairing code/);
	});
});

function readAckReaction(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return Reflect.get(value, 'ackReaction');
}
