import {
	ActionType,
	SessionLifecycle,
	SessionStatus,
	type ListSessionsResult,
	type ResourceReadResult,
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
import { ChannelOperationError } from '../src/channelHealth.js';
import { HostAliasResolutionError } from '../src/agentHosts.js';
import { selectAgentHost, type AgentHostEndpoint } from '../src/endpoints.js';
import type { McpChannelClient, StartedMcpChannel } from '../src/mcpChannel.js';
import { PluginIntegrityError, PluginLoadingError } from '../src/plugins.js';

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
	sessionAvailable = true;
	sessionSnapshotAvailable = true;
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
				result: this.sessionSnapshotAvailable
					? {
						snapshot: {
							resource: sessionUri,
							state,
							fromSeq: 0,
						},
					}
					: {},
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

	request(method: 'listSessions'): Promise<ListSessionsResult>;
	request(method: 'resourceRead'): Promise<ResourceReadResult>;
	async request(method: 'listSessions' | 'resourceRead'): Promise<ListSessionsResult | ResourceReadResult> {
		if (method === 'resourceRead') {
			throw new Error('No tool-input resource is published by this test host');
		}
		return {
			items: this.sessionAvailable ? [{
				resource: sessionUri,
				provider: 'test',
				title: 'Test',
				status: SessionStatus.Idle,
				createdAt: new Date(0).toISOString(),
				modifiedAt: new Date(0).toISOString(),
			}] : [],
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
				mode: 'mcp',
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
			failure: runtime.startupFailure && {
				stage: runtime.startupFailure.stage,
				message: runtime.startupFailure.message,
			},
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
				mode: 'customization-only',
			},
			failure: {
				stage: 'mcp-startup',
				message: 'MCP channel startup: DISCORD_BOT_TOKEN required',
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
						sessionAvailable: false,
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

	it('prefers an alias and falls back only to a local host owning the bound session', async () => {
		const preferredClient = new TestHostClient();
		preferredClient.sessionSnapshotAvailable = false;
		const wrongClient = new TestHostClient();
		wrongClient.sessionAvailable = false;
		const fallbackClient = new TestHostClient();
		const mcp = new TestMcpChannel();
		const services = createServices(preferredClient, mcp);
		const preferred = { ...endpoint, id: 'standalone:1:preferred' };
		const wrong = { ...endpoint, id: 'editor:2:wrong', type: 'editor' as const };
		const fallback = { ...endpoint, id: 'editor:3:fallback', type: 'editor' as const };
		services.resolveAgentHost = async selector => {
			assert.equal(selector, '@work');
			return preferred;
		};
		services.discoverAgentHosts = async () => [wrong, fallback];
		const attempted: string[] = [];
		services.connectAgentHost = async (candidate, clientId) => {
			attempted.push(candidate.id);
			return {
				client: candidate.id === preferred.id
					? preferredClient
					: candidate.id === wrong.id
						? wrongClient
						: fallbackClient,
				clientId,
			};
		};
		const statuses: string[] = [];

		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			chat: chatUri,
			host: '@work',
			enabled: true,
		}, services, message => statuses.push(message));
		try {
			assert.deepEqual(attempted, [preferred.id, wrong.id, fallback.id]);
			assert.equal(runtime.snapshot.host, fallback.id);
			assert.equal(runtime.snapshot.session, sessionUri);
			assert.equal(runtime.snapshot.chat, chatUri);
			assert.ok(statuses.some(message => /using local fallback/.test(message)));
		} finally {
			await runtime.close();
		}
	});

	it('falls back when an alias is unavailable but rejects ambiguous aliases', async () => {
		const services = createServices(new TestHostClient(), new TestMcpChannel());
		services.resolveAgentHost = async () => {
			throw new HostAliasResolutionError('unavailable', "Host alias '@work' is unavailable");
		};
		const statuses: string[] = [];
		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			host: '@work',
			enabled: true,
		}, services, message => statuses.push(message));
		await runtime.close();
		assert.ok(statuses.some(message => /searching other local Agent Hosts/.test(message)));

		let discovered = false;
		services.resolveAgentHost = async () => {
			throw new HostAliasResolutionError('ambiguous', "Host alias '@work' is ambiguous");
		};
		services.discoverAgentHosts = async () => {
			discovered = true;
			return [endpoint];
		};
		await assert.rejects(
			ChannelRuntime.start('personal', {
				plugin: 'fake',
				session: sessionUri,
				host: '@work',
				enabled: true,
			}, services),
			(error: unknown) => error instanceof ChannelOperationError
				&& error.stage === 'agent-host-discovery'
				&& /ambiguous/.test(error.message),
		);
		assert.equal(discovered, false);
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
			(error: unknown) => error instanceof ChannelOperationError
				&& error.stage === 'session-resolution'
				&& /no state snapshot for chat/.test(error.message),
		);
		assert.deepEqual({
			clientShutDown: client.shutDown,
			mcpClosed: mcp.closed,
		}, {
			clientShutDown: true,
			mcpClosed: false,
		});
	});

	it('categorizes Agent Host discovery at its operation boundary', async () => {
			const services = createServices(new TestHostClient(), new TestMcpChannel());
			services.discoverAgentHosts = async () => {
				throw new Error('registry unavailable');
			};

			await assert.rejects(
				ChannelRuntime.start('personal', {
					plugin: 'fake',
					session: sessionUri,
					enabled: true,
				}, services),
				(error: unknown) => error instanceof ChannelOperationError
					&& error.stage === 'agent-host-discovery'
					&& error.cause instanceof Error,
			);
	});

	it('categorizes session resolution without parsing the error message', async () => {
			const client = new TestHostClient();
			client.sessionAvailable = false;

			await assert.rejects(
				ChannelRuntime.start('personal', {
					plugin: 'fake',
					session: sessionUri,
					enabled: true,
				}, createServices(client, new TestMcpChannel())),
				(error: unknown) => error instanceof ChannelOperationError
					&& error.stage === 'session-resolution',
			);
	});

	it('redacts host-reported credentials from foreground startup errors', async () => {
			const client = new TestHostClient();
			client.subscribe = async () => {
				throw new Error('token=host-reported-secret refused');
			};

			await assert.rejects(
				ChannelRuntime.start('personal', {
					plugin: 'fake',
					session: sessionUri,
					enabled: true,
				}, createServices(client, new TestMcpChannel())),
				(error: unknown) => error instanceof ChannelOperationError
					&& error.message.includes('token=[redacted] refused')
					&& !error.message.includes('host-reported-secret'),
			);
	});

	it('distinguishes plugin integrity from plugin loading failures', async () => {
			for (const expected of [
				{ error: new PluginIntegrityError(new Error('digest mismatch')), stage: 'plugin-integrity' },
				{ error: new PluginLoadingError(new Error('invalid manifest')), stage: 'plugin-loading' },
			] as const) {
				const services = createServices(new TestHostClient(), new TestMcpChannel());
				services.resolvePlugin = async () => {
					throw expected.error;
				};
				await assert.rejects(
					ChannelRuntime.start('personal', {
						plugin: 'fake',
						session: sessionUri,
						enabled: true,
					}, services),
					(error: unknown) => error instanceof ChannelOperationError
						&& error.stage === expected.stage
						&& error.cause === expected.error,
				);
			}
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
		async resolveAgentHost(selector) {
			return selectAgentHost([endpoint], selector);
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
