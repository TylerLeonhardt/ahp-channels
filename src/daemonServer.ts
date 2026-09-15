import { timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { ChannelRuntime, validateChannelDefinition, type ChannelRuntimeSnapshot } from './channelRuntime.js';
import { ConfigStore, isValidChannelInstanceName, retargetChannelInstance, type AppConfig, type ChannelInstanceConfig } from './config.js';
import { getDaemonPaths } from './daemonPaths.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolError,
	MAX_DAEMON_MESSAGE_BYTES,
	parseDaemonRequest,
	type ChannelDaemonState,
	type ChannelDaemonStatus,
	type DaemonRequestBody,
	type DaemonResponse,
	type DaemonStatus,
} from './daemonProtocol.js';
import type { PluginManager } from './plugins.js';

export interface ManagedChannelRuntime {
	readonly snapshot: ChannelRuntimeSnapshot;
	readonly whenStopped: Promise<void>;
	tryQuiesce(): boolean;
	close(): Promise<void>;
}

export interface DaemonRuntimeFactory {
	validate(definition: ChannelInstanceConfig): Promise<void>;
	start(name: string, definition: ChannelInstanceConfig, onStatus: (message: string) => void): Promise<ManagedChannelRuntime>;
}

export class DaemonServer {
	private readonly server: Server;
	private readonly startedAt = new Date().toISOString();
	private readonly runtimes = new Map<string, ManagedChannelRuntime>();
	private readonly transitions = new Map<string, ChannelDaemonState>();
	private readonly failures = new Map<string, string>();
	private readonly restartAttempts = new Map<string, number>();
	private readonly restartTimers = new Map<string, NodeJS.Timeout>();
	private readonly stabilityTimers = new Map<string, NodeJS.Timeout>();
	private operationQueue: Promise<void> = Promise.resolve();
	private closing = false;
	private endpointOwned = false;
	private closePromise: Promise<void> | undefined;
	private resolveClosed!: () => void;
	private resolveReady!: () => void;
	private rejectReady!: (error: unknown) => void;
	private resolveListening!: () => void;
	private rejectListening!: (error: unknown) => void;
	readonly whenClosed = new Promise<void>(resolve => {
		this.resolveClosed = resolve;
	});
	readonly whenListening = new Promise<void>((resolve, reject) => {
		this.resolveListening = resolve;
		this.rejectListening = reject;
	});
	private readonly whenReady = new Promise<void>((resolve, reject) => {
		this.resolveReady = resolve;
		this.rejectReady = reject;
	});

	constructor(
		private readonly home: string,
		private readonly token: string,
		private readonly configStore: ConfigStore,
		private readonly runtimeFactory: DaemonRuntimeFactory,
	) {
		this.server = createServer(socket => this.handleConnection(socket));
		void this.whenReady.catch(() => undefined);
		void this.whenListening.catch(() => undefined);
	}

	async start(): Promise<void> {
		const endpoint = getDaemonPaths(this.home).endpoint;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					this.server.off('listening', onListening);
					this.rejectListening(error);
					reject(error);
				};
				const onListening = () => {
					this.server.off('error', onError);
					this.endpointOwned = true;
					this.resolveListening();
					resolve();
				};
				this.server.once('error', onError);
				this.server.once('listening', onListening);
				this.server.listen(endpoint);
			});
			if (process.platform !== 'win32') {
				await chmod(endpoint, 0o600);
			}
			const initialization = this.operationQueue.then(() => this.reconcileEnabledChannels());
			this.operationQueue = initialization.catch(() => undefined);
			await initialization;
			this.resolveReady();
		} catch (error) {
			this.rejectReady(error);
			throw error;
		}
	}

	async close(): Promise<void> {
		this.closePromise ??= this.doClose();
		return this.closePromise;
	}

	private async doClose(): Promise<void> {
		if (this.closing) {
			return;
		}
		this.closing = true;
		for (const timer of this.restartTimers.values()) {
			clearTimeout(timer);
		}
		this.restartTimers.clear();
		for (const timer of this.stabilityTimers.values()) {
			clearTimeout(timer);
		}
		this.stabilityTimers.clear();
		await this.operationQueue.catch(error => {
			console.error(`[daemon] In-flight operation failed during shutdown: ${formatError(error)}`);
		});

		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		const runtimeResults = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
		const errors: Error[] = [];
		for (const result of runtimeResults) {
			if (result.status === 'rejected') {
				errors.push(toError('channel cleanup', result.reason));
			}
		}

		try {
			await new Promise<void>(resolve => {
				if (!this.server.listening) {
					resolve();
					return;
				}
				this.server.close(() => resolve());
			});
			if (this.endpointOwned && process.platform !== 'win32') {
				await rm(getDaemonPaths(this.home).endpoint, { force: true });
			}
		} catch (error) {
			errors.push(toError('control endpoint cleanup', error));
		} finally {
			this.resolveClosed();
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Daemon cleanup failed');
		}
	}

	private handleConnection(socket: Socket): void {
		socket.setEncoding('utf8');
		socket.setTimeout(10_000, () => socket.destroy());
		let buffer = '';
		let handled = false;
		socket.on('data', chunk => {
			if (handled) {
				return;
			}
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_DAEMON_MESSAGE_BYTES) {
				handled = true;
				this.writeResponse(socket, errorResponse('MESSAGE_TOO_LARGE', 'Daemon request exceeds the message size limit'));
				return;
			}
			const newline = buffer.indexOf('\n');
			if (newline < 0) {
				return;
			}
			handled = true;
			socket.setTimeout(0);
			void this.processRequest(buffer.slice(0, newline))
				.then(response => this.writeResponse(socket, response))
				.catch(error => this.writeResponse(socket, errorResponse(
					error instanceof DaemonProtocolError ? error.code : 'INTERNAL_ERROR',
					formatError(error),
				)));
		});
		socket.once('error', error => {
			console.error(`[daemon] Control connection failed: ${error.message}`);
		});
	}

	private writeResponse(socket: Socket, response: DaemonResponse): void {
		socket.end(`${JSON.stringify(response)}\n`);
	}

	private async processRequest(raw: string): Promise<DaemonResponse> {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new DaemonProtocolError('INVALID_REQUEST', 'Daemon request is not valid JSON', { cause: error });
		}
		const request = parseDaemonRequest(value);
		if (!tokensEqual(request.token, this.token)) {
			throw new DaemonProtocolError('UNAUTHORIZED', 'Invalid daemon control token');
		}
		await this.whenReady;
		const result = await this.handleRequest(request.body);
		return {
			version: DAEMON_PROTOCOL_VERSION,
			ok: true,
			result,
		};
	}

	private async handleRequest(request: DaemonRequestBody): Promise<DaemonStatus> {
		if (this.closing && request.command !== 'ping' && request.command !== 'status') {
			throw new DaemonProtocolError('SHUTTING_DOWN', 'Daemon is shutting down');
		}
		switch (request.command) {
			case 'ping':
			case 'status':
				return this.status();
			case 'shutdown':
				setImmediate(() => void this.close().catch(error => {
					console.error(`[daemon] Shutdown failed: ${formatError(error)}`);
				}));
				return this.status();
			case 'channel.create':
				return this.enqueue(async () => {
					assertChannelName(request.name);
					const config = await this.configStore.read();
					if (config.channels[request.name]) {
						throw new DaemonProtocolError('ALREADY_EXISTS', `Channel '${request.name}' already exists`);
					}
					const definition = { ...request.definition, enabled: request.start };
					await this.runtimeFactory.validate(definition);
					await this.configStore.update(current => withChannel(current, request.name, definition));
					if (definition.enabled) {
						await this.startDesired(request.name, definition);
					}
				});
			case 'channel.start':
				return this.enqueue(async () => {
					const definition = await this.getDefinition(request.name);
					const enabled = { ...definition, enabled: true };
					await this.configStore.update(current => withChannel(current, request.name, enabled));
					await this.startDesired(request.name, enabled);
				});
			case 'channel.stop':
				return this.enqueue(async () => {
					const definition = await this.getDefinition(request.name);
					await this.configStore.update(current => withChannel(current, request.name, { ...definition, enabled: false }));
					try {
						await this.stopOne(request.name);
						this.failures.delete(request.name);
					} catch (error) {
						this.failures.set(request.name, formatError(error));
						throw error;
					}
				});
			case 'channel.switch':
				return this.enqueue(async () => this.switchOne(request.name, request.session, request.chat));
			case 'channel.delete':
				return this.enqueue(async () => {
					await this.getDefinition(request.name);
					if (this.runtimes.get(request.name)?.snapshot.busy) {
						throw new DaemonProtocolError('CHANNEL_BUSY', `Channel '${request.name}' is processing a turn`);
					}
					let stopError: unknown;
					try {
						await this.stopOne(request.name);
					} catch (error) {
						stopError = error;
					}
					await this.configStore.update(current => withoutChannel(current, request.name));
					this.failures.delete(request.name);
					if (stopError) {
						throw stopError;
					}
				});
		}
	}

	private enqueue(operation: () => Promise<void>): Promise<DaemonStatus> {
		const queued = this.operationQueue.then(operation);
		this.operationQueue = queued.catch(() => undefined);
		return queued.then(() => this.status());
	}

	private async status(): Promise<DaemonStatus> {
		const config = await this.configStore.read();
		const channels: ChannelDaemonStatus[] = Object.entries(config.channels)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, definition]) => {
				const runtime = this.runtimes.get(name);
				const transition = this.transitions.get(name);
				const failure = this.failures.get(name);
				return {
					name,
					desired: definition.enabled ? 'running' : 'stopped',
					state: transition ?? (runtime ? 'running' : failure ? 'error' : 'stopped'),
					definition,
					...(runtime ? { runtime: runtime.snapshot } : {}),
					...(failure ? { error: failure } : {}),
				};
			});
		return {
			pid: process.pid,
			startedAt: this.startedAt,
			channels,
		};
	}

	private async reconcileEnabledChannels(): Promise<void> {
		const config = await this.configStore.read();
		for (const [name, definition] of Object.entries(config.channels)) {
			if (!definition.enabled) {
				continue;
			}
			try {
				await this.startOne(name, definition);
			} catch (error) {
				this.failures.set(name, formatError(error));
				this.scheduleRestart(name);
			}
		}
	}

	private async startOne(name: string, definition: ChannelInstanceConfig): Promise<void> {
		const existing = this.runtimes.get(name);
		if (existing) {
			return;
		}
		this.clearRestart(name);
		this.transitions.set(name, 'starting');
		try {
			const runtime = await this.runtimeFactory.start(name, definition, message => {
				console.log(`[channel:${name}] ${message}`);
			});
			this.runtimes.set(name, runtime);
			this.failures.delete(name);
			this.markStableAfterDelay(name, runtime);
			void runtime.whenStopped.then(
				() => this.handleUnexpectedStop(name, runtime, new Error('Channel runtime stopped unexpectedly')),
				error => this.handleUnexpectedStop(name, runtime, error),
			);
		} catch (error) {
			this.failures.set(name, formatError(error));
			throw error;
		} finally {
			this.transitions.delete(name);
		}
	}

	private async startDesired(name: string, definition: ChannelInstanceConfig): Promise<void> {
		this.restartAttempts.delete(name);
		try {
			await this.startOne(name, definition);
		} catch (error) {
			this.scheduleRestart(name);
			throw error;
		}
	}

	private async stopOne(name: string): Promise<void> {
		this.clearRestart(name);
		this.clearStability(name);
		this.restartAttempts.delete(name);
		const runtime = this.runtimes.get(name);
		if (!runtime) {
			return;
		}
		this.runtimes.delete(name);
		this.transitions.set(name, 'stopping');
		try {
			await runtime.close();
		} finally {
			this.transitions.delete(name);
		}
	}

	private async switchOne(name: string, session: string, chat?: string): Promise<void> {
		const previous = await this.getDefinition(name);
		const runtime = this.runtimes.get(name);
		const next = retargetChannelInstance(previous, session, chat);
		await this.runtimeFactory.validate(next);
		if (runtime && !runtime.tryQuiesce()) {
			throw new DaemonProtocolError('CHANNEL_BUSY', `Channel '${name}' is processing a turn`);
		}
		const wasRunning = runtime !== undefined;
		try {
			await this.stopOne(name);
		} catch (error) {
			if (previous.enabled) {
				this.scheduleRestart(name);
			}
			throw error;
		}
		await this.configStore.update(current => withChannel(current, name, next));
		try {
			if (next.enabled) {
				this.restartAttempts.delete(name);
				await this.startOne(name, next);
			}
		} catch (switchError) {
			const errors = [toError('new binding', switchError)];
			await this.configStore.update(current => withChannel(current, name, previous));
			if (wasRunning || previous.enabled) {
				try {
					await this.startOne(name, previous);
				} catch (rollbackError) {
					errors.push(toError('rollback', rollbackError));
					this.scheduleRestart(name);
				}
			}
			throw new AggregateError(errors, `Failed to switch channel '${name}'`);
		}
	}

	private async getDefinition(name: string): Promise<ChannelInstanceConfig> {
		assertChannelName(name);
		const definition = (await this.configStore.read()).channels[name];
		if (!definition) {
			throw new DaemonProtocolError('NOT_FOUND', `Channel '${name}' does not exist`);
		}
		return definition;
	}

	private handleUnexpectedStop(name: string, runtime: ManagedChannelRuntime, error: unknown): void {
		if (this.closing || this.runtimes.get(name) !== runtime) {
			return;
		}
		this.runtimes.delete(name);
		this.clearStability(name);
		this.failures.set(name, formatError(error));
		this.transitions.set(name, 'stopping');
		void this.enqueue(async () => {
			try {
				await runtime.close();
			} catch (closeError) {
				console.error(`[channel:${name}] Cleanup after failure failed: ${formatError(closeError)}`);
			} finally {
				this.transitions.delete(name);
			}
			const definition = (await this.configStore.read()).channels[name];
			if (definition?.enabled) {
				this.scheduleRestart(name);
			}
		}).catch(cleanupError => {
			console.error(`[channel:${name}] Failed to process runtime exit: ${formatError(cleanupError)}`);
		});
	}

	private scheduleRestart(name: string): void {
		if (this.closing || this.restartTimers.has(name)) {
			return;
		}
		const attempt = (this.restartAttempts.get(name) ?? 0) + 1;
		this.restartAttempts.set(name, attempt);
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
		const timer = setTimeout(() => {
			this.restartTimers.delete(name);
			void this.enqueue(async () => {
				const definition = (await this.configStore.read()).channels[name];
				if (!definition?.enabled || this.runtimes.has(name)) {
					return;
				}
				try {
					await this.startOne(name, definition);
				} catch {
					this.scheduleRestart(name);
				}
			}).catch(error => {
				console.error(`[channel:${name}] Restart failed: ${formatError(error)}`);
			});
		}, delay);
		timer.unref();
		this.restartTimers.set(name, timer);
	}

	private clearRestart(name: string): void {
		const timer = this.restartTimers.get(name);
		if (timer) {
			clearTimeout(timer);
			this.restartTimers.delete(name);
		}
	}

	private markStableAfterDelay(name: string, runtime: ManagedChannelRuntime): void {
		this.clearStability(name);
		const timer = setTimeout(() => {
			this.stabilityTimers.delete(name);
			if (this.runtimes.get(name) === runtime) {
				this.restartAttempts.delete(name);
			}
		}, 30_000);
		timer.unref();
		this.stabilityTimers.set(name, timer);
	}

	private clearStability(name: string): void {
		const timer = this.stabilityTimers.get(name);
		if (timer) {
			clearTimeout(timer);
			this.stabilityTimers.delete(name);
		}
	}
}

export function createDaemonRuntimeFactory(
	services: Parameters<typeof ChannelRuntime.start>[2],
	plugins: PluginManager,
): DaemonRuntimeFactory {
	return {
		async validate(definition) {
			try {
				await validateChannelDefinition(plugins, definition);
			} catch (error) {
				throw new DaemonProtocolError('INVALID_CHANNEL', formatError(error), { cause: error });
			}
		},
		start: (name, definition, onStatus) => ChannelRuntime.start(name, definition, services, onStatus),
	};
}

function withChannel(config: AppConfig, name: string, definition: ChannelInstanceConfig): AppConfig {
	return {
		...config,
		channels: {
			...config.channels,
			[name]: definition,
		},
	};
}

function withoutChannel(config: AppConfig, name: string): AppConfig {
	const channels = { ...config.channels };
	delete channels[name];
	return { ...config, channels };
}

function assertChannelName(name: string): void {
	if (!isValidChannelInstanceName(name)) {
		throw new DaemonProtocolError('INVALID_CHANNEL', `Invalid channel name '${name}'`);
	}
}

function tokensEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function errorResponse(code: string, message: string): DaemonResponse {
	return {
		version: DAEMON_PROTOCOL_VERSION,
		ok: false,
		error: { code, message },
	};
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toError(label: string, error: unknown): Error {
	return new Error(`${label}: ${formatError(error)}`, { cause: error });
}
