import assert from 'node:assert/strict';
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	getPluginInstallationPath,
	installPluginSnapshot,
	removePluginInstallation,
} from '../src/pluginInstallations.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('plugin installations', () => {
	it('creates immutable content-addressed snapshots without runtime artifacts', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-install-'));
		temporaryDirectories.push(root);
		const source = join(root, 'marketplace', 'plugins', 'fake');
		await mkdir(join(source, '.claude-plugin'), { recursive: true });
		await mkdir(join(source, 'node_modules', 'dependency'), { recursive: true });
		await mkdir(join(source, '.git'), { recursive: true });
		await writeFile(join(source, '.claude-plugin', 'plugin.json'), '{"name":"fake"}');
		await writeFile(join(source, 'server.mjs'), 'export const version = 1;\n', { mode: 0o755 });
		await writeFile(join(source, 'node_modules', 'dependency', 'index.js'), 'runtime artifact');
		await writeFile(join(source, '.git', 'config'), 'marketplace metadata');

		const first = await installPluginSnapshot(join(root, 'home'), source, {
			marketplace: 'test',
			plugin: 'fake',
			source: './plugins/fake',
			version: '1.0.0',
			marketplaceRevision: 'revision-one',
		});
		const repeated = await installPluginSnapshot(join(root, 'home'), source, {
			marketplace: 'test',
			plugin: 'fake',
			source: './plugins/fake',
			version: '1.0.0',
			marketplaceRevision: 'revision-newer-with-identical-content',
		});

		assert.match(first.id, /^[a-f0-9]{64}$/);
		assert.deepEqual({
			first,
			repeated,
			server: await readFile(join(first.path, 'server.mjs'), 'utf8'),
			metadata: JSON.parse(await readFile(
				join(first.path, '.ahp-channels-installation.json'),
				'utf8',
			)),
		}, {
			first: {
				id: first.id,
				path: getPluginInstallationPath(join(root, 'home'), 'test', 'fake', first.id),
				config: {
					source: './plugins/fake',
					version: '1.0.0',
					marketplaceRevision: 'revision-one',
				},
				created: true,
			},
			repeated: {
				id: first.id,
				path: first.path,
				config: first.config,
				created: false,
			},
			server: 'export const version = 1;\n',
			metadata: {
				schemaVersion: 2,
				id: first.id,
				marketplace: 'test',
				plugin: 'fake',
				source: './plugins/fake',
				version: '1.0.0',
				marketplaceRevision: 'revision-one',
				entries: [{
					kind: 'directory',
					path: '.claude-plugin',
				}, {
					kind: 'file',
					path: '.claude-plugin/plugin.json',
				}, {
					kind: 'file',
					path: 'server.mjs',
				}],
			},
		});
		await assert.rejects(access(join(first.path, 'node_modules')));
		await assert.rejects(access(join(first.path, '.git')));

		await writeFile(join(source, 'server.mjs'), 'export const version = 2;\n', { mode: 0o755 });
		const second = await installPluginSnapshot(join(root, 'home'), source, {
			marketplace: 'test',
			plugin: 'fake',
			source: './plugins/fake',
			version: '2.0.0',
			marketplaceRevision: 'revision-two',
		});

		assert.notEqual(second.id, first.id);
		assert.equal(await readFile(join(first.path, 'server.mjs'), 'utf8'), 'export const version = 1;\n');
		assert.equal(await readFile(join(second.path, 'server.mjs'), 'utf8'), 'export const version = 2;\n');
	});

	it('copies internal relative symlinks and rejects escaping symlinks', {
		skip: process.platform === 'win32',
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-install-'));
		temporaryDirectories.push(root);
		const source = join(root, 'marketplace', 'plugin');
		await mkdir(source, { recursive: true });
		await writeFile(join(source, 'target.txt'), 'inside');
		await symlink('target.txt', join(source, 'link.txt'));
		const installed = await installPluginSnapshot(join(root, 'home'), source, {
			marketplace: 'test',
			plugin: 'fake',
			source: './plugin',
		});
		assert.equal(await readFile(join(installed.path, 'link.txt'), 'utf8'), 'inside');

		const outside = join(root, 'outside.txt');
		await writeFile(outside, 'outside');
		await symlink('../../outside.txt', join(source, 'outside.txt'));
		await assert.rejects(
			installPluginSnapshot(join(root, 'home'), source, {
				marketplace: 'test',
				plugin: 'fake',
				source: './plugin',
			}),
			/escapes its source directory/,
		);
	});

	it('converges concurrent installs without temporary directories', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-install-'));
		temporaryDirectories.push(root);
		const source = join(root, 'marketplace', 'plugin');
		await mkdir(source, { recursive: true });
		await writeFile(join(source, 'plugin.json'), '{"name":"fake"}');
		const provenance = {
			marketplace: 'test',
			plugin: 'fake',
			source: './plugin',
		} as const;

		const installed = await Promise.all([
			installPluginSnapshot(join(root, 'home'), source, provenance),
			installPluginSnapshot(join(root, 'home'), source, provenance),
			installPluginSnapshot(join(root, 'home'), source, provenance),
		]);
		const parent = dirname(installed[0].path);

		assert.equal(new Set(installed.map(candidate => candidate.id)).size, 1);
		assert.equal(installed.filter(candidate => candidate.created).length, 1);
		assert.deepEqual(await readdir(parent), [installed[0].id]);
	});

	it('rejects included symlinks whose targets are excluded', {
		skip: process.platform === 'win32',
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-install-'));
		temporaryDirectories.push(root);
		const source = join(root, 'marketplace', 'plugin');
		await mkdir(source, { recursive: true });
		await writeFile(join(source, 'ignored.txt'), 'ignored');
		await symlink('ignored.txt', join(source, 'link.txt'));

		await assert.rejects(
			installPluginSnapshot(join(root, 'home'), source, {
				marketplace: 'test',
				plugin: 'fake',
				source: './plugin',
			}, ['link.txt']),
			/targets an excluded file/,
		);
	});

	it('removes only a validated installation directory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-install-'));
		temporaryDirectories.push(root);
		const home = join(root, 'home');
		const id = 'a'.repeat(64);
		const installation = getPluginInstallationPath(home, 'test', 'fake', id);
		const sibling = join(dirname(installation), 'keep.txt');
		await mkdir(installation, { recursive: true });
		await writeFile(join(installation, 'plugin.json'), '{}');
		await writeFile(sibling, 'keep');

		await removePluginInstallation(home, 'test', 'fake', id);

		await assert.rejects(access(installation));
		await assert.doesNotReject(access(sibling));
		assert.throws(
			() => getPluginInstallationPath(home, '..', 'fake', id),
			/Invalid marketplace name/,
		);
	});
});
