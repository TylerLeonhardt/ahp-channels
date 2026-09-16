#!/usr/bin/env node

import { SessionStatus } from '@microsoft/agent-host-protocol';
import { Command } from 'commander';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentHostService, type HostAliasInspection } from './agentHosts.js';
import { ChannelRuntime, createChannelRuntimeServices, validateChannelDefinition } from './channelRuntime.js';
import {
	ConfigStore,
	isValidChannelInstanceName,
	rebindChannelInstance,
	retargetChannelInstance,
	type AppConfig,
	type ChannelInstanceConfig,
	type SocketHostAliasConfig,
	type WebSocketHostAliasConfig,
} from './config.js';
import {
	ensureDaemonStarted,
	probeDaemon,
	requestDaemon,
	requestDaemonData,
	stopDaemon,
} from './daemonClient.js';
import { getDaemonPaths } from './daemonPaths.js';
import { type ChannelDaemonStatus, type DaemonStatus } from './daemonProtocol.js';
import { describeEndpoint } from './endpoints.js';
import { removeInstanceState } from './instancePaths.js';
import { activeInstallation, PluginManager, listInstalledPlugins } from './plugins.js';
import {
	SessionCatalogService,
	type ChannelBindingTarget,
	type ChatDiscoveryResult,
	type SessionCatalogEntry,
	type SessionDiscoveryResult,
} from './sessionCatalog.js';
import { VERSION } from './version.js';

const program = new Command();
const store = new ConfigStore();
const plugins = new PluginManager(store);
const agentHosts = new AgentHostService(store);
const sessionCatalog = new SessionCatalogService(agentHosts);

program
	.name('ahp-channels')
	.description('Run Claude Code channel plugins against Agent Host Protocol servers')
	.version(VERSION);

const marketplace = program.command('marketplace').description('Manage plugin marketplaces');
marketplace
	.command('add')
	.argument('<name>')
	.argument('<source>')
	.action(async (name: string, source: string) => {
		await plugins.addMarketplace(name, source);
		console.log(`Added marketplace ${name}`);
	});
marketplace
	.command('list')
	.action(async () => {
		const config = await store.read();
		for (const [name, value] of Object.entries(config.marketplaces)) {
			console.log(`${name}\t${value.source}`);
		}
	});
marketplace
	.command('update')
	.argument('<name>')
	.action(async (name: string) => {
		const path = await plugins.updateMarketplace(name);
		console.log(`Updated marketplace ${name}`);
		console.log(path);
	});

const plugin = program.command('plugin').description('Install and inspect Claude channel plugins');
plugin
	.command('install')
	.argument('<plugin>')
	.action(async (spec: string) => {
		const installed = await plugins.install(spec);
		console.log(formatInstalledPlugin(installed.plugin.name, installed.plugin.version, installed.installation, installed.created));
		console.log(installed.plugin.path);
	});
plugin
	.command('upgrade')
	.argument('<plugin>')
	.action(async (name: string) => {
		const installed = await plugins.upgrade(name);
		console.log(formatInstalledPlugin(installed.plugin.name, installed.plugin.version, installed.installation, installed.created));
		console.log('Existing channels remain pinned; run channel upgrade <name> to adopt it');
	});
plugin
	.command('versions')
	.argument('<plugin>')
	.action(async (name: string) => {
		const versions = await plugins.versions(name);
		console.table(versions.map(version => ({
			installation: version.id,
			active: version.active,
			version: version.config.version ?? '',
			marketplaceRevision: version.config.marketplaceRevision ?? '',
			channels: version.channels.join(', '),
			path: version.path,
		})));
	});
plugin
	.command('rollback')
	.argument('<plugin>')
	.argument('<installation>')
	.action(async (name: string, installation: string) => {
		const selected = await plugins.activate(name, installation);
		console.log(`Activated ${name} ${selected.version ?? installation} (${installation})`);
		console.log('Existing channels remain pinned; run channel upgrade <name> to adopt it');
	});
plugin
	.command('prune')
	.argument('[plugin]')
	.action(async (name?: string) => {
		const removed = await plugins.prune(name);
		if (removed.length === 0) {
			console.log('No unreferenced plugin installations');
			return;
		}
		for (const installation of removed) {
			console.log(`Removed ${installation.plugin} ${installation.installation}`);
		}
	});
plugin
	.command('list')
	.action(async () => {
		for (const [name, installed] of listInstalledPlugins(await store.read())) {
			const active = activeInstallation(installed);
			const plugin = await plugins.resolvePlugin(name);
			console.log([
				name,
				installed.marketplace,
				active.version ?? '',
				installed.activeInstallation,
				plugin.path,
			].join('\t'));
		}
	});
plugin
	.command('inspect')
	.argument('<plugin>')
	.option('--installation <id>')
	.action(async (nameOrPath: string, options: { installation?: string }) => {
		const inspected = await plugins.resolvePlugin(nameOrPath, options.installation);
		console.log(JSON.stringify({
			name: inspected.name,
			version: inspected.version,
			path: inspected.path,
			servers: Object.keys(inspected.servers),
		}, undefined, 2));
	});

const host = program.command('host').description('Discover and configure local Agent Host connections');
host
	.command('discover')
	.option('--json', 'Print machine-readable output')
	.action(async (options: { json?: boolean }) => {
		const endpoints = await agentHosts.discover();
		const descriptions = endpoints.map((endpoint, index) => describeEndpoint(endpoint, index));
		if (options.json) {
			console.log(JSON.stringify(descriptions, undefined, 2));
			return;
		}
		if (descriptions.length === 0) {
			console.log('No running local Agent Hosts found');
			return;
		}
		console.table(descriptions);
	});

const hostAlias = host.command('alias').description('Manage stable local Agent Host aliases');
hostAlias
	.command('add')
	.argument('<name>')
	.option('--host <selector>', 'Current VS Code host index or ID prefix')
	.option('--url <url>', 'Fixed loopback ws:// or wss:// URL for a local AHP host')
	.option('--socket <path>', 'Fixed Unix socket or Windows named-pipe path for a local AHP host')
	.option('--token-file <path>', 'File containing the current connection token')
	.option('--token-query-parameter <name>', 'WebSocket query parameter that carries the token')
	.option('--without-authentication', 'Explicitly connect without a connection token')
	.action(async (name: string, options: {
		host?: string;
		url?: string;
		socket?: string;
		tokenFile?: string;
		tokenQueryParameter?: string;
		withoutAuthentication?: boolean;
	}) => {
		const inspection = options.host
			? await addDiscoveredHostAlias(name, options)
			: await addExplicitHostAlias(name, options);
		printHostAliasInspection(inspection);
	});
hostAlias
	.command('list')
	.option('--json', 'Print machine-readable output')
	.action(async (options: { json?: boolean }) => {
		const aliases = await agentHosts.list();
		if (options.json) {
			console.log(JSON.stringify(aliases, undefined, 2));
			return;
		}
		if (aliases.length === 0) {
			console.log('No host aliases configured');
			return;
		}
		console.table(aliases.map(hostAliasTableRow));
	});
hostAlias
	.command('inspect')
	.argument('<name>')
	.option('--json', 'Print machine-readable output')
	.action(async (name: string, options: { json?: boolean }) => {
		const inspection = await agentHosts.inspect(name);
		if (options.json) {
			console.log(JSON.stringify(inspection, undefined, 2));
			return;
		}
		printHostAliasInspection(inspection);
	});
hostAlias
	.command('remove')
	.argument('<name>')
	.action(async (name: string) => {
		const removed = await agentHosts.removeAlias(name);
		console.log(`Removed host alias @${removed}`);
	});

const session = program.command('session').description('Inspect AHP sessions');
session
	.command('list')
	.option('--host <selector>', 'Host alias (@name), discovered host index, or ID prefix')
	.option('--cursor <cursor>', 'Continue from an opaque catalog cursor')
	.option('--limit <count>', 'Maximum sessions to return', parsePositiveInteger)
	.option('--json', 'Print machine-readable output')
	.action(async (options: { host?: string; cursor?: string; limit?: number; json?: boolean }) => {
		const result = await sessionCatalog.discoverSessions({
			...(options.host ? { host: options.host } : {}),
			...(options.cursor ? { cursor: options.cursor } : {}),
			...(options.limit ? { limit: options.limit } : {}),
		});
		if (options.json) {
			console.log(JSON.stringify(result, undefined, 2));
			return;
		}
		printSessionDiscovery(result);
	});

const daemon = program.command('daemon').description('Manage the background channel daemon');
daemon
	.command('start')
	.action(async () => {
		const status = await ensureDaemonStarted(store.home);
		console.log(`Daemon running (pid ${status.pid})`);
	});
daemon
	.command('stop')
	.action(async () => {
		await stopDaemon(store.home);
		console.log('Daemon stopped');
	});
daemon
	.command('status')
	.option('--json', 'Print machine-readable output')
	.action(async (options: { json?: boolean }) => {
		const status = await probeDaemon(store.home);
		if (!status) {
			if (options.json) {
				console.log(JSON.stringify({ running: false }, undefined, 2));
			} else {
				console.log('Daemon is not running');
			}
			return;
		}
		printDaemonStatus(status, options.json);
	});
daemon
	.command('logs')
	.action(() => {
		console.log(getDaemonPaths(store.home).logFile);
	});

const channel = program.command('channel').description('Run channel compatibility bridges');
channel
	.command('create')
	.argument('<name>')
	.requiredOption('--plugin <plugin>', 'Installed plugin name or absolute plugin path')
	.requiredOption('--session <uri>', 'AHP session URI')
	.option('--chat <uri>', 'AHP chat URI; defaults to the session default chat')
	.option('--server <name>', 'MCP server name when the plugin declares more than one')
	.option('--host <selector>', 'Preferred host alias (@name), discovered host index, or ID prefix')
	.option('--client-id <id>', 'Override the stable AHP client ID')
	.option('--installation <id>', 'Pin a specific installed plugin version')
	.option('--start', 'Start the channel immediately')
	.action(async (name: string, options: {
		plugin: string;
		session: string;
		chat?: string;
		server?: string;
		host?: string;
		clientId?: string;
		installation?: string;
		start?: boolean;
	}) => {
		assertChannelName(name);
		const definition = await channelDefinition(options);
		if (!options.start) {
			await validateChannelDefinition(plugins, definition);
			await store.update(config => {
				if (findChannelName(config, name)) {
					throw new Error(`Channel '${name}' already exists`);
				}
				return withChannel(config, name, definition);
			});
			printChannelStatus(stoppedChannelStatus(name, definition));
			return;
		}
		await ensureDaemonStarted(store.home);
		const status = await requestDaemon(store.home, {
			command: 'channel.create',
			name,
			definition,
			start: true,
		});
		printChannelStatus(requireChannelStatus(status, name));
	});
channel
	.command('list')
	.option('--json', 'Print machine-readable output')
	.action(async (options: { json?: boolean }) => {
		const status = await probeDaemon(store.home);
		if (status) {
			if (options.json) {
				console.log(JSON.stringify(status.channels, undefined, 2));
			} else {
				printChannelTable(status.channels);
			}
			return;
		}
		const config = await store.read();
		const channels = offlineChannelStatuses(config);
		if (options.json) {
			console.log(JSON.stringify(channels, undefined, 2));
		} else {
			printChannelTable(channels);
		}
	});
channel
	.command('start')
	.argument('<name>')
	.action(async (name: string) => {
		await ensureDaemonStarted(store.home);
		const status = await requestDaemon(store.home, { command: 'channel.start', name });
		printChannelStatus(requireChannelStatus(status, name));
	});
channel
	.command('restart')
	.argument('<name>')
	.action(async (name: string) => {
		const status = await probeDaemon(store.home);
		if (!status) {
			throw new Error('Daemon is not running');
		}
		const restarted = await requestDaemon(store.home, { command: 'channel.restart', name });
		printChannelStatus(requireChannelStatus(restarted, name));
	});
channel
	.command('upgrade')
	.argument('<name>')
	.action(async (name: string) => {
		const current = await getOfflineChannel(name);
		const reference = await plugins.pinPlugin(current.plugin);
		if (!reference.installation) {
			throw new Error(`Channel '${name}' uses a plugin path and cannot be upgraded through the plugin registry`);
		}
		const updated = { ...current, installation: reference.installation };
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			const status = await requestDaemon(store.home, {
				command: 'channel.repin',
				name,
				installation: reference.installation,
			});
			printChannelStatus(requireChannelStatus(status, name));
			return;
		}
		await validateChannelDefinition(plugins, updated);
		await store.update(config => withChannel(config, name, updated));
		printChannelStatus(stoppedChannelStatus(name, updated));
	});
channel
	.command('stop')
	.argument('<name>')
	.action(async (name: string) => {
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			const status = await requestDaemon(store.home, { command: 'channel.stop', name });
			printChannelStatus(requireChannelStatus(status, name));
			return;
		}
		const definition = await updateOfflineChannel(name, current => ({ ...current, enabled: false }));
		printChannelStatus(stoppedChannelStatus(name, definition));
	});
channel
	.command('switch')
	.argument('<name>')
	.requiredOption('--session <uri>', 'New AHP session URI')
	.option('--chat <uri>', 'New AHP chat URI; omit to use the session default')
	.action(async (name: string, options: { session: string; chat?: string }) => {
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			const status = await requestDaemon(store.home, {
				command: 'channel.switch',
				name,
				session: options.session,
				...(options.chat ? { chat: options.chat } : {}),
			});
			printChannelStatus(requireChannelStatus(status, name));
			return;
		}
		const current = await getOfflineChannel(name);
		const definition = retargetChannelInstance(current, options.session, options.chat);
		await validateChannelDefinition(plugins, definition);
		await store.update(config => withChannel(config, name, definition));
		printChannelStatus(stoppedChannelStatus(name, definition));
	});
channel
	.command('handoff')
	.argument('<name>')
	.requiredOption('--session <uri>', 'Destination AHP session URI')
	.option('--chat <uri>', 'Destination AHP chat URI; omit to use the session default')
	.option('--host <selector>', 'Destination preferred host alias (@name), discovered host index, or ID prefix')
	.action(async (name: string, options: { session: string; chat?: string; host?: string }) => {
		await handoffChannel(name, {
			...(options.host ? { host: options.host } : {}),
			session: options.session,
			...(options.chat ? { chat: options.chat } : {}),
		});
	});
channel
	.command('select')
	.argument('<name>')
	.description('Interactively search existing sessions and redirect a managed channel')
	.action(async (name: string) => {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error('Interactive channel selection requires a terminal; use channel handoff with explicit --host, --session, and optional --chat values');
		}
		const current = await getOfflineChannel(name);
		const daemonStatus = await probeDaemon(store.home);
		const sessions = await discoverAllSessions(name, current, daemonStatus !== undefined);
		if (sessions.length === 0) {
			console.log('No existing sessions are available from the configured local Agent Hosts');
			return;
		}
		const selectedSession = await pickSession(sessions, current);
		if (!selectedSession) {
			console.log('Selection cancelled; channel binding is unchanged');
			return;
		}
		const chats = await discoverAllChats(
			name,
			selectedSession.host.preferred,
			selectedSession.resource,
			daemonStatus !== undefined,
		);
		const selectedChat = await pickChat(chats);
		if (selectedChat.cancelled) {
			console.log('Selection cancelled; channel binding is unchanged');
			return;
		}
		await handoffChannel(name, {
			...(selectedSession.host.preferred ? { host: selectedSession.host.preferred } : {}),
			session: selectedSession.resource,
			...(selectedChat.chat ? { chat: selectedChat.chat } : {}),
		});
	});
channel
	.command('select-host')
	.argument('<name>')
	.requiredOption('--host <selector>', 'Preferred host alias (@name), discovered host index, or ID prefix')
	.action(async (name: string, options: { host: string }) => {
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			const status = await requestDaemon(store.home, {
				command: 'channel.rehost',
				name,
				host: options.host,
			});
			printChannelStatus(requireChannelStatus(status, name));
			return;
		}
		const current = await getOfflineChannel(name);
		const definition = {
			...current,
			host: options.host,
		};
		await validateChannelDefinition(plugins, definition);
		await store.update(config => withChannel(config, name, definition));
		printChannelStatus(stoppedChannelStatus(name, definition));
	});
channel
	.command('status')
	.argument('[name]')
	.option('--json', 'Print machine-readable output')
	.action(async (name: string | undefined, options: { json?: boolean }) => {
		const status = await probeDaemon(store.home);
		if (!status) {
			const config = await store.read();
			if (name) {
				const definition = config.channels[name];
				if (!definition) {
					throw new Error(`Channel '${name}' does not exist`);
				}
				const channelStatus = stoppedChannelStatus(name, definition);
				if (options.json) {
					console.log(JSON.stringify(channelStatus, undefined, 2));
				} else {
					printChannelStatus(channelStatus);
				}
			} else {
				const channels = offlineChannelStatuses(config);
				if (options.json) {
					console.log(JSON.stringify(channels, undefined, 2));
				} else {
					console.log('Daemon is not running');
					printChannelTable(channels);
				}
			}
			return;
		}
		if (!name) {
			if (options.json) {
				console.log(JSON.stringify(status.channels, undefined, 2));
			} else {
				printChannelTable(status.channels);
			}
			return;
		}
		const channelStatus = requireChannelStatus(status, name);
		if (options.json) {
			console.log(JSON.stringify(channelStatus, undefined, 2));
		} else {
			printChannelStatus(channelStatus);
		}
	});
channel
	.command('delete')
	.argument('<name>')
	.action(async (name: string) => {
		await getOfflineChannel(name);
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			await requestDaemon(store.home, { command: 'channel.delete', name });
		} else {
			await store.update(config => withoutChannel(config, name));
		}
		await removeInstanceState(store.home, name);
		console.log(`Deleted channel ${name}`);
	});
channel
	.command('run')
	.argument('<plugin>')
	.requiredOption('--session <uri>', 'AHP session URI')
	.option('--chat <uri>', 'AHP chat URI; defaults to the session default chat')
	.option('--server <name>', 'MCP server name when the plugin declares more than one')
	.option('--host <selector>', 'Preferred host alias (@name), discovered host index, or ID prefix')
	.option('--client-id <id>', 'Override the stable AHP client ID')
	.option('--installation <id>', 'Use a specific installed plugin version')
	.action(async (pluginName: string, options: {
		session: string;
		chat?: string;
		server?: string;
		host?: string;
		clientId?: string;
		installation?: string;
	}) => {
		const reference = await plugins.pinPlugin(pluginName, options.installation);
		const runtime = await ChannelRuntime.start(pluginName, {
			...reference,
			session: options.session,
			enabled: true,
			...(options.chat ? { chat: options.chat } : {}),
			...(options.server ? { server: options.server } : {}),
			...(options.host ? { host: options.host } : {}),
			...(options.clientId ? { clientId: options.clientId } : {}),
		}, createChannelRuntimeServices(plugins, agentHosts), {
			report(message) {
				console.log(`[channel] ${message}`);
			},
		});
		try {
			await Promise.race([
				waitForShutdownSignal(),
				runtime.whenStopped.then(() => {
					throw new Error('Channel runtime stopped unexpectedly');
				}),
			]);
		} finally {
			await runtime.close();
		}
	});

program.parseAsync(process.argv).catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

function waitForShutdownSignal(): Promise<void> {
	return new Promise(resolve => {
		const done = () => {
			process.off('SIGINT', done);
			process.off('SIGTERM', done);
			resolve();
		};
		process.once('SIGINT', done);
		process.once('SIGTERM', done);
	});
}

async function channelDefinition(options: {
	plugin: string;
	session: string;
	chat?: string;
	server?: string;
	host?: string;
	clientId?: string;
	installation?: string;
}): Promise<ChannelInstanceConfig> {
	const reference = await plugins.pinPlugin(options.plugin, options.installation);
	return {
		...reference,
		session: options.session,
		enabled: false,
		...(options.chat ? { chat: options.chat } : {}),
		...(options.server ? { server: options.server } : {}),
		...(options.host ? { host: options.host } : {}),
		...(options.clientId ? { clientId: options.clientId } : {}),
	};
}

function requireChannelStatus(status: DaemonStatus, name: string): ChannelDaemonStatus {
	const channelStatus = status.channels.find(channel => channel.name === name);
	if (!channelStatus) {
		throw new Error(`Daemon returned no status for channel '${name}'`);
	}
	return channelStatus;
}

function printDaemonStatus(status: DaemonStatus, json = false): void {
	if (json) {
		console.log(JSON.stringify({ running: true, ...status }, undefined, 2));
		return;
	}
	console.log(`Daemon running (pid ${status.pid}, started ${status.startedAt})`);
	printChannelTable(status.channels);
}

function printChannelTable(channels: readonly ChannelDaemonStatus[]): void {
	if (channels.length === 0) {
		console.log('No channel instances configured');
		return;
	}
	console.table(channels.map(channel => ({
		name: channel.name,
		state: channel.state,
		desired: channel.desired,
		plugin: channel.definition.plugin,
		installation: channel.definition.installation?.slice(0, 12) ?? '',
		session: channel.definition.session,
		chat: channel.runtime?.chat ?? channel.definition.chat ?? 'default',
		host: formatChannelHost(channel),
		handoff: channel.handoff?.state ?? '',
		health: channel.health.state,
		failure: channel.health.failure?.summary ?? '',
	})));
}

function printChannelStatus(channel: ChannelDaemonStatus): void {
	const installation = channel.definition.installation
		? ` @ ${channel.definition.installation.slice(0, 12)}`
		: '';
	console.log(`${channel.name}: ${channel.state} (${channel.health.state})${installation} → ${channel.definition.session}${channel.runtime ? ` (${channel.runtime.chat})` : ''}`);
	console.log(`Host: ${formatChannelHost(channel)}`);
	if (channel.handoff) {
		console.log(`Handoff: ${channel.handoff.state} (${channel.handoff.requestId})`);
		console.log(`Handoff target: ${channel.handoff.target.host ?? channel.definition.host ?? 'automatic'} → ${channel.handoff.target.session}${channel.handoff.target.chat ? ` (${channel.handoff.target.chat})` : ' (default chat)'}`);
		if (channel.handoff.error) {
			console.log(`Handoff error: ${channel.handoff.error}`);
		}
	}
	if (channel.runtime?.mode === 'customization-only') {
		console.log('Mode: customizations available; channel MCP server unavailable');
	}
	if (channel.health.failure) {
		console.log(`Failure stage: ${channel.health.failure.stage}`);
		console.log(`Error: ${channel.health.failure.summary}`);
		console.log(`Failed at: ${channel.health.failure.failedAt}`);
		console.log(`Recovery: ${channel.health.failure.guidance}`);
	}
	if (channel.health.retry) {
		console.log(`Retry: attempt ${channel.health.retry.attempt} (${channel.health.retry.state})`);
		if (channel.health.retry.nextRetryAt) {
			console.log(`Next retry: ${channel.health.retry.nextRetryAt}`);
		}
	}
}

function formatInstalledPlugin(
	name: string,
	version: string | undefined,
	installation: string,
	created: boolean,
): string {
	return `${created ? 'Installed' : 'Reused'} ${name}${version ? ` ${version}` : ''} (${installation})`;
}

async function getOfflineChannel(name: string): Promise<ChannelInstanceConfig> {
	assertChannelName(name);
	const definition = (await store.read()).channels[name];
	if (!definition) {
		throw new Error(`Channel '${name}' does not exist`);
	}
	return definition;
}

async function updateOfflineChannel(
	name: string,
	update: (definition: ChannelInstanceConfig) => ChannelInstanceConfig,
): Promise<ChannelInstanceConfig> {
	let result: ChannelInstanceConfig | undefined;
	await store.update(config => {
		const definition = config.channels[name];
		if (!definition) {
			throw new Error(`Channel '${name}' does not exist`);
		}
		result = update(definition);
		return withChannel(config, name, result);
	});
	if (!result) {
		throw new Error(`Failed to update channel '${name}'`);
	}
	return result;
}

function stoppedChannelStatus(name: string, definition: ChannelInstanceConfig): ChannelDaemonStatus {
	return {
		name,
		desired: definition.enabled ? 'running' : 'stopped',
		state: 'stopped',
		definition,
		health: { state: 'stopped' },
	};
}

function withChannel(config: AppConfig, name: string, definition: ChannelInstanceConfig): AppConfig {
	return {
		...config,
		channels: {
			...config.channels,
			[name]: definition,
		},
	};
}

function withoutChannel(config: AppConfig, name: string): AppConfig {
	const channels = { ...config.channels };
	delete channels[name];
	return { ...config, channels };
}

function findChannelName(config: AppConfig, name: string): string | undefined {
	return Object.keys(config.channels).find(candidate => candidate.toLowerCase() === name.toLowerCase());
}

function assertChannelName(name: string): void {
	if (!isValidChannelInstanceName(name)) {
		throw new Error(`Invalid channel name '${name}'`);
	}
}

function offlineChannelStatuses(config: AppConfig): ChannelDaemonStatus[] {
	return Object.entries(config.channels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, definition]) => stoppedChannelStatus(name, definition));
}

async function handoffChannel(name: string, target: ChannelBindingTarget): Promise<void> {
	const daemonStatus = await probeDaemon(store.home);
	if (daemonStatus) {
		const status = await requestDaemon(store.home, {
			command: 'channel.handoff',
			name,
			target,
		});
		printChannelStatus(requireChannelStatus(status, name));
		return;
	}
	const current = await getOfflineChannel(name);
	const next = rebindChannelInstance(current, target);
	await validateChannelDefinition(plugins, next);
	const resolved = await sessionCatalog.validateBinding(next);
	for (const warning of resolved.warnings) {
		console.error(`Warning: ${warning}`);
	}
	await store.update(config => withChannel(config, name, next));
	printChannelStatus(stoppedChannelStatus(name, next));
}

async function discoverAllSessions(
	name: string,
	current: ChannelInstanceConfig,
	useDaemon: boolean,
): Promise<readonly SessionCatalogEntry[]> {
	const items: SessionCatalogEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 100; page++) {
		const result = useDaemon
			? await daemonSessionDiscovery(name, cursor)
			: await sessionCatalog.discoverSessions({
				currentHost: current.host ?? null,
				...(cursor ? { cursor } : {}),
				limit: 100,
			});
		for (const failure of result.failures) {
			console.error(`Warning: ${failure.preferred ?? 'automatic host'}: ${failure.error}`);
		}
		if (result.outcome === 'failed') {
			throw new Error('Session discovery failed on every requested Agent Host');
		}
		items.push(...result.items);
		if (!result.nextCursor) {
			return items;
		}
		if (seen.has(result.nextCursor)) {
			throw new Error('Session discovery returned a repeated aggregate cursor');
		}
		seen.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	throw new Error('Session discovery exceeded 100 aggregate pages');
}

async function daemonSessionDiscovery(name: string, cursor?: string): Promise<SessionDiscoveryResult> {
	const data = await requestDaemonData(store.home, {
		command: 'catalog.sessions',
		name,
		...(cursor ? { cursor } : {}),
		limit: 100,
	});
	if (data.kind !== 'sessions') {
		throw new Error('Daemon returned chat data for a session catalog request');
	}
	return data;
}

async function discoverAllChats(
	name: string,
	host: string | undefined,
	session: string,
	useDaemon: boolean,
): Promise<ChatDiscoveryResult> {
	const items: ChatDiscoveryResult['items'][number][] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	let first: ChatDiscoveryResult | undefined;
	for (let page = 0; page < 100; page++) {
		const result = useDaemon
			? await daemonChatDiscovery(name, host, session, cursor)
			: await sessionCatalog.discoverChats({
				...(host ? { host } : {}),
				session,
				...(cursor ? { cursor } : {}),
				limit: 100,
			});
		first ??= result;
		items.push(...result.items);
		if (!result.nextCursor) {
			return { ...first, items, outcome: items.length > 0 ? 'ok' : 'empty', nextCursor: undefined };
		}
		if (seen.has(result.nextCursor)) {
			throw new Error('Chat discovery returned a repeated aggregate cursor');
		}
		seen.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	throw new Error('Chat discovery exceeded 100 aggregate pages');
}

async function daemonChatDiscovery(
	name: string,
	host: string | undefined,
	session: string,
	cursor?: string,
): Promise<ChatDiscoveryResult> {
	const data = await requestDaemonData(store.home, {
		command: 'catalog.chats',
		name,
		...(host ? { host } : {}),
		session,
		...(cursor ? { cursor } : {}),
		limit: 100,
	});
	if (data.kind !== 'chats') {
		throw new Error('Daemon returned session data for a chat catalog request');
	}
	return data;
}

async function pickSession(
	sessions: readonly SessionCatalogEntry[],
	current: ChannelInstanceConfig,
): Promise<SessionCatalogEntry | undefined> {
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		let query = '';
		while (true) {
			const matches = sessions.filter(session => sessionSearchText(session).includes(query.toLowerCase()));
			if (matches.length === 0) {
				console.log('No sessions match that search');
			} else {
				console.table(matches.slice(0, 50).map((session, index) => ({
					index: index + 1,
					current: isCurrentSession(session, current) ? '*' : '',
					title: session.title,
					provider: session.provider,
					status: formatSessionStatus(session.status),
					host: formatCatalogHost(session),
					workspace: formatWorkspace(session),
					session: session.resource,
				})));
				if (matches.length > 50) {
					console.log(`${matches.length - 50} additional matches; narrow the search to select them`);
				}
			}
			const answer = (await terminal.question(
				"Select a session number, enter '/search text' to filter, or 'q' to cancel: ",
			)).trim();
			if (answer.toLowerCase() === 'q') {
				return undefined;
			}
			if (answer.startsWith('/')) {
				query = answer.slice(1).trim().toLowerCase();
				continue;
			}
			const index = Number(answer);
			if (Number.isSafeInteger(index) && index >= 1 && index <= Math.min(matches.length, 50)) {
				return matches[index - 1];
			}
			console.log('Enter a displayed session number, a search beginning with /, or q');
		}
	} finally {
		terminal.close();
	}
}

async function pickChat(
	result: ChatDiscoveryResult,
): Promise<{ readonly cancelled: boolean; readonly chat?: string }> {
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		let query = '';
		while (true) {
			const matches = result.items.filter(chat =>
				`${chat.title}\n${chat.resource}\n${chat.activity ?? ''}`.toLowerCase().includes(query.toLowerCase())
			);
			console.log(`d\tUse session default${result.defaultChat ? ` (${result.defaultChat})` : ''}`);
			for (const [index, chat] of matches.slice(0, 50).entries()) {
				console.log(`${index + 1}\t${chat.title}${chat.isDefault ? ' [default]' : ''}\t${formatSessionStatus(chat.status)}\t${chat.resource}`);
			}
			const answer = (await terminal.question(
				"Select a chat number, 'd' for session default, '/search text' to filter, or 'q' to cancel: ",
			)).trim();
			if (answer.toLowerCase() === 'q') {
				return { cancelled: true };
			}
			if (answer.toLowerCase() === 'd') {
				return { cancelled: false };
			}
			if (answer.startsWith('/')) {
				query = answer.slice(1).trim().toLowerCase();
				continue;
			}
			const index = Number(answer);
			if (Number.isSafeInteger(index) && index >= 1 && index <= Math.min(matches.length, 50)) {
				return { cancelled: false, chat: matches[index - 1].resource };
			}
			console.log('Enter a displayed chat number, d, a search beginning with /, or q');
		}
	} finally {
		terminal.close();
	}
}

function printSessionDiscovery(result: SessionDiscoveryResult): void {
	if (result.outcome === 'failed') {
		throw new Error(result.failures.map(failure =>
			`${failure.preferred ?? 'automatic host'}: ${failure.error}`
		).join('; ') || 'Session discovery failed');
	}
	for (const failure of result.failures) {
		console.error(`Warning: ${failure.preferred ?? 'automatic host'}: ${failure.error}`);
	}
	if (result.items.length === 0) {
		console.log('No existing sessions found');
	} else {
		console.table(result.items.map(item => ({
			title: item.title,
			resource: item.resource,
			provider: item.provider,
			status: formatSessionStatus(item.status),
			activity: item.activity ?? '',
			host: formatCatalogHost(item),
			workspace: formatWorkspace(item),
			modifiedAt: item.modifiedAt,
		})));
	}
	if (result.nextCursor) {
		console.log(`Next cursor: ${result.nextCursor}`);
	}
}

function sessionSearchText(session: SessionCatalogEntry): string {
	return [
		session.title,
		session.provider,
		session.resource,
		session.activity ?? '',
		session.host.preferred ?? '',
		session.host.actual,
		session.project?.displayName ?? '',
		...(session.workingDirectories ?? []),
	].join('\n').toLowerCase();
}

function isCurrentSession(session: SessionCatalogEntry, current: ChannelInstanceConfig): boolean {
	return session.resource === current.session
		&& (session.host.preferred ?? undefined) === current.host;
}

function formatCatalogHost(session: SessionCatalogEntry): string {
	return session.host.preferred && session.host.preferred !== session.host.actual
		? `${session.host.preferred} -> ${session.host.actual}`
		: session.host.preferred ?? session.host.actual;
}

function formatWorkspace(session: Pick<SessionCatalogEntry, 'project' | 'workingDirectories'>): string {
	return session.project?.displayName
		?? session.workingDirectories?.join(', ')
		?? '';
}

function formatSessionStatus(status: number): string {
	if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) {
		return 'input needed';
	}
	if ((status & SessionStatus.InProgress) === SessionStatus.InProgress) {
		return 'in progress';
	}
	if ((status & SessionStatus.Error) === SessionStatus.Error) {
		return 'error';
	}
	return 'idle';
}

function parsePositiveInteger(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
		throw new Error('Value must be an integer between 1 and 100');
	}
	return parsed;
}

async function addDiscoveredHostAlias(
	name: string,
	options: {
		host?: string;
		url?: string;
		socket?: string;
		tokenFile?: string;
		tokenQueryParameter?: string;
		withoutAuthentication?: boolean;
	},
): Promise<HostAliasInspection> {
	if (!options.host) {
		throw new Error('--host requires a selector');
	}
	if (options.url
		|| options.socket
		|| options.tokenFile
		|| options.tokenQueryParameter
		|| options.withoutAuthentication) {
		throw new Error('--host cannot be combined with explicit URL, socket, or authentication options');
	}
	return agentHosts.addDiscoveredAlias(name, options.host);
}

async function addExplicitHostAlias(
	name: string,
	options: {
		host?: string;
		url?: string;
		socket?: string;
		tokenFile?: string;
		tokenQueryParameter?: string;
		withoutAuthentication?: boolean;
	},
): Promise<HostAliasInspection> {
	if ((options.url ? 1 : 0) + (options.socket ? 1 : 0) !== 1) {
		throw new Error('Specify exactly one of --host, --url, or --socket');
	}
	if (Boolean(options.tokenFile) === Boolean(options.withoutAuthentication)) {
		throw new Error('Specify exactly one of --token-file or --without-authentication');
	}
	if (options.tokenFile && !options.tokenQueryParameter) {
		throw new Error('--token-file requires --token-query-parameter because AHP does not define authentication');
	}
	if (!options.tokenFile && options.tokenQueryParameter) {
		throw new Error('--token-query-parameter requires --token-file');
	}
	const authentication = options.tokenFile && options.tokenQueryParameter
		? {
			tokenFile: absolutePath(options.tokenFile),
			tokenQueryParameter: options.tokenQueryParameter,
		}
		: { withoutAuthentication: true as const };
	const target: WebSocketHostAliasConfig | SocketHostAliasConfig = options.url
		? {
			kind: 'websocket',
			url: options.url,
			...authentication,
		}
		: {
			kind: 'socket',
			path: absolutePath(options.socket as string),
			...authentication,
		};
	return agentHosts.addExplicitAlias(name, target);
}

function absolutePath(path: string): string {
	return isAbsolute(path) ? path : resolve(path);
}

function printHostAliasInspection(inspection: HostAliasInspection): void {
	console.table([hostAliasTableRow(inspection)]);
}

function hostAliasTableRow(inspection: HostAliasInspection): Record<string, unknown> {
	return {
		name: inspection.name,
		selector: inspection.selector,
		kind: inspection.kind,
		state: inspection.state,
		target: formatHostAliasLocation(inspection.target),
		endpoint: inspection.endpoint?.['endpoint'] ?? '',
		error: inspection.error ?? '',
	};
}

function formatHostAliasLocation(target: Record<string, unknown>): string {
	return String(target['registry'] ?? target['url'] ?? target['path'] ?? '');
}

function formatChannelHost(channel: ChannelDaemonStatus): string {
	const preferred = channel.definition.host ?? 'automatic';
	if (!channel.runtime) {
		return preferred;
	}
	return channel.definition.host && channel.definition.host !== channel.runtime.host
		? `${preferred} -> ${channel.runtime.host}`
		: channel.runtime.host;
}
