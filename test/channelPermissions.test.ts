import {
	ActionType,
	ContentEncoding,
	ConfirmationOptionKind,
	MessageKind,
	ResponsePartKind,
	SessionStatus,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	ToolCallStatus,
	type ActionEnvelope,
	type ChatState,
	type ChatToolCallStartAction,
	type ResponsePart,
	type ResourceReadParams,
	type ResourceReadResult,
	type StateAction,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it, type TestContext } from 'node:test';
import {
	ChannelPermissionRelay,
	PERMISSION_REQUEST_TTL_MS,
	type ChannelPermissionRequest,
	type ChannelPermissionTransport,
	type PermissionHost,
	type PermissionTransportEvents,
} from '../src/channelPermissions.js';

const chat = 'ahp-chat:/permissions';
const turnId = 'turn-1';
const toolCallId = 'tool-1';

class TestTransport implements ChannelPermissionTransport {
	readonly events = new EventEmitter<PermissionTransportEvents>();
	readonly requests: ChannelPermissionRequest[] = [];
	sendError: Error | undefined;

	async sendRequest(request: ChannelPermissionRequest): Promise<void> {
		if (this.sendError) {
			throw this.sendError;
		}
		this.requests.push(request);
	}
}

class TestHost implements PermissionHost {
	readonly dispatched: Array<{ channel: string; action: StateAction }> = [];
	input = '{"command":"echo first"}';
	readResult: Promise<ResourceReadResult> | undefined;

	dispatch(channel: string, action: StateAction): DispatchHandle {
		this.dispatched.push({ channel, action });
		return { clientSeq: this.dispatched.length };
	}

	async request(_method: 'resourceRead', _params: ResourceReadParams): Promise<ResourceReadResult> {
		return this.readResult ?? { data: this.input, encoding: ContentEncoding.Utf8 };
	}
}

function createRelay(context: TestContext, initial: ChatState = emptyState(), nativePermissions = true) {
	const host = new TestHost();
	const transport = new TestTransport();
	const relay = new ChannelPermissionRelay(
		host, 'channel-client', chat, nativePermissions ? transport : undefined, initial,
		[{ name: 'reply' }, { name: 'edit_message' }],
	);
	const failures: Error[] = [];
	const statuses: string[] = [];
	relay.events.on('failure', error => failures.push(error));
	relay.events.on('status', message => statuses.push(message));
	relay.start();
	context.after(() => relay.close());
	let serverSeq = 0;
	const observe = (action: StateAction, extra: Partial<ActionEnvelope> = {}) => relay.observe({
		channel: chat,
		action,
		serverSeq: ++serverSeq,
		origin: undefined,
		...extra,
	});
	const beginTool = (
		input: string | { uri: string } = '{"command":"echo hello"}',
		tool: Pick<ChatToolCallStartAction, 'toolName' | 'displayName' | 'contributor' | 'intention'> = { toolName: 'shell', displayName: 'Shell' },
	) => {
		observe({
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: { text: 'use the tool', origin: { kind: MessageKind.User } },
		});
		observe({ type: ActionType.ChatToolCallStart, turnId, toolCallId, ...tool });
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId,
			invocationMessage: { markdown: 'Run the requested command' },
			toolInput: input,
		});
	};
	return { host, transport, relay, failures, statuses, observe, beginTool };
}

describe('channel permission relay', () => {
	for (const nativePermissions of [true, false]) {
		for (const toolName of ['reply', 'edit_message']) {
			it(`automatically approves contributed ${toolName} ${nativePermissions ? 'with' : 'without'} native permissions`, context => {
				const { host, transport, relay, beginTool } = createRelay(context, emptyState(), nativePermissions);
				beginTool('{"text":"hello"}', {
					toolName, displayName: toolName,
					contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
				});
				assert.deepEqual(host.dispatched, [{
					channel: chat,
					action: {
						type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
						approved: true, confirmed: ToolCallConfirmationReason.NotNeeded,
					},
				}]);
				assert.deepEqual(transport.requests, []);
				relay.start();
				assert.equal(host.dispatched.length, 1);
			});
		}
	}

	for (const tool of [
		{ toolName: 'reply', displayName: 'Reply' },
		{
			toolName: 'reply', displayName: 'Reply',
			contributor: { kind: ToolCallContributorKind.Client, clientId: 'other-client' },
		},
	] satisfies ReadonlyArray<Pick<ChatToolCallStartAction, 'toolName' | 'displayName' | 'contributor'>>) {
		it(`does not auto-approve ${tool.toolName} from ${tool.contributor?.clientId ?? 'the host'}`, async context => {
			const { host, transport, beginTool } = createRelay(context);
			beginTool('{}', tool);
			await waitFor(() => transport.requests.length === 1);
			assert.deepEqual(host.dispatched, []);
		});
	}

	for (const nativePermissions of [true, false]) {
		it(`denies an unavailable owned tool ${nativePermissions ? 'with' : 'without'} native permissions`, context => {
			const { host, transport, statuses, beginTool } = createRelay(context, emptyState(), nativePermissions);
			beginTool('{}', {
				toolName: 'unadvertised', displayName: 'Unadvertised',
				contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
			});
			const action = host.dispatched[0]?.action;
			assert.ok(action?.type === ActionType.ChatToolCallConfirmed && !action.approved);
			assert.equal(action.reason, ToolCallCancellationReason.Denied);
			assert.match(String(action.reasonMessage), /unadvertised.*no longer available/);
			assert.deepEqual(transport.requests, []);
			assert.ok(statuses.some(message => message.includes('no longer available')));
		});
	}

	it('shows the current permission request when a running tool needs re-confirmation', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool('{}', { toolName: 'shell', displayName: 'Shell', intention: 'Inspect project' });
		await waitFor(() => transport.requests.length === 1);
		observe({
			type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
			approved: true, confirmed: ToolCallConfirmationReason.UserAction,
		});
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId,
			invocationMessage: { markdown: 'Allow access outside the workspace' },
			toolInput: '{}',
		});
		await waitFor(() => transport.requests.length === 2);
		assert.match(transport.requests[1].description, /Allow access outside the workspace/);
		assert.match(transport.requests[1].description, /Inspect project/);
		assert.deepEqual(host.dispatched, []);
	});

	it('leaves host permissions in the host UI when there is no native transport', context => {
		const { host, transport, beginTool } = createRelay(context, emptyState(), false);
		beginTool();
		assert.deepEqual(host.dispatched, []);
		assert.deepEqual(transport.requests, []);
	});

	it('surfaces rejected automatic approvals without offering a channel prompt', context => {
		const { host, transport, failures, observe, beginTool } = createRelay(context);
		beginTool('{}', {
			toolName: 'reply', displayName: 'Reply',
			contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
		});
		assert.equal(host.dispatched.length, 1);
		observe(host.dispatched[0].action, {
			rejectionReason: 'read only',
			origin: { clientId: 'channel-client', clientSeq: 1 },
		});
		assert.match(failures[0]?.message ?? '', /rejected.*automatic.*read only/);
		assert.deepEqual(transport.requests, []);
	});

	it('still approves channel tools when the native prompt capacity is exhausted', async context => {
		const state = emptyState();
		state.activeTurn = {
			id: turnId,
			startedAt: new Date().toISOString(),
			message: { text: 'many pending tools', origin: { kind: MessageKind.User } },
			usage: undefined,
			responseParts: [
				...Array.from({ length: 129 }, (_, index) => ({
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						toolCallId: `host-${index}`, toolName: 'shell', displayName: 'Shell',
						status: ToolCallStatus.PendingConfirmation,
						invocationMessage: 'Run command', toolInput: '{}',
					},
				} satisfies ResponsePart)),
				{
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						toolCallId, toolName: 'reply', displayName: 'Reply',
						contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
						status: ToolCallStatus.PendingConfirmation,
						invocationMessage: 'Reply', toolInput: '{}',
					},
				},
			],
		};
		const { host, transport, statuses } = createRelay(context, state);
		await waitFor(() => transport.requests.length === 128);
		assert.equal(host.dispatched.length, 1);
		assert.deepEqual(host.dispatched[0].action, {
			type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
			approved: true, confirmed: ToolCallConfirmationReason.NotNeeded,
		});
		assert.equal(statuses.filter(message => message.includes('capacity reached')).length, 1);
	});

	for (const behavior of ['allow', 'deny'] as const) {
		it(`relays ${behavior} only after a valid channel verdict`, async context => {
			const { host, transport, beginTool } = createRelay(context);
			beginTool();
			await waitFor(() => transport.requests.length === 1);
			const request = transport.requests[0];
			assert.match(request.request_id, /^[a-km-z]{5}$/);
			assert.equal(request.tool_name, 'shell');
			assert.match(request.input_preview, /echo hello/);
			assert.match(request.description, /expires/);
			assert.deepEqual(host.dispatched, []);

			transport.events.emit('verdict', { request_id: request.request_id, behavior });
			await waitFor(() => host.dispatched.length === 1);
			assert.deepEqual(host.dispatched[0], {
				channel: chat,
				action: behavior === 'allow' ? {
					type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
					approved: true, confirmed: ToolCallConfirmationReason.UserAction,
				} : {
					type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
					approved: false, reason: ToolCallCancellationReason.Denied,
				},
			});
			transport.events.emit('verdict', { request_id: request.request_id, behavior });
			assert.equal(host.dispatched.length, 1);
		});
	}

	it('accepts only the first decision and leaves execution to the Agent Host', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		const request = transport.requests[0];
		observe({
			type: ActionType.ChatToolCallConfirmed, turnId, toolCallId,
			approved: false, reason: ToolCallCancellationReason.Denied,
		});
		transport.events.emit('verdict', { request_id: request.request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched, []);
	});

	it('keeps simultaneous requests bound to their own tool calls', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		observe({
			type: ActionType.ChatToolCallStart, turnId, toolCallId: 'tool-2',
			toolName: 'write', displayName: 'Write',
		});
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId: 'tool-2',
			invocationMessage: 'Write a file', toolInput: '{"path":"test.txt","content":"hello"}',
		});
		await waitFor(() => transport.requests.length === 2);
		const shell = transport.requests.find(request => request.tool_name === 'shell');
		const write = transport.requests.find(request => request.tool_name === 'write');
		assert.ok(shell && write);
		assert.notEqual(shell.request_id, write.request_id);
		transport.events.emit('verdict', { request_id: write.request_id, behavior: 'deny' });
		transport.events.emit('verdict', { request_id: shell.request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched.map(item => {
			assert.ok(item.action.type === ActionType.ChatToolCallConfirmed);
			return { toolCallId: item.action.toolCallId, approved: item.action.approved };
		}), [{ toolCallId: 'tool-2', approved: false }, { toolCallId, approved: true }]);
	});

	it('expires requests at the production deadline without approving them', async context => {
		context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01T00:00:00Z') });
		const { host, transport, beginTool, statuses } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		context.mock.timers.tick(PERMISSION_REQUEST_TTL_MS);
		transport.events.emit('verdict', { request_id: transport.requests[0].request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched, []);
		assert.ok(statuses.some(message => message.includes('expired')));
	});

	it('ignores other chats and invalidates a superseded prompt', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		const old = transport.requests[0];
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId,
			invocationMessage: 'Updated command', toolInput: '{"command":"echo updated"}',
		}, { channel: 'ahp-chat:/unrelated' });
		assert.equal(transport.requests.length, 1);
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId,
			invocationMessage: 'Updated command', toolInput: '{"command":"echo updated"}',
		});
		await waitFor(() => transport.requests.length === 2);
		assert.notEqual(transport.requests[1].request_id, old.request_id);
		transport.events.emit('verdict', { request_id: old.request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched, []);
		transport.events.emit('verdict', { request_id: transport.requests[1].request_id, behavior: 'deny' });
		assert.equal(host.dispatched.length, 1);
	});

	it('does not select policy-changing confirmation options', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		observe({
			type: ActionType.ChatToolCallReady, turnId, toolCallId,
			invocationMessage: 'Choose a policy', toolInput: '{}',
			options: [{ id: 'trust-everything', label: 'Trust all future calls', kind: ConfirmationOptionKind.Approve }],
		});
		await waitFor(() => transport.requests.length === 1);
		transport.events.emit('verdict', { request_id: transport.requests[0].request_id, behavior: 'allow' });
		const action = host.dispatched[0]?.action;
		assert.ok(action?.type === ActionType.ChatToolCallConfirmed && action.approved);
		assert.equal(action.selectedOptionId, undefined);
	});

	it('reissues referenced input if its contents changed before approval', async context => {
		const { host, transport, beginTool } = createRelay(context);
		beginTool({ uri: 'ahp-session:/session/input' });
		await waitFor(() => transport.requests.length === 1);
		const first = transport.requests[0];
		assert.match(first.input_preview, /echo first/);
		host.input = '{"command":"echo changed"}';
		transport.events.emit('verdict', { request_id: first.request_id, behavior: 'allow' });
		await waitFor(() => transport.requests.length === 2);
		assert.deepEqual(host.dispatched, []);
		assert.match(transport.requests[1].input_preview, /echo changed/);
		transport.events.emit('verdict', { request_id: transport.requests[1].request_id, behavior: 'allow' });
		await waitFor(() => host.dispatched.length === 1);
	});

	it('cancels unresolved input reads on shutdown', async context => {
		const { host, transport, relay, beginTool } = createRelay(context);
		host.readResult = new Promise(() => undefined);
		beginTool({ uri: 'ahp-session:/session/input' });
		await relay.close();
		assert.deepEqual(transport.requests, []);
		assert.deepEqual(host.dispatched, []);
	});

	it('leaves unreadable input for local approval without restarting the channel', async context => {
		const { host, transport, beginTool, statuses, failures } = createRelay(context);
		host.readResult = Promise.reject(new Error('resource denied'));
		beginTool({ uri: 'ahp-session:/session/input' });
		await waitFor(() => statuses.some(message => message.includes('resource denied')));
		assert.deepEqual(transport.requests, []);
		assert.deepEqual(host.dispatched, []);
		assert.deepEqual(failures, []);
	});

	it('invalidates requests on turn cancellation and channel shutdown', async context => {
		const { host, transport, relay, beginTool, observe } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		const request = transport.requests[0];
		observe({ type: ActionType.ChatTurnCancelled, turnId, duration: 0 });
		transport.events.emit('verdict', { request_id: request.request_id, behavior: 'allow' });
		await relay.close();
		transport.events.emit('verdict', { request_id: request.request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched, []);
	});

	it('ignores a historical turn error without invalidating the active approval', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		observe({
			type: ActionType.ChatError,
			turnId: 'previous-turn',
			duration: 0,
			part: { kind: ResponsePartKind.Error, error: { errorType: 'test', message: 'A previous turn failed' } },
		});
		transport.events.emit('verdict', { request_id: transport.requests[0].request_id, behavior: 'allow' });
		assert.equal(host.dispatched.length, 1);
	});

	it('invalidates approvals when their own turn fails', async context => {
		const { host, transport, beginTool, observe } = createRelay(context);
		beginTool();
		await waitFor(() => transport.requests.length === 1);
		observe({
			type: ActionType.ChatError,
			turnId,
			duration: 0,
			part: { kind: ResponsePartKind.Error, error: { errorType: 'test', message: 'This turn failed' } },
		});
		transport.events.emit('verdict', { request_id: transport.requests[0].request_id, behavior: 'allow' });
		assert.deepEqual(host.dispatched, []);
	});

	it('surfaces send failures and rejected host decisions', async context => {
		const failed = createRelay(context);
		failed.transport.sendError = new Error('MCP transport closed');
		failed.beginTool();
		await waitFor(() => failed.failures.length === 1);
		assert.deepEqual(failed.host.dispatched, []);
		assert.match(failed.failures[0].message, /Permission relay failed: MCP transport closed/);
		assert.match(String(failed.failures[0].cause), /MCP transport closed/);

		const rejected = createRelay(context);
		rejected.beginTool();
		await waitFor(() => rejected.transport.requests.length === 1);
		rejected.transport.events.emit('verdict', {
			request_id: rejected.transport.requests[0].request_id, behavior: 'allow',
		});
		const decision = rejected.host.dispatched[0].action;
		rejected.observe(decision, { rejectionReason: 'read only', origin: { clientId: 'channel-client', clientSeq: 1 } });
		assert.match(rejected.failures[0]?.message ?? '', /rejected.*read only/);
	});

	it('reconstructs pending approvals from a snapshot after restart', async context => {
		const state = emptyState();
		state.activeTurn = {
			id: turnId,
			startedAt: new Date().toISOString(),
			message: { text: 'pending work', origin: { kind: MessageKind.User } },
			usage: undefined,
			responseParts: [{
				kind: ResponsePartKind.ToolCall,
				toolCall: {
					toolCallId, toolName: 'shell', displayName: 'Shell',
					status: ToolCallStatus.PendingConfirmation,
					invocationMessage: 'Run pending command', toolInput: '{"command":"echo resumed"}',
				},
			}],
		};
		const { host, transport } = createRelay(context, state);
		await waitFor(() => transport.requests.length === 1);
		assert.match(transport.requests[0].input_preview, /echo resumed/);
		assert.deepEqual(host.dispatched, []);
	});
});

function emptyState(): ChatState {
	return { resource: chat, title: 'Permissions', status: SessionStatus.Idle, modifiedAt: new Date(0).toISOString(), turns: [] };
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 2000;
	while (!condition()) {
		if (performance.now() >= deadline) {
			throw new Error('Timed out waiting for permission relay');
		}
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}
