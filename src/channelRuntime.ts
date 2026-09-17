import type { ChatState } from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';
import { AgentHostService } from './agentHosts.js';
import { createChannelClientId, resolveChat } from './ahp.js';
import { ChannelBridge, publishActiveClient } from './bridge.js';
import {
	DaemonChannelManagementService,
	type ChannelManagementService,
} from './channelManagement.js';
import {
	ChannelOperationError,
	recoveryGuidance,
	sanitizeErrorSummary,
	type ChannelFailureStage,
} from './channelHealth.js';
import type { ChannelInstanceConfig } from './config.js';
import type { LogWriter } from './daemonLog.js';
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
import {
	SessionCatalogService,
	SessionHostResolutionError,
	type ChannelBindingTarget,
	type ChatDiscoveryRequest,
	type ChatDiscoveryResult,
	type OpenedSession,
	type OpenSessionRequest,
	type ResolvedChannelBinding,
	type SessionDiscoveryRequest,
	type SessionDiscoveryResult,
	type SessionCatalogHostClient,
	type SessionCatalogHostConnection,
	type SessionCatalogSubscription,
} from './sessionCatalog.js';
import type { StatusReporter } from './status.js';

export interface ChannelRuntimeSnapshot {
	readonly name: string;
	readonly plugin: string;
	readonly session: string;
	readonly chat: string;
	readonly host: string;
	readonly clientId: string;
	readonly channelName: string;
	readonly startedAt: string;
	readonly bindingId: string;
	readonly busy: boolean;
	readonly mode: 'mcp' | 'customization-only';
}

export interface ChannelRuntimeServices {
	resolvePlugin(nameOrPath: string, installation?: string): Promise<ClaudePlugin>;
	readonly sessionCatalog: ChannelSessionCatalog;
	readonly management?: ChannelManagementService;
	createMcpChannel(config: StdioMcpServerConfig): McpChannelClient;
	createEventJournal?(name: string): ChannelEventJournal;
}

export interface ChannelSessionCatalog {
	discoverSessions(request: SessionDiscoveryRequest, signal?: AbortSignal): Promise<SessionDiscoveryResult>;
	discoverChats(request: ChatDiscoveryRequest, signal?: AbortSignal): Promise<ChatDiscoveryResult>;
	openSession(target: OpenSessionRequest, signal?: AbortSignal): Promise<OpenedSession>;
	validateBinding(target: ChannelBindingTarget, signal?: AbortSignal): Promise<ResolvedChannelBinding>;
}

export type ChannelSubscription = SessionCatalogSubscription;
export type ChannelHostClient = SessionCatalogHostClient;
export type ChannelHostConnection = SessionCatalogHostConnection;

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
	const sessionCatalog = new SessionCatalogService(agentHosts);
	return {
		resolvePlugin: (nameOrPath, installation) => plugins.resolvePlugin(nameOrPath, installation),
		sessionCatalog,
		...(home ? { management: new DaemonChannelManagementService(home) } : {}),
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
	private lifecycle: 'prepared' | 'active' | 'closed';

	private constructor(
		readonly name: string,
		readonly definition: ChannelInstanceConfig,
		private readonly connection: ChannelHostConnection,
		private readonly sessionSubscription: ChannelSubscription,
		private readonly bridge: ChannelBridge,
		private readonly mcpWhenStopped: Promise<void>,
		private readonly host: string,
		private readonly channelInfo: StartedMcpChannel,
		private readonly chat: string,
		private readonly startedAt: string,
		private readonly bindingId: string,
		lifecycle: 'prepared' | 'active',
		readonly startupFailure?: ChannelOperationError,
	) {
		this.lifecycle = lifecycle;
	}

	static start(
		name: string,
		definition: ChannelInstanceConfig,
		services: ChannelRuntimeServices,
		status?: StatusReporter,
	): Promise<ChannelRuntime> {
		return this.create(name, definition, services, 'active', status);
	}

	static prepare(
		name: string,
		definition: ChannelInstanceConfig,
		services: ChannelRuntimeServices,
		status?: StatusReporter,
	): Promise<ChannelRuntime> {
		return this.create(name, definition, services, 'prepared', status);
	}

	private static async create(
		name: string,
		definition: ChannelInstanceConfig,
		services: ChannelRuntimeServices,
		activation: 'prepared' | 'active',
		status?: StatusReporter,
	): Promise<ChannelRuntime> {
		const bindingId = randomUUID();
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
			let connected: OpenedSession;
			try {
				connected = await services.sessionCatalog.openSession({ ...definition, clientId });
			} catch (error) {
				throw operationError(sessionFailureStage(error), error);
			}
			connection = connected.connection;
			for (const warning of connected.warnings) {
				status?.report(warning);
			}
			try {
				connection.client.setResourceRequestHandlers(
					await createPluginResourceRequestHandlers(plugin.path),
				);
			} catch (error) {
				throw operationError('plugin-loading', error);
			}
			sessionSubscription = connected.subscription;
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
			const management = services.management?.bind({
				channel: name,
				bindingId,
				...(definition.host ? { preferredHost: definition.host } : {}),
				session: definition.session,
				chat,
			});

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
			if (activation === 'active') {
				publishActiveClient(connection.client, definition.session, {
					clientId: connection.clientId,
					displayName: `ahp-channels (${plugin.name})`,
					tools: [...(management?.tools ?? [])],
					customizations: [customization],
				});
			}
			mcp = services.createMcpChannel(server.config);
			let channelInfo: StartedMcpChannel;
			let startupFailure: ChannelOperationError | undefined;
			try {
				channelInfo = await mcp.start();
			} catch (error) {
				const errors = [toError('MCP channel startup', error)];
				await cleanup('MCP channel cleanup', () => mcp?.close(), errors);
				startupFailure = new ChannelOperationError(
					'mcp-startup',
					errors.map(candidate => candidate.message).join('; '),
					error instanceof ChannelOperationError ? error.guidance : recoveryGuidance('mcp-startup'),
					{ cause: new AggregateError(errors, 'MCP channel startup failed') },
				);
				status?.report(startupFailure.message);
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
				...(management ? { management } : {}),
				customizations: [customization],
				eventJournal: services.createEventJournal?.(name),
				...(status ? { status } : {}),
			});
			if (activation === 'prepared') {
				await bridge.startPaused();
			} else {
				await bridge.start();
			}
			return new ChannelRuntime(
				name,
				definition,
				connection,
				sessionSubscription,
				bridge,
				mcp.whenStopped,
				connected.host.actual,
				channelInfo,
				chat,
				new Date().toISOString(),
				bindingId,
				activation,
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
			host: this.host,
			clientId: this.connection.clientId,
			channelName: this.channelInfo.name,
			startedAt: this.startedAt,
			bindingId: this.bindingId,
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

	beginHandoff(id: string): void {
		this.bridge.beginHandoff(id);
	}

	waitForHandoffReady(id: string, signal: AbortSignal): Promise<void> {
		return this.bridge.waitForHandoffReady(id, signal);
	}

	cancelHandoff(id: string): Promise<void> {
		return this.bridge.cancelHandoff(id);
	}

	quiesceHandoff(id: string): Promise<boolean> {
		return this.bridge.quiesceHandoff(id);
	}

	async activate(): Promise<void> {
		if (this.lifecycle === 'active') {
			return;
		}
		if (this.lifecycle !== 'prepared') {
			throw new Error(`Cannot activate channel '${this.name}' in state '${this.lifecycle}'`);
		}
		await this.bridge.activate();
		this.lifecycle = 'active';
	}

	async close(): Promise<void> {
		this.closePromise ??= this.doClose();
		return this.closePromise;
	}

	private async doClose(): Promise<void> {
		this.lifecycle = 'closed';
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

function sessionFailureStage(error: unknown): ChannelFailureStage {
	if (!(error instanceof SessionHostResolutionError)) {
		return 'agent-host-connection';
	}
	switch (error.stage) {
		case 'discovery':
			return 'agent-host-discovery';
		case 'connection':
			return 'agent-host-connection';
		case 'session':
			return 'session-resolution';
	}
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
