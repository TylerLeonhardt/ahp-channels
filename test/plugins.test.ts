import {
	CustomizationEnablementKind,
	CustomizationType,
} from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore } from '../src/config.js';
import { createPluginCustomization, PluginManager, resolveServerConfig } from '../src/plugins.js';
import { runProcess, runProcessOutput } from '../src/process.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('PluginManager', () => {
	it('rejects marketplace names that could escape managed storage', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-'));
		temporaryDirectories.push(root);
		const manager = new PluginManager(new ConfigStore(join(root, 'home')));

		await assert.rejects(manager.addMarketplace('..', './marketplace'), /Invalid marketplace name/);
	});

	it('installs a relative marketplace plugin into a content-addressed copy', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-'));
		temporaryDirectories.push(root);
		const repository = join(root, 'repository');
		const marketplace = join(repository, 'catalog');
		const pluginPath = join(marketplace, 'plugins', 'fake');
		await mkdir(marketplace, { recursive: true });
		await writeFile(join(marketplace, 'marketplace.json'), JSON.stringify({
			plugins: [
				{ name: 'unsupported', source: { source: 'npm', package: 'unsupported' } },
				{ name: 'fake', source: './plugins/fake' },
			],
		}));
		await writePlugin(pluginPath, '1.2.3', 'version one');
		await writeFile(join(marketplace, '.gitignore'), '**/.env\n');
		await initializeGitRepository(repository);
		await writeFile(join(pluginPath, '.env'), 'SHOULD_NOT_BE_COPIED=true\n');
		const marketplaceRevision = (await runProcessOutput('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();

		const store = new ConfigStore(join(root, 'home'));
		const manager = new PluginManager(store);
		await manager.addMarketplace('test', marketplace);
		const installed = await manager.install('fake@test');
		const stored = (await store.read()).plugins['fake'];
		assert.ok(stored);
		const storedInstallation = stored.installations[installed.installation];
		assert.ok(storedInstallation);

		assert.deepEqual({
			name: installed.plugin.name,
			version: installed.plugin.version,
			created: installed.created,
			server: resolveServerConfig(installed.plugin),
			sourceIsInstallation: installed.plugin.path !== pluginPath,
			stored,
		}, {
			name: 'fake',
			version: '1.2.3',
			created: true,
			server: {
				command: 'node',
				args: [join(installed.plugin.path, 'server.mjs')],
			},
			sourceIsInstallation: true,
			stored: {
				marketplace: 'test',
				activeInstallation: installed.installation,
				installations: {
					[installed.installation]: {
						source: './plugins/fake',
						version: '1.2.3',
						marketplaceRevision,
					},
				},
			},
		});
		assert.deepEqual(storedInstallation, installed.config);
		await assert.rejects(access(join(installed.plugin.path, '.env')));
		await assert.rejects(manager.install('fake@test'), /already installed/);
		await writeFile(join(pluginPath, 'server.mjs'), 'dirty marketplace');
		await assert.rejects(manager.upgrade('fake'), /Marketplace has local changes/);
		await writeFile(join(installed.plugin.path, 'server.mjs'), 'tampered installation');
		await assert.rejects(manager.resolvePlugin('fake'), /does not match digest/);
	});

	it('upgrades explicitly, keeps channel pins, rolls back, and prunes only unreferenced versions', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-'));
		temporaryDirectories.push(root);
		const marketplace = join(root, 'marketplace');
		const pluginPath = join(marketplace, 'plugins', 'fake');
		await mkdir(marketplace, { recursive: true });
		await writeFile(join(marketplace, 'marketplace.json'), JSON.stringify({
			plugins: [{ name: 'fake', source: './plugins/fake' }],
		}));
		await writePlugin(pluginPath, '1.0.0', 'version one');
		const store = new ConfigStore(join(root, 'home'));
		const manager = new PluginManager(store);
		await manager.addMarketplace('test', marketplace);
		const first = await manager.install('fake@test');
		const firstReference = await manager.pinPlugin('fake');

		await writePlugin(pluginPath, '2.0.0', 'version two');
		await manager.updateMarketplace('test');
		assert.equal((await manager.resolvePlugin('fake')).version, '1.0.0');
		const second = await manager.upgrade('fake');
		const secondReference = await manager.pinPlugin('fake');
		assert.notEqual(second.installation, first.installation);
		assert.deepEqual({
			firstReference,
			secondReference,
			activeVersion: (await manager.resolvePlugin('fake')).version,
			firstVersion: (await manager.resolvePlugin('fake', first.installation)).version,
		}, {
			firstReference: { plugin: 'fake', installation: first.installation },
			secondReference: { plugin: 'fake', installation: second.installation },
			activeVersion: '2.0.0',
			firstVersion: '1.0.0',
		});

		await store.update(config => ({
			...config,
			channels: {
				first: {
					...firstReference,
					session: 'ahp-session:/one',
					enabled: false,
				},
				second: {
					...secondReference,
					session: 'ahp-session:/two',
					enabled: false,
				},
			},
		}));
		assert.deepEqual(await manager.versions('fake'), [{
			id: first.installation,
			active: false,
			config: first.config,
			path: first.plugin.path,
			channels: ['first'],
		}, {
			id: second.installation,
			active: true,
			config: second.config,
			path: second.plugin.path,
			channels: ['second'],
		}].sort((left, right) => left.id.localeCompare(right.id)));
		assert.deepEqual(await manager.prune('fake'), []);

		await manager.activate('fake', first.installation);
		assert.deepEqual(await manager.pinPlugin('fake'), {
			plugin: 'fake',
			installation: first.installation,
		});
		await store.update(config => ({ ...config, channels: {} }));
		const removed = await manager.prune('fake');
		assert.deepEqual(removed, [{
			marketplace: 'test',
			plugin: 'fake',
			installation: second.installation,
			path: second.plugin.path,
			config: second.config,
		}]);
		await assert.doesNotReject(access(first.plugin.path));
		await assert.rejects(access(second.plugin.path));
	});

	it('publishes an installed plugin while disabling only the proxied MCP server', async () => {
		const pluginPath = join(tmpdir(), 'fake-plugin');
		const customization = createPluginCustomization({
			name: 'fake',
			path: pluginPath,
			version: '1.2.3',
			servers: {
				channel: { command: 'node', args: ['server.mjs'] },
				helper: { command: 'node', args: ['helper.mjs'] },
			},
		}, 'client-id', 'channel', 'installation-digest');

		assert.deepEqual({
			...customization,
		}, {
			type: CustomizationType.Plugin,
			id: 'client-id:plugin:fake',
			uri: pathToFileURL(pluginPath).href,
			name: 'fake',
			version: '1.2.3',
			enablement: [{
				kind: CustomizationEnablementKind.Global,
				enabled: true,
			}],
			nonce: 'installation-digest',
			childEnablement: {
				channel: [{
					kind: CustomizationEnablementKind.Global,
					enabled: false,
				}],
			},
		});
	});

	async function writePlugin(path: string, version: string, content: string): Promise<void> {
		await mkdir(join(path, '.claude-plugin'), { recursive: true });
		await writeFile(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({
			name: 'fake',
			version,
		}));
		await writeFile(join(path, '.mcp.json'), JSON.stringify({
			mcpServers: {
				fake: {
					command: 'node',
					args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
				},
			},
		}));
		await writeFile(join(path, 'server.mjs'), content);
	}

	async function initializeGitRepository(path: string): Promise<void> {
		await runProcess('git', ['init', '--quiet', path], { quiet: true });
		await runProcess('git', ['-C', path, 'add', '.'], { quiet: true });
		await runProcess('git', [
			'-C',
			path,
			'-c',
			'user.name=ahp-channels test',
			'-c',
			'user.email=ahp-channels@example.invalid',
			'commit',
			'--quiet',
			'-m',
			'Create test marketplace',
		], { quiet: true });
	}
});
