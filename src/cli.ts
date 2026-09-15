#!/usr/bin/env node

import { Command } from 'commander';
import { connectAgentHost, listSessions } from './ahp.js';
import { ChannelAccessStore, isAccessPluginName, type DirectMessagePolicy } from './channelAccess.js';
import { ChannelRuntime, createChannelRuntimeServices, validateChannelDefinition } from './channelRuntime.js';
import { ConfigStore, isValidChannelInstanceName, retargetChannelInstance, type AppConfig, type ChannelInstanceConfig } from './config.js';
import { ensureDaemonStarted, probeDaemon, requestDaemon, stopDaemon } from './daemonClient.js';
import { getDaemonPaths } from './daemonPaths.js';
import { DaemonProtocolError, type ChannelDaemonStatus, type DaemonStatus } from './daemonProtocol.js';
import { describeEndpoint, discoverLocalAgentHosts, selectAgentHost } from './endpoints.js';
import { removeInstanceState } from './instancePaths.js';
import { PluginManager, listInstalledPlugins } from './plugins.js';
import { readSecret } from './secretInput.js';
import { KeyringSecretStore, validateSecretKey } from './secrets.js';
import { VERSION } from './version.js';

const program = new Command();
const store = new ConfigStore();
const plugins = new PluginManager(store);
const secrets = new KeyringSecretStore();

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
			definition: {
				...definition,
				secretEnvironment: definition.secretEnvironment ? [...definition.secretEnvironment] : undefined,
			},
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
		const definition = await getOfflineChannel(name);
		const daemonStatus = await probeDaemon(store.home);
		if (daemonStatus) {
			await requestDaemon(store.home, { command: 'channel.delete', name });
		} else {
			await store.update(config => withoutChannel(config, name));
		}
		const secretErrors: Error[] = [];
		for (const key of definition.secretEnvironment ?? []) {
			try {
				await secrets.delete(name, key);
			} catch (error) {
				secretErrors.push(new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
			}
		}
		await removeInstanceState(store.home, name);
		if (secretErrors.length > 0) {
			throw new AggregateError(secretErrors, `Channel '${name}' was deleted but some credentials could not be removed`);
		}
		console.log(`Deleted channel ${name}`);
	});
const channelSecret = channel.command('secret').description('Manage channel secrets in the OS credential store');
channelSecret
	.command('set')
	.argument('<name>')
	.argument('<key>')
	.description('Read a secret from a hidden prompt or piped stdin')
	.action(async (name: string, key: string) => {
		validateSecretKey(key);
		await getOfflineChannel(name);
		let value = await readSecret(`${name}/${key}: `);
		const previous = await secrets.get(name, key);
		let configUpdated = false;
		try {
			await secrets.set(name, key, value);
			let updated: ChannelInstanceConfig | undefined;
			await store.update(config => {
				const current = config.channels[name];
				if (!current) {
					throw new Error(`Channel '${name}' no longer exists`);
				}
				updated = {
					...current,
					secretEnvironment: [...new Set([...(current.secretEnvironment ?? []), key])],
				};
				return withChannel(config, name, updated);
			});
			if (!updated) {
				throw new Error(`Failed to update channel '${name}'`);
			}
			configUpdated = true;
			await restartAfterSecretChange(name, updated);
			console.log(`Stored ${key} for channel ${name}`);
		} catch (error) {
			if (!configUpdated) {
				try {
					if (previous === undefined) {
						await secrets.delete(name, key);
					} else {
						await secrets.set(name, key, previous);
					}
				} catch (rollbackError) {
					throw new AggregateError([
						error,
						rollbackError,
					], `Failed to store ${key} and restore its previous credential`);
				}
			}
			throw error;
		} finally {
			value = '';
		}
	});
channelSecret
	.command('delete')
	.argument('<name>')
	.argument('<key>')
	.action(async (name: string, key: string) => {
		validateSecretKey(key);
		await getOfflineChannel(name);
		let updated: ChannelInstanceConfig | undefined;
		await store.update(config => {
			const current = config.channels[name];
			if (!current) {
				throw new Error(`Channel '${name}' no longer exists`);
			}
			updated = {
				...current,
				secretEnvironment: current.secretEnvironment?.filter(candidate => candidate !== key),
			};
			return withChannel(config, name, updated);
		});
		if (!updated) {
			throw new Error(`Failed to update channel '${name}'`);
		}
		const deleted = await secrets.delete(name, key);
		await restartAfterSecretChange(name, updated);
		console.log(deleted ? `Deleted ${key}` : `${key} was not stored`);
	});
channelSecret
	.command('list')
	.argument('<name>')
	.action(async (name: string) => {
		const definition = await getOfflineChannel(name);
		const entries = await Promise.all((definition.secretEnvironment ?? []).map(async key => ({
			key,
			source: process.env[key] ? 'environment' : await secrets.get(name, key) ? 'keyring' : 'missing',
		})));
		if (entries.length === 0) {
			console.log('No secrets configured');
		} else {
			console.table(entries);
		}
	});
const channelAccess = channel.command('access').description('Manage access for supported channel plugins');
channelAccess
	.command('status')
	.argument('<name>')
	.option('--json', 'Print machine-readable output')
	.action(async (name: string, options: { json?: boolean }) => {
		const status = await channelAccessStore(name).then(access => access.status());
		if (options.json) {
			console.log(JSON.stringify(status, undefined, 2));
		} else {
			console.log(`Policy: ${status.policy}`);
			console.log(`Allowed senders: ${status.allowedSenders.length}`);
			console.log(`Pending pairings: ${status.pendingPairings.length}`);
			console.log(`Groups: ${status.groupCount}`);
			if (status.pendingPairings.length > 0) {
				console.table(status.pendingPairings);
			}
		}
	});
channelAccess
	.command('pair')
	.argument('<name>')
	.argument('<code>')
	.action(async (name: string, code: string) => {
		const access = await channelAccessStore(name);
		const senderId = await withSuspendedChannel(name, () => access.pair(code));
		console.log(`Paired sender ${senderId}`);
	});
channelAccess
	.command('deny')
	.argument('<name>')
	.argument('<code>')
	.action(async (name: string, code: string) => {
		const access = await channelAccessStore(name);
		await withSuspendedChannel(name, () => access.deny(code));
		console.log(`Denied pairing ${code}`);
	});
channelAccess
	.command('policy')
	.argument('<name>')
	.argument('<policy>')
	.action(async (name: string, policy: string) => {
		if (!isDirectMessagePolicy(policy)) {
			throw new Error(`Invalid access policy '${policy}'`);
		}
		const access = await channelAccessStore(name);
		await withSuspendedChannel(name, () => access.setPolicy(policy));
		console.log(`Set policy to ${policy}`);
	});
channelAccess
	.command('allow')
	.argument('<name>')
	.argument('<sender-id>')
	.action(async (name: string, senderId: string) => {
		const access = await channelAccessStore(name);
		await withSuspendedChannel(name, () => access.allow(requireValue(senderId, 'sender ID')));
		console.log(`Allowed sender ${senderId}`);
	});
channelAccess
	.command('remove')
	.argument('<name>')
	.argument('<sender-id>')
	.action(async (name: string, senderId: string) => {
		const access = await channelAccessStore(name);
		await withSuspendedChannel(name, () => access.remove(requireValue(senderId, 'sender ID')));
		console.log(`Removed sender ${senderId}`);
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

async function restartAfterSecretChange(name: string, definition: ChannelInstanceConfig): Promise<void> {
	if (!definition.enabled || !await probeDaemon(store.home)) {
		return;
	}
	try {
		await requestDaemon(store.home, { command: 'channel.restart', name });
	} catch (error) {
		if (error instanceof DaemonProtocolError && error.code === 'CHANNEL_BUSY') {
			console.log('Channel is busy. Restart it when the current turn finishes to apply this change.');
			return;
		}
		throw error;
	}
}

async function channelAccessStore(name: string): Promise<ChannelAccessStore> {
	const definition = await getOfflineChannel(name);
	const plugin = await plugins.resolvePlugin(definition.plugin);
	if (!isAccessPluginName(plugin.name)) {
		throw new Error(`Access management is not available for plugin '${plugin.name}'`);
	}
	return new ChannelAccessStore(store.home, name, plugin.name);
}

function isDirectMessagePolicy(value: string): value is DirectMessagePolicy {
	return value === 'pairing' || value === 'allowlist' || value === 'disabled';
}

function requireValue(value: string, label: string): string {
	if (!value.trim()) {
		throw new Error(`${label} must not be empty`);
	}
	return value;
}

async function withSuspendedChannel<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const definition = await getOfflineChannel(name);
	const daemon = await probeDaemon(store.home);
	const suspend = definition.enabled && daemon !== undefined;
	if (suspend) {
		await requestDaemon(store.home, { command: 'channel.suspend', name });
	}
	let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
	try {
		outcome = { ok: true, value: await operation() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	let resumeError: unknown;
	if (suspend) {
		try {
			await requestDaemon(store.home, { command: 'channel.resume', name });
		} catch (error) {
			resumeError = error;
		}
	}
	if (!outcome.ok && resumeError) {
		throw new AggregateError([outcome.error, resumeError], `Access update failed and channel '${name}' could not resume`);
	}
	if (!outcome.ok) {
		throw outcome.error;
	}
	if (resumeError) {
		throw resumeError;
	}
	return outcome.value;
}
