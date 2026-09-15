import {
	ActionType,
	SessionLifecycle,
	SessionStatus,
	type ListSessionsResult,
	type SessionState,
	type StateAction,
	type SubscribeResult,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, ResourceRequestHandlers, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
	ChannelRuntime,
	type ChannelHostClient,
	type ChannelRuntimeServices,
	type ChannelSubscription,
} from '../src/channelRuntime.js';
import type { AgentHostEndpoint } from '../src/endpoints.js';
import type { McpChannelClient, StartedMcpChannel } from '../src/mcpChannel.js';

const sessionUri = 'ahp-session:/session';
const chatUri = 'ahp-chat:/chat';
const endpoint: AgentHostEndpoint = {
	id: 'standalone:1:test',
	type: 'standalone',
	pid: 1,
	protocolVersion: '0.9.0',
	connectionToken: 'token',
	endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 },
	registryFile: 'entry.json',
	modifiedAt: 0,
};

class TestSubscription implements ChannelSubscription {
	private waiter: ((result: IteratorResult<SubscriptionEvent>) => void) | undefined;
	closed = false;

	[Symbol.asyncIterator](): AsyncIterator<SubscriptionEvent> {
		return {
			next: () => {
				if (this.closed) {
					return Promise.resolve({ done: true, value: undefined });
				}
				return new Promise(resolve => {
					this.waiter = resolve;
				});
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		this.waiter?.({ done: true, value: undefined });
		this.waiter = undefined;
	}
}

class TestHostClient implements ChannelHostClient {
	readonly dispatched: Array<{ channel: string; action: StateAction }> = [];
	readonly subscriptions = new Map<string, TestSubscription>();
	shutDown = false;
	resourceHandlers: ResourceRequestHandlers | null | undefined;
	resourceHandlersSetBeforeActiveClient = false;

	setResourceRequestHandlers(handlers: ResourceRequestHandlers | null): void {
		this.resourceHandlers = handlers;
	}

	async subscribe(uri: string): Promise<{ result: SubscribeResult; subscription: TestSubscription }> {
		const subscription = new TestSubscription();
		this.subscriptions.set(uri, subscription);
		if (uri === sessionUri) {
			const state: SessionState = {
				provider: 'test',
				title: 'Test',
				status: SessionStatus.Idle,
				lifecycle: SessionLifecycle.Ready,
				activeClients: [],
				chats: [{
					resource: chatUri,
					title: 'Chat',
					status: SessionStatus.Idle,
					modifiedAt: new Date(0).toISOString(),
				}],
				defaultChat: chatUri,
			};
			return {
				result: {
					snapshot: {
						resource: sessionUri,
						state,
						fromSeq: 0,
					},
				},
				subscription,
			};
		}

		if (uri === chatUri) {
			return {
				result: {
					snapshot: {
						resource: chatUri,
						state: {
							resource: chatUri,
							title: 'Chat',
							status: SessionStatus.Idle,
							modifiedAt: new Date(0).toISOString(),
							turns: [],
						},
						fromSeq: 0,
					},
				},
				subscription,
			};
		}
		return { result: {}, subscription };
	}

	async request(): Promise<ListSessionsResult> {
		return {
			items: [{
				resource: sessionUri,
				provider: 'test',
				title: 'Test',
				status: SessionStatus.Idle,
				createdAt: new Date(0).toISOString(),
				modifiedAt: new Date(0).toISOString(),
			}],
		};
	}

	dispatch(channel: string, action: StateAction): DispatchHandle {
		if (action.type === ActionType.SessionActiveClientSet) {
			this.resourceHandlersSetBeforeActiveClient = this.resourceHandlers !== undefined;
		}
		this.dispatched.push({ channel, action });
		return { clientSeq: this.dispatched.length };
	}

	async unsubscribe(uri: string): Promise<void> {
		await this.subscriptions.get(uri)?.close();
	}

	async shutdown(): Promise<void> {
		this.shutDown = true;
		for (const subscription of this.subscriptions.values()) {
			await subscription.close();
		}
	}
}

class TestMcpChannel implements McpChannelClient {
	closed = false;
	private resolveStopped!: () => void;
	readonly whenStopped = new Promise<void>(resolve => {
		this.resolveStopped = resolve;
	});

	constructor(private readonly startError?: Error) { }

	async start(): Promise<StartedMcpChannel> {
		if (this.startError) {
			throw this.startError;
		}
		return {
			name: 'fake-channel',
			tools: [{ name: 'reply', inputSchema: { type: 'object' } }],
		};
	}

	async setChannelHandler(): Promise<void> { }

	async callTool(): Promise<never> {
		throw new Error('Unexpected tool call');
	}

	async close(): Promise<void> {
		this.closed = true;
		this.resolveStopped();
	}
}

describe('ChannelRuntime', () => {
	it('starts and closes every owned resource', async () => {
		const client = new TestHostClient();
		const mcp = new TestMcpChannel();
		const services = createServices(client, mcp);
		const installation = 'a'.repeat(64);

		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			installation,
			session: sessionUri,
			enabled: true,
		}, services);
		const snapshot = runtime.snapshot;
		await runtime.close();

		assert.deepEqual({
			snapshot,
			actionTypes: client.dispatched.map(item => item.action.type),
			sessionClosed: client.subscriptions.get(sessionUri)?.closed,
			chatClosed: client.subscriptions.get(chatUri)?.closed,
			clientShutDown: client.shutDown,
			mcpClosed: mcp.closed,
			resourceHandlersSetBeforeActiveClient: client.resourceHandlersSetBeforeActiveClient,
			customizationNonces: client.dispatched.flatMap(item =>
				item.action.type === ActionType.SessionActiveClientSet
					? item.action.activeClient.customizations?.map(customization => customization.nonce) ?? []
					: []
			),
		}, {
			snapshot: {
				name: 'personal',
				plugin: 'fake',
				session: sessionUri,
				chat: chatUri,
				host: endpoint.id,
				clientId: 'client',
				channelName: 'fake-channel',
				startedAt: snapshot.startedAt,
				busy: false,
			},
			actionTypes: [
				ActionType.SessionActiveClientSet,
				ActionType.SessionActiveClientSet,
				ActionType.SessionActiveClientRemoved,
			],
			sessionClosed: true,
			chatClosed: true,
			clientShutDown: true,
			mcpClosed: true,
			resourceHandlersSetBeforeActiveClient: true,
			customizationNonces: [installation, installation],
		});
	});

	it('keeps plugin skills contributed when the MCP server cannot start', async () => {
		const client = new TestHostClient();
		const mcp = new TestMcpChannel(new Error('DISCORD_BOT_TOKEN required'));
		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			enabled: true,
		}, createServices(client, mcp));
		const registration = client.dispatched.find(item => item.action.type === ActionType.SessionActiveClientSet);
		assert.ok(registration?.action.type === ActionType.SessionActiveClientSet);

		assert.deepEqual({
			state: runtime.snapshot,
			tools: registration.action.activeClient.tools,
			customizationName: registration.action.activeClient.customizations?.[0]?.name,
			failedMcpClosed: mcp.closed,
			clientShutDown: client.shutDown,
		}, {
			state: {
				name: 'personal',
				plugin: 'fake',
				session: sessionUri,
				chat: chatUri,
				host: endpoint.id,
				clientId: 'client',
				channelName: 'fake',
				startedAt: runtime.snapshot.startedAt,
				busy: false,
				error: 'MCP channel startup: DISCORD_BOT_TOKEN required',
			},
			tools: [],
			customizationName: 'fake',
			failedMcpClosed: true,
			clientShutDown: false,
		});

		await runtime.close();
		assert.equal(client.shutDown, true);
	});

	it('finds the session owner when the newest Agent Host does not have it', async () => {
		const client = new TestHostClient();
		const mcp = new TestMcpChannel();
		const services = createServices(client, mcp);
		const wrongEndpoint: AgentHostEndpoint = {
			...endpoint,
			id: 'editor:2:wrong',
			type: 'editor',
			endpoint: { type: 'socket', path: 'wrong' },
		};
		services.discoverAgentHosts = async () => [wrongEndpoint, endpoint];
		const attempted: string[] = [];
		services.connectAgentHost = async (candidate, clientId) => {
			attempted.push(candidate.id);
			return {
				client: candidate === wrongEndpoint
					? Object.assign(new TestHostClient(), {
						async request() {
							return { items: [] };
						},
					})
					: client,
				clientId,
			};
		};

		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			enabled: true,
		}, services);
		try {
			assert.deepEqual({
				attempted,
				host: runtime.snapshot.host,
			}, {
				attempted: [wrongEndpoint.id, endpoint.id],
				host: endpoint.id,
			});
		} finally {
			await runtime.close();
		}
	});

	it('cleans up when the chat snapshot is unavailable', async () => {
		const client = new TestHostClient();
		client.subscribe = async uri => ({
			result: uri === sessionUri
				? (await new TestHostClient().subscribe(uri)).result
				: {},
			subscription: new TestSubscription(),
		});
		const mcp = new TestMcpChannel();

		await assert.rejects(
			ChannelRuntime.start('personal', {
				plugin: 'fake',
				session: sessionUri,
				enabled: true,
			}, createServices(client, mcp)),
			/no state snapshot for chat/,
		);
		assert.deepEqual({
			clientShutDown: client.shutDown,
			mcpClosed: mcp.closed,
		}, {
			clientShutDown: true,
			mcpClosed: false,
		});
	});
});

function createServices(client: TestHostClient, mcp: TestMcpChannel): ChannelRuntimeServices {
	return {
		async resolvePlugin() {
			return {
				name: 'fake',
				path: resolve(import.meta.dirname, 'fixtures', 'fake-plugin'),
				servers: {
					fake: { command: 'fake', args: [] },
				},
			};
		},
		async discoverAgentHosts() {
			return [endpoint];
		},
		async connectAgentHost(_endpoint, clientId) {
			assert.match(clientId, /^[a-f0-9-]+$/);
			return { client, clientId: 'client' };
		},
		createMcpChannel() {
			return mcp;
		},
	};
}
