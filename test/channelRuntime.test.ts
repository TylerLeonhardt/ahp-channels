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
	type ChannelSessionCatalog,
	type ChannelRuntimeServices,
	type ChannelSubscription,
} from '../src/channelRuntime.js';
import { ChannelOperationError } from '../src/channelHealth.js';
import type { AgentHostEndpoint } from '../src/endpoints.js';
import type { McpChannelClient, StartedMcpChannel } from '../src/mcpChannel.js';
import { PluginIntegrityError, PluginLoadingError } from '../src/plugins.js';
import {
	SessionHostResolutionError,
	type OpenedSession,
	type OpenSessionRequest,
} from '../src/sessionCatalog.js';

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

class TestSessionCatalog implements ChannelSessionCatalog {
	openSessionHook: ((target: OpenSessionRequest) => Promise<OpenedSession>) | undefined;

	constructor(private readonly client: TestHostClient) { }

	async openSession(target: OpenSessionRequest): Promise<OpenedSession> {
		if (this.openSessionHook) {
			return this.openSessionHook(target);
		}
		if (!this.client.sessionAvailable) {
			throw new SessionHostResolutionError('session', `No Agent Host candidate owns session ${target.session}`);
		}
		let subscribed: Awaited<ReturnType<TestHostClient['subscribe']>>;
		try {
			subscribed = await this.client.subscribe(target.session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new SessionHostResolutionError(
				'session',
				message.replace('host-reported-secret', '[redacted]'),
				{ cause: error },
			);
		}
		if (!subscribed.result.snapshot) {
			await subscribed.subscription.close();
			throw new SessionHostResolutionError('session', 'Agent Host returned no valid session state snapshot');
		}
		return {
			host: { ...(target.host ? { preferred: target.host } : {}), actual: endpoint.id, fallback: false },
			connection: { client: this.client, clientId: 'client' },
			subscription: subscribed.subscription,
			state: subscribed.result.snapshot.state as SessionState,
			warnings: [],
		};
	}

	async discoverSessions(): Promise<never> {
		throw new Error('Unexpected session discovery');
	}

	async discoverChats(): Promise<never> {
		throw new Error('Unexpected chat discovery');
	}

	async validateBinding(): Promise<never> {
		throw new Error('Unexpected binding validation');
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
				bindingId: snapshot.bindingId,
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
				bindingId: runtime.snapshot.bindingId,
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

	it('prepares a healthy replacement without publishing it until activation', async () => {
		const client = new TestHostClient();
		const runtime = await ChannelRuntime.prepare('personal', {
			plugin: 'fake',
			session: sessionUri,
			enabled: true,
		}, createServices(client, new TestMcpChannel()));
		assert.equal(client.dispatched.some(item =>
			item.action.type === ActionType.SessionActiveClientSet
		), false);

		await runtime.activate();
		assert.equal(client.dispatched.some(item =>
			item.action.type === ActionType.SessionActiveClientSet
		), true);
		await runtime.close();
	});

	it('rejects a prepared replacement whose channel process cannot start', async () => {
		const client = new TestHostClient();
		await assert.rejects(
			ChannelRuntime.prepare('personal', {
				plugin: 'fake',
				session: sessionUri,
				enabled: true,
			}, createServices(client, new TestMcpChannel(new Error('missing destination credential')))),
			(error: unknown) => error instanceof ChannelOperationError
				&& error.stage === 'mcp-startup'
				&& /missing destination credential/.test(error.message),
		);
		assert.equal(client.dispatched.some(item =>
			item.action.type === ActionType.SessionActiveClientSet
		), false);
		assert.equal(client.shutDown, true);
	});

	it('uses the session owner selected by the shared catalog service', async () => {
		const client = new TestHostClient();
		const mcp = new TestMcpChannel();
		const services = createServices(client, mcp);
		services.sessionCatalog.openSessionHook = target =>
			openTestSession(client, target, 'editor:3:owner');

		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			enabled: true,
		}, services);
		try {
			assert.equal(runtime.snapshot.host, 'editor:3:owner');
		} finally {
			await runtime.close();
		}
	});

	it('prefers an alias and falls back only to a local host owning the bound session', async () => {
		const fallbackClient = new TestHostClient();
		const mcp = new TestMcpChannel();
		const services = createServices(fallbackClient, mcp);
		services.sessionCatalog.openSessionHook = target => openTestSession(
			fallbackClient,
			target,
			'editor:3:fallback',
			["Host alias '@work' did not connect; using local fallback editor:3:fallback for ahp-session:/session"],
			true,
		);
		const statuses: string[] = [];

		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			chat: chatUri,
			host: '@work',
			enabled: true,
		}, services, { report: message => statuses.push(message) });
		try {
			assert.equal(runtime.snapshot.host, 'editor:3:fallback');
			assert.equal(runtime.snapshot.session, sessionUri);
			assert.equal(runtime.snapshot.chat, chatUri);
			assert.ok(statuses.some(message => /using local fallback/.test(message)));
		} finally {
			await runtime.close();
		}
	});

	it('falls back when an alias is unavailable but rejects ambiguous aliases', async () => {
		const services = createServices(new TestHostClient(), new TestMcpChannel());
		services.sessionCatalog.openSessionHook = target => openTestSession(
			new TestHostClient(),
			target,
			endpoint.id,
			["Host alias '@work' is unavailable; searching other local Agent Hosts for the bound session"],
			true,
		);
		const statuses: string[] = [];
		const runtime = await ChannelRuntime.start('personal', {
			plugin: 'fake',
			session: sessionUri,
			host: '@work',
			enabled: true,
		}, services, { report: message => statuses.push(message) });
		await runtime.close();
		assert.ok(statuses.some(message => /searching other local Agent Hosts/.test(message)));

		services.sessionCatalog.openSessionHook = async () => {
			throw new SessionHostResolutionError('discovery', "Host alias '@work' is ambiguous");
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
			services.sessionCatalog.openSessionHook = async () => {
				throw new SessionHostResolutionError('discovery', 'registry unavailable');
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

interface TestRuntimeServices extends ChannelRuntimeServices {
	readonly sessionCatalog: TestSessionCatalog;
}

function createServices(client: TestHostClient, mcp: TestMcpChannel): TestRuntimeServices {
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
		sessionCatalog: new TestSessionCatalog(client),
		createMcpChannel() {
			return mcp;
		},
	};
}

async function openTestSession(
	client: TestHostClient,
	target: OpenSessionRequest,
	actualHost: string,
	warnings: readonly string[] = [],
	fallback = false,
): Promise<OpenedSession> {
	assert.match(target.clientId ?? '', /^[a-f0-9-]+$/);
	const subscribed = await client.subscribe(target.session);
	assert.ok(subscribed.result.snapshot);
	return {
		host: {
			...(target.host ? { preferred: target.host } : {}),
			actual: actualHost,
			fallback,
		},
		connection: { client, clientId: 'client' },
		subscription: subscribed.subscription,
		state: subscribed.result.snapshot.state as SessionState,
		warnings,
	};
}
