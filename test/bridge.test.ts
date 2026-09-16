import {
	ActionType,
	ContentEncoding,
	ConfirmationOptionKind,
	CustomizationEnablementKind,
	CustomizationType,
	MessageKind,
	PendingMessageKind,
	ResponsePartKind,
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
			onStatus: message => statuses.push(message),
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
