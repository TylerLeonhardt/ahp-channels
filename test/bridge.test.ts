import {
	ActionType,
	ConfirmationOptionKind,
	MessageKind,
	PendingMessageKind,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	ToolResultContentType,
	type StateAction,
	type ToolCallResult,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
	it('routes an inbound event and executes a client-owned tool', async () => {
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
			autoApproveTools: true,
			onStatus: message => statuses.push(message),
		});

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
		subscription.push(actionEvent({
			type: ActionType.ChatToolCallConfirmed,
			turnId: turnAction.turnId,
			toolCallId: 'tool-1',
			approved: true,
			confirmed: ToolCallConfirmationReason.UserAction,
			selectedOptionId: 'allow-once',
		}));
		await waitFor(() => dispatched.some(item => item.action.type === ActionType.ChatToolCallComplete));
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
		});

		await bridge.start();
		assert.equal(bridge.busy, true);
		assert.equal(bridge.tryQuiesce(), false);
		subscription.push(actionEvent({
			type: ActionType.ChatPendingMessageRemoved,
			kind: PendingMessageKind.Queued,
			id: 'queued',
		}));
		await waitFor(() => !bridge.busy);
		assert.equal(bridge.tryQuiesce(), true);
		await channelHandler?.({ content: 'ignored' });
		assert.equal(dispatchCount, 1);
		await bridge.close();
	});
});

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
