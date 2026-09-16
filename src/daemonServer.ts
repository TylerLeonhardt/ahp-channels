import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { ChannelRuntime, validateChannelDefinition, type ChannelRuntimeSnapshot } from './channelRuntime.js';
import { ChannelBindingError, ChannelBindingService } from './channelBindings.js';
import {
	FileChannelHandoffStore,
	failedHandoff,
	type ChannelHandoffRecord,
} from './channelHandoff.js';
import {
	ChannelOperationError,
	FileChannelHealthStore,
	failureFromError,
	recoveryGuidance,
	type ChannelHealth,
	type PersistedChannelHealth,
} from './channelHealth.js';
import {
	ConfigStore,
	isValidChannelInstanceName,
	rebindChannelInstance,
	retargetChannelInstance,
	validateAppConfig,
	type AppConfig,
	type ChannelInstanceConfig,
} from './config.js';
import { ConsoleDaemonLogger, type DaemonLogger } from './daemonLog.js';
import { getDaemonPaths } from './daemonPaths.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolError,
	MAX_DAEMON_MESSAGE_BYTES,
	parseDaemonRequest,
	type ChannelDaemonState,
	type ChannelDaemonStatus,
	type DaemonRequestBody,
	type DaemonCommandResult,
	type DaemonResponse,
	type DaemonResponseData,
	type DaemonStatus,
} from './daemonProtocol.js';
import type { PluginManager } from './plugins.js';
import type {
	ChatDiscoveryRequest,
	ChatDiscoveryResult,
	ChannelBindingTarget,
	ResolvedChannelBinding,
	SessionDiscoveryRequest,
	SessionDiscoveryResult,
} from './sessionCatalog.js';
import type { StatusReporter } from './status.js';

export interface ManagedChannelRuntime {
	readonly snapshot: ChannelRuntimeSnapshot;
	readonly whenStopped: Promise<void>;
	readonly startupFailure?: ChannelOperationError;
	quiesce(): Promise<boolean>;
	beginHandoff(id: string): void;
	waitForHandoffReady(id: string, signal: AbortSignal): Promise<void>;
	cancelHandoff(id: string): Promise<void>;
	quiesceHandoff(id: string): Promise<boolean>;
	activate(): Promise<void>;
	close(): Promise<void>;
}

export interface DaemonRuntimeFactory {
	validate(definition: ChannelInstanceConfig): Promise<void>;
	start(name: string, definition: ChannelInstanceConfig, status: StatusReporter): Promise<ManagedChannelRuntime>;
	prepare(name: string, definition: ChannelInstanceConfig, status: StatusReporter): Promise<ManagedChannelRuntime>;
}

export interface DaemonSessionCatalog {
	discoverSessions(request: SessionDiscoveryRequest, signal?: AbortSignal): Promise<SessionDiscoveryResult>;
	discoverChats(request: ChatDiscoveryRequest, signal?: AbortSignal): Promise<ChatDiscoveryResult>;
	validateBinding(target: ChannelBindingTarget, signal?: AbortSignal): Promise<ResolvedChannelBinding>;
}

interface PendingHandoffOperation {
	readonly record: ChannelHandoffRecord;
	readonly runtime: ManagedChannelRuntime;
	readonly next: ChannelInstanceConfig;
	readonly abort: AbortController;
}

export class DaemonServer {
	private readonly server: Server;
	private readonly startedAt = new Date().toISOString();
	private readonly runtimes = new Map<string, ManagedChannelRuntime>();
	private readonly transitions = new Map<string, ChannelDaemonState>();
	private readonly healthRecords = new Map<string, PersistedChannelHealth>();
	private readonly handoffRecords = new Map<string, ChannelHandoffRecord>();
	private readonly pendingHandoffs = new Map<string, PendingHandoffOperation>();
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
	private readonly healthStore: FileChannelHealthStore;
	private readonly handoffStore: FileChannelHandoffStore;
	private readonly bindings: ChannelBindingService;
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
		private readonly logger: DaemonLogger = new ConsoleDaemonLogger(),
		private readonly sessionCatalog?: DaemonSessionCatalog,
	) {
		this.server = createServer(socket => this.handleConnection(socket));
		this.healthStore = new FileChannelHealthStore(home);
		this.handoffStore = new FileChannelHandoffStore(home);
		this.bindings = new ChannelBindingService(configStore, this.handoffStore);
		void this.whenReady.catch(() => undefined);
		void this.whenListening.catch(() => undefined);
	}

	async start(): Promise<void> {
		const endpoint = getDaemonPaths(this.home).endpoint;
		try {
			let config = await this.configStore.read();
			await this.loadHealth(config);
			config = await this.loadHandoffs(config);
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
			const initialization = this.operationQueue.then(() => this.reconcileEnabledChannels(config));
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
		const errors: Error[] = [];
		for (const timer of this.restartTimers.values()) {
			clearTimeout(timer);
		}
		this.restartTimers.clear();
		for (const timer of this.stabilityTimers.values()) {
			clearTimeout(timer);
		}
		this.stabilityTimers.clear();
		await this.operationQueue.catch(error => {
			this.logger.error(`[daemon] In-flight operation failed during shutdown: ${formatError(error)}`);
		});
		try {
			await this.interruptPendingHandoffs();
		} catch (error) {
			errors.push(toError('pending handoff interruption', error));
		}
		await this.operationQueue.catch(error => {
			this.logger.error(`[daemon] Handoff operation failed during shutdown: ${formatError(error)}`);
		});

		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		const runtimeResults = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
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
		const requestLifetime = new AbortController();
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
			void this.processRequest(buffer.slice(0, newline), requestLifetime.signal)
				.then(response => this.writeResponse(socket, response))
				.catch(error => this.writeResponse(socket, errorResponse(
					error instanceof DaemonProtocolError || error instanceof ChannelBindingError
						? error.code
						: 'INTERNAL_ERROR',
					formatError(error),
				)));
		});
		socket.once('error', error => {
			requestLifetime.abort(error);
			this.logger.error(`[daemon] Control connection failed: ${error.message}`);
		});
		socket.once('close', () => requestLifetime.abort(new Error('Daemon control connection closed')));
	}

	private writeResponse(socket: Socket, response: DaemonResponse): void {
		socket.end(`${JSON.stringify(response)}\n`);
	}

	private async processRequest(raw: string, signal: AbortSignal): Promise<DaemonResponse> {
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
		const result = await this.handleRequest(request.body, signal);
		return {
			version: DAEMON_PROTOCOL_VERSION,
			ok: true,
			result,
		};
	}

	private async handleRequest(
		request: DaemonRequestBody,
		signal: AbortSignal,
	): Promise<DaemonCommandResult> {
		if (this.closing && request.command !== 'ping' && request.command !== 'status') {
			throw new DaemonProtocolError('SHUTTING_DOWN', 'Daemon is shutting down');
		}
		switch (request.command) {
			case 'ping':
			case 'status':
				return this.statusResult(this.status());
			case 'shutdown':
				setImmediate(() => void this.close().catch(error => {
					this.logger.error(`[daemon] Shutdown failed: ${formatError(error)}`);
				}));
				return this.statusResult(this.status());
			case 'channel.create':
				return this.statusResult(this.enqueue(async () => {
					assertChannelName(request.name);
					const config = await this.configStore.read();
					if (findChannelName(config, request.name)) {
						throw new DaemonProtocolError('ALREADY_EXISTS', `Channel '${request.name}' already exists`);
					}
					const definition = { ...request.definition, enabled: request.start };
					await this.runtimeFactory.validate(definition);
					await this.configStore.update(current => withChannel(current, request.name, definition));
					if (definition.enabled) {
						await this.startDesired(request.name, definition);
					}
				}));
			case 'channel.start':
				return this.statusResult(this.enqueue(async () => {
					const definition = await this.getDefinition(request.name);
					const enabled = { ...definition, enabled: true };
					await this.configStore.update(current => withChannel(current, request.name, enabled));
					await this.startDesired(request.name, enabled);
				}));
			case 'channel.stop':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					const definition = await this.getDefinition(request.name);
					await this.configStore.update(current => withChannel(current, request.name, { ...definition, enabled: false }));
					try {
						await this.stopOne(request.name);
						await this.clearHealth(request.name);
					} catch (error) {
						await this.recordFailure(request.name, new ChannelOperationError(
							'mcp-exit',
							formatError(error),
							'Inspect daemon logs and retry stopping the channel.',
							{ cause: error },
						));
						throw error;
					}
				}));
			case 'channel.restart':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					const definition = await this.getDefinition(request.name);
					await this.runtimeFactory.validate(definition);
					const runtime = this.runtimes.get(request.name);
					if (runtime && !await runtime.quiesce()) {
						throw new DaemonProtocolError('CHANNEL_BUSY', `Channel '${request.name}' is processing a turn`);
					}
					try {
						await this.stopOne(request.name);
					} catch (error) {
						if (definition.enabled) {
							await this.recordFailure(request.name, new ChannelOperationError(
								'mcp-exit',
								formatError(error),
								'Inspect daemon logs and retry the channel restart.',
								{ cause: error },
							));
							await this.scheduleRestart(request.name);
						}
						throw error;
					}
					if (definition.enabled) {
						await this.startDesired(request.name, definition);
					}
				}));
			case 'channel.switch':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					await this.switchOne(request.name, request.session, request.chat);
				}));
			case 'channel.rehost':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					await this.rehostOne(request.name, request.host);
				}));
			case 'channel.handoff':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					await this.handoffOne(request.name, request.target, signal);
				}));
			case 'channel.handoff.request':
				return this.statusResult(this.enqueue(async () => {
					await this.requestPendingHandoff(
						request.name,
						request.sourceBindingId,
						request.target,
						signal,
					);
				}));
			case 'channel.handoff.cancel':
				return this.statusResult(this.enqueue(async () => {
					await this.cancelPendingHandoff(
						request.name,
						request.sourceBindingId,
						request.requestId,
					);
				}));
			case 'catalog.sessions': {
				const definition = await this.getDefinition(request.name);
				this.assertSourceBinding(request.name, request.sourceBindingId);
				const data = await this.requireSessionCatalog().discoverSessions({
					...(request.host ? { host: request.host } : {}),
					currentHost: definition.host ?? null,
					...(request.cursor ? { cursor: request.cursor } : {}),
					...(request.limit ? { limit: request.limit } : {}),
				}, signal);
				return this.statusResult(this.status(), data);
			}
			case 'catalog.chats': {
				await this.getDefinition(request.name);
				this.assertSourceBinding(request.name, request.sourceBindingId);
				const data = await this.requireSessionCatalog().discoverChats({
					...(request.host ? { host: request.host } : {}),
					session: request.session,
					...(request.cursor ? { cursor: request.cursor } : {}),
					...(request.limit ? { limit: request.limit } : {}),
				}, signal);
				return this.statusResult(this.status(), data);
			}
			case 'channel.repin':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
					await this.repinOne(request.name, request.installation);
				}));
			case 'channel.delete':
				return this.statusResult(this.enqueue(async () => {
					this.assertNoPendingHandoff(request.name);
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
					await this.clearHealth(request.name);
					this.handoffRecords.delete(request.name);
					await this.handoffStore.clear(request.name);
					if (stopError) {
						throw stopError;
					}
				}));
		}
	}

	private async statusResult(
		status: DaemonStatus | Promise<DaemonStatus>,
		data?: DaemonResponseData,
	): Promise<DaemonCommandResult> {
		return {
			status: await status,
			...(data ? { data } : {}),
		};
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
				const healthRecord = this.healthRecords.get(name);
				const handoff = this.handoffRecords.get(name);
				let health: ChannelHealth;
				if (!definition.enabled) {
					health = { state: 'stopped' };
				} else if (runtime && !runtime.startupFailure) {
					health = { state: 'healthy' };
				} else if ((transition === 'starting' || transition === 'stopping') && !healthRecord) {
					health = { state: 'healthy' };
				} else if (handoff?.state === 'pending' && !healthRecord) {
					health = { state: 'healthy' };
				} else if (this.closing && !healthRecord) {
					health = { state: 'healthy' };
				} else {
					if (!healthRecord) {
						throw new Error(`Channel '${name}' is unhealthy without actionable health information`);
					}
					health = {
						state: runtime ? 'degraded' : 'unhealthy',
						...healthRecord,
					};
				}
				return {
					name,
					desired: definition.enabled ? 'running' : 'stopped',
					state: transition ?? (healthRecord ? 'error' : runtime ? 'running' : 'stopped'),
					definition,
					...(runtime ? { runtime: runtime.snapshot } : {}),
					health,
					...(handoff ? { handoff } : {}),
				};
			});
		return {
			pid: process.pid,
			startedAt: this.startedAt,
			channels,
		};
	}

	private async reconcileEnabledChannels(config: AppConfig): Promise<void> {
		for (const [name, definition] of Object.entries(config.channels)) {
			if (!definition.enabled) {
				continue;
			}
			try {
				await this.startOne(name, definition);
			} catch (error) {
				await this.scheduleRestart(name);
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
			const runtime = await this.runtimeFactory.start(
				name,
				definition,
				new DaemonChannelStatusReporter(this.logger, name),
			);
			this.runtimes.set(name, runtime);
			if (runtime.startupFailure) {
				await this.recordFailure(name, runtime.startupFailure);
				await this.scheduleRestart(name);
			} else {
				await this.clearHealth(name);
				this.markStableAfterDelay(name, runtime);
			}
			this.superviseRuntime(name, runtime);
		} catch (error) {
			await this.recordFailure(name, error);
			throw error;
		} finally {
			this.transitions.delete(name);
		}
	}

	private async prepareOne(
		name: string,
		definition: ChannelInstanceConfig,
	): Promise<ManagedChannelRuntime> {
		this.clearRestart(name);
		this.transitions.set(name, 'starting');
		try {
			const runtime = await this.runtimeFactory.prepare(
				name,
				definition,
				new DaemonChannelStatusReporter(this.logger, name),
			);
			if (runtime.startupFailure) {
				const startupFailure = runtime.startupFailure;
				await runtime.close();
				throw startupFailure;
			}
			return runtime;
		} catch (error) {
			this.transitions.delete(name);
			throw error;
		}
	}

	private async activatePreparedOne(name: string, runtime: ManagedChannelRuntime): Promise<void> {
		this.runtimes.set(name, runtime);
		try {
			await runtime.activate();
			await this.clearHealth(name);
			this.markStableAfterDelay(name, runtime);
			this.superviseRuntime(name, runtime);
		} catch (error) {
			if (this.runtimes.get(name) === runtime) {
				this.runtimes.delete(name);
			}
			const errors = [error];
			try {
				await runtime.close();
			} catch (closeError) {
				errors.push(closeError);
			}
			throw errors.length === 1
				? error
				: new AggregateError(errors, `Failed to activate replacement channel '${name}'`);
		} finally {
			this.transitions.delete(name);
		}
	}

	private superviseRuntime(name: string, runtime: ManagedChannelRuntime): void {
		void runtime.whenStopped.then(
			() => this.handleUnexpectedStop(name, runtime, new Error('Channel runtime stopped unexpectedly')),
			error => this.handleUnexpectedStop(name, runtime, error),
		);
	}

	private async startDesired(name: string, definition: ChannelInstanceConfig): Promise<void> {
		this.restartAttempts.delete(name);
		if (!this.runtimes.has(name)) {
			await this.clearHealth(name);
		}
		try {
			await this.startOne(name, definition);
		} catch (error) {
			await this.scheduleRestart(name);
			throw error;
		}
	}

	private async stopOne(name: string, preserveRestartAttempts = false): Promise<void> {
		this.clearRestart(name);
		this.clearStability(name);
		if (!preserveRestartAttempts) {
			this.restartAttempts.delete(name);
		}
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
		const next = retargetChannelInstance(previous, session, chat);
		await this.replaceOne(name, previous, next);
	}

	private async rehostOne(name: string, host: string): Promise<void> {
		const previous = await this.getDefinition(name);
		if (previous.host === host) {
			return;
		}
		await this.replaceOne(name, previous, { ...previous, host });
	}

	private async handoffOne(
		name: string,
		target: ChannelBindingTarget,
		signal?: AbortSignal,
	): Promise<void> {
		const previous = await this.getDefinition(name);
		const runtime = this.runtimes.get(name);
		const next = rebindChannelInstance(previous, target);
		const resolvedTarget = await this.validateHandoffTarget(name, next, signal);
		signal?.throwIfAborted();
		const requestedAt = new Date().toISOString();
		const pending: ChannelHandoffRecord = {
			requestId: randomUUID(),
			state: 'pending',
			requestedAt,
			updatedAt: requestedAt,
			source: handoffSource(previous, runtime),
			target: bindingTarget(next),
			resolvedTarget,
		};
		await this.setHandoffRecord(name, pending);
		try {
			await this.replaceOne(name, previous, next, pending);
		} catch (error) {
			if (this.handoffRecords.get(name)?.state !== 'failed') {
				await this.setHandoffRecord(name, failedHandoff(pending, error));
			}
			throw error;
		}
	}

	private async requestPendingHandoff(
		name: string,
		sourceBindingId: string,
		target: ChannelBindingTarget,
		signal?: AbortSignal,
	): Promise<void> {
		this.assertNoPendingHandoff(name);
		const runtime = this.requireSourceRuntime(name, sourceBindingId);
		const previous = await this.getDefinition(name);
		const next = rebindChannelInstance(previous, target);
		const resolvedTarget = await this.validateHandoffTarget(name, next, signal);
		signal?.throwIfAborted();
		if (this.runtimes.get(name) !== runtime || runtime.snapshot.bindingId !== sourceBindingId) {
			throw new DaemonProtocolError('STALE_BINDING', `Channel '${name}' is no longer owned by this source binding`);
		}
		if (sameResolvedBinding(runtime.snapshot, previous, next, resolvedTarget)) {
			throw new DaemonProtocolError('ALREADY_BOUND', `Channel '${name}' already uses the requested binding`);
		}

		const requestId = randomUUID();
		runtime.beginHandoff(requestId);
		const requestedAt = new Date().toISOString();
		const record: ChannelHandoffRecord = {
			requestId,
			state: 'pending',
			requestedAt,
			updatedAt: requestedAt,
			source: handoffSource(previous, runtime),
			target: bindingTarget(next),
			resolvedTarget,
		};
		try {
			await this.setHandoffRecord(name, record);
		} catch (error) {
			await runtime.cancelHandoff(requestId);
			throw error;
		}
		const operation: PendingHandoffOperation = {
			record,
			runtime,
			next,
			abort: new AbortController(),
		};
		this.pendingHandoffs.set(name, operation);
		this.schedulePendingHandoff(name, operation);
	}

	private async cancelPendingHandoff(
		name: string,
		sourceBindingId: string,
		requestId: string,
	): Promise<void> {
		const runtime = this.requireSourceRuntime(name, sourceBindingId);
		const operation = this.pendingHandoffs.get(name);
		if (!operation || operation.record.requestId !== requestId) {
			throw new DaemonProtocolError('HANDOFF_NOT_PENDING', `Handoff '${requestId}' is not pending for channel '${name}'`);
		}
		if (operation.runtime !== runtime) {
			throw new DaemonProtocolError('STALE_BINDING', `Channel '${name}' is no longer owned by this source binding`);
		}
		operation.abort.abort(new Error(`Handoff ${requestId} was cancelled`));
		const cancelled: ChannelHandoffRecord = {
			...operation.record,
			state: 'cancelled',
			updatedAt: new Date().toISOString(),
		};
		await this.setHandoffRecord(name, cancelled);
		await runtime.cancelHandoff(requestId);
		this.pendingHandoffs.delete(name);
	}

	private schedulePendingHandoff(name: string, operation: PendingHandoffOperation): void {
		void this.completePendingHandoff(name, operation).catch(error => {
			this.logger.error(`[channel:${name}] Pending handoff failed: ${formatError(error)}`);
		});
	}

	private async completePendingHandoff(
		name: string,
		operation: PendingHandoffOperation,
	): Promise<void> {
		try {
			await operation.runtime.waitForHandoffReady(operation.record.requestId, operation.abort.signal);
		} catch (error) {
			if (operation.abort.signal.aborted) {
				return;
			}
			await this.failPendingHandoff(name, operation, error);
			return;
		}
		await this.enqueue(async () => {
			if (this.closing || this.pendingHandoffs.get(name) !== operation) {
				return;
			}
			const current = this.runtimes.get(name);
			if (current !== operation.runtime
				|| current.snapshot.bindingId !== operation.runtime.snapshot.bindingId) {
				await this.failPendingHandoff(
					name,
					operation,
					new DaemonProtocolError('STALE_BINDING', `Channel '${name}' is no longer owned by the requesting binding`),
				);
				return;
			}
			const previous = await this.getDefinition(name);
			try {
				await this.replaceOne(
					name,
					previous,
					operation.next,
					operation.record,
					operation.record.requestId,
				);
				this.pendingHandoffs.delete(name);
			} catch (error) {
				await this.failPendingHandoff(name, operation, error);
			}
		});
	}

	private async failPendingHandoff(
		name: string,
		operation: PendingHandoffOperation,
		error: unknown,
	): Promise<void> {
		if (this.pendingHandoffs.get(name) !== operation) {
			return;
		}
		operation.abort.abort(error);
		const current = this.runtimes.get(name);
		const errors = [error];
		if (this.handoffRecords.get(name)?.state !== 'failed') {
			await this.setHandoffRecord(name, failedHandoff(operation.record, error));
		}
		this.pendingHandoffs.delete(name);
		if (current === operation.runtime) {
			try {
				await current.cancelHandoff(operation.record.requestId);
			} catch (cancelError) {
				errors.push(cancelError);
			}
		}
		const failure = errors.length === 1
			? error
			: new AggregateError(errors, `Failed to restore source delivery for channel '${name}'`);
		if (errors.length > 1) {
			await this.setHandoffRecord(name, failedHandoff(operation.record, failure));
		}
	}

	private async repinOne(name: string, installation: string): Promise<void> {
		const previous = await this.getDefinition(name);
		if (previous.installation === installation) {
			return;
		}
		await this.replaceOne(name, previous, { ...previous, installation });
	}

	private async replaceOne(
		name: string,
		previous: ChannelInstanceConfig,
		next: ChannelInstanceConfig,
		handoff?: ChannelHandoffRecord,
		sourceHandoffId?: string,
	): Promise<void> {
		const runtime = this.runtimes.get(name);
		await this.runtimeFactory.validate(next);
		validateAppConfig(withChannel(await this.configStore.read(), name, next));
		const quiesced = runtime
			? sourceHandoffId
				? await runtime.quiesceHandoff(sourceHandoffId)
				: await runtime.quiesce()
			: true;
		if (!quiesced) {
			throw new DaemonProtocolError('CHANNEL_BUSY', `Channel '${name}' is processing a turn`);
		}
		const wasRunning = runtime !== undefined;
		try {
			await this.stopOne(name);
		} catch (error) {
			if (previous.enabled) {
				await this.recordFailure(name, new ChannelOperationError(
					'mcp-exit',
					formatError(error),
					'Inspect daemon logs and retry the channel operation.',
					{ cause: error },
				));
				await this.scheduleRestart(name);
			}
			throw error;
		}
		let configUpdated = false;
		let preparedRuntime: ManagedChannelRuntime | undefined;
		try {
			await this.bindings.replace(name, previous, next, handoff?.requestId);
			configUpdated = true;
			if (next.enabled) {
				this.restartAttempts.delete(name);
				preparedRuntime = await this.prepareOne(name, next);
				if (handoff) {
					await this.setHandoffRecord(name, appliedHandoff(handoff, preparedRuntime));
				}
				await this.activatePreparedOne(name, preparedRuntime);
				preparedRuntime = undefined;
			} else if (handoff) {
				await this.setHandoffRecord(name, appliedHandoff(handoff, undefined));
			}
		} catch (switchError) {
			this.transitions.delete(name);
			const errors = [toError('new binding', switchError)];
			if (preparedRuntime) {
				try {
					await preparedRuntime.close();
				} catch (closeError) {
					errors.push(toError('prepared binding cleanup', closeError));
				}
			}
			const appliedRecord = handoff && this.handoffRecords.get(name)?.state === 'applied';
			if (appliedRecord) {
				try {
					await this.setHandoffRecord(name, failedHandoff(handoff, switchError, true));
				} catch (handoffError) {
					errors.push(toError('handoff recovery state', handoffError));
					try {
						await this.startDesired(name, next);
					} catch (recoveryError) {
						errors.push(toError('committed target recovery', recoveryError));
					}
					throw new AggregateError(errors, `Failed to switch channel '${name}'`);
				}
			}
			if (configUpdated) {
				try {
					await this.bindings.replace(name, next, previous, handoff?.requestId);
				} catch (rollbackError) {
					errors.push(toError('persisted binding rollback', rollbackError));
				}
			}
			if (handoff) {
				try {
					await this.setHandoffRecord(name, failedHandoff(handoff, switchError));
				} catch (handoffError) {
					errors.push(toError('handoff failure state', handoffError));
				}
			}
			if (wasRunning || previous.enabled) {
				try {
					const restored = await this.getDefinition(name);
					if (restored.enabled) {
						await this.startOne(name, restored);
					}
				} catch (rollbackError) {
					errors.push(toError('rollback', rollbackError));
					await this.recordFailure(name, rollbackError);
					await this.scheduleRestart(name);
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

	private async validateHandoffTarget(
		name: string,
		next: ChannelInstanceConfig,
		signal?: AbortSignal,
	): Promise<ResolvedChannelBinding> {
		await this.runtimeFactory.validate(next);
		validateAppConfig(withChannel(await this.configStore.read(), name, next));
		try {
			const resolved = await this.requireSessionCatalog().validateBinding(next, signal);
			for (const warning of resolved.warnings) {
				this.logger.info(`[channel:${name}] ${warning}`);
			}
			return resolved;
		} catch (error) {
			throw new DaemonProtocolError(
				'INVALID_TARGET',
				`Cannot hand off channel '${name}': ${formatError(error)}`,
				{ cause: error },
			);
		}
	}

	private requireSourceRuntime(name: string, bindingId: string): ManagedChannelRuntime {
		const runtime = this.runtimes.get(name);
		if (!runtime || runtime.snapshot.bindingId !== bindingId) {
			throw new DaemonProtocolError('STALE_BINDING', `Channel '${name}' is no longer owned by this source binding`);
		}
		return runtime;
	}

	private assertSourceBinding(name: string, bindingId: string | undefined): void {
		if (bindingId) {
			this.requireSourceRuntime(name, bindingId);
		}
	}

	private assertNoPendingHandoff(name: string): void {
		const operation = this.pendingHandoffs.get(name);
		if (operation) {
			throw new DaemonProtocolError(
				'HANDOFF_PENDING',
				`Handoff '${operation.record.requestId}' is already pending for channel '${name}'`,
			);
		}
	}

	private requireSessionCatalog(): DaemonSessionCatalog {
		if (!this.sessionCatalog) {
			throw new DaemonProtocolError('UNAVAILABLE', 'Session discovery is not configured for this daemon');
		}
		return this.sessionCatalog;
	}

	private async setHandoffRecord(name: string, record: ChannelHandoffRecord): Promise<void> {
		await this.handoffStore.write(name, record);
		this.handoffRecords.set(name, record);
	}

	private handleUnexpectedStop(name: string, runtime: ManagedChannelRuntime, error: unknown): void {
		if (this.closing || this.runtimes.get(name) !== runtime) {
			return;
		}
		const pendingHandoff = this.pendingHandoffs.get(name);
		this.runtimes.delete(name);
		this.clearStability(name);
		this.transitions.set(name, 'stopping');
		void this.enqueue(async () => {
			if (pendingHandoff?.runtime === runtime
				&& this.pendingHandoffs.get(name) === pendingHandoff) {
				pendingHandoff.abort.abort(error);
				this.pendingHandoffs.delete(name);
				await this.setHandoffRecord(name, failedHandoff(
					pendingHandoff.record,
					new Error('Source runtime stopped before the pending handoff reached a safe boundary', { cause: error }),
				));
			}
			await this.recordFailure(name, new ChannelOperationError(
				'mcp-exit',
				formatError(error),
				recoveryGuidance('mcp-exit'),
				{ cause: error },
			));
			try {
				await runtime.close();
			} catch (closeError) {
				this.logger.error(`[channel:${name}] Cleanup after failure failed: ${formatError(closeError)}`);
			} finally {
				this.transitions.delete(name);
			}
			const definition = (await this.configStore.read()).channels[name];
			if (definition?.enabled) {
				await this.scheduleRestart(name);
			}
		}).catch(cleanupError => {
			this.logger.error(`[channel:${name}] Failed to process runtime exit: ${formatError(cleanupError)}`);
		});
	}

	private async scheduleRestart(name: string): Promise<void> {
		if (this.closing || this.restartTimers.has(name)) {
			return;
		}
		const attempt = (this.restartAttempts.get(name) ?? 0) + 1;
		this.restartAttempts.set(name, attempt);
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
		const failure = this.healthRecords.get(name)?.failure;
		if (!failure) {
			throw new Error(`Cannot schedule retry for channel '${name}' without an actionable failure`);
		}
		const retry = {
			attempt,
			state: 'scheduled' as const,
			nextRetryAt: new Date(Date.now() + delay).toISOString(),
		};
		const health = { failure, retry };
		this.healthRecords.set(name, health);
		try {
			await this.healthStore.write(name, health);
		} catch (error) {
			const schedulingFailure = failureFromError(new ChannelOperationError(
				'retry-scheduling',
				formatError(error),
				recoveryGuidance('retry-scheduling'),
				{ cause: error },
			));
			this.healthRecords.set(name, { failure: schedulingFailure });
			throw error;
		}
		const timer = setTimeout(() => {
			this.restartTimers.delete(name);
			void this.enqueue(async () => {
				const definition = (await this.configStore.read()).channels[name];
				const runtime = this.runtimes.get(name);
				if (!definition?.enabled || (runtime && !runtime.startupFailure)) {
					return;
				}
				if (runtime) {
					if (!await runtime.quiesce()) {
						await this.scheduleRestart(name);
						return;
					}
					await this.stopOne(name, true);
				}
				try {
					await this.startOne(name, definition);
				} catch (error) {
					this.logger.error(`[channel:${name}] Restart attempt failed: ${formatError(error)}`);
					await this.scheduleRestart(name);
				}
			}).catch(error => {
				this.logger.error(`[channel:${name}] Restart failed: ${formatError(error)}`);
			});
		}, delay);
		timer.unref();
		this.restartTimers.set(name, timer);
	}

	private async loadHealth(config: AppConfig): Promise<void> {
		for (const [name, definition] of Object.entries(config.channels)) {
			const health = await this.healthStore.read(name);
			if (!health) {
				continue;
			}
			if (!definition.enabled) {
				await this.healthStore.clear(name);
				continue;
			}
			this.healthRecords.set(name, health);
			if (health.retry) {
				this.restartAttempts.set(name, health.retry.attempt);
			}
		}
	}

	private async loadHandoffs(config: AppConfig): Promise<AppConfig> {
		for (const name of Object.keys(config.channels)) {
			const recovered = await this.bindings.recover(name);
			if (recovered.handoff) {
				this.handoffRecords.set(name, recovered.handoff);
			}
		}
		return this.configStore.read();
	}

	private async interruptPendingHandoffs(): Promise<void> {
			const operations = [...this.pendingHandoffs.entries()];
			this.pendingHandoffs.clear();
			const errors: Error[] = [];
			for (const [name, operation] of operations) {
				operation.abort.abort(new Error('Daemon stopped before the handoff was applied'));
				try {
					await this.setHandoffRecord(name, failedHandoff(
						operation.record,
						new Error('Daemon stopped before the handoff was applied; the committed source binding was preserved'),
					));
				} catch (error) {
					errors.push(toError(name, error));
				}
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, 'Failed to persist interrupted handoffs');
			}
	}

	private async recordFailure(name: string, error: unknown): Promise<void> {
		const failure = failureFromError(error);
		const previousRetry = this.healthRecords.get(name)?.retry;
		const health = {
			failure,
			...(previousRetry ? { retry: previousRetry } : {}),
		};
		this.healthRecords.set(name, health);
		await this.healthStore.write(name, health);
	}

	private async clearHealth(name: string): Promise<void> {
		this.healthRecords.delete(name);
		await this.healthStore.clear(name);
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
		start: (name, definition, status) => ChannelRuntime.start(name, definition, services, status),
		prepare: (name, definition, status) => ChannelRuntime.prepare(name, definition, services, status),
	};
}

class DaemonChannelStatusReporter implements StatusReporter {
	constructor(
		private readonly logger: DaemonLogger,
		private readonly channel: string,
	) { }

	report(message: string): void {
		this.logger.info(`[channel:${this.channel}] ${message}`);
	}
}

function handoffSource(
	definition: ChannelInstanceConfig,
	runtime: ManagedChannelRuntime | undefined,
): ChannelHandoffRecord['source'] {
	return {
		actualHost: runtime?.snapshot.host ?? definition.host ?? 'automatic',
		...(definition.host ? { host: definition.host } : {}),
		session: definition.session,
		...(definition.chat ? { chat: definition.chat } : {}),
		resolvedChat: runtime?.snapshot.chat ?? definition.chat ?? 'default chat',
	};
}

function bindingTarget(definition: ChannelInstanceConfig): ChannelBindingTarget {
	return {
		...(definition.host ? { host: definition.host } : {}),
		session: definition.session,
		...(definition.chat ? { chat: definition.chat } : {}),
	};
}

function appliedHandoff(
	record: ChannelHandoffRecord,
	runtime: ManagedChannelRuntime | undefined,
): ChannelHandoffRecord {
	return {
		...record,
		state: 'applied',
		updatedAt: new Date().toISOString(),
		resolvedTarget: runtime
			? {
				...record.resolvedTarget,
				actualHost: runtime.snapshot.host,
				chat: runtime.snapshot.chat,
			}
			: record.resolvedTarget,
	};
}

function sameResolvedBinding(
	runtime: ChannelRuntimeSnapshot,
	previous: ChannelInstanceConfig,
	next: ChannelInstanceConfig,
	resolved: ResolvedChannelBinding,
): boolean {
	return previous.host === next.host
		&& previous.session === next.session
		&& previous.chat === next.chat
		&& runtime.host === resolved.actualHost
		&& runtime.session === next.session
		&& runtime.chat === resolved.chat;
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

function findChannelName(config: AppConfig, name: string): string | undefined {
	return Object.keys(config.channels).find(candidate => candidate.toLowerCase() === name.toLowerCase());
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
