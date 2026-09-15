import {
	CustomizationEnablementKind,
	CustomizationType,
} from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore } from '../src/config.js';
import { createPluginCustomization, PluginManager, resolveServerConfig } from '../src/plugins.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('PluginManager', () => {
	it('installs a relative Claude marketplace plugin', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-'));
		temporaryDirectories.push(root);
		const marketplace = join(root, 'marketplace');
		const pluginPath = join(marketplace, 'plugins', 'fake');
		await mkdir(join(pluginPath, '.claude-plugin'), { recursive: true });
		await writeFile(join(marketplace, 'marketplace.json'), JSON.stringify({
			plugins: [
				{ name: 'unsupported', source: { source: 'npm', package: 'unsupported' } },
				{ name: 'fake', source: './plugins/fake' },
			],
		}));
		await writeFile(join(pluginPath, '.claude-plugin', 'plugin.json'), JSON.stringify({
			name: 'fake',
			version: '1.2.3',
		}));
		await writeFile(join(pluginPath, '.mcp.json'), JSON.stringify({
			mcpServers: {
				fake: {
					command: 'node',
					args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
				},
			},
		}));

		const store = new ConfigStore(join(root, 'home'));
		const manager = new PluginManager(store);
		await manager.addMarketplace('test', marketplace);
		const installed = await manager.install('fake@test');

		assert.deepEqual({
			name: installed.name,
			version: installed.version,
			server: resolveServerConfig(installed),
			stored: (await store.read()).plugins['fake'],
		}, {
			name: 'fake',
			version: '1.2.3',
			server: {
				command: 'node',
				args: [join(pluginPath, 'server.mjs')],
			},
			stored: {
				marketplace: 'test',
				path: pluginPath,
				version: '1.2.3',
			},
		});
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
		}, 'client-id', 'channel');
		const nonce = customization.nonce;

		assert.match(nonce ?? '', /^[0-9a-f-]{36}$/);
		assert.deepEqual({
			...customization,
			nonce: '<nonce>',
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
			nonce: '<nonce>',
			childEnablement: {
				channel: [{
					kind: CustomizationEnablementKind.Global,
					enabled: false,
				}],
			},
		});
	});
});
