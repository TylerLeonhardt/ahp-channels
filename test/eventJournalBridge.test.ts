import {
	ActionType,
	MessageKind,
	SessionStatus,
	type StateAction,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ChannelBridge } from '../src/bridge.js';
import { FileChannelEventJournal, readJournalEventId, type ChannelEventJournal } from '../src/eventJournal.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

class TestSubscription implements AsyncIterable<SubscriptionEvent> {
	private waiter: ((result: IteratorResult<SubscriptionEvent>) => void) | undefined;
	private closed = false;

	push(event: SubscriptionEvent): void {
		this.waiter?.({ done: false, value: event });
		this.waiter = undefined;
	}

	[Symbol.asyncIterator](): AsyncIterator<SubscriptionEvent> {
		return {
			next: () => {
				if (this.closed) {
					return Promise.resolve({ done: true, value: undefined });
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

describe('ChannelBridge event journal', () => {
	it('replays pending events and marks the accepted AHP action delivered', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-bridge-events-'));
		temporaryDirectories.push(home);
		const event = {
			content: 'hello',
			meta: { chat_id: '42', message_id: '7' },
		};
		const journal = new FileChannelEventJournal(home, 'telegram');
		const pending = await journal.enqueue('telegram', event);
		assert.ok(pending);
		const subscription = new TestSubscription();
		const dispatched: StateAction[] = [];
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
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'telegram', tools: [] },
			eventJournal: journal,
		});

		await bridge.start();
		const turn = dispatched.find(action => action.type === ActionType.ChatTurnStarted);
		assert.ok(turn?.type === ActionType.ChatTurnStarted);
		assert.equal(readJournalEventId(turn.message._meta), pending.id);
		assert.deepEqual(turn.message.origin, { kind: MessageKind.User });
		subscription.push({
			type: 'action',
			params: {
				channel: 'ahp-chat:/chat',
				action: turn,
				serverSeq: 1,
				origin: { clientId: 'channel-client', clientSeq: 1 },
			},
		});
		await waitFor(async () => (await journal.pending()).length === 0);
		await bridge.close();

		assert.equal(await new FileChannelEventJournal(home, 'telegram').enqueue('telegram', event), undefined);
	});

	it('supervises journal failures and drains in-flight events before quiescing', async () => {
		const subscription = new TestSubscription();
		let releaseEnqueue!: () => void;
		const enqueueGate = new Promise<void>(resolve => {
			releaseEnqueue = resolve;
		});
		let fail = false;
		const journal: ChannelEventJournal = {
			async enqueue(_source, event) {
				await enqueueGate;
				if (fail) {
					throw new Error('disk full');
				}
				return {
					id: 'event',
					event,
					receivedAt: new Date(0).toISOString(),
					stableIdentity: true,
				};
			},
			async pending() {
				return [];
			},
			async markDelivered() { },
		};
		let handler: ((event: { content: string }) => Promise<void> | void) | undefined;
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
				async setChannelHandler(value) {
					handler = value;
				},
				async callTool(): Promise<never> {
					throw new Error('Unexpected tool call');
				},
				async close() { },
			},
			channelInfo: { name: 'telegram', tools: [] },
			eventJournal: journal,
		});
		await bridge.start();
		const handling = Promise.resolve(handler?.({ content: 'queued' }));
		let quiesced = false;
		const quiescing = bridge.quiesce().then(value => {
			quiesced = value;
		});
		await Promise.resolve();
		assert.equal(quiesced, false);
		releaseEnqueue();
		await handling;
		await quiescing;
		assert.equal(quiesced, true);

		fail = true;
		assert.ok(handler);
		await assert.rejects(Promise.resolve(handler({ content: 'fails' })), /disk full/);
		await assert.rejects(bridge.whenStopped, /channel event: disk full/);
		await bridge.close();
	});
});

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('Timed out waiting for condition');
}
