import {
	ActionType,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	sessionReducer,
	type ChatState,
	type RootState,
	type SessionAction,
	type SessionState,
} from '@microsoft/agent-host-protocol';
import type { Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';
import { connectAgentHost, resolveChat, type ConnectedAgentHost } from '../src/ahp.js';
import { ConfigStore } from '../src/config.js';
import {
	ensureDaemonStarted,
	probeDaemon,
	requestDaemon,
	stopDaemon,
} from '../src/daemonClient.js';
import { discoverAgentHostsInRegistryDirectories } from '../src/endpoints.js';
import { HANDOFF_RESOURCE_TOOL, assertHandoffResource, handoffResourceUri } from '../test/fixtures/handoff-resource.js';
import {
	DeterministicAgentHost,
	type DeterministicHandoffTarget,
} from './deterministic-agent-host.js';

const CHANNEL_NAME = 'handoff-e2e';
const PLUGIN_NAME = 'handoff-channel-fixture';
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureEntry = join(repositoryRoot, 'test', 'fixtures', 'handoff-channel.ts');
const testRoot = await mkdtemp(join(tmpdir(), 'ahp-channel-handoff-'));
const sourceRegistry = join(testRoot, 'source-registry');
const destinationRegistry = join(testRoot, 'destination-registry');
const pluginPath = join(testRoot, 'plugin');
const sourceSession = `ahp-session:/${randomUUID()}`;
const destinationSession = `ahp-session:/${randomUUID()}`;
const handoffMarker = `AHP_CHANNEL_HANDOFF_${randomUUID()}`;
const sourceReply = `HANDOFF_SOURCE_REPLY_${randomUUID()}`;
const destinationReply = `FAKECHAT_FIRST_${randomUUID()}`;
const resourceId = process.argv.includes('--resources') ? randomUUID() : undefined;
const hosts = [
	new DeterministicAgentHost(sourceRegistry),
	new DeterministicAgentHost(destinationRegistry),
];
const connections: ConnectedAgentHost[] = [];
const subscriptions: Subscription[] = [];
const sockets = new Set<WebSocket>();
let daemonStarted = false;
let channelCreated = false;
let primaryError: unknown;
const environment = overrideEnvironment({
	AHP_CHANNELS_ENDPOINT_REGISTRY: sourceRegistry,
});

try {
	const port = await allocateLoopbackPort();
	await Promise.all(hosts.map(host => host.start()));
	const [sourceEndpoint] = await discoverAgentHostsInRegistryDirectories([sourceRegistry]);
	const [destinationEndpoint] = await discoverAgentHostsInRegistryDirectories([destinationRegistry]);
	if (!sourceEndpoint || !destinationEndpoint) {
		throw new Error('Deterministic handoff Agent Hosts did not publish isolated endpoints');
	}
	const sourceConnection = await connectAgentHost(sourceEndpoint);
	const destinationConnection = await connectAgentHost(destinationEndpoint);
	connections.push(sourceConnection, destinationConnection);
	const source = await createSession(sourceConnection, sourceSession);
	const destination = await createSession(destinationConnection, destinationSession);
	subscriptions.push(
		source.sessionSubscription,
		source.chatSubscription,
		destination.sessionSubscription,
		destination.chatSubscription,
	);

	const target: DeterministicHandoffTarget = {
		host: '@destination',
		session: destinationSession,
		chat: destination.chat,
		sourceReply,
		...(resourceId ? { resourceId } : {}),
	};
	hosts[0].configureHandoff(handoffMarker, target);
	await createFixturePlugin(pluginPath, port);
	const store = new ConfigStore(testRoot);
	await store.update(config => ({
		...config,
		hostAliases: {
			source: {
				kind: 'vscode-local',
				registry: sourceRegistry,
				hostType: 'standalone',
			},
			destination: {
				kind: 'vscode-local',
				registry: destinationRegistry,
				hostType: 'standalone',
			},
		},
	}));

	await ensureDaemonStarted(testRoot);
	daemonStarted = true;
	const created = await requestDaemon(testRoot, {
		command: 'channel.create',
		name: CHANNEL_NAME,
		definition: {
			plugin: pluginPath,
			host: '@source',
			session: sourceSession,
			chat: source.chat,
			enabled: false,
		},
		start: true,
	});
	channelCreated = true;
	const sourceRuntime = requireRunningBinding(
		created,
		'@source',
		sourceEndpoint.id,
		sourceSession,
		source.chat,
	);
	await waitForClientTools(
		source.state,
		source.sessionSubscription,
		sourceRuntime.clientId,
		['reply', 'ahp_channels_handoff'],
	);

	const sourceSocket = await connectExternalChannel(port);
	sockets.add(sourceSocket);
	const sourceProgress = new EventEmitter<{ pending: [] }>();
	const sourceTurn = observeSourceHandoffTurn(
		source.chatSubscription,
		handoffMarker,
		sourceRuntime.clientId,
		sourceProgress,
		resourceId,
	);
	const sourceResponse = waitForExactExternalReply(sourceSocket, sourceReply);
	const resourceHandoff = resourceId
		? verifyResourceHandoff(sourceSocket, sourceProgress, sourceRuntime.bindingId, resourceId)
		: Promise.resolve();
	sendExternalMessage(sourceSocket, `Please redirect this channel now: ${handoffMarker}`);
	await Promise.all([sourceTurn, sourceResponse, resourceHandoff]);
	await waitForSocketClose(sourceSocket);
	sockets.delete(sourceSocket);

	const applied = await waitForAppliedHandoff(testRoot);
	const destinationRuntime = requireRunningBinding(
		applied,
		'@destination',
		destinationEndpoint.id,
		destinationSession,
		destination.chat,
	);
	assert.equal(applied.channels[0]?.handoff?.state, 'applied');
	assert.equal(applied.channels[0]?.handoff?.source.session, sourceSession);
	assert.equal(applied.channels[0]?.handoff?.resolvedTarget.actualHost, destinationEndpoint.id);
	await waitForClientTools(
		destination.state,
		destination.sessionSubscription,
		destinationRuntime.clientId,
		['reply', 'ahp_channels_handoff'],
	);

	const destinationSocket = await connectExternalChannel(port);
	sockets.add(destinationSocket);
	const destinationTurn = observeDestinationTurn(
		destination.chatState,
		destination.chatSubscription,
		destinationReply,
		resourceId,
	);
	const destinationResponse = waitForExactExternalReply(destinationSocket, destinationReply);
	sendExternalMessage(
		destinationSocket,
		`Reply with exactly ${destinationReply}. Use the reply tool.`,
	);
	await Promise.all([destinationTurn, destinationResponse]);
	await closeWebSocket(destinationSocket);
	sockets.delete(destinationSocket);

	await requestDaemon(testRoot, { command: 'channel.delete', name: CHANNEL_NAME });
	channelCreated = false;
	console.log([
		'Deterministic cross-host handoff E2E passed:',
		`${sourceEndpoint.id}/${sourceSession}/${source.chat}`,
		'->',
		`${destinationEndpoint.id}/${destinationSession}/${destination.chat}`,
		...(resourceId ? ['including an in-flight MCP resources/read with exact text and PNG bytes'] : []),
		'(fixture agent, fixture external channel; no real model or browser)',
	].join(' '));
} catch (error) {
	primaryError = error;
} finally {
	const cleanupErrors: Error[] = [];
	for (const socket of sockets) {
		await cleanup('external channel WebSocket', () => closeWebSocket(socket), cleanupErrors);
	}
	if (channelCreated && daemonStarted) {
		await cleanup(
			'handoff channel',
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
	for (const subscription of subscriptions) {
		await cleanup('AHP subscription', () => subscription.close(), cleanupErrors);
	}
	for (const [connection, session] of [
		[connections[0], sourceSession],
		[connections[1], destinationSession],
	] as const) {
		if (connection) {
			await cleanup(
				`temporary session ${session}`,
				() => connection.client.request('disposeSession', { channel: session }),
				cleanupErrors,
			);
			await cleanup('Agent Host client', () => connection.client.shutdown(), cleanupErrors);
		}
	}
	for (const host of hosts) {
		await cleanup('deterministic Agent Host', () => host.close(), cleanupErrors);
	}
	environment.restore();
	if (daemonStarted) {
		cleanupErrors.push(new Error(`temporary handoff state retained because its daemon may still be running: ${testRoot}`));
	} else {
		await cleanup('temporary handoff state', () => rm(testRoot, { recursive: true, force: true }), cleanupErrors);
	}

	if (primaryError) {
		for (const cleanupError of cleanupErrors) {
			console.error(`[e2e:handoff] cleanup failed: ${cleanupError.message}`);
		}
		throw primaryError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'Handoff E2E passed but cleanup failed');
	}
}

interface CreatedSession {
	readonly state: SessionState;
	readonly chat: string;
	readonly chatState: ChatState;
	readonly sessionSubscription: Subscription;
	readonly chatSubscription: Subscription;
}

async function createSession(
	connection: ConnectedAgentHost,
	session: string,
): Promise<CreatedSession> {
	const root = connection.initializeResult.snapshots.find(snapshot => snapshot.resource === 'ahp-root://');
	const provider = (root?.state as RootState | undefined)?.agents[0]?.provider;
	if (!provider) {
		throw new Error('Deterministic Agent Host advertises no provider');
	}
	await connection.client.request('createSession', { channel: session, provider });
	const subscribedSession = await connection.client.subscribe(session);
	if (!subscribedSession.result.snapshot) {
		throw new Error(`Session ${session} returned no snapshot`);
	}
	const state = subscribedSession.result.snapshot.state as SessionState;
	const chat = resolveChat(state, undefined, session);
	const subscribedChat = await connection.client.subscribe(chat);
	if (!subscribedChat.result.snapshot) {
		throw new Error(`Chat ${chat} returned no snapshot`);
	}
	return {
		state,
		chat,
		chatState: subscribedChat.result.snapshot.state as ChatState,
		sessionSubscription: subscribedSession.subscription,
		chatSubscription: subscribedChat.subscription,
	};
}

async function createFixturePlugin(path: string, port: number): Promise<void> {
	await mkdir(join(path, '.claude-plugin'), { recursive: true });
	await writeFile(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({
		name: PLUGIN_NAME,
		version: '1.0.0',
	}));
	await writeFile(join(path, '.mcp.json'), JSON.stringify({
		mcpServers: {
			[PLUGIN_NAME]: {
				command: process.execPath,
				args: ['--import', import.meta.resolve('tsx'), fixtureEntry],
				env: {
					AHP_CHANNEL_HANDOFF_FIXTURE_PORT: String(port),
				},
			},
		},
	}));
}

function requireRunningBinding(
	status: Awaited<ReturnType<typeof requestDaemon>>,
	preferredHost: string,
	actualHost: string,
	session: string,
	chat: string,
) {
	const channel = status.channels.find(candidate => candidate.name === CHANNEL_NAME);
	if (channel?.state !== 'running'
		|| channel.definition.host !== preferredHost
		|| channel.runtime?.host !== actualHost
		|| channel.runtime.session !== session
		|| channel.runtime.chat !== chat) {
		throw new Error(`Channel did not use the expected binding: ${JSON.stringify(channel)}`);
	}
	return channel.runtime;
}

async function waitForClientTools(
	initial: SessionState,
	subscription: Subscription,
	clientId: string,
	expected: readonly string[],
): Promise<void> {
	let state = initial;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const tools = new Set(state.activeClients.find(client => client.clientId === clientId)?.tools.map(tool => tool.name));
		if (expected.every(tool => tools.has(tool))) {
			return;
		}
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type === 'action' && !event.params.rejectionReason) {
			state = sessionReducer(state, event.params.action as SessionAction);
		}
	}
	throw new Error(`Timed out waiting for tools: ${expected.join(', ')}`);
}

async function observeSourceHandoffTurn(
	subscription: Subscription,
	marker: string,
	clientId: string,
	progress: EventEmitter<{ pending: [] }>,
	expectedResourceId?: string,
): Promise<void> {
	let turnId: string | undefined;
	let sawPendingResult = false;
	let sawSourceReply = false;
	let resourceToolCallId: string | undefined;
	let sawResourceResult = false;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type !== 'action' || event.params.rejectionReason) {
			continue;
		}
		const action = event.params.action;
		if (action.type === ActionType.ChatTurnStarted && action.message.text.includes(marker)) {
			turnId = action.turnId;
			continue;
		}
		if (!turnId || !('turnId' in action) || action.turnId !== turnId) {
			continue;
		}
		if (action.type === ActionType.ChatToolCallReady
			&& action.contributor?.kind === ToolCallContributorKind.Client
			&& action.contributor.clientId === clientId
			&& action.confirmed === ToolCallConfirmationReason.Setting) {
			assert.equal(event.params.origin, undefined, 'The fixture host, not the bridge, must authorize management');
		}
		if (action.type === ActionType.ChatToolCallComplete
			&& action.result.structuredContent?.['state'] === 'pending') {
			assert.equal(action.result.success, true);
			sawPendingResult = true;
			progress.emit('pending');
		}
		if (action.type === ActionType.ChatToolCallStart && action.toolName === HANDOFF_RESOURCE_TOOL) {
			resourceToolCallId = action.toolCallId;
			assert.equal(action.contributor?.kind, ToolCallContributorKind.Client);
			assert.equal(action.contributor.clientId, clientId);
		}
		if (action.type === ActionType.ChatToolCallComplete && action.toolCallId === resourceToolCallId) {
			assert.ok(expectedResourceId);
			assert.equal(sawPendingResult, true, 'Resource materialization must finish after the pending handoff result');
			assertHandoffResource(action.result, expectedResourceId);
			sawResourceResult = true;
		}
		if (action.type === ActionType.ChatToolCallStart && action.toolName === 'reply') {
			sawSourceReply = true;
		}
		if (action.type === ActionType.ChatTurnComplete) {
			assert.equal(sawPendingResult, true, 'Source agent must receive an accurate pending handoff result');
			assert.equal(sawSourceReply, true, 'Source response must finish through the plugin before handoff');
			if (expectedResourceId) {
				assert.equal(sawResourceResult, true, 'The source turn must consume the materialized resource before handoff');
			}
			return;
		}
	}
	throw new Error('Timed out observing the source handoff turn');
}

async function observeDestinationTurn(
	initial: ChatState,
	subscription: Subscription,
	marker: string,
	sourceResourceId?: string,
): Promise<void> {
	let turnId = initial.activeTurn?.message.text.includes(marker)
		? initial.activeTurn.id
		: undefined;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const event = await nextEvent(subscription, deadline - Date.now());
		if (event.type !== 'action' || event.params.rejectionReason) {
			continue;
		}
		const action = event.params.action;
		if (sourceResourceId && action.type === ActionType.ChatToolCallComplete) {
			assert.ok(!JSON.stringify(action.result).includes(handoffResourceUri(sourceResourceId)),
				'Source resource results must never be published in the destination chat');
		}
		if (action.type === ActionType.ChatTurnStarted && action.message.text.includes(marker)) {
			turnId = action.turnId;
		}
		if (action.type === ActionType.ChatTurnComplete && action.turnId === turnId) {
			return;
		}
	}
	throw new Error('Timed out observing the destination turn');
}

async function verifyResourceHandoff(
	socket: WebSocket,
	progress: EventEmitter<{ pending: [] }>,
	sourceBindingId: string,
	id: string,
): Promise<void> {
	const pending = once(progress, 'pending', { signal: AbortSignal.timeout(30_000) });
	const request = waitForExternalMessage(socket, { type: 'resource-read-started', uri: handoffResourceUri(id) })
		.then(() => hosts[0].requestConfiguredHandoff(handoffMarker));
	await Promise.all([pending, request]);
	const status = await requestDaemon(testRoot, { command: 'status' });
	const channel = status.channels.find(candidate => candidate.name === CHANNEL_NAME);
	assert.equal(channel?.handoff?.state, 'pending');
	assert.equal(channel.runtime?.bindingId, sourceBindingId);
	assert.equal(channel.definition.session, sourceSession);
	assert.equal(socket.readyState, WebSocket.OPEN, 'The source plugin must survive the blocked resource read');
	socket.send(JSON.stringify({ type: 'release-resource', uri: handoffResourceUri(id) }));
}

async function waitForAppliedHandoff(home: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const status = await probeDaemon(home);
		const channel = status?.channels.find(candidate => candidate.name === CHANNEL_NAME);
		if (channel?.handoff?.state === 'failed') {
			throw new Error(`Handoff failed: ${channel.handoff.error}`);
		}
		if (status && channel?.handoff?.state === 'applied') {
			return status;
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for the handoff to apply');
}

function sendExternalMessage(socket: WebSocket, text: string): void {
	socket.send(JSON.stringify({ id: randomUUID(), text }));
}

function waitForExactExternalReply(socket: WebSocket, expected: string): Promise<void> {
	return waitForExternalMessage(socket, { type: 'assistant', text: expected });
}

function waitForExternalMessage(socket: WebSocket, expected: Readonly<Record<string, string>>): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => finish(new Error(`Timed out waiting for external message ${JSON.stringify(expected)}`)),
			30_000,
		);
		const onMessage = (data: RawData) => {
			let value: unknown;
			try {
				value = JSON.parse(String(data));
			} catch (error) {
				finish(new Error('External channel returned invalid JSON', { cause: error }));
				return;
			}
			if (isRecord(value) && Object.entries(expected).every(([key, item]) => value[key] === item)) {
				finish();
			}
		};
		const onClose = () => finish(new Error(`External channel closed before message ${JSON.stringify(expected)}`));
		const finish = (error?: Error) => {
			clearTimeout(timer);
			socket.off('message', onMessage);
			socket.off('close', onClose);
			error ? reject(error) : resolve();
		};
		socket.on('message', onMessage);
		socket.once('close', onClose);
	});
}

async function connectExternalChannel(port: number): Promise<WebSocket> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once('open', resolve);
				socket.once('error', reject);
			});
			return socket;
		} catch (error) {
			lastError = error;
			socket.terminate();
			await delay(50);
		}
	}
	throw new Error(`Timed out connecting to external channel on port ${port}`, { cause: lastError });
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off('close', onClose);
			reject(new Error('Source external channel stayed open after handoff'));
		}, 30_000);
		const onClose = () => {
			clearTimeout(timer);
			resolve();
		};
		socket.once('close', onClose);
	});
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) {
		return;
	}
	await new Promise<void>(resolve => {
		const timer = setTimeout(() => {
			socket.terminate();
			resolve();
		}, 2000);
		socket.once('close', () => {
			clearTimeout(timer);
			resolve();
		});
		socket.close();
	});
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
			throw new Error('Failed to allocate a loopback port');
		}
		return address.port;
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve());
		});
	}
}

async function nextEvent(subscription: Subscription, timeoutMs: number): Promise<SubscriptionEvent> {
	if (timeoutMs <= 0) {
		throw new Error('Timed out waiting for an AHP action');
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			subscription.next().then(result => {
				if (result.done) {
					throw new Error('AHP subscription closed unexpectedly');
				}
				return result.value;
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for an AHP action')), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
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
