import type { ChatState, ListSessionsResult, SessionState, StateAction, SubscribeResult } from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { connectAgentHost, createChannelClientId, resolveChat } from './ahp.js';
import { ChannelBridge } from './bridge.js';
import type { ChannelInstanceConfig } from './config.js';
import { discoverLocalAgentHosts, selectAgentHost, type AgentHostEndpoint } from './endpoints.js';
import { FileChannelEventJournal, type ChannelEventJournal } from './eventJournal.js';
import { getClaudeConfigDirectory } from './instancePaths.js';
import { McpChannelProcess, type McpChannelClient, type StartedMcpChannel } from './mcpChannel.js';
import { PluginManager, resolveServerConfig, type ClaudePlugin, type StdioMcpServerConfig } from './plugins.js';
import type { SecretStore } from './secrets.js';
import { validateSecretKey } from './secrets.js';

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
	createEventJournal?(name: string): ChannelEventJournal;
	resolveEnvironment?(name: string, definition: ChannelInstanceConfig): Promise<Readonly<Record<string, string>>>;
}

export interface ChannelSubscription extends AsyncIterable<SubscriptionEvent> {
	close(): Promise<void>;
}

export interface ChannelHostClient {
	dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
	request(method: 'listSessions', params: {
		readonly channel: 'ahp-root://';
		readonly cursor?: string;
		readonly limit?: number;
	}): Promise<ListSessionsResult>;
	subscribe(uri: string): Promise<{ result: SubscribeResult; subscription: ChannelSubscription }>;
	unsubscribe(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface ChannelHostConnection {
	readonly client: ChannelHostClient;
	readonly clientId: string;
}

export interface ChannelRuntimeServiceOptions {
	readonly home?: string;
	readonly secretStore?: SecretStore;
	readonly environment?: NodeJS.ProcessEnv;
}

export function createChannelRuntimeServices(
	plugins: PluginManager,
	options: ChannelRuntimeServiceOptions = {},
): ChannelRuntimeServices {
	const { home, secretStore } = options;
	return {
		resolvePlugin: nameOrPath => plugins.resolvePlugin(nameOrPath),
		discoverAgentHosts: () => discoverLocalAgentHosts(),
		connectAgentHost: async (endpoint, clientId) => connectAgentHost(endpoint, clientId),
		createMcpChannel: config => new McpChannelProcess(config),
		...(home ? { createEventJournal: (name: string) => new FileChannelEventJournal(home, name) } : {}),
		...(home && secretStore ? {
			resolveEnvironment: (name: string, definition: ChannelInstanceConfig) =>
				resolveChannelEnvironment(home, secretStore, name, definition, options.environment),
		} : {}),
	};
}

export async function validateChannelDefinition(plugins: PluginManager, definition: ChannelInstanceConfig): Promise<void> {
	const plugin = await plugins.resolvePlugin(definition.plugin);
	resolveServerConfig(plugin, definition.server);
	for (const key of definition.secretEnvironment ?? []) {
		validateSecretKey(key);
	}
}

export async function resolveChannelEnvironment(
	home: string,
	secretStore: SecretStore,
	name: string,
	definition: ChannelInstanceConfig,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<Record<string, string>>> {
	const result: Record<string, string> = {
		CLAUDE_CONFIG_DIR: getClaudeConfigDirectory(home, name),
	};
	for (const key of definition.secretEnvironment ?? []) {
		validateSecretKey(key);
		const value = environment[key] ?? await secretStore.get(name, key);
		if (!value) {
			throw new Error(`Secret '${key}' is not configured for channel '${name}'`);
		}
		result[key] = value;
	}
	return result;
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
			const runtimeEnvironment = await services.resolveEnvironment?.(name, definition);
			const runtimeServer: StdioMcpServerConfig = runtimeEnvironment
				? { ...server, env: { ...server.env, ...runtimeEnvironment } }
				: server;
			const clientId = definition.clientId ?? createChannelClientId(name, definition.session);
			const connected = await connectOwningHost(
				services,
				await services.discoverAgentHosts(),
				definition,
				clientId,
			);
			connection = connected.connection;
			sessionSubscription = connected.subscription;
			const endpoint = connected.endpoint;
			const chat = resolveChat(connected.state, definition.chat, definition.session);
			chatSubscription = await connection.client.subscribe(chat);
			if (!chatSubscription.result.snapshot) {
				throw new Error(`Agent Host returned no state snapshot for chat ${chat}`);
			}

			mcp = services.createMcpChannel(runtimeServer);
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
				eventJournal: services.createEventJournal?.(name),
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

	quiesce(): Promise<boolean> {
		return this.bridge.quiesce();
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

async function connectOwningHost(
	services: ChannelRuntimeServices,
	endpoints: readonly AgentHostEndpoint[],
	definition: ChannelInstanceConfig,
	clientId: string,
): Promise<{
	readonly endpoint: AgentHostEndpoint;
	readonly connection: ChannelHostConnection;
	readonly subscription: ChannelSubscription;
	readonly state: SessionState;
}> {
	const candidates = definition.host
		? [selectAgentHost(endpoints, definition.host)]
		: endpoints;
	if (candidates.length === 0) {
		throw new Error('No running local Agent Host endpoints were discovered');
	}
	const errors: Error[] = [];
	for (const endpoint of candidates) {
		let connection: ChannelHostConnection | undefined;
		let subscription: ChannelSubscription | undefined;
		try {
			connection = await services.connectAgentHost(endpoint, clientId);
			if (!definition.host && !await hostHasSession(connection.client, definition.session)) {
				throw new Error('Session is not present in this Agent Host catalog');
			}

			async function hostHasSession(client: ChannelHostClient, session: string): Promise<boolean> {
				const seenCursors = new Set<string>();
				let cursor: string | undefined;
				for (let page = 0; page < 100; page++) {
					const result = await client.request('listSessions', {
						channel: 'ahp-root://',
						limit: 100,
						...(cursor ? { cursor } : {}),
					});
					if (result.items.some(candidate => candidate.resource === session)) {
						return true;
					}
					if (!result.nextCursor) {
						return false;
					}
					if (seenCursors.has(result.nextCursor)) {
						throw new Error('Agent Host returned a repeated session cursor');
					}
					seenCursors.add(result.nextCursor);
					cursor = result.nextCursor;
				}
				throw new Error('Agent Host session catalog exceeded 100 pages');
			}
			const subscribed = await connection.client.subscribe(definition.session);
			subscription = subscribed.subscription;
			if (!subscribed.result.snapshot) {
				throw new Error('Agent Host returned no session state snapshot');
			}
			return {
				endpoint,
				connection,
				subscription,
				state: subscribed.result.snapshot.state as SessionState,
			};
		} catch (error) {
			errors.push(toError(endpoint.id, error));
			await cleanup(endpoint.id, () => subscription?.close(), errors);
			await cleanup(endpoint.id, () => connection?.client.shutdown(), errors);
		}
	}
	throw new AggregateError(errors, `No discovered Agent Host owns session ${definition.session}`);
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
