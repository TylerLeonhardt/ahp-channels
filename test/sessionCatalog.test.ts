import {
	SessionLifecycle,
	SessionStatus,
	type ListSessionsResult,
	type ResourceReadResult,
	type SessionState,
	type SubscribeResult,
} from '@microsoft/agent-host-protocol';
import type {
	DispatchHandle,
	ResourceRequestHandlers,
	SubscriptionEvent,
} from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AgentHostResolutionPlan } from '../src/agentHosts.js';
import type { AgentHostConnectionTarget } from '../src/endpoints.js';
import {
	SessionCatalogService,
	type AgentHostConnector,
	type SessionCatalogHostClient,
	type SessionCatalogHostConnection,
	type SessionCatalogHostResolver,
	type SessionCatalogSubscription,
} from '../src/sessionCatalog.js';

const firstTarget = target('@first');
const secondTarget = target('@second');
const preferredTarget = target('@preferred');
const fallbackTarget = target('editor:2:fallback');

class TestSubscription implements SessionCatalogSubscription {
	closed = false;

	[Symbol.asyncIterator](): AsyncIterator<SubscriptionEvent> {
		return {
			next: () => this.closed
				? Promise.resolve({ done: true, value: undefined })
				: new Promise(() => undefined),
		};
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class TestHostClient implements SessionCatalogHostClient {
	readonly subscriptions: TestSubscription[] = [];
	readonly pages = new Map<string, unknown>();
	readonly sessions = new Map<string, SessionState>();
	shutDown = false;
	requestOverride: Promise<ListSessionsResult> | undefined;

	setResourceRequestHandlers(_handlers: ResourceRequestHandlers | null): void { }

	dispatch(): DispatchHandle {
		return { clientSeq: 1 };
	}

	request(method: 'listSessions'): Promise<ListSessionsResult>;
	request(method: 'resourceRead'): Promise<ResourceReadResult>;
	async request(
		method: 'listSessions' | 'resourceRead',
		params?: { readonly cursor?: string },
	): Promise<ListSessionsResult | ResourceReadResult> {
		if (method === 'resourceRead') {
			throw new Error('Unexpected resource read');
		}
		if (this.requestOverride) {
			return this.requestOverride;
		}
		return (this.pages.get(params?.cursor ?? '') ?? { items: [] }) as ListSessionsResult;
	}

	async subscribe(uri: string): Promise<{
		result: SubscribeResult;
		subscription: TestSubscription;
	}> {
		const subscription = new TestSubscription();
		this.subscriptions.push(subscription);
		const state = this.sessions.get(uri);
		return {
			result: state
				? {
					snapshot: {
						resource: uri,
						state,
						fromSeq: 0,
					},
				}
				: {},
			subscription,
		};
	}

	async unsubscribe(): Promise<void> { }

	async shutdown(): Promise<void> {
		this.shutDown = true;
	}
}

class TestResolver implements SessionCatalogHostResolver {
	readonly targets = new Map<string, AgentHostConnectionTarget>();
	readonly plans = new Map<string, AgentHostResolutionPlan>();
	readonly failures = new Map<string, Error>();

	constructor(readonly selectors: readonly string[]) { }

	async configuredSelectors(): Promise<readonly string[]> {
		return this.selectors;
	}

	async resolve(selector?: string): Promise<AgentHostConnectionTarget> {
		const key = selector ?? '';
		const failure = this.failures.get(key);
		if (failure) {
			throw failure;
		}
		const resolved = this.targets.get(key);
		if (!resolved) {
			throw new Error(`No target for ${selector ?? 'automatic'}`);
		}
		return resolved;
	}

	async resolveCandidates(selector?: string): Promise<AgentHostResolutionPlan> {
		const key = selector ?? '';
		const failure = this.failures.get(key);
		if (failure) {
			throw failure;
		}
		const plan = this.plans.get(key);
		if (plan) {
			return plan;
		}
		return {
			...(selector ? { preferredHost: selector } : {}),
			candidates: [{
				target: await this.resolve(selector),
				fallback: false,
				verifySessionCatalog: false,
			}],
			warnings: [],
		};
	}
}

class TestConnector implements AgentHostConnector {
	readonly clients = new Map<string, TestHostClient>();
	readonly attempts: string[] = [];
	connectionOverride: Promise<SessionCatalogHostConnection> | undefined;

	async connect(target: AgentHostConnectionTarget, clientId: string): Promise<SessionCatalogHostConnection> {
		assert.match(clientId, /^[a-f0-9-]+$/);
		this.attempts.push(target.id);
		if (this.connectionOverride) {
			return this.connectionOverride;
		}
		const client = this.clients.get(target.id);
		if (!client) {
			throw new Error(`Host ${target.id} is unavailable`);
		}
		return { client, clientId };
	}
}

describe('SessionCatalogService', () => {
	it('paginates duplicate titles across configured hosts without persisting display identity', async () => {
		const resolver = new TestResolver(['@first', '@second']);
		resolver.targets.set('@first', firstTarget);
		resolver.targets.set('@second', secondTarget);
		const connector = new TestConnector();
		const first = new TestHostClient();
		first.pages.set('', { items: [summary('ahp-session:/one', 'Duplicate', 'first')] });
		const second = new TestHostClient();
		second.pages.set('', { items: [summary('ahp-session:/two', 'Duplicate', 'second')] });
		connector.clients.set(firstTarget.id, first);
		connector.clients.set(secondTarget.id, second);
		const service = new SessionCatalogService(resolver, connector);

		const firstPage = await service.discoverSessions({ limit: 1 });
		assert.equal(firstPage.outcome, 'ok');
		assert.equal(firstPage.items[0]?.host.preferred, '@first');
		assert.equal(firstPage.items[0]?.resource, 'ahp-session:/one');
		assert.ok(firstPage.nextCursor);

		const secondPage = await service.discoverSessions({
			limit: 1,
			cursor: firstPage.nextCursor,
		});
		assert.equal(secondPage.items[0]?.host.preferred, '@second');
		assert.equal(secondPage.items[0]?.resource, 'ahp-session:/two');
		assert.equal(secondPage.nextCursor, undefined);
		assert.equal(first.shutDown, true);
		assert.equal(second.shutDown, true);
	});

	it('distinguishes empty, partial, and fully failed discovery', async () => {
		const resolver = new TestResolver(['@empty', '@down']);
		resolver.targets.set('@empty', firstTarget);
		resolver.failures.set('@down', new Error('connection refused'));
		const connector = new TestConnector();
		connector.clients.set(firstTarget.id, new TestHostClient());
		const service = new SessionCatalogService(resolver, connector);

		const partial = await service.discoverSessions();
		assert.deepEqual({
			outcome: partial.outcome,
			items: partial.items.length,
			failures: partial.failures,
		}, {
			outcome: 'partial',
			items: 0,
			failures: [{ preferred: '@down', error: 'connection refused' }],
		});

		resolver.failures.set('@empty', new Error('also unavailable'));
		const failed = await service.discoverSessions();
		assert.equal(failed.outcome, 'failed');

		resolver.failures.clear();
		const empty = await service.discoverSessions({ host: '@empty' });
		assert.equal(empty.outcome, 'empty');
	});

	it('reports malformed and repeated host pagination and rejects invalid aggregate cursors', async () => {
		const resolver = new TestResolver(['@first']);
		resolver.targets.set('@first', firstTarget);
		const connector = new TestConnector();
		const client = new TestHostClient();
		connector.clients.set(firstTarget.id, client);
		const service = new SessionCatalogService(resolver, connector);

		client.pages.set('', { items: [], nextCursor: 'repeat' });
		client.pages.set('repeat', { items: [], nextCursor: 'repeat' });
		const repeated = await service.discoverSessions();
		assert.equal(repeated.outcome, 'failed');
		assert.match(repeated.failures[0]?.error ?? '', /repeated session cursor/);

		client.pages.set('', { items: 'not-an-array' });
		const malformed = await service.discoverSessions({ host: '@first' });
		assert.equal(malformed.outcome, 'failed');
		assert.match(malformed.failures[0]?.error ?? '', /malformed session catalog/);

		await assert.rejects(
			service.discoverSessions({ cursor: 'not-base64-json' }),
			/Invalid catalog cursor/,
		);
	});

	it('discovers chats through exact-session fallback and preserves default-chat semantics', async () => {
		const resolver = new TestResolver(['@work']);
		resolver.plans.set('@work', {
			preferredHost: '@work',
			candidates: [{
				target: preferredTarget,
				fallback: false,
				verifySessionCatalog: false,
			}, {
				target: fallbackTarget,
				fallback: true,
				verifySessionCatalog: true,
			}],
			warnings: ["Host alias '@work' is unavailable; searching other local Agent Hosts for the bound session"],
		});
		const connector = new TestConnector();
		const preferred = new TestHostClient();
		const fallback = new TestHostClient();
		fallback.pages.set('', { items: [summary('ahp-session:/target', 'Target', 'provider')] });
		fallback.sessions.set('ahp-session:/target', sessionState());
		connector.clients.set(preferredTarget.id, preferred);
		connector.clients.set(fallbackTarget.id, fallback);
		const service = new SessionCatalogService(resolver, connector);

		const chats = await service.discoverChats({
			host: '@work',
			session: 'ahp-session:/target',
			limit: 1,
		});
		assert.deepEqual({
			preferred: chats.host.preferred,
			actual: chats.host.actual,
			fallback: chats.host.fallback,
			defaultChat: chats.defaultChat,
			first: chats.items[0],
			hasNext: Boolean(chats.nextCursor),
		}, {
			preferred: '@work',
			actual: fallbackTarget.id,
			fallback: true,
			defaultChat: 'ahp-chat:/default',
			first: {
				resource: 'ahp-chat:/default',
				title: 'Default',
				status: SessionStatus.Idle,
				modifiedAt: new Date(1).toISOString(),
				isDefault: true,
			},
			hasNext: true,
		});
		assert.equal(preferred.shutDown, true);
		assert.equal(preferred.subscriptions[0]?.closed, true);
		assert.equal(fallback.shutDown, true);
		assert.equal(fallback.subscriptions.at(-1)?.closed, true);

		const resolved = await service.validateBinding({
			host: '@work',
			session: 'ahp-session:/target',
		});
		assert.equal(resolved.chat, 'ahp-chat:/default');
		await assert.rejects(
			service.validateBinding({
				host: '@work',
				session: 'ahp-session:/target',
				chat: 'ahp-chat:/missing',
			}),
			/does not belong/,
		);
	});

	it('cancels a pending request and closes its discovery connection', async () => {
		const resolver = new TestResolver(['@first']);
		resolver.targets.set('@first', firstTarget);
		const connector = new TestConnector();
		const client = new TestHostClient();
		const request = deferred<ListSessionsResult>();
		client.requestOverride = request.promise;
		connector.clients.set(firstTarget.id, client);
		const service = new SessionCatalogService(resolver, connector);
		const abort = new AbortController();

		const discovery = service.discoverSessions({ host: '@first' }, abort.signal);
		await waitFor(() => connector.attempts.length === 1);
		abort.abort(new Error('cancelled'));
		await assert.rejects(discovery, /cancelled/);
		assert.equal(client.shutDown, true);
		request.resolve({ items: [] });
	});

	it('disposes a connection that finishes opening after cancellation', async () => {
		const resolver = new TestResolver(['@first']);
		resolver.targets.set('@first', firstTarget);
		const connector = new TestConnector();
		const client = new TestHostClient();
		const connection = deferred<SessionCatalogHostConnection>();
		connector.connectionOverride = connection.promise;
		const service = new SessionCatalogService(resolver, connector);
		const abort = new AbortController();

		const discovery = service.discoverSessions({ host: '@first' }, abort.signal);
		await waitFor(() => connector.attempts.length === 1);
		abort.abort(new Error('cancelled while connecting'));
		await assert.rejects(discovery, /cancelled while connecting/);
		connection.resolve({ client, clientId: randomUUID() });
		await waitFor(() => client.shutDown);
	});
});

function target(id: string): AgentHostConnectionTarget {
	return {
		id,
		endpoint: { type: 'socket', path: `/tmp/${id.replace(/\W/g, '')}.sock` },
	};
}

function summary(resource: string, title: string, provider: string) {
	return {
		resource,
		title,
		provider,
		status: SessionStatus.Idle,
		createdAt: new Date(0).toISOString(),
		modifiedAt: new Date(1).toISOString(),
		project: {
			uri: `file:///workspace/${provider}`,
			displayName: `${provider} workspace`,
		},
		workingDirectories: [`file:///workspace/${provider}`],
	};
}

function sessionState(): SessionState {
	return {
		provider: 'provider',
		title: 'Target',
		status: SessionStatus.Idle,
		lifecycle: SessionLifecycle.Ready,
		activeClients: [],
		chats: [{
			resource: 'ahp-chat:/default',
			title: 'Default',
			status: SessionStatus.Idle,
			modifiedAt: new Date(1).toISOString(),
		}, {
			resource: 'ahp-chat:/other',
			title: 'Other',
			status: SessionStatus.InProgress,
			modifiedAt: new Date(2).toISOString(),
		}],
		defaultChat: 'ahp-chat:/default',
	};
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => {
		resolve = accept;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error('Timed out waiting for condition');
}
