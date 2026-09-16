import type { ChatState, ListSessionsResult, SessionState, StateAction, SubscribeResult } from '@microsoft/agent-host-protocol';
import type { DispatchHandle, ResourceRequestHandlers, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { connectAgentHost, createChannelClientId, resolveChat } from './ahp.js';
import { ChannelBridge, publishActiveClient } from './bridge.js';
import {
	ChannelOperationError,
	recoveryGuidance,
	type ChannelFailureStage,
} from './channelHealth.js';
import type { ChannelInstanceConfig } from './config.js';
import type { LogWriter } from './daemonLog.js';
import { discoverLocalAgentHosts, selectAgentHost, type AgentHostEndpoint } from './endpoints.js';
import { FileChannelEventJournal, type ChannelEventJournal } from './eventJournal.js';
import { McpChannelProcess, type McpChannelClient, type StartedMcpChannel } from './mcpChannel.js';
import { createPluginResourceRequestHandlers } from './pluginResources.js';
import {
	createPluginCustomization,
	PluginManager,
	PluginIntegrityError,
	resolvePluginServer,
	resolveServerConfig,
	type ClaudePlugin,
	type StdioMcpServerConfig,
} from './plugins.js';

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
	readonly mode: 'mcp' | 'customization-only';
}

export interface ChannelRuntimeServices {
	resolvePlugin(nameOrPath: string, installation?: string): Promise<ClaudePlugin>;
	discoverAgentHosts(): Promise<readonly AgentHostEndpoint[]>;
	connectAgentHost(endpoint: AgentHostEndpoint, clientId: string): Promise<ChannelHostConnection>;
	createMcpChannel(config: StdioMcpServerConfig): McpChannelClient;
	createEventJournal?(name: string): ChannelEventJournal;
}

export interface ChannelSubscription extends AsyncIterable<SubscriptionEvent> {
	close(): Promise<void>;
}

export interface ChannelHostClient {
	dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
	setResourceRequestHandlers(handlers: ResourceRequestHandlers | null): void;
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
	readonly stderr?: LogWriter;
}

export function createChannelRuntimeServices(
	plugins: PluginManager,
	options: ChannelRuntimeServiceOptions = {},
): ChannelRuntimeServices {
	const { home, stderr } = options;
	return {
		resolvePlugin: (nameOrPath, installation) => plugins.resolvePlugin(nameOrPath, installation),
		discoverAgentHosts: () => discoverLocalAgentHosts(),
		connectAgentHost: async (endpoint, clientId) => connectAgentHost(endpoint, clientId),
		createMcpChannel: config => new McpChannelProcess(config, stderr),
		...(home ? { createEventJournal: (name: string) => new FileChannelEventJournal(home, name) } : {}),
	};
}

export async function validateChannelDefinition(plugins: PluginManager, definition: ChannelInstanceConfig): Promise<void> {
	const plugin = await plugins.resolvePlugin(definition.plugin, definition.installation);
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
		readonly startupFailure?: ChannelOperationError,
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
			let plugin: ClaudePlugin;
			try {
				plugin = await services.resolvePlugin(definition.plugin, definition.installation);
			} catch (error) {
				throw operationError(error instanceof PluginIntegrityError ? 'plugin-integrity' : 'plugin-loading', error);
			}
			let server: ReturnType<typeof resolvePluginServer>;
			try {
				server = resolvePluginServer(plugin, definition.server);
			} catch (error) {
				throw operationError('plugin-loading', error);
			}
			const clientId = definition.clientId ?? createChannelClientId(name, definition.session);
			let endpoints: readonly AgentHostEndpoint[];
			try {
				endpoints = await services.discoverAgentHosts();
			} catch (error) {
				throw operationError('agent-host-discovery', error);
			}
			if (endpoints.length === 0) {
				throw operationError('agent-host-discovery', new Error('No running local Agent Host endpoints were discovered'));
			}
			let connected: Awaited<ReturnType<typeof connectOwningHost>>;
			try {
				connected = await connectOwningHost(
					services,
					endpoints,
					definition,
					clientId,
				);
			} catch (error) {
				throw operationError('agent-host-connection', error);
			}
			connection = connected.connection;
			try {
				connection.client.setResourceRequestHandlers(
					await createPluginResourceRequestHandlers(plugin.path),
				);
			} catch (error) {
				throw operationError('plugin-loading', error);
			}
			sessionSubscription = connected.subscription;
			const endpoint = connected.endpoint;
			let chat: string;
			try {
				chat = resolveChat(connected.state, definition.chat, definition.session);
				chatSubscription = await connection.client.subscribe(chat);
				if (!chatSubscription.result.snapshot) {
					throw new Error(`Agent Host returned no state snapshot for chat ${chat}`);
				}
			} catch (error) {
				throw operationError('session-resolution', error);
			}

			let customization: ReturnType<typeof createPluginCustomization>;
			try {
				customization = createPluginCustomization(
					plugin,
					connection.clientId,
					server.name,
					definition.installation,
				);
			} catch (error) {
				throw operationError('plugin-loading', error);
			}
			publishActiveClient(connection.client, definition.session, {
				clientId: connection.clientId,
				displayName: `ahp-channels (${plugin.name})`,
				tools: [],
				customizations: [customization],
			});
			mcp = services.createMcpChannel(server.config);
			let channelInfo: StartedMcpChannel;
			let startupFailure: ChannelOperationError | undefined;
			try {
				channelInfo = await mcp.start();
			} catch (error) {
				const errors = [toError('MCP channel startup', error)];
				await cleanup('MCP channel cleanup', () => mcp?.close(), errors);
				startupFailure = operationError(
					'mcp-startup',
					new AggregateError(errors, errors.map(candidate => candidate.message).join('; ')),
				);
				onStatus?.(startupFailure.message);
				mcp = new CustomizationOnlyChannel(plugin.name);
				channelInfo = await mcp.start();
			}
			bridge = new ChannelBridge({
				client: connection.client,
				clientId: connection.clientId,
				session: definition.session,
				chat,
				chatState: chatSubscription.result.snapshot.state as ChatState,
				chatSubscription: chatSubscription.subscription,
				channel: mcp,
				channelInfo,
				customizations: [customization],
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
				startupFailure,
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
				if (error instanceof ChannelOperationError) {
					throw new ChannelOperationError(
						error.stage,
						error.message,
						error.guidance,
						{ cause: new AggregateError([error, ...cleanupErrors], `Failed to start channel '${name}'`) },
					);
				}
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
			mode: this.startupFailure ? 'customization-only' : 'mcp',
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

class CustomizationOnlyChannel implements McpChannelClient {
	private resolveStopped!: () => void;
	readonly whenStopped = new Promise<void>(resolve => {
		this.resolveStopped = resolve;
	});

	constructor(private readonly name: string) { }

	async start(): Promise<StartedMcpChannel> {
		return { name: this.name, tools: [] };
	}

	async setChannelHandler(): Promise<void> { }

	async callTool(): Promise<never> {
		throw new Error('Customization-only channels do not provide tools');
	}

	async close(): Promise<void> {
		this.resolveStopped();
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
	let failureStage: ChannelFailureStage = 'agent-host-connection';
	for (const endpoint of candidates) {
		let connection: ChannelHostConnection | undefined;
		let subscription: ChannelSubscription | undefined;
		try {
			try {
				connection = await services.connectAgentHost(endpoint, clientId);
			} catch (error) {
				throw operationError('agent-host-connection', error);
			}
			try {
				if (!definition.host && !await hostHasSession(connection.client, definition.session)) {
					throw new Error('Session is not present in this Agent Host catalog');
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
				throw operationError('session-resolution', error);
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
		} catch (error) {
			if (error instanceof ChannelOperationError && error.stage === 'session-resolution') {
				failureStage = 'session-resolution';
			}
			errors.push(toError(endpoint.id, error));
			await cleanup(endpoint.id, () => subscription?.close(), errors);
			await cleanup(endpoint.id, () => connection?.client.shutdown(), errors);
		}
	}
	throw new ChannelOperationError(
		failureStage,
		`No discovered Agent Host owns session ${definition.session}: ${errors.map(error => error.message).join('; ')}`,
		recoveryGuidance(failureStage),
		{ cause: new AggregateError(errors) },
	);
}

function operationError(stage: ChannelFailureStage, error: unknown): ChannelOperationError {
	if (error instanceof ChannelOperationError) {
		return error;
	}
	return new ChannelOperationError(
		stage,
		error instanceof Error ? error.message : String(error),
		recoveryGuidance(stage),
		{ cause: error },
	);
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
