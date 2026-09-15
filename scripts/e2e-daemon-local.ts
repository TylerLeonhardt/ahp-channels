import {
	ActionType,
	ConfirmationOptionKind,
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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAgentHost, resolveChat } from '../src/ahp.js';
import { ensureDaemonStarted, requestDaemon, stopDaemon } from '../src/daemonClient.js';
import { discoverLocalAgentHosts, selectAgentHost } from '../src/endpoints.js';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = join(tmpdir(), `ahp-channels-daemon-e2e-${randomUUID()}`);
const pluginRoot = join(testRoot, 'plugin');
const outputFile = join(testRoot, 'replies.txt');
const fixtureServer = join(repositoryRoot, 'test', 'fixtures', 'fake-plugin', 'server.mjs');
const marker = `DAEMON_SWITCH_${randomUUID()}`;
const endpoint = selectAgentHost(await discoverLocalAgentHosts());
const connection = await connectAgentHost(endpoint);
const client = connection.client;
const sessions = [`ahp-session:/${randomUUID()}`, `ahp-session:/${randomUUID()}`] as const;
const sessionSubscriptions: Subscription[] = [];
const chatSubscriptions: Subscription[] = [];
let daemonStarted = false;

try {
	await createTestPlugin();
	const rootSnapshot = connection.initializeResult.snapshots.find(snapshot => snapshot.resource === 'ahp-root://');
	const provider = (rootSnapshot?.state as RootState | undefined)?.agents[0]?.provider;
	if (!provider) {
		throw new Error('The local Agent Host advertises no agent providers');
	}

	const chats: string[] = [];
	for (const session of sessions) {
		await client.request('createSession', { channel: session, provider });
		const subscribed = await client.subscribe(session);
		sessionSubscriptions.push(subscribed.subscription);
		if (!subscribed.result.snapshot) {
			throw new Error(`No state snapshot for ${session}`);
		}
		const state = await waitForSessionChat(
			subscribed.result.snapshot.state as SessionState,
			subscribed.subscription,
		);
		chats.push(resolveChat(state, undefined, session));
	}

	const firstChat = await client.subscribe(chats[0]);
	const secondChat = await client.subscribe(chats[1]);
	chatSubscriptions.push(firstChat.subscription, secondChat.subscription);
	if (!firstChat.result.snapshot || !secondChat.result.snapshot) {
		throw new Error('A daemon E2E chat returned no snapshot');
	}

	await ensureDaemonStarted(testRoot);
	daemonStarted = true;
	const firstTurn = approveChannelTurn(
		firstChat.result.snapshot.state as ChatState,
		firstChat.subscription,
		marker,
	);
	await requestDaemon(testRoot, {
		command: 'channel.create',
		name: 'switch-test',
		definition: {
			plugin: pluginRoot,
			session: sessions[0],
			enabled: false,
		},
		start: true,
	});
	await firstTurn;
	await waitForReplyCount(1);

	const secondTurn = approveChannelTurn(
		secondChat.result.snapshot.state as ChatState,
		secondChat.subscription,
		marker,
	);
	const switched = await requestDaemon(testRoot, {
		command: 'channel.switch',
		name: 'switch-test',
		session: sessions[1],
	});
	await secondTurn;
	await waitForReplyCount(2);

	const channel = switched.channels.find(candidate => candidate.name === 'switch-test');
	if (channel?.runtime?.session !== sessions[1]) {
		throw new Error(`Daemon did not switch to ${sessions[1]}`);
	}
	const replies = (await readFile(outputFile, 'utf8')).trim().split(/\r?\n/);
	if (replies.length !== 2 || replies.some(reply => reply !== 'PONG')) {
		throw new Error(`Expected two PONG replies, received ${JSON.stringify(replies)}`);
	}
	console.log(`Daemon E2E passed: routed ${marker} through ${sessions[0]} and then ${sessions[1]}`);

	await requestDaemon(testRoot, { command: 'channel.stop', name: 'switch-test' });
	await requestDaemon(testRoot, { command: 'channel.delete', name: 'switch-test' });
} finally {
	if (daemonStarted) {
		await stopDaemon(testRoot).catch(error => {
			console.error(`[e2e] Failed to stop daemon: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	for (const subscription of chatSubscriptions) {
		await subscription.close();
	}
	for (const subscription of sessionSubscriptions) {
		await subscription.close();
	}
	for (const session of sessions) {
		await client.request('disposeSession', { channel: session }).catch(error => {
			console.error(`[e2e] Failed to dispose ${session}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	await client.shutdown();
	await rm(testRoot, { recursive: true, force: true });
}

async function createTestPlugin(): Promise<void> {
	await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
	await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
		name: 'fake-channel',
		version: '1.0.0',
	}));
	await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify({
		mcpServers: {
			'fake-channel': {
				command: process.execPath,
				args: [fixtureServer],
				env: {
					AHP_CHANNELS_FAKE_OUTPUT: outputFile,
					AHP_CHANNELS_FAKE_MESSAGE: `Use the reply tool to send exactly PONG. Marker: ${marker}`,
				},
			},
		},
	}));
}

async function approveChannelTurn(initial: ChatState, subscription: Subscription, expectedMarker: string): Promise<void> {
	let activeTurnId = initial.activeTurn?.message.text.includes(expectedMarker) ? initial.activeTurn.id : undefined;
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
		if (action.type === ActionType.ChatToolCallReady && action.turnId === activeTurnId && action.confirmed === undefined) {
			approveTool(subscription.uri, action);
			continue;
		}
		if ((action.type === ActionType.ChatTurnComplete
			|| action.type === ActionType.ChatTurnCancelled
			|| action.type === ActionType.ChatError)
			&& action.turnId === activeTurnId) {
			if (action.type !== ActionType.ChatTurnComplete) {
				throw new Error(`Channel turn ${activeTurnId} ended with ${action.type}`);
			}
			return;
		}
	}
	throw new Error(`Timed out waiting for channel turn containing ${expectedMarker}`);
}

function approveTool(chat: string, action: ChatToolCallReadyAction): void {
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
			throw new Error(`Session creation failed: ${state.creationError?.message ?? 'unknown error'}`);
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

async function waitForReplyCount(count: number): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			const replies = (await readFile(outputFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
			if (replies.length >= count) {
				return;
			}
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
				throw error;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${count} channel replies`);
}
