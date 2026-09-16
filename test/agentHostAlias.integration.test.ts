import {
	SessionLifecycle,
	SessionStatus,
	type ChatState,
	type RootState,
	type SessionState,
} from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { AgentHostService } from '../src/agentHosts.js';
import { createChannelRuntimeServices } from '../src/channelRuntime.js';
import { ConfigStore } from '../src/config.js';
import { requestDaemon } from '../src/daemonClient.js';
import { getOrCreateDaemonToken } from '../src/daemonPaths.js';
import { createDaemonRuntimeFactory, DaemonServer } from '../src/daemonServer.js';
import { PluginManager } from '../src/plugins.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('local host alias integration', () => {
	it('restores a channel through fresh endpoint details and credentials', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-alias-integration-'));
		temporaryDirectories.push(root);
		const home = join(root, 'home');
		const registry = join(root, 'registry');
		const session = `ahp-session:/${randomUUID()}`;
		const chat = `ahp-chat:/${randomUUID()}`;
		const store = new ConfigStore(home);
		const hostService = new AgentHostService(store, {
			AHP_CHANNELS_ENDPOINT_REGISTRY: registry,
		});

		const firstHost = new FixtureAgentHost(registry, session, chat);
		const firstEndpointId = await firstHost.start();
		await hostService.addDiscoveredAlias('local', firstEndpointId);
		await store.update(config => ({
			...config,
			channels: {
				fixture: {
					plugin: resolve(import.meta.dirname, 'fixtures', 'fake-plugin'),
					session,
					chat,
					host: '@local',
					enabled: true,
				},
			},
		}));

		const firstDaemon = await createDaemon(home, store, hostService);
		await firstDaemon.start();
		try {
			const status = await requestDaemon(home, { command: 'status' });
			assert.equal(status.channels[0]?.runtime?.host, firstEndpointId);
			assert.equal(status.channels[0]?.runtime?.session, session);
			assert.equal(status.channels[0]?.runtime?.chat, chat);
			assert.ok(firstHost.initializeCount > 0);
		} finally {
			await firstDaemon.close();
		}

		const secondHost = new FixtureAgentHost(registry, session, chat);
		let secondDaemon: DaemonServer | undefined;
		try {
			const secondEndpointId = await secondHost.start();
			assert.notEqual(secondEndpointId, firstEndpointId);
			assert.notEqual(secondHost.connectionToken, firstHost.connectionToken);
			assert.notEqual(secondHost.port, firstHost.port);
			await firstHost.close();

			secondDaemon = await createDaemon(home, store, hostService);
			await secondDaemon.start();
			const status = await requestDaemon(home, { command: 'status' });
			const channel = status.channels[0];
			assert.deepEqual({
				preferredHost: channel?.definition.host,
				actualHost: channel?.runtime?.host,
				session: channel?.runtime?.session,
				chat: channel?.runtime?.chat,
				health: channel?.health.state,
			}, {
				preferredHost: '@local',
				actualHost: secondEndpointId,
				session,
				chat,
				health: 'healthy',
			});
			assert.ok(secondHost.initializeCount > 0);
			assert.doesNotMatch(JSON.stringify(await store.read()), /connectionToken/);
		} finally {
			await secondDaemon?.close();
			await secondHost.close();
			await firstHost.close();
		}
	});
});

async function createDaemon(
	home: string,
	store: ConfigStore,
	hostService: AgentHostService,
): Promise<DaemonServer> {
	const plugins = new PluginManager(store);
	return new DaemonServer(
		home,
		await getOrCreateDaemonToken(home),
		store,
		createDaemonRuntimeFactory(
			createChannelRuntimeServices(plugins, hostService, { home }),
			plugins,
		),
	);
}

class FixtureAgentHost {
	readonly connectionToken = randomUUID();
	private readonly instanceId = randomUUID();
	private readonly server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	private readonly peers = new Set<WebSocket>();
	private registryFile: string | undefined;
	private closePromise: Promise<void> | undefined;
	initializeCount = 0;

	constructor(
		private readonly registry: string,
		private readonly session: string,
		private readonly chat: string,
	) {
		this.server.on('connection', (socket, request) => {
			const token = new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams.get('tkn');
			if (token !== this.connectionToken) {
				socket.close(1008, 'invalid connection token');
				return;
			}
			this.peers.add(socket);
			socket.on('message', raw => this.handleMessage(socket, raw));
			socket.once('close', () => this.peers.delete(socket));
		});
	}

	async start(): Promise<string> {
		await new Promise<void>((resolveListening, reject) => {
			this.server.once('listening', resolveListening);
			this.server.once('error', reject);
		});
		const address = this.server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Fixture Agent Host did not bind a TCP port');
		}
		await mkdir(this.registry, { recursive: true });
		this.registryFile = join(this.registry, `${this.instanceId}.json`);
		await writeFile(this.registryFile, JSON.stringify({
			schemaVersion: 2,
			type: 'standalone',
			pid: process.pid,
			instanceId: this.instanceId,
			protocolVersion: '0.1.0',
			connectionToken: this.connectionToken,
			endpoint: {
				type: 'tcp',
				host: '127.0.0.1',
				port: address.port,
			},
		}));
		return `standalone:${process.pid}:${this.instanceId}`;
	}

	get port(): number {
		const address = this.server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Fixture Agent Host is not listening on TCP');
		}
		return address.port;
	}

	async close(): Promise<void> {
		this.closePromise ??= this.doClose();
		return this.closePromise;
	}

	private async doClose(): Promise<void> {
		for (const peer of this.peers) {
			peer.close();
		}
		await new Promise<void>(resolveClose => this.server.close(() => resolveClose()));
		if (this.registryFile) {
			await rm(this.registryFile, { force: true });
		}
	}

	private handleMessage(socket: WebSocket, raw: RawData): void {
		const request = JSON.parse(raw.toString()) as {
			readonly id?: number;
			readonly method?: string;
			readonly params?: { readonly channel?: string };
		};
		if (request.id === undefined || !request.method) {
			return;
		}
		try {
			socket.send(JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				result: this.resultFor(request.method, request.params?.channel),
			}));
		} catch (error) {
			socket.send(JSON.stringify({
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: -32_603,
					message: error instanceof Error ? error.message : String(error),
				},
			}));
		}
	}

	private resultFor(method: string, channel?: string): unknown {
		switch (method) {
			case 'initialize':
				this.initializeCount++;
				return {
					protocolVersion: '0.9.0',
					serverSeq: 0,
					snapshots: [{
						resource: 'ahp-root://',
						state: { agents: [] } satisfies RootState,
						fromSeq: 0,
					}],
				};
			case 'listSessions':
				return {
					items: [{
						resource: this.session,
						provider: 'fixture',
						title: 'Fixture',
						status: SessionStatus.Idle,
						createdAt: new Date(0).toISOString(),
						modifiedAt: new Date(0).toISOString(),
					}],
				};
			case 'subscribe':
				if (channel === this.session) {
					return {
						snapshot: {
							resource: this.session,
							state: this.sessionState(),
							fromSeq: 0,
						},
					};
				}
				if (channel === this.chat) {
					return {
						snapshot: {
							resource: this.chat,
							state: this.chatState(),
							fromSeq: 0,
						},
					};
				}
				return {};
			default:
				throw new Error(`Unsupported fixture request '${method}'`);
		}
	}

	private sessionState(): SessionState {
		return {
			provider: 'fixture',
			title: 'Fixture',
			status: SessionStatus.Idle,
			lifecycle: SessionLifecycle.Ready,
			activeClients: [],
			chats: [{
				resource: this.chat,
				title: 'Fixture',
				status: SessionStatus.Idle,
				modifiedAt: new Date(0).toISOString(),
			}],
			defaultChat: this.chat,
		};
	}

	private chatState(): ChatState {
		return {
			resource: this.chat,
			title: 'Fixture',
			status: SessionStatus.Idle,
			modifiedAt: new Date(0).toISOString(),
			turns: [],
		};
	}
}
