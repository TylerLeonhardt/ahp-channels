import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CONFIG_VERSION, ConfigStore, isValidChannelInstanceName } from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ConfigStore', () => {
	it('rejects unsupported configuration versions', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION - 2,
			marketplaces: {},
			plugins: {},
		}));

		await assert.rejects(new ConfigStore(home).read(), /Unsupported ahp-channels config version/);
	});

	it('migrates version 3 configuration without changing channel bindings', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: 3,
			marketplaces: {},
			plugins: {},
			channels: {
				personal: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					chat: 'ahp-chat:/one',
					host: 'standalone:123:legacy',
					enabled: false,
				},
			},
		}));

		assert.deepEqual(await new ConfigStore(home).read(), {
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {},
			channels: {
				personal: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					chat: 'ahp-chat:/one',
					host: 'standalone:123:legacy',
					enabled: false,
				},
			},
		});
	});

	it('serializes concurrent updates through a lock', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		const first = new ConfigStore(home);
		const second = new ConfigStore(home);

		await Promise.all([
			first.update(asyncConfig => ({
				...asyncConfig,
				channels: {
					...asyncConfig.channels,
					first: { plugin: 'fake', session: 'ahp-session:/one', enabled: false },
				},
			})),
			second.update(asyncConfig => ({
				...asyncConfig,
				channels: {
					...asyncConfig.channels,
					second: { plugin: 'fake', session: 'ahp-session:/two', enabled: false },
				},
			})),
		]);

		assert.deepEqual(Object.keys((await first.read()).channels).sort(), ['first', 'second']);
		await assert.rejects(access(join(home, 'config.json.lock')), (error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'ENOENT'
		);
	});

	it('loads installed versions and channel pins', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		const installation = 'a'.repeat(64);
		const marketplaceRevision = 'b'.repeat(40);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: { test: { source: './marketplace' } },
			plugins: {
				fake: {
					marketplace: 'test',
					activeInstallation: installation,
					installations: {
						[installation]: {
							source: './plugins/fake',
							version: '1.0.0',
							marketplaceRevision,
						},
					},
				},
			},
			channels: {
				personal: {
					plugin: 'fake',
					installation,
					session: 'ahp-session:/one',
					enabled: false,
				},
			},
		}));

		assert.deepEqual(await new ConfigStore(home).read(), {
			version: CONFIG_VERSION,
			marketplaces: { test: { source: './marketplace' } },
			plugins: {
				fake: {
					marketplace: 'test',
					activeInstallation: installation,
					installations: {
						[installation]: {
							source: './plugins/fake',
							version: '1.0.0',
							marketplaceRevision,
						},
					},
				},
			},
			hostAliases: {},
			channels: {
				personal: {
					plugin: 'fake',
					installation,
					session: 'ahp-session:/one',
					enabled: false,
				},
			},
		});
	});

	it('rejects channel names that could escape the instance directory', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			channels: {
				'../outside': {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: true,
				},
			},
		}));

		await assert.rejects(new ConfigStore(home).read(), /Invalid channel name/);
		assert.deepEqual({
			dot: isValidChannelInstanceName('.'),
			dotDot: isValidChannelInstanceName('..'),
			reserved: isValidChannelInstanceName('CON'),
			normal: isValidChannelInstanceName('telegram-personal'),
		}, {
			dot: false,
			dotDot: false,
			reserved: false,
			normal: true,
		});
	});

	it('rejects managed names and installation references that can escape storage', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		const installation = 'a'.repeat(64);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {
				'..': { source: './marketplace' },
			},
			plugins: {},
			channels: {},
		}));
		await assert.rejects(new ConfigStore(home).read(), /Invalid marketplace name/);

		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			channels: {
				personal: {
					plugin: join(home, 'plugin'),
					installation,
					session: 'ahp-session:/one',
					enabled: false,
				},
			},
		}));
		await assert.rejects(new ConfigStore(home).read(), /Invalid channel instance configuration/);

	});

	it('rejects invalid references before writing an update', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.write({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {},
			channels: {},
		});

		await assert.rejects(
			store.update(config => ({
				...config,
				channels: {
					personal: {
						plugin: 'fake',
						installation: 'a'.repeat(64),
						session: 'ahp-session:/one',
						enabled: false,
					},
				},
			})),
			/references missing fake installation/,
		);
		assert.deepEqual((await store.read()).channels, {});
	});

	it('rejects channel names that alias on case-insensitive filesystems', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			channels: {
				Telegram: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: true,
				},
				telegram: {
					plugin: 'fake',
					session: 'ahp-session:/two',
					enabled: true,
				},
			},
		}));

		await assert.rejects(new ConfigStore(home).read(), /differs only by case/);
	});

	it('validates host aliases and channel references without accepting embedded secrets', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {
				Local: {
					kind: 'websocket',
					url: 'ws://127.0.0.1:1234/?tkn=super-secret',
					withoutAuthentication: true,
				},
			},
			channels: {},
		}));

		await assert.rejects(
			store.read(),
			(error: unknown) => error instanceof Error
				&& /Invalid local WebSocket host alias URL/.test(error.message)
				&& !error.message.includes('super-secret'),
		);

		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {
				Local: {
					kind: 'websocket',
					url: 'ws://127.0.0.1:1234/',
					tokenFile: join(home, 'host.token'),
				},
			},
			channels: {},
		}));
		await assert.rejects(store.read(), /token query parameter/);

		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {
				Local: {
					kind: 'socket',
					path: join(home, 'host.sock'),
					withoutAuthentication: true,
				},
				local: {
					kind: 'socket',
					path: join(home, 'other.sock'),
					withoutAuthentication: true,
				},
			},
			channels: {},
		}));
		await assert.rejects(store.read(), /Duplicate host alias name/);

		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: CONFIG_VERSION,
			marketplaces: {},
			plugins: {},
			hostAliases: {},
			channels: {
				personal: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					host: '@missing',
					enabled: false,
				},
			},
		}));
		await assert.rejects(store.read(), /references unknown host alias '@missing'/);
	});
});
