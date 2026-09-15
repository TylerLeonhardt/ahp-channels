import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore } from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ConfigStore', () => {
	it('migrates an existing version 1 config without channels', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-config-'));
		temporaryDirectories.push(home);
		await writeFile(join(home, 'config.json'), JSON.stringify({
			version: 1,
			marketplaces: {},
			plugins: {},
		}));

		const config = await new ConfigStore(home).read();

		assert.deepEqual(config, {
			version: 1,
			marketplaces: {},
			plugins: {},
			channels: {},
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
});
