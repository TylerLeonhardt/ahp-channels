import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore, type ChannelInstanceConfig } from '../src/config.js';
import { FileChannelHandoffStore, type ChannelHandoffRecord } from '../src/channelHandoff.js';
import { ChannelOperationError } from '../src/channelHealth.js';
import {
	DaemonChannelManagementService,
	MANAGEMENT_TOOL_NAMES,
} from '../src/channelManagement.js';
import { requestDaemon, requestDaemonData } from '../src/daemonClient.js';
import { getOrCreateDaemonToken } from '../src/daemonPaths.js';
import { DaemonProtocolError } from '../src/daemonProtocol.js';
import {
	DaemonServer,
	type DaemonRuntimeFactory,
	type DaemonSessionCatalog,
	type ManagedChannelRuntime,
} from '../src/daemonServer.js';
import type { ChannelRuntimeSnapshot } from '../src/channelRuntime.js';
import type {
	ChatDiscoveryRequest,
	ChatDiscoveryResult,
	ChannelBindingTarget,
	ResolvedChannelBinding,
	SessionDiscoveryRequest,
	SessionDiscoveryResult,
} from '../src/sessionCatalog.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

class TestRuntime implements ManagedChannelRuntime {
	closed = false;
	busy = false;
	failClose = false;
	private handoff: {
		readonly id: string;
		readonly ready: Promise<void>;
		readonly resolveReady: () => void;
	} | undefined;
	readonly bindingId = randomUUID();
	private resolveStopped!: () => void;
	readonly whenStopped = new Promise<void>(resolve => {
		this.resolveStopped = resolve;
	});

	constructor(
		readonly name: string,
		readonly definition: ChannelInstanceConfig,
		private readonly startupError?: string,
	) { }

	get snapshot(): ChannelRuntimeSnapshot {
		return {
			name: this.name,
			plugin: this.definition.plugin,
			session: this.definition.session,
			chat: this.definition.chat ?? 'ahp-chat:/default',
			host: this.definition.host === '@source'
				? 'editor:1:source'
				: this.definition.host === '@destination'
					? 'editor:2:destination'
					: this.definition.host === '@fallback'
						? 'editor:3:fallback'
						: 'test-host',
			clientId: 'test-client',
			channelName: 'fake-channel',
			startedAt: new Date(0).toISOString(),
			bindingId: this.bindingId,
			busy: this.busy,
			mode: this.startupError ? 'customization-only' : 'mcp',
		};
	}

	get startupFailure(): ChannelOperationError | undefined {
		return this.startupError
			? new ChannelOperationError('mcp-startup', this.startupError)
			: undefined;
	}

	async quiesce(): Promise<boolean> {
		return !this.busy;
	}

	beginHandoff(id: string): void {
		let resolveReady!: () => void;
		const ready = new Promise<void>(resolve => {
			resolveReady = resolve;
		});
		this.handoff = { id, ready, resolveReady };
		if (!this.busy) {
			resolveReady();
		}
	}

	async waitForHandoffReady(id: string, signal: AbortSignal): Promise<void> {
		if (!this.handoff || this.handoff.id !== id) {
			throw new Error(`Unknown handoff ${id}`);
		}
		await Promise.race([
			this.handoff.ready,
			new Promise<never>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			}),
		]);
	}

	async cancelHandoff(id: string): Promise<void> {
		if (!this.handoff || this.handoff.id !== id) {
			throw new Error(`Unknown handoff ${id}`);
		}
		this.handoff = undefined;
	}

	async quiesceHandoff(id: string): Promise<boolean> {
		return this.handoff?.id === id && !this.busy;
	}

	async activate(): Promise<void> { }

	finishTurn(): void {
		this.busy = false;
		this.handoff?.resolveReady();
	}

	async close(): Promise<void> {
		this.closed = true;
		this.resolveStopped();
		if (this.failClose) {
			throw new Error('close failed');
		}
	}

	stopUnexpectedly(): void {
		this.resolveStopped();
	}
}

class TestRuntimeFactory implements DaemonRuntimeFactory {
	readonly runtimes: TestRuntime[] = [];
	failSession: string | undefined;
	runtimeError: string | undefined;
	runtimeErrorSession: string | undefined;
	validateHook: ((definition: ChannelInstanceConfig) => void | Promise<void>) | undefined;
	startHook: ((definition: ChannelInstanceConfig) => void | Promise<void>) | undefined;

	async validate(definition: ChannelInstanceConfig): Promise<void> {
		await this.validateHook?.(definition);
		if (definition.plugin === 'invalid') {
			throw new Error('invalid plugin');
		}
	}

	async start(name: string, definition: ChannelInstanceConfig): Promise<TestRuntime> {
		await this.startHook?.(definition);
		if (definition.session === this.failSession) {
			throw new ChannelOperationError('session-resolution', `failed to connect ${definition.session}`);
		}
		const runtime = new TestRuntime(
			name,
			definition,
			!this.runtimeErrorSession || definition.session === this.runtimeErrorSession
				? this.runtimeError
				: undefined,
		);
		this.runtimes.push(runtime);
		return runtime;
	}

	prepare(name: string, definition: ChannelInstanceConfig): Promise<TestRuntime> {
		return this.start(name, definition);
	}
}

class TestSessionCatalog implements DaemonSessionCatalog {
	validationError: Error | undefined;
	readonly validations: ChannelBindingTarget[] = [];

	async discoverSessions(request: SessionDiscoveryRequest): Promise<SessionDiscoveryResult> {
		return {
			kind: 'sessions',
			outcome: 'ok',
			items: [{
				host: {
					...(request.host ? { preferred: request.host } : {}),
					actual: request.host === '@destination' ? 'editor:2:destination' : 'editor:1:source',
					fallback: request.host === '@fallback',
				},
				resource: 'ahp-session:/destination',
				title: 'Destination',
				provider: 'test',
				status: 1,
				createdAt: new Date(0).toISOString(),
				modifiedAt: new Date(1).toISOString(),
			}],
			failures: [],
		};
	}

	async discoverChats(request: ChatDiscoveryRequest): Promise<ChatDiscoveryResult> {
		return {
			kind: 'chats',
			outcome: 'ok',
			host: {
				...(request.host ? { preferred: request.host } : {}),
				actual: 'editor:2:destination',
				fallback: false,
			},
			session: {
				resource: request.session,
				title: 'Destination',
				provider: 'test',
				status: 1,
			},
			defaultChat: 'ahp-chat:/destination',
			items: [{
				resource: 'ahp-chat:/destination',
				title: 'Destination chat',
				status: 1,
				modifiedAt: new Date(1).toISOString(),
				isDefault: true,
			}],
			warnings: [],
		};
	}

	async validateBinding(target: ChannelBindingTarget): Promise<ResolvedChannelBinding> {
		this.validations.push(target);
		if (this.validationError) {
			throw this.validationError;
		}
		return {
			...(target.host ? { preferredHost: target.host } : {}),
			actualHost: target.host === '@fallback'
				? 'editor:3:fallback'
				: target.host === '@destination'
					? 'editor:2:destination'
					: target.host === '@source'
						? 'editor:1:source'
					: target.host ?? 'editor:2:destination',
			fallback: target.host === '@fallback',
			session: target.session,
			chat: target.chat ?? 'ahp-chat:/default-destination',
			warnings: target.host === '@fallback'
				? ["Host alias '@fallback' did not connect; using local fallback editor:3:fallback"]
				: [],
		};
	}
}

describe('DaemonServer', () => {
	it('creates, starts, safely switches, retries, stops, and deletes channels', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, factory);
		await server.start();
		try {
			let status = await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: false,
				},
				start: true,
			});
			assert.equal(status.channels[0]?.state, 'running');
			assert.deepEqual(status.channels[0]?.health, { state: 'healthy' });
			assert.equal(factory.runtimes.length, 1);

			factory.runtimes[0].busy = true;
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.switch',
					name: 'personal',
					session: 'ahp-session:/two',
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'CHANNEL_BUSY',
			);
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/one');

			factory.runtimes[0].busy = false;
			factory.validateHook = async definition => {
				if (definition.session === 'ahp-session:/racing') {
					await Promise.resolve();
					factory.runtimes[0].busy = true;
				}
			};
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.switch',
					name: 'personal',
					session: 'ahp-session:/racing',
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'CHANNEL_BUSY',
			);
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/one');
			factory.runtimes[0].busy = false;
			factory.validateHook = undefined;

			status = await requestDaemon(home, {
				command: 'channel.switch',
				name: 'personal',
				session: 'ahp-session:/two',
			});
			assert.equal(status.channels[0]?.runtime?.session, 'ahp-session:/two');
			assert.equal(factory.runtimes[0].closed, true);

			await store.update(config => ({
				...config,
				hostAliases: {
					local: {
						kind: 'socket',
						path: join(home, 'agent-host.sock'),
						withoutAuthentication: true,
					},
				},
			}));
			status = await requestDaemon(home, {
				command: 'channel.rehost',
				name: 'personal',
				host: '@local',
			});
			assert.equal(status.channels[0]?.definition.host, '@local');
			assert.equal(status.channels[0]?.definition.session, 'ahp-session:/two');
			const currentRuntime = factory.runtimes.at(-1);
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.rehost',
					name: 'personal',
					host: '@missing',
				}),
				/references unknown host alias '@missing'/,
			);
			assert.equal((await store.read()).channels['personal'].host, '@local');
			assert.equal(currentRuntime?.closed, false);

			const installation = 'a'.repeat(64);
			await store.update(config => ({
				...config,
				marketplaces: {
					...config.marketplaces,
					test: { source: './marketplace' },
				},
				plugins: {
					...config.plugins,
					fake: {
						marketplace: 'test',
						activeInstallation: installation,
						installations: {
							[installation]: {
								source: './plugins/fake',
							},
						},
					},
				},
			}));
			const beforeRepin = factory.runtimes.length;
			status = await requestDaemon(home, {
				command: 'channel.repin',
				name: 'personal',
				installation,
			});
			assert.equal(status.channels[0]?.definition.installation, installation);
			assert.equal(factory.runtimes.length, beforeRepin + 1);
			assert.equal(factory.runtimes[beforeRepin - 1]?.closed, true);

			const beforeRestartCommand = factory.runtimes.length;
			status = await requestDaemon(home, { command: 'channel.restart', name: 'personal' });
			assert.equal(status.channels[0]?.state, 'running');
			assert.equal(factory.runtimes.length, beforeRestartCommand + 1);

			const beforeFailedRestart = factory.runtimes.length;
			const failingRuntime = factory.runtimes.at(-1);
			assert.ok(failingRuntime);
			failingRuntime.failClose = true;
			await assert.rejects(
				requestDaemon(home, { command: 'channel.restart', name: 'personal' }),
				/close failed/,
			);
			await waitFor(async () => factory.runtimes.length > beforeFailedRestart, 3000);

			factory.failSession = 'ahp-session:/broken';
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.switch',
					name: 'personal',
					session: 'ahp-session:/broken',
				}),
				/Failed to switch channel/,
			);
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/two');
			assert.equal(factory.runtimes.at(-1)?.definition.session, 'ahp-session:/two');
			factory.failSession = undefined;

			const beforeRestart = factory.runtimes.length;
			factory.runtimes.at(-1)?.stopUnexpectedly();
			await waitFor(async () => {
				const channel = (await requestDaemon(home, { command: 'status' })).channels[0];
				return channel?.health.failure?.stage === 'mcp-exit'
					&& channel.health.retry?.attempt === 1
					&& channel.health.retry.nextRetryAt !== undefined;
			}, 500);
			await waitFor(async () => factory.runtimes.length > beforeRestart, 3000);
			status = await requestDaemon(home, { command: 'status' });
			assert.equal(status.channels[0]?.state, 'running');

			const afterFirstRestart = factory.runtimes.length;
			factory.runtimes.at(-1)?.stopUnexpectedly();
			await new Promise(resolve => setTimeout(resolve, 1300));
			assert.equal(factory.runtimes.length, afterFirstRestart);
			await waitFor(async () => factory.runtimes.length > afterFirstRestart, 2500);

			status = await requestDaemon(home, { command: 'channel.stop', name: 'personal' });
			assert.equal(status.channels[0]?.state, 'stopped');
			assert.equal(status.channels[0]?.desired, 'stopped');
			assert.deepEqual(status.channels[0]?.health, { state: 'stopped' });

			status = await requestDaemon(home, { command: 'channel.start', name: 'personal' });
			assert.equal(status.channels[0]?.state, 'running');

			status = await requestDaemon(home, { command: 'channel.delete', name: 'personal' });
			assert.deepEqual(status.channels, []);
			assert.deepEqual((await store.read()).channels, {});
		} finally {
			await server.close();
		}
	});

	it('accepts an agent handoff as pending and applies one cross-host binding after the source turn', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const catalog = new TestSessionCatalog();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			catalog,
		);
		await server.start();
		try {
			let status = await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					chat: 'ahp-chat:/source',
					enabled: false,
				},
				start: true,
			});
			const source = factory.runtimes[0];
			assert.ok(source);
			source.busy = true;

			const management = new DaemonChannelManagementService(home).bind({
				channel: 'personal',
				bindingId: source.bindingId,
				preferredHost: '@source',
				session: 'ahp-session:/source',
				chat: 'ahp-chat:/source',
			});
			const listResult = await management.callTool(
				MANAGEMENT_TOOL_NAMES.listSessions,
				{ limit: 10 },
				new AbortController().signal,
			);
			assert.equal(listResult.success, true);
			assert.equal(listResult.structuredContent?.['kind'], 'sessions');
			await assert.rejects(
				requestDaemonData(home, {
					command: 'catalog.sessions',
					name: 'personal',
					sourceBindingId: randomUUID(),
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'STALE_BINDING',
			);

			const handoffResult = await management.callTool(
				MANAGEMENT_TOOL_NAMES.handoff,
				{
					host: '@destination',
					session: 'ahp-session:/destination',
					chat: 'ahp-chat:/destination',
				},
				new AbortController().signal,
			);
			assert.equal(handoffResult.success, true);
			assert.equal(handoffResult.structuredContent?.['state'], 'pending');
			status = await requestDaemon(home, { command: 'status' });
			const pending = status.channels[0]?.handoff;
			assert.equal(pending?.state, 'pending');
			assert.equal(pending?.resolvedTarget.actualHost, 'editor:2:destination');
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/source');
			assert.equal(source.closed, false);

			const competingToolResult = await management.callTool(
				MANAGEMENT_TOOL_NAMES.handoff,
				{ host: '@destination', session: 'ahp-session:/other' },
				new AbortController().signal,
			);
			assert.equal(competingToolResult.success, false);
			assert.match(competingToolResult.error?.message ?? '', /already pending/);
			assert.equal(source.closed, false);

			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.handoff.request',
					name: 'personal',
					sourceBindingId: source.bindingId,
					target: {
						host: '@destination',
						session: 'ahp-session:/other',
					},
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'HANDOFF_PENDING',
			);

			source.finishTurn();
			await waitFor(async () => {
				const handoff = (await requestDaemon(home, { command: 'status' })).channels[0]?.handoff;
				return handoff?.state === 'applied';
			}, 1000);
			status = await requestDaemon(home, { command: 'status' });
			assert.deepEqual({
				definition: status.channels[0]?.definition,
				runtime: status.channels[0]?.runtime && {
					host: status.channels[0].runtime.host,
					session: status.channels[0].runtime.session,
					chat: status.channels[0].runtime.chat,
				},
				handoff: status.channels[0]?.handoff && {
					state: status.channels[0].handoff.state,
					actualHost: status.channels[0].handoff.resolvedTarget.actualHost,
				},
				sourceClosed: source.closed,
			}, {
				definition: {
					plugin: 'fake',
					host: '@destination',
					session: 'ahp-session:/destination',
					chat: 'ahp-chat:/destination',
					enabled: true,
				},
				runtime: {
					host: 'editor:2:destination',
					session: 'ahp-session:/destination',
					chat: 'ahp-chat:/destination',
				},
				handoff: {
					state: 'applied',
					actualHost: 'editor:2:destination',
				},
				sourceClosed: true,
			});
		} finally {
			await server.close();
		}
	});

	it('allows only the owning source binding to cancel the first pending handoff', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			new TestSessionCatalog(),
		);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: false,
				},
				start: true,
			});
			const source = factory.runtimes[0];
			assert.ok(source);
			source.busy = true;
			const pending = await requestDaemon(home, {
				command: 'channel.handoff.request',
				name: 'personal',
				sourceBindingId: source.bindingId,
				target: {
					host: '@destination',
					session: 'ahp-session:/destination',
				},
			});
			const requestId = pending.channels[0]?.handoff?.requestId;
			assert.ok(requestId);

			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.handoff.cancel',
					name: 'personal',
					sourceBindingId: randomUUID(),
					requestId,
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'STALE_BINDING',
			);
			const cancelled = await requestDaemon(home, {
				command: 'channel.handoff.cancel',
				name: 'personal',
				sourceBindingId: source.bindingId,
				requestId,
			});
			assert.equal(cancelled.channels[0]?.handoff?.state, 'cancelled');
			source.finishTurn();
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/source');
			assert.equal(source.closed, false);
		} finally {
			await server.close();
		}
	});

	it('fails and releases a pending handoff when its source runtime stops unexpectedly', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			new TestSessionCatalog(),
		);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: false,
				},
				start: true,
			});
			const source = factory.runtimes[0];
			assert.ok(source);
			source.busy = true;
			await requestDaemon(home, {
				command: 'channel.handoff.request',
				name: 'personal',
				sourceBindingId: source.bindingId,
				target: {
					host: '@destination',
					session: 'ahp-session:/destination',
				},
			});

			source.stopUnexpectedly();
			await waitFor(async () => {
				const status = await requestDaemon(home, { command: 'status' });
				return status.channels[0]?.handoff?.state === 'failed';
			}, 1000);
			const stopped = await requestDaemon(home, { command: 'channel.stop', name: 'personal' });
			assert.equal(stopped.channels[0]?.desired, 'stopped');
			assert.match(stopped.channels[0]?.handoff?.error ?? '', /source runtime stopped/i);
		} finally {
			await server.close();
		}
	});

	it('does not conflate default-chat semantics with an explicit pin to the same chat', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			new TestSessionCatalog(),
		);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: false,
				},
				start: true,
			});
			const source = factory.runtimes[0];
			assert.ok(source);
			source.busy = true;
			const status = await requestDaemon(home, {
				command: 'channel.handoff.request',
				name: 'personal',
				sourceBindingId: source.bindingId,
				target: {
					host: '@source',
					session: 'ahp-session:/source',
					chat: 'ahp-chat:/default',
				},
			});
			assert.equal(status.channels[0]?.handoff?.state, 'pending');
		} finally {
			await server.close();
		}
	});

	it('executes an explicit cross-host handoff through the real CLI entrypoint', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-cli-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			new TestRuntimeFactory(),
			undefined,
			new TestSessionCatalog(),
		);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: false,
				},
				start: true,
			});
			const output = await runCli(home, [
				'channel',
				'handoff',
				'personal',
				'--host',
				'@destination',
				'--session',
				'ahp-session:/destination',
				'--chat',
				'ahp-chat:/destination',
			]);
			assert.match(output, /Handoff: applied/);
			assert.deepEqual((await store.read()).channels['personal'], {
				plugin: 'fake',
				host: '@destination',
				session: 'ahp-session:/destination',
				chat: 'ahp-chat:/destination',
				enabled: true,
			});
		} finally {
			await server.close();
		}
	});

	it('keeps the committed source binding while the destination is preparing', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(
			home, await getOrCreateDaemonToken(home), store, factory, undefined, new TestSessionCatalog(),
		);
		let prepared!: () => void;
		let release!: () => void;
		const preparing = new Promise<void>(resolve => { prepared = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		let switching: Promise<unknown> | undefined;
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake', host: '@source', session: 'ahp-session:/source', enabled: false,
				},
				start: true,
			});
			factory.startHook = async definition => {
				if (definition.session === 'ahp-session:/destination') {
					prepared();
					await gate;
				}
			};
			switching = requestDaemon(home, {
				command: 'channel.handoff',
				name: 'personal',
				target: { host: '@destination', session: 'ahp-session:/destination' },
			});
			await preparing;
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/source');
			const status = await requestDaemon(home, { command: 'status' });
			assert.equal(status.channels[0]?.handoff?.state, 'pending');
			assert.equal(status.channels[0]?.state, 'starting');
			release();
			await switching;
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/destination');
		} finally {
			release();
			await switching;
			await server.close();
		}
	});

	it('restores the committed source and reports failure when restart interrupts a pending handoff', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		await store.update(config => ({
			...config,
			channels: {
				personal: {
					plugin: 'fake',
					host: '@destination',
					session: 'ahp-session:/destination',
					chat: 'ahp-chat:/destination',
					enabled: true,
				},
			},
		}));
		const now = new Date().toISOString();
		const pending: ChannelHandoffRecord = {
			requestId: randomUUID(),
			state: 'pending',
			requestedAt: now,
			updatedAt: now,
			source: {
				actualHost: 'editor:1:source',
				host: '@source',
				session: 'ahp-session:/source',
				resolvedChat: 'ahp-chat:/source-default',
			},
			target: {
				host: '@destination',
				session: 'ahp-session:/destination',
				chat: 'ahp-chat:/destination',
			},
			resolvedTarget: {
				preferredHost: '@destination',
				actualHost: 'editor:2:destination',
				fallback: false,
				session: 'ahp-session:/destination',
				chat: 'ahp-chat:/destination',
				warnings: [],
			},
		};
		await new FileChannelHandoffStore(home).write('personal', pending);
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			new TestSessionCatalog(),
		);

		await server.start();
		try {
			const status = await requestDaemon(home, { command: 'status' });
			assert.deepEqual({
				definition: status.channels[0]?.definition,
				handoffState: status.channels[0]?.handoff?.state,
				handoffError: status.channels[0]?.handoff?.error,
			}, {
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: true,
				},
				handoffState: 'failed',
				handoffError: 'Daemon restarted before the handoff was applied; the committed source binding was restored',
			});
		} finally {
			await server.close();
		}
	});

	it('validates the destination before stopping and rolls back a failed cross-host start', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-handoff-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await configureHostAliases(store, home);
		const factory = new TestRuntimeFactory();
		const catalog = new TestSessionCatalog();
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			factory,
			undefined,
			catalog,
		);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					host: '@source',
					session: 'ahp-session:/source',
					enabled: false,
				},
				start: true,
			});
			const source = factory.runtimes[0];
			assert.ok(source);
			catalog.validationError = new Error('destination unavailable');
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.handoff',
					name: 'personal',
					target: {
						host: '@destination',
						session: 'ahp-session:/destination',
					},
				}),
				(error: unknown) => error instanceof DaemonProtocolError
					&& error.code === 'INVALID_TARGET',
			);
			assert.equal(source.closed, false);
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/source');

			catalog.validationError = undefined;
			factory.failSession = 'ahp-session:/destination';
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.handoff',
					name: 'personal',
					target: {
						host: '@fallback',
						session: 'ahp-session:/destination',
					},
				}),
				/Failed to switch channel/,
			);
			const status = await requestDaemon(home, { command: 'status' });
			assert.equal(status.channels[0]?.handoff?.state, 'failed');
			assert.equal(status.channels[0]?.handoff?.resolvedTarget.actualHost, 'editor:3:fallback');
			assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/source');
			assert.equal(factory.runtimes.at(-1)?.definition.session, 'ahp-session:/source');

			factory.failSession = undefined;
			factory.runtimeError = 'destination channel setup is incomplete';
			factory.runtimeErrorSession = 'ahp-session:/destination';
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.handoff',
					name: 'personal',
					target: {
						host: '@destination',
						session: 'ahp-session:/destination',
					},
				}),
				/Failed to switch channel/,
			);
			const degraded = await requestDaemon(home, { command: 'status' });
			assert.equal(degraded.channels[0]?.handoff?.state, 'failed');
			assert.equal(degraded.channels[0]?.definition.session, 'ahp-session:/source');
			assert.equal(degraded.channels[0]?.runtime?.session, 'ahp-session:/source');
			assert.equal(degraded.channels[0]?.runtime?.mode, 'mcp');
		} finally {
			await server.close();
		}
	});

	it('reports a customization-only runtime as an error', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		const factory = new TestRuntimeFactory();
		factory.runtimeError = 'Plugin setup required';
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, factory);
		await server.start();
		try {
			const status = await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: false,
				},
				start: true,
			});

			assert.deepEqual({
				state: status.channels[0]?.state,
				health: status.channels[0]?.health,
				hasRuntime: status.channels[0]?.runtime !== undefined,
			}, {
				state: 'error',
				health: {
					state: 'degraded',
					failure: {
						stage: 'mcp-startup',
						summary: 'Plugin setup required',
						failedAt: status.channels[0]?.health.failure?.failedAt,
						guidance: 'Run the plugin setup skill in the target session, then wait for retry or restart the channel.',
					},
					retry: {
						attempt: 1,
						state: 'scheduled',
						nextRetryAt: status.channels[0]?.health.retry?.nextRetryAt,
					},
				},
				hasRuntime: true,
			});

			factory.runtimeError = undefined;
			await waitFor(async () => factory.runtimes.length > 1, 3000);
			const recovered = await requestDaemon(home, { command: 'status' });
			assert.deepEqual({
				state: recovered.channels[0]?.state,
				health: recovered.channels[0]?.health,
				failedRuntimeClosed: factory.runtimes[0]?.closed,
			}, {
				state: 'running',
				health: { state: 'healthy' },
				failedRuntimeClosed: true,
			});
			await assert.rejects(access(join(home, 'instances', 'personal', 'health.json')));
		} finally {
			await server.close();
		}
	});

	it('preserves failure and retry attempts across a daemon restart', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			channels: {
				remembered: {
					plugin: 'fake',
					session: 'ahp-session:/remembered',
					enabled: true,
				},
			},
		}));

		const firstFactory = new TestRuntimeFactory();
		firstFactory.failSession = 'ahp-session:/remembered';
		const first = new DaemonServer(home, await getOrCreateDaemonToken(home), store, firstFactory);
		await first.start();
		const firstStatus = await requestDaemon(home, { command: 'status' });
		assert.equal(firstStatus.channels[0]?.health.failure?.summary, 'failed to connect ahp-session:/remembered');
		assert.equal(firstStatus.channels[0]?.health.retry?.attempt, 1);
		await first.close();

		const secondFactory = new TestRuntimeFactory();
		secondFactory.failSession = 'ahp-session:/remembered';
		const second = new DaemonServer(home, await getOrCreateDaemonToken(home), store, secondFactory);
		await second.start();
		try {
			const secondStatus = await requestDaemon(home, { command: 'status' });
			assert.equal(secondStatus.channels[0]?.health.failure?.summary, 'failed to connect ahp-session:/remembered');
			assert.equal(secondStatus.channels[0]?.health.retry?.attempt, 2);
			assert.ok(secondStatus.channels[0]?.health.retry?.nextRetryAt);
		} finally {
			await second.close();
		}
	});

	it('fails explicitly when persisted health state is invalid', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			channels: {
				remembered: {
					plugin: 'fake',
					session: 'ahp-session:/remembered',
					enabled: false,
				},
			},
		}));
		const healthDirectory = join(home, 'instances', 'remembered');
		await mkdir(healthDirectory, { recursive: true });
		await writeFile(join(healthDirectory, 'health.json'), '{"version":1,"failure":{"stage":"made-up"}}');
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, new TestRuntimeFactory());

		await assert.rejects(server.start(), /Invalid channel health state/);
		await server.close();
	});

	it('prints actionable diagnostics without exposing secrets', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		const factory = new TestRuntimeFactory();
		factory.runtimeError = 'token=super-secret setup required';
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, factory);
		await server.start();
		try {
			await requestDaemon(home, {
				command: 'channel.create',
				name: 'personal',
				definition: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: false,
				},
				start: true,
			});

			const output = await runCli(home, ['channel', 'status', 'personal']);
			assert.match(output, /personal: (?:error|starting) \(degraded\)/);
			assert.match(output, /Mode: customizations available; channel MCP server unavailable/);
			assert.match(output, /Failure stage: mcp-startup/);
			assert.match(output, /Error: token=\[redacted\] setup required/);
			assert.match(output, /Failed at: /);
			assert.match(output, /Recovery: Run the plugin setup skill/);
			assert.match(output, /Retry: attempt [1-9][0-9]* \(scheduled\)/);
			assert.match(output, /Next retry: /);
			assert.doesNotMatch(output, /super-secret/);
		} finally {
			await server.close();
		}
	});

	it('rejects invalid channel definitions without persisting them', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		const server = new DaemonServer(
			home,
			await getOrCreateDaemonToken(home),
			store,
			new TestRuntimeFactory(),
		);
		await server.start();
		try {
			await assert.rejects(
				requestDaemon(home, {
					command: 'channel.create',
					name: 'invalid/name',
					definition: {
						plugin: 'fake',
						session: 'ahp-session:/one',
						enabled: false,
					},
					start: false,
				}),
				(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_CHANNEL',
			);
			assert.deepEqual((await store.read()).channels, {});
		} finally {
			await server.close();
		}
	});

	it('restarts desired channels when the daemon starts', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			channels: {
				remembered: {
					plugin: 'fake',
					session: 'ahp-session:/remembered',
					enabled: true,
				},
			},
		}));
		const factory = new TestRuntimeFactory();
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, factory);

		await server.start();
		try {
			const status = await requestDaemon(home, { command: 'status' });
			assert.deepEqual({
				state: status.channels[0]?.state,
				session: factory.runtimes[0]?.definition.session,
			}, {
				state: 'running',
				session: 'ahp-session:/remembered',
			});
		} finally {
			await server.close();
		}
	});

	it('preserves alias and URI bindings across daemon restoration', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			hostAliases: {
				local: {
					kind: 'socket',
					path: join(home, 'agent-host.sock'),
					withoutAuthentication: true,
				},
			},
			channels: {
				remembered: {
					plugin: 'fake',
					session: 'ahp-session:/remembered',
					chat: 'ahp-chat:/remembered',
					host: '@local',
					enabled: true,
				},
			},
		}));

		const firstFactory = new TestRuntimeFactory();
		const first = new DaemonServer(home, await getOrCreateDaemonToken(home), store, firstFactory);
		await first.start();
		assert.equal(firstFactory.runtimes[0]?.definition.host, '@local');
		await first.close();

		const secondFactory = new TestRuntimeFactory();
		const second = new DaemonServer(home, await getOrCreateDaemonToken(home), store, secondFactory);
		await second.start();
		try {
			const restored = secondFactory.runtimes[0]?.definition;
			assert.deepEqual({
				host: restored?.host,
				session: restored?.session,
				chat: restored?.chat,
			}, {
				host: '@local',
				session: 'ahp-session:/remembered',
				chat: 'ahp-chat:/remembered',
			});
		} finally {
			await second.close();
		}
	});

	it('gates commands until startup reconciliation completes', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			channels: {
				remembered: {
					plugin: 'fake',
					session: 'ahp-session:/remembered',
					enabled: true,
				},
			},
		}));
		const factory = new TestRuntimeFactory();
		let releaseStart!: () => void;
		const startGate = new Promise<void>(resolve => {
			releaseStart = resolve;
		});
		factory.startHook = () => startGate;
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, factory);
		const starting = server.start();
		await server.whenListening;
		let commandCompleted = false;
		const command = requestDaemon(home, { command: 'channel.start', name: 'remembered' })
			.then(status => {
				commandCompleted = true;
				return status;
			});

		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(commandCompleted, false);
		releaseStart();
		await starting;
		try {
			const status = await command;
			assert.equal(status.channels[0]?.state, 'running');
			assert.equal(factory.runtimes.length, 1);
		} finally {
			await server.close();
		}
	});

	it('does not remove another daemon socket after losing a start race', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		const token = await getOrCreateDaemonToken(home);
		const winner = new DaemonServer(home, token, store, new TestRuntimeFactory());
		const loser = new DaemonServer(home, token, store, new TestRuntimeFactory());
		await winner.start();
		try {
			await assert.rejects(loser.start());
			await loser.close();
			const status = await requestDaemon(home, { command: 'ping' });
			assert.equal(status.pid, process.pid);
		} finally {
			await winner.close();
		}
	});

	it('does not report healthy channels as failed while shutting down', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-daemon-'));
		temporaryDirectories.push(home);
		const store = new ConfigStore(home);
		await store.update(config => ({
			...config,
			channels: {
				personal: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					enabled: true,
				},
			},
		}));
		const server = new DaemonServer(home, await getOrCreateDaemonToken(home), store, new TestRuntimeFactory());
		await server.start();

		const status = await requestDaemon(home, { command: 'shutdown' });
		assert.deepEqual(status.channels[0]?.health, { state: 'healthy' });
		await server.whenClosed;
	});
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Timed out waiting for condition');
}

async function configureHostAliases(store: ConfigStore, home: string): Promise<void> {
	await store.update(config => ({
		...config,
		hostAliases: {
			source: {
				kind: 'socket',
				path: join(home, 'source.sock'),
				withoutAuthentication: true,
			},
			destination: {
				kind: 'socket',
				path: join(home, 'destination.sock'),
				withoutAuthentication: true,
			},
			fallback: {
				kind: 'socket',
				path: join(home, 'fallback.sock'),
				withoutAuthentication: true,
			},
		},
	}));
}

function runCli(home: string, args: readonly string[]): Promise<string> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [
			'--import',
			'tsx',
			join(import.meta.dirname, '..', 'src', 'cli.ts'),
			...args,
		], {
			cwd: join(import.meta.dirname, '..'),
			env: { ...process.env, AHP_CHANNELS_HOME: home },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', chunk => stderr += chunk);
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolveRun(stdout);
			} else {
				reject(new Error(`CLI exited with ${code}: ${stderr}`));
			}
		});
	});
}
