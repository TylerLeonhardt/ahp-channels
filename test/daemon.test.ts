import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore, type ChannelInstanceConfig } from '../src/config.js';
import { requestDaemon } from '../src/daemonClient.js';
import { getOrCreateDaemonToken } from '../src/daemonPaths.js';
import { DaemonProtocolError } from '../src/daemonProtocol.js';
import { DaemonServer, type DaemonRuntimeFactory, type ManagedChannelRuntime } from '../src/daemonServer.js';
import type { ChannelRuntimeSnapshot } from '../src/channelRuntime.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

class TestRuntime implements ManagedChannelRuntime {
	closed = false;
	busy = false;
	failClose = false;
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
			host: 'test-host',
			clientId: 'test-client',
			channelName: 'fake-channel',
			startedAt: new Date(0).toISOString(),
			busy: this.busy,
			...(this.startupError ? { error: this.startupError } : {}),
		};
	}

	async quiesce(): Promise<boolean> {
		return !this.busy;
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
			throw new Error(`failed to connect ${definition.session}`);
		}
		const runtime = new TestRuntime(name, definition, this.runtimeError);
		this.runtimes.push(runtime);
		return runtime;
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

			status = await requestDaemon(home, { command: 'channel.start', name: 'personal' });
			assert.equal(status.channels[0]?.state, 'running');

			status = await requestDaemon(home, { command: 'channel.delete', name: 'personal' });
			assert.deepEqual(status.channels, []);
			assert.deepEqual((await store.read()).channels, {});
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
				error: status.channels[0]?.error,
				hasRuntime: status.channels[0]?.runtime !== undefined,
			}, {
				state: 'error',
				error: 'Plugin setup required',
				hasRuntime: true,
			});

			factory.runtimeError = undefined;
			await waitFor(async () => factory.runtimes.length > 1, 3000);
			const recovered = await requestDaemon(home, { command: 'status' });
			assert.deepEqual({
				state: recovered.channels[0]?.state,
				error: recovered.channels[0]?.error,
				failedRuntimeClosed: factory.runtimes[0]?.closed,
			}, {
				state: 'running',
				error: undefined,
				failedRuntimeClosed: true,
			});
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
