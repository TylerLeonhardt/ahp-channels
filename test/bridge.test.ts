import {
	ActionType,
	ContentEncoding,
	ConfirmationOptionKind,
	CustomizationEnablementKind,
	CustomizationType,
	MessageKind,
	PendingMessageKind,
	ResponsePartKind,
	SessionStatus,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	ToolCallStatus,
	ToolResultContentType,
	type ChatState,
	type ResourceReadResult,
	type StateAction,
	type ToolCallPendingConfirmationState,
	type ToolCallResult,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { ChannelBridge } from '../src/bridge.js';
import type { ChannelEvent } from '../src/channelPrompt.js';

class TestSubscription implements AsyncIterable<SubscriptionEvent> {
	private readonly events: SubscriptionEvent[] = [];
	private waiter: ((result: IteratorResult<SubscriptionEvent>) => void) | undefined;
	private closed = false;

	push(event: SubscriptionEvent): void {
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			waiter({ done: false, value: event });
		} else {
			this.events.push(event);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SubscriptionEvent> {
		return {
			next: async () => {
				const event = this.events.shift();
				if (event) {
					return { done: false, value: event };
				}
				if (this.closed) {
					return { done: true, value: undefined };
				}
				return new Promise(resolve => {
					this.waiter = resolve;
				});
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		this.waiter?.({ done: true, value: undefined });
		this.waiter = undefined;
	}
}

describe('ChannelBridge', () => {
	it('auto-approves a contributed tool but executes only after the host accepts', async context => {
		const dispatched: Array<{ channel: string; action: StateAction }> = [];
		let channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const statuses: string[] = [];
		const subscription = new TestSubscription();
		const bridge = new ChannelBridge({
			client: {
				dispatch(channel, action): DispatchHandle {
					dispatched.push({ channel, action });
					return { clientSeq: dispatched.length };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: 1,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler(handler) {
					channelHandler = handler;
				},
				async callTool(name, args): Promise<ToolCallResult> {
					toolCalls.push({ name, args });
					return {
						success: true,
						pastTenseMessage: 'Replied',
						content: [{ type: ToolResultContentType.Text, text: 'sent' }],
					};
				},
				async close() { },
			},
			channelInfo: {
				name: 'fake',
				instructions: 'Use reply.',
				tools: [{
					name: 'reply',
					inputSchema: { type: 'object' },
				}],
			},
			customizations: [{
				type: CustomizationType.Plugin,
				id: 'channel-client:plugin:fake',
				uri: 'file:///plugins/fake',
				name: 'fake',
				enablement: [{
					kind: CustomizationEnablementKind.Global,
					enabled: true,
				}],
				nonce: 'plugin-nonce',
			}],
			status: { report: message => statuses.push(message) },
		});
		context.after(() => bridge.close());

		await bridge.start();
		await channelHandler?.({ content: 'hello', meta: { chat_id: '42' } });
		const rejectedTurn = dispatched.find(item => item.action.type === ActionType.ChatTurnStarted)?.action;
		assert.ok(rejectedTurn?.type === ActionType.ChatTurnStarted);
		subscription.push(actionEvent(rejectedTurn, 'read only'));
		await waitFor(() => statuses.includes('action rejected: read only'));
		await channelHandler?.({ content: 'hello', meta: { chat_id: '42' } });
		const turnActions = dispatched
			.map(item => item.action)
			.filter(action => action.type === ActionType.ChatTurnStarted);
		assert.equal(turnActions.length, 2);
		const turnAction = turnActions[1];
		assert.ok(turnAction?.type === ActionType.ChatTurnStarted);
		subscription.push(actionEvent(turnAction));

		subscription.push(actionEvent({
			type: ActionType.ChatToolCallStart,
			turnId: turnAction.turnId,
			toolCallId: 'tool-1',
			toolName: 'reply',
			displayName: 'Reply',
			contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
		}));
		subscription.push(actionEvent({
			type: ActionType.ChatToolCallReady,
			turnId: turnAction.turnId,
			toolCallId: 'tool-1',
			invocationMessage: 'Reply',
			toolInput: '{"chat_id":"42","text":"pong"}',
			options: [
				{ id: 'allow-session', label: 'Allow in Session', kind: ConfirmationOptionKind.Approve },
				{ id: 'allow-once', label: 'Allow Once', kind: ConfirmationOptionKind.Approve },
			],
		}));
		await waitFor(() => dispatched.some(item => item.action.type === ActionType.ChatToolCallConfirmed));
		const confirmation = dispatched.find(item => item.action.type === ActionType.ChatToolCallConfirmed)?.action;
		assert.deepEqual(confirmation, {
			type: ActionType.ChatToolCallConfirmed,
			turnId: turnAction.turnId,
			toolCallId: 'tool-1',
			approved: true,
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
		assert.deepEqual(toolCalls, []);
		assert.ok(confirmation?.type === ActionType.ChatToolCallConfirmed);
		subscription.push(actionEvent({ ...confirmation, turnId: 'previous-turn' }));
		subscription.push(actionEvent(confirmation, 'read only'));
		await waitFor(() => statuses.filter(message => message === 'action rejected: read only').length === 2);
		assert.deepEqual(toolCalls, []);
		subscription.push(actionEvent(confirmation));
		await waitFor(() => dispatched.some(item => item.action.type === ActionType.ChatToolCallComplete));
		assert.equal(dispatched.filter(item => item.action.type === ActionType.ChatToolCallConfirmed).length, 1);
		await bridge.close();

		assert.deepEqual({
			registered: dispatched[0],
			turnMessage: turnAction.message,
			toolCalls,
			completion: dispatched.find(item => item.action.type === ActionType.ChatToolCallComplete),
		}, {
			registered: {
				channel: 'ahp-session:/session',
				action: {
					type: ActionType.SessionActiveClientSet,
					activeClient: {
						clientId: 'channel-client',
						displayName: 'ahp-channels (fake)',
						tools: [{ name: 'reply', inputSchema: { type: 'object' } }],
						customizations: [{
							type: CustomizationType.Plugin,
							id: 'channel-client:plugin:fake',
							uri: 'file:///plugins/fake',
							name: 'fake',
							enablement: [{
								kind: CustomizationEnablementKind.Global,
								enabled: true,
							}],
							nonce: 'plugin-nonce',
						}],
					},
				},
			},
			turnMessage: {
				text: [
					'<channel_instructions>',
					'Use reply.',
					'</channel_instructions>',
					'',
					'<channel source="fake" chat_id="42">',
					'hello',
					'</channel>',
				].join('\n'),
				origin: { kind: MessageKind.User },
			},
			toolCalls: [{
				name: 'reply',
				args: { chat_id: '42', text: 'pong' },
			}],
			completion: {
				channel: 'ahp-chat:/chat',
				action: {
					type: ActionType.ChatToolCallComplete,
					turnId: turnAction.turnId,
					toolCallId: 'tool-1',
					result: {
						success: true,
						pastTenseMessage: 'Replied',
						content: [{ type: ToolResultContentType.Text, text: 'sent' }],
					},
				},
			},
		});
	});

	it('restores a pending contributed tool from a snapshot and waits for host approval', async context => {
		const subscription = new TestSubscription();
		const dispatched: StateAction[] = [];
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const bridge = new ChannelBridge({
			client: {
				dispatch(_channel, action) {
					dispatched.push(action);
					return { clientSeq: dispatched.length };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: 1,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
				activeTurn: {
					id: 'resumed-turn',
					startedAt: new Date(0).toISOString(),
					message: { text: 'reply', origin: { kind: MessageKind.User } },
					usage: undefined,
					responseParts: [{
						kind: ResponsePartKind.ToolCall,
						toolCall: {
							toolCallId: 'resumed-tool',
							toolName: 'reply',
							displayName: 'Reply',
							contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
							status: ToolCallStatus.PendingConfirmation,
							invocationMessage: 'Reply',
							toolInput: '{"text":"resumed reply"}',
						},
					}],
				},
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler() { },
				async callTool(name, args) {
					toolCalls.push({ name, args });
					return { success: true, pastTenseMessage: 'Replied' };
				},
				async close() { },
			},
			channelInfo: { name: 'fake', tools: [{ name: 'reply' }] },
			customizations: [],
		});
		context.after(() => bridge.close());
		await bridge.start();
		const confirmation = dispatched.find(action => action.type === ActionType.ChatToolCallConfirmed);
		assert.deepEqual(confirmation, {
			type: ActionType.ChatToolCallConfirmed,
			turnId: 'resumed-turn',
			toolCallId: 'resumed-tool',
			approved: true,
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
		assert.deepEqual(toolCalls, []);
		assert.ok(confirmation);
		subscription.push(actionEvent(confirmation));
		await waitFor(() => dispatched.some(action => action.type === ActionType.ChatToolCallComplete));
		assert.deepEqual(toolCalls, [{ name: 'reply', args: { text: 'resumed reply' } }]);
	});

	it('defers restored tool permissions and execution until destination activation', async context => {
		const fixture = createToolFixture(context);
		await fixture.bridge.startPaused();
		assert.deepEqual(fixture.dispatched, []);
		assert.deepEqual(fixture.calls, []);

		fixture.confirm();
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(fixture.dispatched, []);
		assert.equal(fixture.host.readCount, 0);
		assert.deepEqual(fixture.calls, []);

		await fixture.bridge.activate();
		await waitFor(() => fixture.dispatched.some(action => action.type === ActionType.ChatToolCallComplete));
		assert.deepEqual(fixture.calls, ['reply']);
	});

	it('does not resurrect a tool completed while the destination was prepared', async context => {
		const fixture = createToolFixture(context);
		await fixture.bridge.startPaused();
		fixture.subscription.push(actionEvent({
			type: ActionType.ChatToolCallComplete,
			turnId: 'tool-turn',
			toolCallId: 'owned-tool',
			result: { success: false, pastTenseMessage: 'Cancelled while preparing' },
		}));
		await new Promise(resolve => setImmediate(resolve));
		await fixture.bridge.activate();
		assert.deepEqual(fixture.calls, []);
		assert.equal(fixture.dispatched.some(action => action.type === ActionType.ChatToolCallConfirmed), false);
	});

	for (const type of [ActionType.ChatTurnCancelled, ActionType.ChatTurnComplete] as const) {
		it(`cancels a referenced input read immediately on ${type}`, async context => {
			const fixture = createToolFixture(context);
			const input = deferred<ResourceReadResult>();
			fixture.host.readResult = input.promise;
			await fixture.bridge.start();
			fixture.confirm();
			await waitFor(() => fixture.host.readCount === 1);
			fixture.subscription.push(actionEvent({ type, turnId: 'tool-turn', duration: 0 }));
			try {
				await waitFor(() => !fixture.bridge.busy);
			} finally {
				input.resolve({ data: '{"text":"too late"}', encoding: ContentEncoding.Utf8 });
			}
			await fixture.bridge.close();
			assert.deepEqual(fixture.calls, []);
			assert.equal(fixture.dispatched.some(action => action.type === ActionType.ChatToolCallComplete), false);
		});
	}

	it('discards the result of a running MCP call when its turn is cancelled', async context => {
		const fixture = createToolFixture(context);
		const result = deferred<ToolCallResult>();
		fixture.channel.result = result.promise;
		await fixture.bridge.start();
		fixture.confirm();
		await waitFor(() => fixture.calls.length === 1);
		fixture.subscription.push(actionEvent({
			type: ActionType.ChatTurnCancelled, turnId: 'tool-turn', duration: 0,
		}));
		try {
			await waitFor(() => !fixture.bridge.busy);
		} finally {
			result.reject(new Error('late MCP failure after cancellation'));
		}
		await fixture.bridge.close();
		assert.equal(fixture.dispatched.some(action => action.type === ActionType.ChatToolCallComplete), false);
		assert.equal(fixture.signals[0]?.aborted, true);
	});

	it('invalidates an input read when the host completes that tool', async context => {
		const fixture = createToolFixture(context);
		const input = deferred<ResourceReadResult>();
		fixture.host.readResult = input.promise;
		await fixture.bridge.start();
		fixture.confirm();
		await waitFor(() => fixture.host.readCount === 1);
		fixture.subscription.push(actionEvent({
			type: ActionType.ChatToolCallComplete, turnId: 'tool-turn', toolCallId: 'owned-tool',
			result: { success: false, pastTenseMessage: 'Timed out', error: { message: 'Host timed out the tool' } },
		}));
		fixture.subscription.push(actionEvent({
			type: ActionType.ChatTurnComplete, turnId: 'tool-turn', duration: 0,
		}));
		try {
			await waitFor(() => !fixture.bridge.busy);
		} finally {
			input.resolve({ data: '{}', encoding: ContentEncoding.Utf8 });
		}
		await fixture.bridge.close();
		assert.deepEqual(fixture.calls, []);
	});

	it('denies a restored tool that the channel no longer provides', async context => {
		const fixture = createToolFixture(context, 'removed');
		await fixture.bridge.start();
		const decision = fixture.dispatched.find(action => action.type === ActionType.ChatToolCallConfirmed);
		assert.ok(decision?.type === ActionType.ChatToolCallConfirmed && !decision.approved);
		assert.equal(decision.reason, ToolCallCancellationReason.Denied);
		fixture.subscription.push(actionEvent(decision));
		fixture.subscription.push(actionEvent({
			type: ActionType.ChatTurnComplete, turnId: 'tool-turn', duration: 0,
		}));
		await waitFor(() => !fixture.bridge.busy);
		assert.deepEqual(fixture.calls, []);
		assert.equal(fixture.host.readCount, 0);
	});

	it('explicitly fails an unavailable owned tool restored in running state', async context => {
		const fixture = createToolFixture(context, 'removed', true);
		await fixture.bridge.start();
		await waitFor(() => fixture.dispatched.some(action => action.type === ActionType.ChatToolCallComplete));
		const completion = fixture.dispatched.find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(completion?.type === ActionType.ChatToolCallComplete && !completion.result.success);
		assert.match(completion.result.error?.message ?? '', /removed.*no longer available/);
		assert.deepEqual(fixture.calls, []);
		assert.equal(fixture.host.readCount, 0);
	});

	it('stays busy while queued messages are pending', async () => {
		const subscription = new TestSubscription();
		let dispatchCount = 0;
		let channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
		const bridge = new ChannelBridge({
			client: {
				dispatch(): DispatchHandle {
					dispatchCount++;
					return { clientSeq: dispatchCount };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: 1,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
				queuedMessages: [{
					id: 'queued',
					message: { text: 'queued', origin: { kind: MessageKind.User } },
				}],
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler(handler) {
					channelHandler = handler;
				},
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: {
				name: 'fake',
				tools: [],
			},
			customizations: [],
		});

		await bridge.start();
		assert.equal(bridge.busy, true);
		assert.equal(await bridge.quiesce(), false);
		subscription.push(actionEvent({
			type: ActionType.ChatPendingMessageRemoved,
			kind: PendingMessageKind.Queued,
			id: 'queued',
		}));
		await waitFor(() => !bridge.busy);
		assert.equal(await bridge.quiesce(), true);
		await channelHandler?.({ content: 'ignored' });
		assert.equal(dispatchCount, 1);
		await bridge.close();
	});

	it('leaves bridge management tools for Agent Host approval and dispatches them separately', async context => {
		const subscription = new TestSubscription();
		const dispatched: StateAction[] = [];
		const managementCalls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
		const channelCalls: string[] = [];
		const bridge = new ChannelBridge({
			client: {
				dispatch(_channel, action): DispatchHandle {
					dispatched.push(action);
					return { clientSeq: dispatched.length };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: SessionStatus.Idle,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler() { },
				async callTool(name) {
					channelCalls.push(name);
					return { success: true, pastTenseMessage: 'Called channel tool' };
				},
				async close() { },
			},
			channelInfo: {
				name: 'fake',
				tools: [{ name: 'reply' }],
			},
			management: {
				tools: [{ name: 'manage', inputSchema: { type: 'object' } }],
				async callTool(name, args) {
					managementCalls.push({ name, args });
					return { success: true, pastTenseMessage: 'Managed channel' };
				},
			},
			customizations: [],
		});
		context.after(() => bridge.close());
		await bridge.start();
		const registration = dispatched.find(action => action.type === ActionType.SessionActiveClientSet);
		assert.ok(registration?.type === ActionType.SessionActiveClientSet);
		assert.deepEqual(registration.activeClient.tools.map(tool => tool.name), ['reply', 'manage']);

		const turn = {
			type: ActionType.ChatTurnStarted,
			turnId: 'management-turn',
			startedAt: new Date(0).toISOString(),
			message: { text: 'switch', origin: { kind: MessageKind.User } },
		} as const;
		subscription.push(actionEvent(turn));
		subscription.push(actionEvent({
			type: ActionType.ChatToolCallStart,
			turnId: turn.turnId,
			toolCallId: 'management-tool',
			toolName: 'manage',
			displayName: 'Manage',
			contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
		}));
		subscription.push(actionEvent({
			type: ActionType.ChatToolCallReady,
			turnId: turn.turnId,
			toolCallId: 'management-tool',
			invocationMessage: 'Manage',
			toolInput: '{"session":"ahp-session:/next"}',
			options: [],
		}));
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(dispatched.some(action =>
			action.type === ActionType.ChatToolCallConfirmed
				&& action.toolCallId === 'management-tool'
		), false);
		assert.deepEqual(managementCalls, []);

		subscription.push(actionEvent({
			type: ActionType.ChatToolCallConfirmed,
			turnId: turn.turnId,
			toolCallId: 'management-tool',
			approved: true,
			confirmed: ToolCallConfirmationReason.UserAction,
		}));
		await waitFor(() => dispatched.some(action =>
			action.type === ActionType.ChatToolCallComplete
				&& action.toolCallId === 'management-tool'
		));
		assert.deepEqual(managementCalls, [{
			name: 'manage',
			args: { session: 'ahp-session:/next' },
		}]);
		assert.deepEqual(channelCalls, []);
	});

	it('rejects channel tool names that collide with bridge management tools', async () => {
		const subscription = new TestSubscription();
		const bridge = new ChannelBridge({
			client: {
				dispatch(): DispatchHandle {
					return { clientSeq: 1 };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: SessionStatus.Idle,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler() { },
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'fake', tools: [{ name: 'collision' }] },
			management: {
				tools: [{ name: 'collision' }],
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
			},
			customizations: [],
		});
		await assert.rejects(
			bridge.start(),
			/tool name conflicts with bridge management tool.*collision/,
		);
		await bridge.close();
	});

	it('holds journaled inbound messages until a pending handoff is cancelled', async context => {
		const subscription = new TestSubscription();
		const dispatched: StateAction[] = [];
		let channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
		let enqueueGate: Promise<void> | undefined;
		const pending: Array<{ id: string; event: ChannelEvent; receivedAt: string; stableIdentity: boolean }> = [];
		const bridge = new ChannelBridge({
			client: {
				dispatch(_channel, action): DispatchHandle {
					dispatched.push(action);
					return { clientSeq: dispatched.length };
				},
			},
			clientId: 'channel-client',
			session: 'ahp-session:/session',
			chat: 'ahp-chat:/chat',
			chatState: {
				resource: 'ahp-chat:/chat',
				title: 'Chat',
				status: SessionStatus.InProgress,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
				activeTurn: {
					id: 'source-turn',
					startedAt: new Date(0).toISOString(),
					message: { text: 'handoff', origin: { kind: MessageKind.User } },
					usage: undefined,
					responseParts: [],
				},
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler(handler) {
					channelHandler = handler;
				},
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'fake', tools: [] },
			customizations: [],
			eventJournal: {
				async enqueue(_source, event) {
					await enqueueGate;
					const value = {
						id: `held-${pending.length}`,
						event,
						receivedAt: new Date(0).toISOString(),
						stableIdentity: true,
					};
					pending.push(value);
					return value;
				},
				async pending() {
					return pending;
				},
				async markDelivered() { },
			},
		});
		context.after(() => bridge.close());
		await bridge.start();
		bridge.beginHandoff('handoff-request');
		await channelHandler?.({ content: 'arrived while pending' });
		assert.equal(dispatched.some(action =>
			action.type === ActionType.ChatPendingMessageSet
				|| action.type === ActionType.ChatTurnStarted && action.turnId !== 'source-turn'
		), false);

		const abort = new AbortController();
		let ready = false;
		const readiness = bridge.waitForHandoffReady('handoff-request', abort.signal).then(() => {
			ready = true;
		});
		await Promise.resolve();
		assert.equal(ready, false);
		subscription.push(actionEvent({
			type: ActionType.ChatTurnComplete,
			turnId: 'source-turn',
			duration: 0,
		}));
		await readiness;
		assert.equal(await bridge.quiesceHandoff('handoff-request'), true);

		const lateEnqueue = deferred<void>();
		enqueueGate = lateEnqueue.promise;
		const handling = channelHandler?.({ content: 'late held message' });
		let quiesced = false;
		const quiescing = bridge.quiesceHandoff('handoff-request').then(result => {
			quiesced = result;
		});
		try {
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(quiesced, false, 'Final quiescence must drain a late journal write');
		} finally {
			lateEnqueue.resolve();
		}
		await handling;
		await quiescing;
		assert.equal(quiesced, true, 'A held message must not fail an otherwise idle handoff');

		await bridge.cancelHandoff('handoff-request');
		const replay = dispatched.find(action =>
			action.type === ActionType.ChatTurnStarted
				&& action.turnId !== 'source-turn'
		);
		assert.ok(replay?.type === ActionType.ChatTurnStarted);
		assert.match(replay.message.text, /arrived while pending/);
		const queued = dispatched.find(action => action.type === ActionType.ChatPendingMessageSet);
		assert.ok(queued?.type === ActionType.ChatPendingMessageSet);
		assert.match(queued.message.text, /late held message/);
	});

	it('journals destination events while prepared and replays them only after activation', async context => {
		const subscription = new TestSubscription();
		const dispatched: StateAction[] = [];
		let channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
		const pending: Array<{ id: string; event: ChannelEvent; receivedAt: string; stableIdentity: boolean }> = [];
		const bridge = new ChannelBridge({
			client: {
				dispatch(_channel, action): DispatchHandle {
					dispatched.push(action);
					return { clientSeq: dispatched.length };
				},
			},
			clientId: 'destination-client',
			session: 'ahp-session:/destination',
			chat: 'ahp-chat:/destination',
			chatState: {
				resource: 'ahp-chat:/destination',
				title: 'Destination',
				status: SessionStatus.Idle,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler(handler) {
					channelHandler = handler;
				},
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'fake', tools: [{ name: 'reply' }] },
			customizations: [],
			eventJournal: {
				async enqueue(_source, event) {
					const journaled = {
						id: `prepared-${pending.length}`,
						event,
						receivedAt: new Date(0).toISOString(),
						stableIdentity: true,
					};
					pending.push(journaled);
					return journaled;
				},
				async pending() {
					return pending;
				},
				async markDelivered() { },
			},
		});
		context.after(() => bridge.close());

		await bridge.startPaused();
		await channelHandler?.({ content: 'arrived before durable commit' });
		assert.equal(dispatched.some(action =>
			action.type === ActionType.SessionActiveClientSet
				|| action.type === ActionType.ChatTurnStarted
		), false);

		await bridge.activate();
		assert.equal(dispatched[0]?.type, ActionType.SessionActiveClientSet);
		const turn = dispatched.find(action => action.type === ActionType.ChatTurnStarted);
		assert.ok(turn?.type === ActionType.ChatTurnStarted);
		assert.match(turn.message.text, /arrived before durable commit/);
	});

	it('rejects pending handoff readiness when the source bridge stops unexpectedly', async () => {
		const subscription = new TestSubscription();
		const bridge = new ChannelBridge({
			client: {
				dispatch(): DispatchHandle {
					return { clientSeq: 1 };
				},
			},
			clientId: 'source-client',
			session: 'ahp-session:/source',
			chat: 'ahp-chat:/source',
			chatState: {
				resource: 'ahp-chat:/source',
				title: 'Source',
				status: SessionStatus.InProgress,
				modifiedAt: new Date(0).toISOString(),
				turns: [],
				activeTurn: {
					id: 'active',
					startedAt: new Date(0).toISOString(),
					message: { text: 'handoff', origin: { kind: MessageKind.User } },
					usage: undefined,
					responseParts: [],
				},
			},
			chatSubscription: subscription,
			channel: {
				async setChannelHandler() { },
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'fake', tools: [] },
			customizations: [],
			eventJournal: {
				async enqueue(): Promise<never> {
					throw new Error('Unexpected event');
				},
				async pending() {
					return [];
				},
				async markDelivered() { },
			},
		});
		await bridge.start();
		bridge.beginHandoff('interrupted');
		const readiness = bridge.waitForHandoffReady('interrupted', new AbortController().signal);
		await bridge.close();
		await assert.rejects(readiness);
	});
});

function createToolFixture(context: TestContext, toolName = 'reply', running = false) {
	const subscription = new TestSubscription();
	const dispatched: StateAction[] = [];
	const calls: string[] = [];
	const signals: AbortSignal[] = [];
	const host = {
		readCount: 0,
		readResult: undefined as Promise<ResourceReadResult> | undefined,
		async request(): Promise<ResourceReadResult> {
			this.readCount++;
			return this.readResult ?? { data: '{"text":"hello"}', encoding: ContentEncoding.Utf8 };
		},
		dispatch(_channel: string, action: StateAction): DispatchHandle {
			dispatched.push(action);
			return { clientSeq: dispatched.length };
		},
	};
	const channel = {
		result: undefined as Promise<ToolCallResult> | undefined,
		async setChannelHandler() { },
		async callTool(name: string, _args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult> {
			calls.push(name);
			assert.ok(signal, 'The bridge must propagate tool cancellation to MCP');
			signals.push(signal);
			return this.result ?? { success: true, pastTenseMessage: 'Replied' };
		},
		async close() { },
	};
	const tool: ToolCallPendingConfirmationState = {
		toolCallId: 'owned-tool', toolName, displayName: toolName,
		contributor: { kind: ToolCallContributorKind.Client, clientId: 'channel-client' },
		status: ToolCallStatus.PendingConfirmation,
		invocationMessage: 'Send a reply',
		toolInput: { uri: 'ahp-session:/session/input' },
	};
	const state: ChatState = {
		resource: 'ahp-chat:/chat', title: 'Chat', status: 1,
		modifiedAt: new Date(0).toISOString(), turns: [],
		activeTurn: {
			id: 'tool-turn', startedAt: new Date(0).toISOString(),
			message: { text: 'reply', origin: { kind: MessageKind.User } },
			usage: undefined,
			responseParts: [{
				kind: ResponsePartKind.ToolCall,
				toolCall: running ? { ...tool, status: ToolCallStatus.Running, confirmed: ToolCallConfirmationReason.NotNeeded } : tool,
			}],
		},
	};
	const bridge = new ChannelBridge({
		client: host, clientId: 'channel-client', session: 'ahp-session:/session', chat: state.resource,
		chatState: state, chatSubscription: subscription, channel,
		channelInfo: { name: 'fake', tools: [{ name: 'reply' }] }, customizations: [],
	});
	context.after(() => bridge.close());
	const confirm = () => subscription.push(actionEvent({
		type: ActionType.ChatToolCallConfirmed, turnId: 'tool-turn', toolCallId: 'owned-tool',
		approved: true, confirmed: ToolCallConfirmationReason.NotNeeded,
	}));
	return { bridge, host, channel, subscription, dispatched, calls, signals, confirm };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function actionEvent(action: StateAction, rejectionReason?: string): SubscriptionEvent {
	return {
		type: 'action',
		params: {
			channel: 'ahp-chat:/chat',
			action,
			serverSeq: 1,
			origin: undefined,
			...(rejectionReason ? { rejectionReason } : {}),
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error('Timed out waiting for condition');
}
