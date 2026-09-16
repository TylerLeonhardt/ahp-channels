import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { DeterministicAgentHost } from '../scripts/deterministic-agent-host.js';
import { AgentHostService } from '../src/agentHosts.js';
import { connectAgentHost } from '../src/ahp.js';
import { ChannelBindingService } from '../src/channelBindings.js';
import { FileChannelHandoffStore, type ChannelHandoffRecord } from '../src/channelHandoff.js';
import { createChannelRuntimeServices } from '../src/channelRuntime.js';
import { ConfigStore, type ChannelInstanceConfig } from '../src/config.js';
import { probeDaemon, requestDaemon } from '../src/daemonClient.js';
import { getOrCreateDaemonToken } from '../src/daemonPaths.js';
import { createDaemonRuntimeFactory, DaemonServer } from '../src/daemonServer.js';
import { PluginManager } from '../src/plugins.js';

const execute = promisify(execFile);
const source: ChannelInstanceConfig = {
	plugin: 'fixture', session: 'ahp-session:/source', enabled: false,
};
const target: ChannelInstanceConfig = { ...source, session: 'ahp-session:/target' };

describe('ChannelBindingService', () => {
	it('recovers interrupted handoffs and preserves subsequent explicit bindings', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-bindings-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		const config = new ConfigStore(home);
		const handoffs = new FileChannelHandoffStore(home);
		const bindings = new ChannelBindingService(config, handoffs);
		await config.update(value => ({ ...value, channels: { personal: target } }));
		await handoffs.write('personal', pendingHandoff(source, target));

		const recovered = await bindings.recover('personal');
		assert.deepEqual(recovered.definition, source);
		assert.equal(recovered.handoff?.state, 'failed');
		const next = { ...source, session: 'ahp-session:/explicit' };
		await bindings.replace('personal', source, next);
		assert.deepEqual((await bindings.recover('personal')).definition, next);
	});

	it('does not restore over a different binding or overwrite an intervening change', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-bindings-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		const config = new ConfigStore(home);
		const handoffs = new FileChannelHandoffStore(home);
		const bindings = new ChannelBindingService(config, handoffs);
		const later = { ...source, session: 'ahp-session:/later' };
		await config.update(value => ({ ...value, channels: { personal: later } }));
		await handoffs.write('personal', pendingHandoff(source, target));

		const recovered = await bindings.recover('personal');
		assert.deepEqual(recovered.definition, later);
		assert.match(recovered.handoff?.error ?? '', /later binding was preserved/);
		await assert.rejects(bindings.replace('personal', source, target), /changed while the binding operation/);
		assert.deepEqual((await config.read()).channels['personal'], later);
	});

	it('requires ownership of an active handoff before changing its persisted binding', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-bindings-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		const config = new ConfigStore(home);
		const handoffs = new FileChannelHandoffStore(home);
		const bindings = new ChannelBindingService(config, handoffs);
		await config.update(value => ({ ...value, channels: { personal: source } }));
		const pending = pendingHandoff(source, target);
		await handoffs.write('personal', pending);
		await assert.rejects(bindings.replace('personal', source, target), /Recover or cancel handoff/);
		await assert.rejects(bindings.replace('personal', source, target, randomUUID()), /no longer owns/);
		await bindings.replace('personal', source, target, pending.requestId);
		assert.deepEqual((await config.read()).channels['personal'], target);
	});

	it('keeps an offline CLI handoff when the daemon next starts', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-bindings-'));
		const registry = join(home, 'registry');
		const host = new DeterministicAgentHost(registry);
		let daemon: DaemonServer | undefined;
		let connection: Awaited<ReturnType<typeof connectAgentHost>> | undefined;
		context.after(async () => {
			await daemon?.close();
			await connection?.client.shutdown();
			await host.close();
			await rm(home, { recursive: true, force: true });
		});
		await host.start();
		const config = new ConfigStore(home);
		const hosts = new AgentHostService(config, { AHP_CHANNELS_ENDPOINT_REGISTRY: registry });
		connection = await connectAgentHost(await hosts.resolve());
		const session = `ahp-session:/${randomUUID()}`;
		await connection.client.request('createSession', { channel: session, provider: 'deterministic-e2e' });
		const plugin = join(home, 'plugin');
		await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
		await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture' }));
		await writeFile(join(plugin, '.mcp.json'), JSON.stringify({
			mcpServers: { fixture: { command: process.execPath, args: ['--version'] } },
		}));
		const before = { ...source, plugin, host: '@fixture' };
		const interrupted = { ...target, plugin, host: '@fixture' };
		await config.update(value => ({
			...value,
			hostAliases: { fixture: { kind: 'vscode-local', registry, hostType: 'standalone' } },
			channels: { personal: interrupted },
		}));
		await new FileChannelHandoffStore(home).write('personal', pendingHandoff(before, interrupted));
		await execute(process.execPath, [
			'--import', 'tsx', resolve(import.meta.dirname, '..', 'src', 'cli.ts'),
			'channel', 'handoff', 'personal', '--host', '@fixture', '--session', session,
		], {
			cwd: resolve(import.meta.dirname, '..'),
			env: { ...process.env, AHP_CHANNELS_HOME: home, AHP_CHANNELS_ENDPOINT_REGISTRY: registry },
			timeout: 15_000,
		});
		assert.equal(await probeDaemon(home), undefined, 'Offline selection must not start a plugin or daemon');
		assert.equal((await config.read()).channels['personal'].session, session);

		const plugins = new PluginManager(config);
		const services = createChannelRuntimeServices(plugins, hosts, { home });
		daemon = new DaemonServer(
			home, await getOrCreateDaemonToken(home), config,
			createDaemonRuntimeFactory(services, plugins), undefined, services.sessionCatalog,
		);
		await daemon.start();
		const status = await requestDaemon(home, { command: 'status' });
		assert.equal(status.channels[0]?.definition.session, session);
		assert.equal(status.channels[0]?.runtime, undefined);
		assert.equal(status.channels[0]?.handoff?.state, 'failed');
	});
});

function pendingHandoff(
	previous: ChannelInstanceConfig,
	next: ChannelInstanceConfig,
): ChannelHandoffRecord {
	const timestamp = new Date().toISOString();
	return {
		requestId: randomUUID(),
		state: 'pending',
		requestedAt: timestamp,
		updatedAt: timestamp,
		source: {
			...(previous.host ? { host: previous.host } : {}),
			session: previous.session,
			...(previous.chat ? { chat: previous.chat } : {}),
			actualHost: 'fixture-source',
			resolvedChat: previous.chat ?? 'ahp-chat:/source',
		},
		target: {
			...(next.host ? { host: next.host } : {}),
			session: next.session,
			...(next.chat ? { chat: next.chat } : {}),
		},
		resolvedTarget: {
			...(next.host ? { preferredHost: next.host } : {}),
			actualHost: 'fixture-target',
			fallback: false,
			session: next.session,
			chat: next.chat ?? 'ahp-chat:/target',
			warnings: [],
		},
	};
}
