import {
	CustomizationType,
	SessionLifecycle,
	sessionReducer,
	type ChatState,
	type RootState,
	type SessionState,
	type StateAction,
} from '@microsoft/agent-host-protocol';
import type { Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAgentHost, resolveChat } from '../src/ahp.js';
import { ChannelBridge } from '../src/bridge.js';
import { discoverLocalAgentHosts, selectAgentHost } from '../src/endpoints.js';
import { McpChannelProcess } from '../src/mcpChannel.js';
import { createPluginResourceRequestHandlers } from '../src/pluginResources.js';
import { createPluginCustomization, inspectPlugin, resolvePluginServer } from '../src/plugins.js';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = await inspectPlugin(join(repositoryRoot, 'test', 'fixtures', 'fake-plugin'));
const outputFile = join(tmpdir(), `ahp-channels-e2e-${randomUUID()}.txt`);
const endpoints = await discoverLocalAgentHosts();
const endpoint = process.env['AHP_CHANNELS_E2E_HOST']
	? selectAgentHost(endpoints, process.env['AHP_CHANNELS_E2E_HOST'])
	: endpoints.find(candidate => candidate.type === 'standalone') ?? selectAgentHost(endpoints);
const connection = await connectAgentHost(endpoint);
const client = connection.client;
client.setResourceRequestHandlers(await createPluginResourceRequestHandlers(plugin.path));
const session = `ahp-session:/${randomUUID()}`;
let created = false;
let sessionSubscription: Subscription | undefined;
let bridge: ChannelBridge | undefined;
let mcp: McpChannelProcess | undefined;
let primaryError: unknown;

try {
	const channelServer = resolvePluginServer(plugin);
	mcp = new McpChannelProcess({
		...channelServer.config,
		env: {
			...channelServer.config.env,
			AHP_CHANNELS_FAKE_OUTPUT: outputFile,
			AHP_CHANNELS_FAKE_MESSAGE: 'Use the reply tool to send exactly PONG. Do not answer in the transcript.',
		},
	}, {
		write(chunk: string): void {
			process.stderr.write(`[fake-channel] ${chunk}`);
		},
	});
	const channelInfo = await mcp.start();

	const rootSnapshot = connection.initializeResult.snapshots.find(snapshot => snapshot.resource === 'ahp-root://');
	const rootState = rootSnapshot?.state as RootState | undefined;
	const provider = rootState?.agents[0]?.provider;
	if (!provider) {
		throw new Error('The local Agent Host advertises no agent providers');
	}

	const customizations = [createPluginCustomization(plugin, connection.clientId, channelServer.name)];
	await client.request('createSession', {
		channel: session,
		provider,
		activeClient: {
			clientId: connection.clientId,
			displayName: 'ahp-channels e2e',
			tools: [...channelInfo.tools],
			customizations,
		},
	});
	created = true;

	const subscribed = await client.subscribe(session);
	sessionSubscription = subscribed.subscription;
	if (!subscribed.result.snapshot) {
		throw new Error('The E2E session returned no snapshot');
	}
	const sessionStateWithChat = await waitForSessionChat(
		subscribed.result.snapshot.state as SessionState,
		sessionSubscription,
	);
	const chat = resolveChat(sessionStateWithChat, undefined, session);
	const chatSubscription = await client.subscribe(chat);
	if (!chatSubscription.result.snapshot) {
		await chatSubscription.subscription.close();
		throw new Error('The E2E chat returned no snapshot');
	}

	bridge = new ChannelBridge({
		client,
		clientId: connection.clientId,
		session,
		chat,
		chatState: chatSubscription.result.snapshot.state as ChatState,
		chatSubscription: chatSubscription.subscription,
		channel: mcp,
		channelInfo,
		customizations,
		autoApproveTools: true,
		onStatus: message => console.log(`[e2e] ${message}`),
	});
	await bridge.start();
	await waitForPluginSkill(
		sessionStateWithChat,
		sessionSubscription,
		plugin.name,
		'configure',
	);

	const reply = await waitForFile(outputFile, 120_000);
	if (reply.trim().toUpperCase() !== 'PONG') {
		throw new Error(`Expected channel reply PONG, received ${JSON.stringify(reply)}`);
	}
	console.log(`E2E passed: ${channelInfo.name} contributed its configure skill and received ${reply.trim()} from ${provider}`);
} catch (error) {
	primaryError = error;
} finally {
	const cleanupErrors: Error[] = [];
	await cleanup('bridge', () => bridge?.close(), cleanupErrors);
	if (!bridge) {
		await cleanup('MCP channel', () => mcp?.close(), cleanupErrors);
	}
	await cleanup('session subscription', () => sessionSubscription?.close(), cleanupErrors);
	if (created) {
		await cleanup('E2E session', () => client.request('disposeSession', { channel: session }), cleanupErrors);
	}
	await cleanup('AHP client', () => client.shutdown(), cleanupErrors);
	await cleanup('output file', () => rm(outputFile, { force: true }), cleanupErrors);
	if (primaryError) {
		for (const error of cleanupErrors) {
			console.error(`[e2e] cleanup failed: ${error.message}`);
		}
		throw primaryError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, 'E2E validation passed but cleanup failed');
	}
}

async function waitForSessionChat(initial: SessionState, subscription: Subscription): Promise<SessionState> {
	let state = initial;
	const deadline = Date.now() + 60_000;
	while (state.chats.length === 0) {
		if (state.lifecycle === SessionLifecycle.Failed) {
			throw new Error(`E2E session creation failed: ${state.creationError?.message ?? 'unknown error'}`);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error('Timed out waiting for the E2E session chat');
		}
		const event = await nextEvent(subscription, remaining);
		if (event.type === 'action' && !event.params.rejectionReason && isSessionAction(event.params.action)) {
			state = sessionReducer(state, event.params.action);
		}
	}
	return state;
}

async function waitForPluginSkill(
	initial: SessionState,
	subscription: Subscription,
	pluginName: string,
	skillName: string,
): Promise<SessionState> {
	let state = initial;
	const deadline = Date.now() + 60_000;
	while (!state.customizations?.some(customization =>
		customization.type === CustomizationType.Plugin
		&& customization.name === pluginName
		&& customization.children?.some(child =>
			child.type === CustomizationType.Skill && child.name === skillName
		)
	)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timed out waiting for ${pluginName}:${skillName}; customizations: ${JSON.stringify(state.customizations ?? [])}`,
			);
		}
		let event: SubscriptionEvent;
		try {
			event = await nextEvent(subscription, remaining);
		} catch (error) {
			throw new Error(
				`Timed out waiting for ${pluginName}:${skillName}; customizations: ${JSON.stringify(state.customizations ?? [])}`,
				{ cause: error },
			);
		}
		if (event.type === 'action' && !event.params.rejectionReason && isSessionAction(event.params.action)) {
			state = sessionReducer(state, event.params.action);
		}
	}
	return state;
}

function isSessionAction(action: StateAction): action is Extract<StateAction, { type: `session/${string}` }> {
	return action.type.startsWith('session/');
}

async function nextEvent(subscription: Subscription, timeoutMs: number): Promise<SubscriptionEvent> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			subscription.next().then(result => {
				if (result.done) {
					throw new Error('Session subscription closed before the session chat was created');
				}
				return result.value;
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for a session action')), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const content = await readFile(path, 'utf8');
			if (content.length > 0) {
				return content;
			}
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
				throw error;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error('Timed out waiting for the channel reply tool');
}

async function cleanup(label: string, operation: () => Promise<unknown> | undefined, errors: Error[]): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
	}
}
