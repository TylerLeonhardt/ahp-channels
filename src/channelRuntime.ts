import type { ChatState, ListSessionsResult, ResourceReadParams, ResourceReadResult, SessionState, StateAction, SubscribeResult } from '@microsoft/agent-host-protocol';
import type { DispatchHandle, ResourceRequestHandlers, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import {
	AgentHostService,
	HostAliasResolutionError,
	isHostAliasSelector,
} from './agentHosts.js';
import { connectAgentHost, createChannelClientId, resolveChat } from './ahp.js';
import { ChannelBridge, publishActiveClient } from './bridge.js';
import {
	ChannelOperationError,
	recoveryGuidance,
	sanitizeErrorSummary,
	type ChannelFailureStage,
} from './channelHealth.js';
import type { ChannelInstanceConfig } from './config.js';
import type { LogWriter } from './daemonLog.js';
import type { AgentHostConnectionTarget, AgentHostEndpoint } from './endpoints.js';
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
	resolveAgentHost(selector: string): Promise<AgentHostConnectionTarget>;
	connectAgentHost(target: AgentHostConnectionTarget, clientId: string): Promise<ChannelHostConnection>;
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
	request(method: 'resourceRead', params: ResourceReadParams): Promise<ResourceReadResult>;
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
	agentHosts: AgentHostService,
	options: ChannelRuntimeServiceOptions = {},
): ChannelRuntimeServices {
	const { home, stderr } = options;
	return {
		resolvePlugin: (nameOrPath, installation) => plugins.resolvePlugin(nameOrPath, installation),
		discoverAgentHosts: () => agentHosts.discover(),
		resolveAgentHost: selector => agentHosts.resolve(selector),
		connectAgentHost: async (target, clientId) => connectAgentHost(target, clientId),
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
		private readonly hostTarget: AgentHostConnectionTarget,
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
			let candidates: readonly HostCandidate[];
			try {
				candidates = await resolveHostCandidates(services, definition, onStatus);
			} catch (error) {
				throw operationError('agent-host-discovery', error);
			}
			let connected: Awaited<ReturnType<typeof connectOwningHost>>;
			try {
				connected = await connectOwningHost(
					services,
					candidates,
					definition,
					clientId,
					onStatus,
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
			const hostTarget = connected.target;
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
				hostTarget,
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
			host: this.hostTarget.id,
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

interface HostCandidate {
	readonly target: AgentHostConnectionTarget;
	readonly fallback: boolean;
	readonly verifySessionCatalog: boolean;
}

async function resolveHostCandidates(
	services: ChannelRuntimeServices,
	definition: ChannelInstanceConfig,
	onStatus?: (message: string) => void,
): Promise<readonly HostCandidate[]> {
	if (!definition.host) {
		const endpoints = await services.discoverAgentHosts();
		if (endpoints.length === 0) {
			throw new Error('No running local Agent Host endpoints were discovered');
		}
		return endpoints.map(target => ({
			target,
			fallback: false,
			verifySessionCatalog: true,
		}));
	}

	if (!isHostAliasSelector(definition.host)) {
		return [{
			target: await services.resolveAgentHost(definition.host),
			fallback: false,
			verifySessionCatalog: false,
		}];
	}

	let preferred: AgentHostConnectionTarget | undefined;
	try {
		preferred = await services.resolveAgentHost(definition.host);
	} catch (error) {
		if (!(error instanceof HostAliasResolutionError) || error.code !== 'unavailable') {
			throw error;
		}
		onStatus?.(`${error.message}; searching other local Agent Hosts for the bound session`);
	}

	let fallbackEndpoints: readonly AgentHostEndpoint[] = [];
	try {
		fallbackEndpoints = await services.discoverAgentHosts();
	} catch (error) {
		if (!preferred) {
			throw error;
		}
		onStatus?.(`Local Agent Host fallback discovery failed: ${sanitizeErrorSummary(errorMessage(error))}`);
	}

	const candidates: HostCandidate[] = [];
	if (preferred) {
		candidates.push({
			target: preferred,
			fallback: false,
			verifySessionCatalog: false,
		});
	}
	for (const target of fallbackEndpoints) {
		if (target.id === preferred?.id) {
			continue;
		}
		candidates.push({
			target,
			fallback: true,
			verifySessionCatalog: true,
		});
	}
	if (candidates.length === 0) {
		throw new Error(`Host alias '${definition.host}' is unavailable and no fallback Agent Hosts were discovered`);
	}
	return candidates;
}

async function connectOwningHost(
	services: ChannelRuntimeServices,
	candidates: readonly HostCandidate[],
	definition: ChannelInstanceConfig,
	clientId: string,
	onStatus?: (message: string) => void,
): Promise<{
	readonly target: AgentHostConnectionTarget;
	readonly connection: ChannelHostConnection;
	readonly subscription: ChannelSubscription;
	readonly state: SessionState;
}> {
	if (candidates.length === 0) {
		throw new Error('No Agent Host connection candidates were resolved');
	}
	const errors: Error[] = [];
	let failureStage: ChannelFailureStage = 'agent-host-connection';
	for (const candidate of candidates) {
		const { target } = candidate;
		let connection: ChannelHostConnection | undefined;
		let subscription: ChannelSubscription | undefined;
		try {
			try {
				connection = await services.connectAgentHost(target, clientId);
			} catch (error) {
				throw operationError('agent-host-connection', error);
			}
			try {
				if (candidate.verifySessionCatalog && !await hostHasSession(connection.client, definition.session)) {
					throw new Error('Session is not present in this Agent Host catalog');
				}
				const subscribed = await connection.client.subscribe(definition.session);
				subscription = subscribed.subscription;
				if (!subscribed.result.snapshot) {
					throw new Error('Agent Host returned no session state snapshot');
				}
				if (candidate.fallback && definition.host) {
					onStatus?.(`Host alias '${definition.host}' did not connect; using local fallback ${target.id} for ${definition.session}`);
				}
				return {
					target,
					connection,
					subscription,
					state: subscribed.result.snapshot.state as SessionState,
				};
			} catch (error) {
				throw operationError('session-resolution', error);
			}
		} catch (error) {
			if (error instanceof ChannelOperationError && error.stage === 'session-resolution') {
				failureStage = 'session-resolution';
			}
			errors.push(toError(target.id, error));
			await cleanup(target.id, () => subscription?.close(), errors);
			await cleanup(target.id, () => connection?.client.shutdown(), errors);
		}
	}
	throw new ChannelOperationError(
		failureStage,
		`No Agent Host candidate owns session ${definition.session}: ${errors.map(error => error.message).join('; ')}`,
		recoveryGuidance(failureStage),
		{ cause: new AggregateError(errors) },
	);
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
	return new Error(`${label}: ${sanitizeErrorSummary(errorMessage(error))}`, { cause: error });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
