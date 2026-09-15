#!/usr/bin/env node

import { Command } from 'commander';
import { connectAgentHost, listSessions } from './ahp.js';
import { ChannelRuntime, createChannelRuntimeServices, validateChannelDefinition } from './channelRuntime.js';
import { ConfigStore, isValidChannelInstanceName, retargetChannelInstance, type AppConfig, type ChannelInstanceConfig } from './config.js';
import { ensureDaemonStarted, probeDaemon, requestDaemon, stopDaemon } from './daemonClient.js';
import { getDaemonPaths } from './daemonPaths.js';
import { type ChannelDaemonStatus, type DaemonStatus } from './daemonProtocol.js';
import { describeEndpoint, discoverLocalAgentHosts, selectAgentHost } from './endpoints.js';
import { removeInstanceState } from './instancePaths.js';
import { PluginManager, listInstalledPlugins } from './plugins.js';
import { VERSION } from './version.js';

const program = new Command();
const store = new ConfigStore();
const plugins = new PluginManager(store);

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

const plugin = program.command('plugin').description('Install and inspect Claude channel plugins');
plugin
	.command('install')
	.argument('<plugin>')
	.action(async (spec: string) => {
		const installed = await plugins.install(spec);
		console.log(`Installed ${installed.name}${installed.version ? ` ${installed.version}` : ''}`);
		console.log(installed.path);
	});
plugin
	.command('list')
	.action(async () => {
		for (const [name, installed] of listInstalledPlugins(await store.read())) {
			console.log(`${name}\t${installed.marketplace}\t${installed.path}`);
		}
	});
plugin
	.command('inspect')
	.argument('<plugin>')
	.action(async (nameOrPath: string) => {
		const inspected = await plugins.resolvePlugin(nameOrPath);
		console.log(JSON.stringify({
			name: inspected.name,
			version: inspected.version,
			path: inspected.path,
			servers: Object.keys(inspected.servers),
		}, undefined, 2));
	});

const host = program.command('host').description('Discover Agent Host connections');
host
	.command('discover')
	.option('--json', 'Print machine-readable output')
	.action(async (options: { json?: boolean }) => {
		const endpoints = await discoverLocalAgentHosts();
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

const session = program.command('session').description('Inspect AHP sessions');
session
	.command('list')
	.option('--host <selector>', 'Discovered host index or ID prefix')
	.action(async (options: { host?: string }) => {
		const endpoint = selectAgentHost(await discoverLocalAgentHosts(), options.host);
		const connection = await connectAgentHost(endpoint);
		try {
			const sessions = await listSessions(connection.client);
			console.table(sessions.map(item => ({
				title: item.title,
				resource: item.resource,
				provider: item.provider,
				status: item.status,
				modifiedAt: item.modifiedAt,
			})));
		} finally {
			await connection.client.shutdown();
		}
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
	.option('--host <selector>', 'Discovered host index or ID prefix')
	.option('--client-id <id>', 'Override the stable AHP client ID')
	.option('--start', 'Start the channel immediately')
	.action(async (name: string, options: {
		plugin: string;
		session: string;
		chat?: string;
		server?: string;
		host?: string;
		clientId?: string;
		start?: boolean;
	}) => {
		assertChannelName(name);
		const definition = channelDefinition(options);
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
	.option('--host <selector>', 'Discovered host index or ID prefix')
	.option('--client-id <id>', 'Override the stable AHP client ID')
	.action(async (pluginName: string, options: { session: string; chat?: string; server?: string; host?: string; clientId?: string }) => {
		const runtime = await ChannelRuntime.start(pluginName, {
			plugin: pluginName,
			session: options.session,
			enabled: true,
			...(options.chat ? { chat: options.chat } : {}),
			...(options.server ? { server: options.server } : {}),
			...(options.host ? { host: options.host } : {}),
			...(options.clientId ? { clientId: options.clientId } : {}),
		}, createChannelRuntimeServices(plugins), message => console.log(`[channel] ${message}`));
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

function channelDefinition(options: {
	plugin: string;
	session: string;
	chat?: string;
	server?: string;
	host?: string;
	clientId?: string;
}): ChannelInstanceConfig {
	return {
		plugin: options.plugin,
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
		session: channel.definition.session,
		chat: channel.runtime?.chat ?? channel.definition.chat ?? 'default',
		error: channel.error ?? '',
	})));
}

function printChannelStatus(channel: ChannelDaemonStatus): void {
	console.log(`${channel.name}: ${channel.state} → ${channel.definition.session}${channel.runtime ? ` (${channel.runtime.chat})` : ''}`);
	if (channel.error) {
		console.log(`Error: ${channel.error}`);
	}
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
