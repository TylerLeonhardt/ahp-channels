import {
	SUPPORTED_PROTOCOL_VERSIONS,
	type InitializeResult,
	type SessionState,
	type SessionSummary,
} from '@microsoft/agent-host-protocol';
import { AhpClient, type Subscription } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentHostEndpoint } from './endpoints.js';
import { SocketWebSocketTransport } from './socketWebSocketTransport.js';

export interface ConnectedAgentHost {
	readonly client: AhpClient;
	readonly clientId: string;
	readonly initializeResult: InitializeResult;
}

export interface SubscribedSession {
	readonly state: SessionState;
	readonly subscription: Subscription;
}

export function createChannelClientId(plugin: string, session: string): string {
	const digest = createHash('sha256')
		.update('ahp-channels\0')
		.update(plugin)
		.update('\0')
		.update(session)
		.digest('hex');
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export async function connectAgentHost(endpoint: AgentHostEndpoint, clientId: string = randomUUID()): Promise<ConnectedAgentHost> {
	const transport = endpoint.endpoint.type === 'tcp'
		? await connectTcp(endpoint)
		: await SocketWebSocketTransport.connect(endpoint.endpoint.path, endpoint.connectionToken);
	const client = new AhpClient(transport);
	client.connect();
	try {
		const initializeResult = await client.initialize({
			clientId,
			protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
			initialSubscriptions: ['ahp-root://'],
		});
		return { client, clientId, initializeResult };
	} catch (error) {
		await client.shutdown();
		throw error;
	}

	async function connectTcp(endpoint: AgentHostEndpoint): Promise<WebSocketTransport> {
		if (endpoint.endpoint.type !== 'tcp') {
			throw new Error('Expected a TCP Agent Host endpoint');
		}
		const url = new URL(`ws://${endpoint.endpoint.host}:${endpoint.endpoint.port}/`);
		url.searchParams.set('tkn', endpoint.connectionToken);
		return WebSocketTransport.connect(url);
	}
}

export async function listSessions(client: AhpClient): Promise<readonly SessionSummary[]> {
	const result = await client.request('listSessions', { channel: 'ahp-root://' });
	return result.items;
}

export async function subscribeSession(client: AhpClient, session: string): Promise<SubscribedSession> {
	const { result, subscription } = await client.subscribe(session);
	if (!result.snapshot) {
		await subscription.close();
		throw new Error(`Agent Host returned no state snapshot for session ${session}`);
	}
	return {
		state: result.snapshot.state as SessionState,
		subscription,
	};
}

export function resolveChat(state: SessionState, requested?: string, session = 'session'): string {
	if (requested) {
		const known = state.chats.some(chat => chat.resource === requested);
		if (!known) {
			throw new Error(`Chat ${requested} does not belong to ${session}`);
		}
		return requested;
	}
	const chat = state.defaultChat ?? state.chats[0]?.resource;
	if (!chat) {
		throw new Error(`${session} has no chat`);
	}
	return chat;
}
