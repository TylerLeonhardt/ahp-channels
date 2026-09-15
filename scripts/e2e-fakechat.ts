import {
	ActionType,
	ConfirmationOptionKind,
	CustomizationLoadStatus,
	CustomizationType,
	SessionLifecycle,
	ToolCallConfirmationReason,
	sessionReducer,
	type ChatState,
	type ChatToolCallReadyAction,
	type RootState,
	type SessionAction,
	type SessionState,
} from '@microsoft/agent-host-protocol';
import type { Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';
import { connectAgentHost, resolveChat, type ConnectedAgentHost } from '../src/ahp.js';
import { ensureDaemonStarted, probeDaemon, requestDaemon, stopDaemon } from '../src/daemonClient.js';
import type { DaemonStatus } from '../src/daemonProtocol.js';
import { discoverLocalAgentHosts, selectAgentHost } from '../src/endpoints.js';
import { ConfigStore, OFFICIAL_MARKETPLACE_NAME } from '../src/config.js';
import { PluginManager } from '../src/plugins.js';
import { runProcess } from '../src/process.js';
import { DeterministicAgentHost } from './deterministic-agent-host.js';

const CHANNEL_NAME = 'fakechat-e2e';
const PLUGIN_NAME = 'fakechat';
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const testRoot = await mkdtemp(join(tmpdir(), 'ahp-fakechat-'));
const fakeHome = join(testRoot, 'user-home');
const bunCache = join(testRoot, 'bun-cache');
const session = `ahp-session:/${randomUUID()}`;
const sockets = new Set<WebSocket>();
let deterministicHost: DeterministicAgentHost | undefined;
let connection: ConnectedAgentHost | undefined;
let environment: ReturnType<typeof overrideEnvironment> | undefined;
let sessionCreated = false;
let channelCreated = false;
let daemonStarted = false;
let sessionSubscription: Subscription | undefined;
let chatSubscription: Subscription | undefined;
let primaryError: unknown;

try {
	await requireBun();
	const port = await allocateLoopbackPort();
	const fixtureRegistry = join(testRoot, 'agent-host-registry');
	const useFixtureHost = process.env['AHP_CHANNELS_E2E_USE_FIXTURE_HOST'] === '1';
	let hostSelector = process.env['AHP_CHANNELS_E2E_HOST'];
	if (useFixtureHost) {
		environment = overrideEnvironment({
			AHP_CHANNELS_ENDPOINT_REGISTRY: fixtureRegistry,
			FAKECHAT_PORT: String(port),
			HOME: fakeHome,
			USERPROFILE: fakeHome,
			BUN_INSTALL_CACHE_DIR: bunCache,
			XDG_CACHE_HOME: join(testRoot, 'cache'),
		});
		deterministicHost = new DeterministicAgentHost(fixtureRegistry);
		hostSelector = await deterministicHost.start();
	}
	const endpoints = await discoverLocalAgentHosts();
	if (endpoints.length === 0) {
		throw new Error(
			'e2e:fakechat requires a running local Agent Host; '
				+ 'set AHP_CHANNELS_E2E_USE_FIXTURE_HOST=1 to use the deterministic CI host',
		);
	}
	const endpoint = hostSelector
		? selectAgentHost(endpoints, hostSelector)
		: endpoints.find(candidate => candidate.type === 'standalone') ?? selectAgentHost(endpoints);
	environment ??= overrideEnvironment({
		AHP_CHANNELS_ENDPOINT_REGISTRY: dirname(endpoint.registryFile),
		FAKECHAT_PORT: String(port),
		HOME: fakeHome,
		USERPROFILE: fakeHome,
		BUN_INSTALL_CACHE_DIR: bunCache,
		XDG_CACHE_HOME: join(testRoot, 'cache'),
	});
	connection = await connectAgentHost(endpoint);
	const client = connection.client;
	await mkdir(fakeHome, { recursive: true });
	const installedFakechat = await installOfficialFakechat(testRoot);

	const rootSnapshot = connection.initializeResult.snapshots.find(snapshot => snapshot.resource === 'ahp-root://');
	const provider = (rootSnapshot?.state as RootState | undefined)?.agents[0]?.provider;
	if (!provider) {
		throw new Error('The local Agent Host advertises no agent providers');
	}

	await client.request('createSession', { channel: session, provider });
	sessionCreated = true;
	const subscribedSession = await client.subscribe(session);
	sessionSubscription = subscribedSession.subscription;
	if (!subscribedSession.result.snapshot) {
		throw new Error('The fakechat E2E session returned no snapshot');
	}
	let sessionState = await waitForSessionChat(
		subscribedSession.result.snapshot.state as SessionState,
		sessionSubscription,
	);
	const chat = resolveChat(sessionState, undefined, session);
	const subscribedChat = await client.subscribe(chat);
	chatSubscription = subscribedChat.subscription;
	if (!subscribedChat.result.snapshot) {
		throw new Error('The fakechat E2E chat returned no snapshot');
	}
	const initialChatState = subscribedChat.result.snapshot.state as ChatState;

	await ensureDaemonStarted(testRoot);
	daemonStarted = true;
	const created = await requestDaemon(testRoot, {
		command: 'channel.create',
		name: CHANNEL_NAME,
		definition: {
			plugin: PLUGIN_NAME,
			installation: installedFakechat.installation,
			session,
			enabled: false,
			host: endpoint.id,
		},
		start: true,
	});
	channelCreated = true;
	const clientId = requireRunningChannel(created, installedFakechat.installation);
	sessionState = await waitForFakechatContribution(sessionState, sessionSubscription, clientId);
	await waitForFakechatReady(testRoot, port);
	await access(join(installedFakechat.path, 'node_modules'));
	await assertMissing(
		join(testRoot, 'marketplaces', OFFICIAL_MARKETPLACE_NAME, 'external_plugins', PLUGIN_NAME, 'node_modules'),
	);

	let socket = await connectFakechat(port);
	sockets.add(socket);
	await runRoundTrip(
		client,
		socket,
		initialChatState,
		chatSubscription,
		`FAKECHAT_FIRST_${randomUUID()}`,
	);
	await access(join(fakeHome, '.claude', 'channels', 'fakechat', 'outbox'));
	await closeWebSocket(socket);
	sockets.delete(socket);

	await stopDaemon(testRoot);
	daemonStarted = false;
	await waitForFakechatStopped(port);
	sessionState = await waitForActiveClientRemoval(sessionState, sessionSubscription, clientId);

	const restarted = await ensureDaemonStarted(testRoot);
	daemonStarted = true;
	const restartedClientId = requireRunningChannel(restarted, installedFakechat.installation);
	sessionState = await waitForFakechatContribution(
		sessionState,
		sessionSubscription,
		restartedClientId,
	);
	await waitForFakechatReady(testRoot, port);

	socket = await connectFakechat(port);
	sockets.add(socket);
	await runRoundTrip(
		client,
		socket,
		initialChatState,
		chatSubscription,
		`FAKECHAT_RESTART_${randomUUID()}`,
	);
	await closeWebSocket(socket);
	sockets.delete(socket);

	await requestDaemon(testRoot, { command: 'channel.delete', name: CHANNEL_NAME });
	channelCreated = false;
	console.log(`Official fakechat E2E passed on 127.0.0.1:${port}, including daemon restart`);
} catch (error) {
	primaryError = error;
} finally {
	const cleanupErrors: Error[] = [];
	for (const socket of sockets) {
		await cleanup('fakechat WebSocket', () => closeWebSocket(socket), cleanupErrors);
	}
	if (channelCreated && daemonStarted) {
		await cleanup(
			'fakechat channel',
			() => requestDaemon(testRoot, { command: 'channel.delete', name: CHANNEL_NAME }),
			cleanupErrors,
		);
	}
	if (daemonStarted) {
		await cleanup('isolated daemon', async () => {
			await stopDaemon(testRoot);
			daemonStarted = false;
		}, cleanupErrors);
	}
	await cleanup('chat subscription', () => chatSubscription?.close(), cleanupErrors);
	await cleanup('session subscription', () => sessionSubscription?.close(), cleanupErrors);
	if (sessionCreated && connection) {
		await cleanup(
			'temporary AHP session',
			() => connection?.client.request('disposeSession', { channel: session }),
			cleanupErrors,
		);
	}
	await cleanup('Agent Host client', () => connection?.client.shutdown(), cleanupErrors);
	await cleanup('deterministic Agent Host', () => deterministicHost?.close(), cleanupErrors);
	environment?.restore();
	if (daemonStarted) {
		cleanupErrors.push(new Error(`temporary fakechat state retained because its daemon may still be running: ${testRoot}`));
	} else {
		await cleanup('temporary fakechat state', () => rm(testRoot, { recursive: true, force: true }), cleanupErrors);
	}

	if (primaryError) {
		for (const cleanupError of cleanupErrors) {
			console.error(`[e2e:fakechat] cleanup failed: ${cleanupError.message}`);
		}
		throw primaryError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'Official fakechat E2E passed but cleanup failed');
	}
}

async function requireBun(): Promise<void> {
	try {
		await runProcess('bun', ['--version'], { quiet: true });
	} catch (error) {
		throw new Error('e2e:fakechat requires Bun on PATH', { cause: error });
	}
}

interface InstalledFakechat {
	readonly installation: string;
	readonly path: string;
}

async function installOfficialFakechat(home: string): Promise<InstalledFakechat> {
	await runProcess(process.execPath, [
		join(repositoryRoot, 'dist', 'cli.js'),
		'plugin',
		'install',
		`${PLUGIN_NAME}@${OFFICIAL_MARKETPLACE_NAME}`,
	], {
		env: {
			...process.env,
			AHP_CHANNELS_HOME: home,
		},
	});

	const store = new ConfigStore(home);
	const config = await store.read();
	const installed = config.plugins[PLUGIN_NAME];
	if (installed?.marketplace !== OFFICIAL_MARKETPLACE_NAME) {
		throw new Error('The CLI did not register fakechat from claude-plugins-official');
	}
	const installation = installed.activeInstallation;
	const plugin = await new PluginManager(store).resolvePlugin(PLUGIN_NAME, installation);
	const relativePath = relative(home, plugin.path);
	const expectedPath = join(home, 'plugins', OFFICIAL_MARKETPLACE_NAME, PLUGIN_NAME, installation);
	if (plugin.name !== PLUGIN_NAME
		|| relativePath === '..'
		|| relativePath.startsWith(`..${sep}`)
		|| isAbsolute(relativePath)
		|| resolve(plugin.path) !== resolve(expectedPath)) {
		throw new Error(`Official fakechat was not installed as the expected immutable snapshot: ${plugin.path}`);
	}
	return { installation, path: plugin.path };
}

async function allocateLoopbackPort(): Promise<number> {
	const server = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
		});
		const address = server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Failed to allocate a loopback port for fakechat');
		}
		return address.port;
	} finally {
		if (server.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve());
			});
		}
	}
}

function requireRunningChannel(status: DaemonStatus, installation: string): string {
	const channel = status.channels.find(candidate => candidate.name === CHANNEL_NAME);
	if (channel?.state !== 'running'
		|| !channel.runtime
		|| channel.error
		|| channel.definition.installation !== installation) {
		throw new Error(`fakechat channel did not start: ${JSON.stringify(channel)}`);
	}
	return channel.runtime.clientId;
}

async function waitForFakechatContribution(
	initial: SessionState,
	subscription: Subscription,
	clientId: string,
): Promise<SessionState> {
	let state = initial;
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const activeClient = state.activeClients.find(candidate => candidate.clientId === clientId);
		const customization = state.customizations?.find(candidate =>
			candidate.type === CustomizationType.Plugin
			&& candidate.name === PLUGIN_NAME
			&& candidate.clientId === clientId
		);
		const plugin = customization?.type === CustomizationType.Plugin
			? customization
			: undefined;
		if (plugin?.load?.kind === CustomizationLoadStatus.Error) {
			throw new Error(`Agent Host failed to load official fakechat: ${plugin.load.message}`);
		}
		const toolNames = new Set(activeClient?.tools.map(tool => tool.name));
		const hasPluginServer = plugin?.children?.some(child =>
			child.type === CustomizationType.McpServer && child.name === PLUGIN_NAME
		);
		if (activeClient?.customizations?.some(customization => customization.name === PLUGIN_NAME)
			&& toolNames.has('reply')
			&& toolNames.has('edit_message')
			&& hasPluginServer) {
			return state;
		}

		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type === 'action' && !event.params.rejectionReason) {
			state = sessionReducer(state, event.params.action as SessionAction);
		}
	}
	throw new Error('Timed out waiting for official fakechat customizations and tools');
}

async function waitForActiveClientRemoval(
	initial: SessionState,
	subscription: Subscription,
	clientId: string,
): Promise<SessionState> {
	let state = initial;
	const deadline = Date.now() + 30_000;
	while (state.activeClients.some(client => client.clientId === clientId)) {
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type === 'action' && !event.params.rejectionReason) {
			state = sessionReducer(state, event.params.action as SessionAction);
		}
	}
	return state;
}

async function waitForFakechatReady(home: string, port: number): Promise<void> {
	const deadline = Date.now() + 60_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1000),
			});
			const body = await response.text();
			if (response.ok && body.includes('<title>fakechat</title>')) {
				return;
			}
			lastError = new Error(`fakechat returned HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}

		const status = await probeDaemon(home);
		const channel = status?.channels.find(candidate => candidate.name === CHANNEL_NAME);
		if (channel?.state === 'error') {
			throw new Error(`fakechat channel failed before its UI became ready: ${channel.error ?? 'unknown error'}`);
		}
		await delay(100);
	}
	throw new Error(`Timed out waiting for fakechat UI on 127.0.0.1:${port}`, { cause: lastError });
}

async function waitForFakechatStopped(port: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(500),
			});
		} catch {
			return;
		}
		await delay(100);
	}
	throw new Error(`fakechat UI kept port ${port} open after daemon shutdown`);
}

async function assertMissing(path: string): Promise<void> {
	try {
		await access(path);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	throw new Error(`Official fakechat modified its marketplace source: ${path}`);
}

async function connectFakechat(port: number): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`Timed out connecting to fakechat WebSocket on port ${port}`));
		}, 10_000);
		socket.once('open', () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once('error', error => {
			clearTimeout(timer);
			reject(new Error(`Failed to connect to fakechat WebSocket on port ${port}`, { cause: error }));
		});
	});
}

async function runRoundTrip(
	client: ConnectedAgentHost['client'],
	socket: WebSocket,
	initialChatState: ChatState,
	subscription: Subscription,
	expectedReply: string,
): Promise<void> {
	const prompt = [
		`Reply to this fakechat message with exactly ${expectedReply}.`,
		'Use the fakechat reply tool.',
		'Do not include quotes, punctuation, formatting, or any other text.',
	].join(' ');
	const messageId = `e2e-${randomUUID()}`;
	const turn = approveChannelTurn(client, initialChatState, subscription, expectedReply);
	const reply = waitForExactReply(socket, expectedReply);
	try {
		socket.send(JSON.stringify({ id: messageId, text: prompt }));
	} catch (error) {
		void Promise.allSettled([turn, reply]);
		throw error;
	}
	await Promise.all([turn, reply]);
}

function waitForExactReply(socket: WebSocket, expected: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => finish(new Error(`Timed out waiting for exact fakechat reply ${expected}`)),
			120_000,
		);
		const onMessage = (data: RawData) => {
			let value: unknown;
			try {
				value = JSON.parse(String(data));
			} catch (error) {
				finish(new Error('fakechat returned invalid WebSocket JSON', { cause: error }));
				return;
			}
			if (!isRecord(value) || value['type'] !== 'msg' || value['from'] !== 'assistant') {
				return;
			}
			if (value['text'] !== expected) {
				finish(new Error(`Expected fakechat reply ${expected}, received ${JSON.stringify(value['text'])}`));
				return;
			}
			finish();
		};
		const onClose = () => finish(new Error('fakechat WebSocket closed before the reply arrived'));
		const onError = (error: Error) => finish(new Error('fakechat WebSocket failed before the reply arrived', { cause: error }));
		const finish = (error?: Error) => {
			clearTimeout(timer);
			socket.off('message', onMessage);
			socket.off('close', onClose);
			socket.off('error', onError);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		socket.on('message', onMessage);
		socket.once('close', onClose);
		socket.once('error', onError);
	});
}

async function approveChannelTurn(
	client: ConnectedAgentHost['client'],
	initial: ChatState,
	subscription: Subscription,
	expectedMarker: string,
): Promise<void> {
	let activeTurnId = initial.activeTurn?.message.text.includes(expectedMarker)
		? initial.activeTurn.id
		: undefined;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type !== 'action' || event.params.rejectionReason) {
			continue;
		}
		const action = event.params.action;
		if (action.type === ActionType.ChatTurnStarted && action.message.text.includes(expectedMarker)) {
			activeTurnId = action.turnId;
			continue;
		}
		if (action.type === ActionType.ChatToolCallReady
			&& action.turnId === activeTurnId
			&& action.confirmed === undefined) {
			approveTool(client, subscription.uri, action);
			continue;
		}
		if ((action.type === ActionType.ChatTurnComplete
			|| action.type === ActionType.ChatTurnCancelled
			|| action.type === ActionType.ChatError)
			&& action.turnId === activeTurnId) {
			if (action.type !== ActionType.ChatTurnComplete) {
				throw new Error(`fakechat turn ${activeTurnId} ended with ${action.type}`);
			}
			return;
		}
	}
	throw new Error(`Timed out waiting for fakechat turn containing ${expectedMarker}`);
}

function approveTool(
	client: ConnectedAgentHost['client'],
	chat: string,
	action: ChatToolCallReadyAction,
): void {
	const selectedOptionId = action.options?.find(option =>
		option.kind === ConfirmationOptionKind.Approve && /once/i.test(option.id)
	)?.id ?? action.options?.find(option => option.kind === ConfirmationOptionKind.Approve)?.id;
	client.dispatch(chat, {
		type: ActionType.ChatToolCallConfirmed,
		turnId: action.turnId,
		toolCallId: action.toolCallId,
		approved: true,
		confirmed: ToolCallConfirmationReason.UserAction,
		...(selectedOptionId ? { selectedOptionId } : {}),
	});
}

async function waitForSessionChat(initial: SessionState, subscription: Subscription): Promise<SessionState> {
	let state = initial;
	const deadline = Date.now() + 60_000;
	while (state.chats.length === 0) {
		if (state.lifecycle === SessionLifecycle.Failed) {
			throw new Error(`fakechat E2E session creation failed: ${state.creationError?.message ?? 'unknown error'}`);
		}
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type === 'action' && !event.params.rejectionReason) {
			state = sessionReducer(state, event.params.action as SessionAction);
		}
	}
	return state;
}

async function nextEvent(subscription: Subscription, timeoutMs: number): Promise<SubscriptionEvent> {
	if (timeoutMs <= 0) {
		throw new Error('Timed out waiting for an Agent Host action');
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			subscription.next().then(result => {
				if (result.done) {
					throw new Error('Agent Host subscription closed unexpectedly');
				}
				return result.value;
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for an Agent Host action')), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) {
		return;
	}
	await new Promise<void>(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			socket.terminate();
			finish();
		}, 5000);
		socket.once('close', finish);
		if (socket.readyState === WebSocket.CONNECTING) {
			socket.once('open', () => socket.close());
		} else {
			socket.close();
		}
	});
}

function overrideEnvironment(values: Readonly<Record<string, string>>): { restore(): void } {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	return {
		restore() {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		},
	};
}

async function cleanup(
	label: string,
	operation: () => Promise<unknown> | undefined,
	errors: Error[],
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
