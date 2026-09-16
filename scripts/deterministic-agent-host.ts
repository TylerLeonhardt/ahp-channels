import {
	ActionType,
	ConfirmationOptionKind,
	ContentEncoding,
	CustomizationLoadStatus,
	CustomizationType,
	McpServerStatus,
	SessionLifecycle,
	SessionStatus,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	ToolCallStatus,
	ResponsePartKind,
	chatReducer,
	sessionReducer,
	type ActionEnvelope,
	type ActionOrigin,
	type ChatAction,
	type ChatState,
	type ClientPluginCustomization,
	type InitializeResult,
	type PluginCustomization,
	type RootState,
	type SessionAction,
	type SessionState,
	type SessionSummary,
	type Snapshot,
	type StateAction,
} from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const PROTOCOL_VERSION = '0.9.0';
const PROVIDER = 'deterministic-e2e';
const MODEL = 'deterministic-e2e';
const EXPECTED_REPLY = /\bFAKECHAT_(?:FIRST|RESTART)_[0-9a-f-]+\b/i;
const PERMISSION_MARKER = /\bFAKECHAT_PERMISSION_[A-Z]+_[0-9a-f-]+\b/i;

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface HostPeer {
	readonly socket: WebSocket;
	readonly subscriptions: Set<string>;
	readonly pendingRequests: Map<number, PendingRequest>;
	clientId?: string;
	nextRequestId: number;
}

interface HostedSession {
	readonly resource: string;
	state: SessionState;
	chatState: ChatState;
	readonly createdAt: string;
	readonly pendingToolCalls: Map<string, {
		readonly turnId: string;
		readonly permission?: { readonly marker: string; readonly path: string };
	}>;
}

interface JsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

export class DeterministicAgentHost {
	private readonly instanceId = randomUUID();
	private readonly connectionToken = randomUUID();
	private readonly server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
	});
	private readonly peers = new Set<HostPeer>();
	private readonly sessions = new Map<string, HostedSession>();
	private readonly customizationLoads = new Map<string, Promise<void>>();
	private serverSeq = 0;
	private registryFile: string | undefined;

	constructor(private readonly registryDirectory: string) {
		this.server.on('connection', (socket, request) => {
			const token = new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams.get('tkn');
			if (token !== this.connectionToken) {
				socket.close(1008, 'invalid connection token');
				return;
			}
			this.accept(socket);
		});
	}

	async start(): Promise<string> {
		await waitForListening(this.server);
		const address = this.server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Deterministic Agent Host did not bind a TCP port');
		}
		await mkdir(this.registryDirectory, { recursive: true });
		this.registryFile = join(this.registryDirectory, `${this.instanceId}.json`);
		await writeFile(this.registryFile, `${JSON.stringify({
			schemaVersion: 2,
			type: 'standalone',
			pid: process.pid,
			instanceId: this.instanceId,
			protocolVersion: PROTOCOL_VERSION,
			connectionToken: this.connectionToken,
			endpoint: {
				type: 'tcp',
				host: '127.0.0.1',
				port: address.port,
			},
		}, undefined, 2)}\n`);
		return `standalone:${process.pid}:${this.instanceId}`;
	}

	async close(): Promise<void> {
		for (const peer of this.peers) {
			peer.socket.close();
			this.rejectPendingRequests(peer, new Error('Deterministic Agent Host is closing'));
		}
		this.peers.clear();
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
		});
		if (this.registryFile) {
			await rm(this.registryFile, { force: true });
		}
	}

	private accept(socket: WebSocket): void {
		const peer: HostPeer = {
			socket,
			subscriptions: new Set(),
			pendingRequests: new Map(),
			nextRequestId: 1,
		};
		this.peers.add(peer);
		socket.on('message', data => {
			void this.handleMessage(peer, data).catch(error => {
				socket.close(1011, error instanceof Error ? error.message : String(error));
			});
		});
		socket.once('close', () => this.removePeer(peer));
		socket.once('error', error => {
			this.rejectPendingRequests(peer, error);
		});
	}

	private async handleMessage(peer: HostPeer, raw: RawData): Promise<void> {
		const message = parseJsonRpcMessage(raw);
		const id = message['id'];
		const method = message['method'];
		if (typeof id === 'number' && ('result' in message || 'error' in message)) {
			this.handleResponse(peer, message);
			return;
		}
		if (typeof id === 'number' && typeof method === 'string') {
			await this.handleRequest(peer, {
				jsonrpc: '2.0',
				id,
				method,
				params: message['params'],
			});
			return;
		}
		await this.handleNotification(peer, message);
	}

	private handleResponse(peer: HostPeer, message: Record<string, unknown>): void {
		const id = message['id'];
		if (typeof id !== 'number') {
			return;
		}
		const pending = peer.pendingRequests.get(id);
		if (!pending) {
			return;
		}
		peer.pendingRequests.delete(id);
		if (isRecord(message['error'])) {
			pending.reject(new Error(
				typeof message['error']['message'] === 'string'
					? message['error']['message']
					: 'Reverse Agent Host request failed',
			));
		} else {
			pending.resolve(message['result']);
		}
	}

	private async handleRequest(peer: HostPeer, request: JsonRpcRequest): Promise<void> {
		try {
			const result = await this.executeRequest(peer, request.method, request.params);
			this.send(peer, {
				jsonrpc: '2.0',
				id: request.id,
				result,
			});
		} catch (error) {
			this.send(peer, {
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: -32603,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async executeRequest(peer: HostPeer, method: string, rawParams: unknown): Promise<unknown> {
		const params = requireRecord(rawParams, `${method} params`);
		switch (method) {
			case 'initialize':
				return this.initialize(peer, params);
			case 'ping':
				return null;
			case 'listSessions':
				return { items: [...this.sessions.values()].map(sessionSummary) };
			case 'createSession':
				this.createSession(params);
				return null;
			case 'disposeSession':
				this.sessions.delete(requireString(params['channel'], 'session channel'));
				return null;
			case 'subscribe':
				return this.subscribe(peer, requireString(params['channel'], 'subscription channel'));
			default:
				throw new Error(`Unsupported deterministic Agent Host method: ${method}`);
		}
	}

	private initialize(peer: HostPeer, params: Record<string, unknown>): InitializeResult {
		const protocolVersions = params['protocolVersions'];
		if (!Array.isArray(protocolVersions) || !protocolVersions.includes(PROTOCOL_VERSION)) {
			throw new Error(`Deterministic Agent Host requires AHP ${PROTOCOL_VERSION}`);
		}
		peer.clientId = requireString(params['clientId'], 'clientId');
		const initialSubscriptions = params['initialSubscriptions'];
		if (Array.isArray(initialSubscriptions)) {
			for (const subscription of initialSubscriptions) {
				if (typeof subscription === 'string') {
					peer.subscriptions.add(subscription);
				}
			}
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			serverSeq: this.serverSeq,
			serverInfo: {
				name: 'ahp-channels-deterministic-e2e-host',
				version: '1.0.0',
			},
			snapshots: [...peer.subscriptions].flatMap(channel => {
				const snapshot = this.snapshot(channel);
				return snapshot ? [snapshot] : [];
			}),
		};
	}

	private createSession(params: Record<string, unknown>): void {
		const channel = requireString(params['channel'], 'session channel');
		if (this.sessions.has(channel)) {
			throw new Error(`Session already exists: ${channel}`);
		}
		const chat = `ahp-chat:/${randomUUID()}`;
		const now = new Date().toISOString();
		this.sessions.set(channel, {
			resource: channel,
			createdAt: now,
			pendingToolCalls: new Map(),
			state: {
				provider: PROVIDER,
				title: 'Deterministic fakechat E2E',
				status: SessionStatus.Idle,
				lifecycle: SessionLifecycle.Ready,
				activeClients: [],
				chats: [{
					resource: chat,
					title: 'Fakechat',
					status: SessionStatus.Idle,
					modifiedAt: now,
				}],
				defaultChat: chat,
				customizations: [],
			},
			chatState: {
				resource: chat,
				title: 'Fakechat',
				status: SessionStatus.Idle,
				modifiedAt: now,
				turns: [],
			},
		});
	}

	private subscribe(peer: HostPeer, channel: string): Record<string, unknown> {
		peer.subscriptions.add(channel);
		const snapshot = this.snapshot(channel);
		return snapshot ? { snapshot } : {};
	}

	private snapshot(channel: string): Snapshot | undefined {
		if (channel === 'ahp-root://') {
			return {
				resource: channel,
				state: this.rootState(),
				fromSeq: this.serverSeq,
			};
		}
		const session = this.sessions.get(channel);
		if (session) {
			return {
				resource: channel,
				state: session.state,
				fromSeq: this.serverSeq,
			};
		}
		const hosted = this.findSessionByChat(channel);
		return hosted
			? {
				resource: channel,
				state: hosted.chatState,
				fromSeq: this.serverSeq,
			}
			: undefined;
	}

	private rootState(): RootState {
		return {
			agents: [{
				provider: PROVIDER,
				displayName: 'Deterministic E2E Agent',
				description: 'Executes the official fakechat reply tool deterministically.',
				models: [{
					id: MODEL,
					provider: PROVIDER,
					name: 'Deterministic E2E',
				}],
			}],
			activeSessions: this.sessions.size,
		};
	}

	private async handleNotification(peer: HostPeer, message: Record<string, unknown>): Promise<void> {
		const method = message['method'];
		const params = requireRecord(message['params'], `${String(method)} params`);
		if (method === 'unsubscribe') {
			peer.subscriptions.delete(requireString(params['channel'], 'subscription channel'));
			return;
		}
		if (method !== 'dispatchAction') {
			return;
		}
		const channel = requireString(params['channel'], 'action channel');
		const action = requireStateAction(params['action']);
		const origin: ActionOrigin = {
			clientId: requireString(peer.clientId, 'initialized clientId'),
			clientSeq: requireNumber(params['clientSeq'], 'clientSeq'),
		};
		await this.acceptAction(peer, channel, action, origin);
	}

	private async acceptAction(
		peer: HostPeer,
		channel: string,
		action: StateAction,
		origin: ActionOrigin,
	): Promise<void> {
		const session = this.sessions.get(channel);
		if (session) {
			assertSessionAction(action);
			session.state = sessionReducer(session.state, action);
			this.broadcastAction(channel, action, origin);
			if (action.type === ActionType.SessionActiveClientSet) {
				this.scheduleCustomizationLoad(peer, channel, action.activeClient.customizations ?? []);
			} else if (action.type === ActionType.SessionActiveClientRemoved) {
				this.removeClientCustomizations(channel, action.clientId);
			}
			return;
		}

		const hosted = this.findSessionByChat(channel);
		if (!hosted) {
			return;
		}
		assertChatAction(action);
		if (action.type === ActionType.ChatToolCallConfirmed) {
			const tool = hosted.chatState.activeTurn?.responseParts.find(part =>
				part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === action.toolCallId
			);
			if (hosted.chatState.activeTurn?.id !== action.turnId
				|| tool?.kind !== ResponsePartKind.ToolCall
				|| tool.toolCall.status !== ToolCallStatus.PendingConfirmation) {
				this.broadcastAction(channel, action, origin, 'Tool is not awaiting confirmation');
				return;
			}
		}
		hosted.chatState = chatReducer(hosted.chatState, action);
		this.broadcastAction(channel, action, origin);
		if (action.type === ActionType.ChatTurnStarted) {
			const marker = PERMISSION_MARKER.exec(action.message.text)?.[0];
			if (marker) {
				this.startPermissionTool(hosted, channel, action.turnId, marker);
			} else {
				const expected = EXPECTED_REPLY.exec(action.message.text)?.[0];
				if (expected) {
					await this.startReplyTool(hosted, channel, action.turnId, expected);
				}
			}
		} else if (action.type === ActionType.ChatToolCallConfirmed) {
			const pending = hosted.pendingToolCalls.get(action.toolCallId);
			if (pending?.permission) {
				hosted.pendingToolCalls.delete(action.toolCallId);
				if (action.approved) {
					await writeFile(pending.permission.path, pending.permission.marker);
					this.publishAction(channel, {
						type: ActionType.ChatToolCallComplete,
						turnId: pending.turnId,
						toolCallId: action.toolCallId,
						result: { success: true, pastTenseMessage: 'Wrote the permission test marker' },
					});
				}
				await this.startReplyTool(
					hosted,
					channel,
					pending.turnId,
					`${pending.permission.marker}_${action.approved ? 'ALLOWED' : 'DENIED'}`,
				);
			}
		} else if (action.type === ActionType.ChatToolCallComplete) {
			const pending = hosted.pendingToolCalls.get(action.toolCallId);
			if (pending && !pending.permission) {
				hosted.pendingToolCalls.delete(action.toolCallId);
				this.publishAction(channel, {
					type: ActionType.ChatTurnComplete,
					turnId: pending.turnId,
					duration: 0,
				});
			}
		}
	}

	private scheduleCustomizationLoad(
		peer: HostPeer,
		sessionChannel: string,
		customizations: readonly ClientPluginCustomization[],
	): void {
		for (const customization of customizations) {
			const key = `${sessionChannel}\0${customization.id}\0${customization.nonce ?? ''}`;
			if (this.customizationLoads.has(key)) {
				continue;
			}
			const load = this.loadCustomization(peer, sessionChannel, customization)
				.catch(error => this.publishCustomizationError(sessionChannel, peer, customization, error))
				.finally(() => this.customizationLoads.delete(key));
			this.customizationLoads.set(key, load);
		}
	}

	private async loadCustomization(
		peer: HostPeer,
		sessionChannel: string,
		customization: ClientPluginCustomization,
	): Promise<void> {
		const root = customization.uri.endsWith('/') ? customization.uri : `${customization.uri}/`;
		const manifestUri = new URL('.claude-plugin/plugin.json', root).href;
		const mcpUri = new URL('.mcp.json', root).href;
		const [manifestResult, mcpResult] = await Promise.all([
			this.reverseRequest(peer, 'resourceRead', {
				channel: 'ahp-root://',
				uri: manifestUri,
				encoding: ContentEncoding.Utf8,
			}),
			this.reverseRequest(peer, 'resourceRead', {
				channel: 'ahp-root://',
				uri: mcpUri,
				encoding: ContentEncoding.Utf8,
			}),
		]);
		const manifest = parseJsonObject(readResourceText(manifestResult), 'plugin manifest');
		const mcp = parseJsonObject(readResourceText(mcpResult), 'MCP configuration');
		const servers = requireRecord(mcp['mcpServers'], 'mcpServers');
		const plugin: PluginCustomization = {
			type: CustomizationType.Plugin,
			id: customization.id,
			uri: customization.uri,
			name: requireString(manifest['name'], 'plugin name'),
			...(typeof manifest['version'] === 'string' ? { version: manifest['version'] } : {}),
			...(customization.enablement ? { enablement: customization.enablement } : {}),
			clientId: requireString(peer.clientId, 'initialized clientId'),
			load: { kind: CustomizationLoadStatus.Loaded },
			children: Object.keys(servers).map(name => ({
				type: CustomizationType.McpServer,
				id: `${customization.id}:mcp:${name}`,
				uri: mcpUri,
				name,
				...(customization.childEnablement?.[name]
					? { enablement: customization.childEnablement[name] }
					: {}),
				state: { kind: McpServerStatus.Stopped },
			})),
		};
		this.publishAction(sessionChannel, {
			type: ActionType.SessionCustomizationUpdated,
			customization: plugin,
		});
	}

	private publishCustomizationError(
		sessionChannel: string,
		peer: HostPeer,
		customization: ClientPluginCustomization,
		error: unknown,
	): void {
		this.publishAction(sessionChannel, {
			type: ActionType.SessionCustomizationUpdated,
			customization: {
				type: CustomizationType.Plugin,
				id: customization.id,
				uri: customization.uri,
				name: customization.name,
				clientId: peer.clientId,
				load: {
					kind: CustomizationLoadStatus.Error,
					message: error instanceof Error ? error.message : String(error),
				},
				children: [],
			},
		});
	}

	private startPermissionTool(hosted: HostedSession, chat: string, turnId: string, marker: string): void {
		const toolCallId = randomUUID();
		const path = join(this.registryDirectory, `${marker}.txt`);
		hosted.pendingToolCalls.set(toolCallId, { turnId, permission: { marker, path } });
		this.publishAction(chat, {
			type: ActionType.ChatToolCallStart,
			turnId, toolCallId,
			toolName: 'fixture_write',
			displayName: 'Write test marker',
		});
		this.publishAction(chat, {
			type: ActionType.ChatToolCallReady,
			turnId, toolCallId,
			invocationMessage: 'Write a marker file inside the isolated E2E directory',
			toolInput: JSON.stringify({ path, text: marker }),
			options: [
				{ id: 'allow-once', label: 'Allow once', kind: ConfirmationOptionKind.Approve },
				{ id: 'deny', label: 'Deny', kind: ConfirmationOptionKind.Deny },
			],
		});
	}

	private async startReplyTool(
		hosted: HostedSession,
		chat: string,
		turnId: string,
		expected: string,
	): Promise<void> {
		const client = hosted.state.activeClients.find(candidate =>
			candidate.tools.some(tool => tool.name === 'reply')
		);
		if (!client) {
			throw new Error('Official fakechat reply tool was not contributed to the deterministic Agent Host');
		}
		const toolCallId = randomUUID();
		hosted.pendingToolCalls.set(toolCallId, { turnId });
		const contributor = {
			kind: ToolCallContributorKind.Client,
			clientId: client.clientId,
		} as const;
		this.publishAction(chat, {
			type: ActionType.ChatToolCallStart,
			turnId,
			toolCallId,
			toolName: 'reply',
			displayName: 'reply',
			intention: `Send the exact fakechat response ${expected}`,
			contributor,
		});
		this.publishAction(chat, {
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId,
			contributor,
			invocationMessage: `Send ${expected} to fakechat`,
			toolInput: JSON.stringify({ text: expected }),
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	private publishAction(channel: string, action: StateAction): void {
		const session = this.sessions.get(channel);
		if (session) {
			assertSessionAction(action);
			session.state = sessionReducer(session.state, action);
		} else {
			const hosted = this.findSessionByChat(channel);
			if (hosted) {
				assertChatAction(action);
				hosted.chatState = chatReducer(hosted.chatState, action);
			}
		}
		this.broadcastAction(channel, action, undefined);
	}

	private broadcastAction(
		channel: string,
		action: StateAction,
		origin: ActionOrigin | undefined,
		rejectionReason?: string,
	): void {
		const envelope: ActionEnvelope = {
			channel,
			action,
			serverSeq: ++this.serverSeq,
			origin,
			...(rejectionReason ? { rejectionReason } : {}),
		};
		for (const peer of this.peers) {
			if (peer.subscriptions.has(channel)) {
				this.send(peer, {
					jsonrpc: '2.0',
					method: 'action',
					params: envelope,
				});
			}
		}
	}

	private reverseRequest(
		peer: HostPeer,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const id = peer.nextRequestId++;
		return new Promise((resolve, reject) => {
			peer.pendingRequests.set(id, { resolve, reject });
			this.send(peer, {
				jsonrpc: '2.0',
				id,
				method,
				params,
			});
		});
	}

	private findSessionByChat(chat: string): HostedSession | undefined {
		return [...this.sessions.values()].find(session => session.chatState.resource === chat);
	}

	private send(peer: HostPeer, message: Record<string, unknown>): void {
		if (peer.socket.readyState === WebSocket.OPEN) {
			peer.socket.send(JSON.stringify(message));
		}
	}

	private removePeer(peer: HostPeer): void {
		this.peers.delete(peer);
		this.rejectPendingRequests(peer, new Error('Agent Host client disconnected'));
		if (!peer.clientId) {
			return;
		}
		for (const [channel, session] of this.sessions) {
			if (session.state.activeClients.some(client => client.clientId === peer.clientId)) {
				this.publishAction(channel, {
					type: ActionType.SessionActiveClientRemoved,
					clientId: peer.clientId,
				});
				this.removeClientCustomizations(channel, peer.clientId);
			}
		}
	}

	private removeClientCustomizations(channel: string, clientId: string): void {
		const session = this.sessions.get(channel);
		for (const customization of session?.state.customizations ?? []) {
			if ('clientId' in customization && customization.clientId === clientId) {
				this.publishAction(channel, {
					type: ActionType.SessionCustomizationRemoved,
					id: customization.id,
				});
			}
		}
	}

	private rejectPendingRequests(peer: HostPeer, error: Error): void {
		for (const request of peer.pendingRequests.values()) {
			request.reject(error);
		}
		peer.pendingRequests.clear();
	}
}

function waitForListening(server: WebSocketServer): Promise<void> {
	if (server.address()) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		server.once('listening', resolve);
		server.once('error', reject);
	});
}

function sessionSummary(session: HostedSession): SessionSummary {
	return {
		resource: session.resource,
		provider: session.state.provider,
		title: session.state.title,
		status: session.state.status,
		createdAt: session.createdAt,
		modifiedAt: session.chatState.modifiedAt,
	};
}

function parseJsonRpcMessage(raw: RawData): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(String(raw));
	} catch (error) {
		throw new Error('Deterministic Agent Host received invalid JSON', { cause: error });
	}
	return requireRecord(value, 'JSON-RPC message');
}

function readResourceText(value: unknown): string {
	const result = requireRecord(value, 'resourceRead result');
	if (result['encoding'] !== ContentEncoding.Utf8 || typeof result['data'] !== 'string') {
		throw new Error('Deterministic Agent Host expected a UTF-8 resource');
	}
	return result['data'];
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
	try {
		return requireRecord(JSON.parse(value), label);
	} catch (error) {
		throw new Error(`Invalid ${label}`, { cause: error });
	}
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function requireStateAction(value: unknown): StateAction {
	const action = requireRecord(value, 'state action');
	if (typeof action['type'] !== 'string') {
		throw new Error('Invalid state action type');
	}
	return action as unknown as StateAction;
}

function assertSessionAction(action: StateAction): asserts action is SessionAction {
	if (!action.type.startsWith('session/')) {
		throw new Error(`Expected a session action, received ${action.type}`);
	}
}

function assertChatAction(action: StateAction): asserts action is ChatAction {
	if (!action.type.startsWith('chat/')) {
		throw new Error(`Expected a chat action, received ${action.type}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
