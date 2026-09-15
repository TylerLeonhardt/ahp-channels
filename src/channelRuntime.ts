import type { ChatState, SessionState, StateAction, SubscribeResult } from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { connectAgentHost, createChannelClientId, resolveChat } from './ahp.js';
import { ChannelBridge } from './bridge.js';
import type { ChannelInstanceConfig } from './config.js';
import { discoverLocalAgentHosts, selectAgentHost, type AgentHostEndpoint } from './endpoints.js';
import { McpChannelProcess, type McpChannelClient, type StartedMcpChannel } from './mcpChannel.js';
import { PluginManager, resolveServerConfig, type ClaudePlugin, type StdioMcpServerConfig } from './plugins.js';

export interface ChannelRuntimeSnapshot {
	readonly name: string;
	readonly plugin: string;
	readonly session: string;
	readonly chat: string;
	readonly host: string;
	readonly clientId: string;
	readonly channelName: string;
	readonly startedAt: string;
	readonly busy: boolean;
}

export interface ChannelRuntimeServices {
	resolvePlugin(nameOrPath: string): Promise<ClaudePlugin>;
	discoverAgentHosts(): Promise<readonly AgentHostEndpoint[]>;
	connectAgentHost(endpoint: AgentHostEndpoint, clientId: string): Promise<ChannelHostConnection>;
	createMcpChannel(config: StdioMcpServerConfig): McpChannelClient;
}

export interface ChannelSubscription extends AsyncIterable<SubscriptionEvent> {
	close(): Promise<void>;
}

export interface ChannelHostClient {
	dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
	subscribe(uri: string): Promise<{ result: SubscribeResult; subscription: ChannelSubscription }>;
	unsubscribe(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface ChannelHostConnection {
	readonly client: ChannelHostClient;
	readonly clientId: string;
}

export function createChannelRuntimeServices(plugins: PluginManager): ChannelRuntimeServices {
	return {
		resolvePlugin: nameOrPath => plugins.resolvePlugin(nameOrPath),
		discoverAgentHosts: () => discoverLocalAgentHosts(),
		connectAgentHost: async (endpoint, clientId) => connectAgentHost(endpoint, clientId),
		createMcpChannel: config => new McpChannelProcess(config),
	};
}

export async function validateChannelDefinition(plugins: PluginManager, definition: ChannelInstanceConfig): Promise<void> {
	const plugin = await plugins.resolvePlugin(definition.plugin);
	resolveServerConfig(plugin, definition.server);
}

export class ChannelRuntime {
	private closePromise: Promise<void> | undefined;

	private constructor(
		readonly name: string,
		readonly definition: ChannelInstanceConfig,
		private readonly connection: ChannelHostConnection,
		private readonly sessionSubscription: ChannelSubscription,
		private readonly bridge: ChannelBridge,
		private readonly mcpWhenStopped: Promise<void>,
		private readonly endpoint: AgentHostEndpoint,
		private readonly channelInfo: StartedMcpChannel,
		private readonly chat: string,
		private readonly startedAt: string,
	) { }

	static async start(
		name: string,
		definition: ChannelInstanceConfig,
		services: ChannelRuntimeServices,
		onStatus?: (message: string) => void,
	): Promise<ChannelRuntime> {
		let connection: ChannelHostConnection | undefined;
		let sessionSubscription: ChannelSubscription | undefined;
		let chatSubscription: Awaited<ReturnType<ChannelHostClient['subscribe']>> | undefined;
		let mcp: McpChannelClient | undefined;
		let bridge: ChannelBridge | undefined;
		try {
			const plugin = await services.resolvePlugin(definition.plugin);
			const server = resolveServerConfig(plugin, definition.server);
			const endpoint = selectAgentHost(await services.discoverAgentHosts(), definition.host);
			const clientId = definition.clientId ?? createChannelClientId(name, definition.session);
			connection = await services.connectAgentHost(endpoint, clientId);
			const subscribedSession = await connection.client.subscribe(definition.session);
			sessionSubscription = subscribedSession.subscription;
			if (!subscribedSession.result.snapshot) {
				throw new Error(`Agent Host returned no state snapshot for session ${definition.session}`);
			}
			const chat = resolveChat(subscribedSession.result.snapshot.state as SessionState, definition.chat, definition.session);
			chatSubscription = await connection.client.subscribe(chat);
			if (!chatSubscription.result.snapshot) {
				throw new Error(`Agent Host returned no state snapshot for chat ${chat}`);
			}

			mcp = services.createMcpChannel(server);
			const channelInfo = await mcp.start();
			bridge = new ChannelBridge({
				client: connection.client,
				clientId: connection.clientId,
				session: definition.session,
				chat,
				chatState: chatSubscription.result.snapshot.state as ChatState,
				chatSubscription: chatSubscription.subscription,
				channel: mcp,
				channelInfo,
				onStatus,
			});
			await bridge.start();
			return new ChannelRuntime(
				name,
				definition,
				connection,
				sessionSubscription,
				bridge,
				mcp.whenStopped,
				endpoint,
				channelInfo,
				chat,
				new Date().toISOString(),
			);
		} catch (error) {
			const cleanupErrors: Error[] = [];
			await cleanup('bridge', () => bridge?.close(), cleanupErrors);
			if (!bridge) {
				await cleanup('MCP channel', () => mcp?.close(), cleanupErrors);
				await cleanup('chat subscription', () => chatSubscription?.subscription.close(), cleanupErrors);
			}
			await cleanup('session subscription', () => sessionSubscription?.close(), cleanupErrors);
			await cleanup('AHP client', () => connection?.client.shutdown(), cleanupErrors);
			if (cleanupErrors.length > 0) {
				throw new AggregateError([toError('channel startup', error), ...cleanupErrors], `Failed to start channel '${name}'`);
			}
			throw error;
		}
	}

	get snapshot(): ChannelRuntimeSnapshot {
		return {
			name: this.name,
			plugin: this.definition.plugin,
			session: this.definition.session,
			chat: this.chat,
			host: this.endpoint.id,
			clientId: this.connection.clientId,
			channelName: this.channelInfo.name,
			startedAt: this.startedAt,
			busy: this.bridge.busy,
		};
	}

	get whenStopped(): Promise<void> {
		return Promise.race([this.bridge.whenStopped, this.mcpWhenStopped]);
	}

	tryQuiesce(): boolean {
		return this.bridge.tryQuiesce();
	}

	async close(): Promise<void> {
		this.closePromise ??= this.doClose();
		return this.closePromise;
	}

	private async doClose(): Promise<void> {
		const errors: Error[] = [];
		await cleanup('bridge', () => this.bridge.close(), errors);
		await cleanup('session subscription', () => this.sessionSubscription.close(), errors);
		await cleanup('AHP client', () => this.connection.client.shutdown(), errors);
		if (errors.length > 0) {
			throw new AggregateError(errors, `Failed to stop channel '${this.name}'`);
		}
	}
}

async function cleanup(label: string, operation: () => Promise<unknown> | undefined, errors: Error[]): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(toError(label, error));
	}
}

function toError(label: string, error: unknown): Error {
	return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
