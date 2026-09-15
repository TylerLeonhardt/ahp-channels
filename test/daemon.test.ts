import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ConfigStore, type ChannelInstanceConfig } from '../src/config.js';
import { ChannelOperationError } from '../src/channelHealth.js';
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
			throw new ChannelOperationError('session-resolution', `failed to connect ${definition.session}`);
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
