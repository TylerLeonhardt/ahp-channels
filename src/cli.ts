#!/usr/bin/env node

import type { ChatState } from '@microsoft/agent-host-protocol';
import { Command } from 'commander';
import { connectAgentHost, listSessions, resolveChat, subscribeSession } from './ahp.js';
import { ChannelBridge } from './bridge.js';
import { ConfigStore } from './config.js';
import { describeEndpoint, discoverLocalAgentHosts, selectAgentHost } from './endpoints.js';
import { McpChannelProcess } from './mcpChannel.js';
import { PluginManager, listInstalledPlugins, resolveServerConfig } from './plugins.js';

const program = new Command();
const store = new ConfigStore();
const plugins = new PluginManager(store);

program
	.name('ahp-channels')
	.description('Run Claude Code channel plugins against Agent Host Protocol servers')
	.version('0.1.0');

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

const channel = program.command('channel').description('Run channel compatibility bridges');
channel
	.command('run')
	.argument('<plugin>')
	.requiredOption('--session <uri>', 'AHP session URI')
	.option('--chat <uri>', 'AHP chat URI; defaults to the session default chat')
	.option('--server <name>', 'MCP server name when the plugin declares more than one')
	.option('--host <selector>', 'Discovered host index or ID prefix')
	.action(async (pluginName: string, options: { session: string; chat?: string; server?: string; host?: string }) => {
		const installed = await plugins.resolvePlugin(pluginName);
		const server = resolveServerConfig(installed, options.server);
		const endpoint = selectAgentHost(await discoverLocalAgentHosts(), options.host);
		const connection = await connectAgentHost(endpoint);
		let subscribedSession: Awaited<ReturnType<typeof subscribeSession>> | undefined;
		let chatSubscription: Awaited<ReturnType<typeof connection.client.subscribe>> | undefined;
		let mcp: McpChannelProcess | undefined;
		let bridge: ChannelBridge | undefined;
		let operationError: unknown;
		try {
			subscribedSession = await subscribeSession(connection.client, options.session);
			const chat = resolveChat(subscribedSession.state, options.chat, options.session);
			chatSubscription = await connection.client.subscribe(chat);
			if (!chatSubscription.result.snapshot) {
				throw new Error(`Agent Host returned no state snapshot for chat ${chat}`);
			}

			mcp = new McpChannelProcess(server);
			const channelInfo = await mcp.start();
			bridge = new ChannelBridge({
				client: connection.client,
				clientId: connection.clientId,
				session: options.session,
				chat,
				chatState: chatSubscription.result.snapshot.state as ChatState,
				chatSubscription: chatSubscription.subscription,
				channel: mcp,
				channelInfo,
				onStatus: message => console.log(`[channel] ${message}`),
			});
			await bridge.start();
			await waitForShutdownSignal();
		} catch (error) {
			operationError = error;
		}

		const cleanupErrors: Error[] = [];
		await cleanup('bridge', () => bridge?.close(), cleanupErrors);
		if (!bridge) {
			await cleanup('MCP channel', () => mcp?.close(), cleanupErrors);
			await cleanup('chat subscription', () => chatSubscription?.subscription.close(), cleanupErrors);
		}
		await cleanup('session subscription', () => subscribedSession?.subscription.close(), cleanupErrors);
		await cleanup('AHP client', () => connection.client.shutdown(), cleanupErrors);

		if (operationError !== undefined) {
			for (const error of cleanupErrors) {
				console.error(`Cleanup failed: ${error.message}`);
			}
			throw operationError;
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'Channel stopped but cleanup failed');
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

async function cleanup(label: string, operation: () => Promise<unknown> | undefined, errors: Error[]): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
	}
}
