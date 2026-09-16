import {
	ActionType,
	MessageKind,
	PendingMessageKind,
	ResponsePartKind,
	ToolCallStatus,
	type ActionEnvelope,
	type ChatState,
	type ChatToolCallReadyAction,
	type ChatToolCallStartAction,
	type ClientPluginCustomization,
	type SessionActiveClient,
	type StateAction,
	type ToolCallResult,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { raceAbort } from './async.js';
import { formatChannelPrompt, type ChannelEvent } from './channelPrompt.js';
import { ChannelPermissionRelay, isChannelToolContributor } from './channelPermissions.js';
import {
	readJournalEventId,
	withJournalEventId,
	type ChannelEventJournal,
} from './eventJournal.js';
import type { McpChannelClient, StartedMcpChannel } from './mcpChannel.js';
import { readToolInput, type ToolInputReader } from './toolInput.js';

interface PendingClientTool {
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly abort: AbortController;
	toolInput?: ChatToolCallReadyAction['toolInput'];
	executed: boolean;
}

export interface ChannelBridgeOptions {
	readonly client: {
		dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
		unsubscribe?(channel: string): Promise<void>;
		request?: ToolInputReader['request'];
	};
	readonly clientId: string;
	readonly session: string;
	readonly chat: string;
	readonly chatState: ChatState;
	readonly chatSubscription: AsyncIterable<SubscriptionEvent> & { close(): Promise<void> };
	readonly channel: Pick<McpChannelClient, 'setChannelHandler' | 'callTool' | 'close' | 'permissions'>;
	readonly channelInfo: StartedMcpChannel;
	readonly customizations: readonly ClientPluginCustomization[];
	readonly eventJournal?: ChannelEventJournal;
	readonly onStatus?: (message: string) => void;
}

export class ChannelBridge {
	private activeTurnId: string | undefined;
	private readonly queuedMessageIds: Set<string>;
	private readonly pendingTools = new Map<string, PendingClientTool>();
	private readonly inFlightEventHandlers = new Set<Promise<void>>();
	private readonly inFlightToolExecutions = new Set<Promise<void>>();
	private actionLoop: Promise<void> | undefined;
	private acceptingEvents = true;
	private readonly lifetime = new AbortController();
	private readonly permissionRelay: ChannelPermissionRelay;
	private resolveEventFailure!: (error: Error) => void;
	private readonly eventFailure = new Promise<Error>(resolve => {
		this.resolveEventFailure = resolve;
	});

	constructor(private readonly options: ChannelBridgeOptions) {
		this.activeTurnId = options.chatState.activeTurn?.id;
		this.queuedMessageIds = new Set(options.chatState.queuedMessages?.map(message => message.id));
		const turn = options.chatState.activeTurn;
		for (const part of turn?.responseParts ?? []) {
			if (turn && part.kind === ResponsePartKind.ToolCall
				&& (part.toolCall.status === ToolCallStatus.PendingConfirmation
					|| part.toolCall.status === ToolCallStatus.Running
					&& !options.channelInfo.tools.some(tool => tool.name === part.toolCall.toolName))) {
				const pending = this.trackToolStart({ ...part.toolCall, turnId: turn.id });
				if (pending) {
					pending.toolInput = part.toolCall.toolInput;
				}
			}
		}
		this.permissionRelay = new ChannelPermissionRelay(
			options.client,
			options.clientId,
			options.chat,
			options.channel.permissions,
			options.chatState,
			options.channelInfo.tools,
		);
		this.permissionRelay.events.on('status', message => options.onStatus?.(message));
		this.permissionRelay.events.on('failure', error => this.resolveEventFailure(error));
	}

	get busy(): boolean {
		return this.activeTurnId !== undefined || this.queuedMessageIds.size > 0;
	}

	get whenStopped(): Promise<void> {
		return Promise.race([
			this.actionLoop ?? new Promise<void>(() => undefined),
			this.eventFailure.then(error => {
				throw error;
			}),
		]);
	}

	async quiesce(): Promise<boolean> {
		if (this.lifetime.signal.aborted) {
			return false;
		}
		this.acceptingEvents = false;
		if (this.busy) {
			this.acceptingEvents = true;
			return false;
		}
		await this.drainEventHandlers();
		if (this.busy) {
			this.acceptingEvents = true;
			return false;
		}
		return true;
	}

	async start(): Promise<void> {
		const { client, clientId, session, channelInfo } = this.options;
		publishActiveClient(client, session, {
			clientId,
			displayName: `ahp-channels (${channelInfo.name})`,
			tools: [...channelInfo.tools],
			customizations: [...this.options.customizations],
		});
		this.actionLoop = this.consumeChatActions();
		this.permissionRelay.start();
		for (const part of this.options.chatState.activeTurn?.responseParts ?? []) {
			if (part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Running) {
				this.executeTool(part.toolCall.toolCallId);
			}
		}
		if (this.options.eventJournal) {
			await this.options.eventJournal.markDelivered(journalEventIds(this.options.chatState));
			for (const pending of await this.options.eventJournal.pending()) {
				this.dispatchChannelEvent(pending.event, pending.id);
			}
		}
		await this.options.channel.setChannelHandler(event => this.trackChannelEvent(event));
		this.options.onStatus?.(`registered ${channelInfo.name} client for ${this.options.chat}`);
	}

	async close(): Promise<void> {
		if (this.lifetime.signal.aborted) {
			return;
		}
		this.lifetime.abort();
		this.acceptingEvents = false;
		for (const pending of this.pendingTools.values()) {
			this.cancelTool(pending);
		}
		const errors: Error[] = [];
		await this.permissionRelay.close();
		await Promise.allSettled([...this.inFlightToolExecutions]);
		try {
			await this.options.channel.close();
		} catch (error) {
			errors.push(toError('MCP channel', error));
		}
		await this.drainEventHandlers();
		try {
			this.options.client.dispatch(this.options.session, {
				type: ActionType.SessionActiveClientRemoved,
				clientId: this.options.clientId,
			});
		} catch (error) {
			this.options.onStatus?.(`failed to remove active client: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			if (this.options.client.unsubscribe) {
				await this.options.client.unsubscribe(this.options.chat);
			} else {
				await this.options.chatSubscription.close();
			}
		} catch (error) {
			errors.push(toError('chat subscription', error));
		}
		try {
			await this.actionLoop;
		} catch (error) {
			errors.push(toError('chat action loop', error));
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Failed to close channel bridge');
		}
	}

	private async handleChannelEvent(event: ChannelEvent): Promise<void> {
		if (!this.options.eventJournal) {
			if (this.acceptingEvents) {
				this.dispatchChannelEvent(event);
			} else {
				this.options.onStatus?.('ignored channel event while the bridge was stopping');
			}
			return;
		}
		const journaled = await this.options.eventJournal.enqueue(this.options.channelInfo.name, event);
		if (!journaled) {
			this.options.onStatus?.('ignored duplicate channel event');
			return;
		}
		if (!this.acceptingEvents) {
			this.options.onStatus?.('journaled channel event for replay after restart');
			return;
		}
		this.dispatchChannelEvent(journaled.event, journaled.id);
	}

	private trackChannelEvent(event: ChannelEvent): Promise<void> {
		const handler = this.handleChannelEvent(event);
		this.inFlightEventHandlers.add(handler);
		void handler.then(
			() => this.inFlightEventHandlers.delete(handler),
			error => {
				this.inFlightEventHandlers.delete(handler);
				this.resolveEventFailure(toError('channel event', error));
			},
		);
		return handler;
	}

	private async drainEventHandlers(): Promise<void> {
		while (this.inFlightEventHandlers.size > 0) {
			await Promise.allSettled([...this.inFlightEventHandlers]);
		}
	}

	private dispatchChannelEvent(event: ChannelEvent, eventId?: string): void {
		const message = {
			text: formatChannelPrompt(this.options.channelInfo.name, event, this.options.channelInfo.instructions),
			origin: { kind: MessageKind.User },
			...(eventId ? { _meta: withJournalEventId(undefined, eventId) } : {}),
		};
		if (this.busy) {
			const id = randomUUID();
			this.queuedMessageIds.add(id);
			this.options.client.dispatch(this.options.chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id,
				message,
			});
			this.options.onStatus?.('queued inbound channel message');
			return;
		}
		const turnId = randomUUID();
		this.activeTurnId = turnId;
		this.options.client.dispatch(this.options.chat, {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message,
		});
		this.options.onStatus?.(`started turn ${turnId}`);
	}

	private async consumeChatActions(): Promise<void> {
		for await (const event of this.options.chatSubscription) {
			if (event.type !== 'action') {
				continue;
			}
			this.permissionRelay.observe(event.params);
			if (event.params.rejectionReason) {
				const rejectedEventId = event.params.action.type === ActionType.ChatTurnStarted
					|| event.params.action.type === ActionType.ChatPendingMessageSet
					? readJournalEventId(event.params.action.message._meta)
					: undefined;
				if (event.params.action.type === ActionType.ChatTurnStarted
					&& this.activeTurnId === event.params.action.turnId) {
					this.activeTurnId = undefined;
				} else if (event.params.action.type === ActionType.ChatPendingMessageSet
					&& event.params.action.kind === PendingMessageKind.Queued) {
					this.queuedMessageIds.delete(event.params.action.id);
				}
				this.options.onStatus?.(`action rejected: ${event.params.rejectionReason}`);
				if (rejectedEventId && this.options.eventJournal) {
					throw new Error(`Journaled channel event ${rejectedEventId} was rejected: ${event.params.rejectionReason}`);
				}
				continue;
			}
			await this.handleAction(event.params);
		}
	}

	private async handleAction(envelope: ActionEnvelope): Promise<void> {
		const action = envelope.action;
		if (action.type === ActionType.ChatTurnStarted || action.type === ActionType.ChatPendingMessageSet) {
			const eventId = readJournalEventId(action.message._meta);
			if (eventId) {
				await this.options.eventJournal?.markDelivered([eventId]);
			}
		}
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				for (const pending of this.pendingTools.values()) {
					if (pending.turnId !== action.turnId) {
						this.cancelTool(pending);
					}
				}
				this.activeTurnId = action.turnId;
				if (action.queuedMessageId) {
					this.queuedMessageIds.delete(action.queuedMessageId);
				}
				break;
			case ActionType.ChatTurnComplete:
			case ActionType.ChatTurnCancelled:
			case ActionType.ChatError:
				if (this.activeTurnId === action.turnId) {
					this.activeTurnId = undefined;
				}
				for (const pending of this.pendingTools.values()) {
					if (pending.turnId === action.turnId) {
						this.cancelTool(pending);
					}
				}
				break;
			case ActionType.ChatToolCallStart:
				this.trackToolStart(action);
				break;
			case ActionType.ChatToolCallReady:
				this.trackToolReady(action);
				break;
			case ActionType.ChatToolCallConfirmed: {
				const pending = this.pendingTools.get(action.toolCallId);
				if (!pending || pending.turnId !== action.turnId || this.activeTurnId !== action.turnId) {
					break;
				}
				if (action.approved) {
					if (typeof pending.toolInput !== 'object' && action.editedToolInput !== undefined) {
						pending.toolInput = action.editedToolInput;
					}
					this.executeTool(action.toolCallId);
				} else {
					this.cancelTool(pending);
				}
				break;
			}
			case ActionType.ChatToolCallComplete: {
				const pending = this.pendingTools.get(action.toolCallId);
				if (pending?.turnId === action.turnId) {
					this.cancelTool(pending);
				}
				break;
			}
			case ActionType.ChatPendingMessageSet:
				if (action.kind === PendingMessageKind.Queued) {
					this.queuedMessageIds.add(action.id);
				}
				break;
			case ActionType.ChatPendingMessageRemoved:
				if (action.kind === PendingMessageKind.Queued) {
					this.queuedMessageIds.delete(action.id);
				}
				break;
		}
	}

	private trackToolStart(
		action: Pick<ChatToolCallStartAction, 'turnId' | 'toolCallId' | 'toolName' | 'contributor'>,
	): PendingClientTool | undefined {
		if (!isChannelToolContributor(action, this.options.clientId)) {
			return;
		}
		const previous = this.pendingTools.get(action.toolCallId);
		if (previous?.turnId === action.turnId) {
			return previous;
		}
		if (previous) {
			this.cancelTool(previous);
		}
		const pending: PendingClientTool = {
			turnId: action.turnId,
			toolCallId: action.toolCallId,
			toolName: action.toolName,
			abort: new AbortController(),
			executed: false,
		};
		this.pendingTools.set(action.toolCallId, pending);
		return pending;
	}

	private trackToolReady(action: ChatToolCallReadyAction): void {
		const pending = this.pendingTools.get(action.toolCallId);
		if (!pending || pending.turnId !== action.turnId || this.activeTurnId !== action.turnId) {
			return;
		}
		pending.toolInput = action.toolInput ?? pending.toolInput;
		if (action.confirmed !== undefined) {
			this.executeTool(action.toolCallId);
		}
	}

	private executeTool(toolCallId: string): void {
		const pending = this.pendingTools.get(toolCallId);
		if (!pending || pending.executed || !this.isCurrentTool(pending)) {
			return;
		}
		pending.executed = true;
		const task = this.runTool(pending);
		this.inFlightToolExecutions.add(task);
		void task.then(
			() => this.inFlightToolExecutions.delete(task),
			error => {
				this.inFlightToolExecutions.delete(task);
				if (this.isCurrentTool(pending)) {
					this.resolveEventFailure(toError('channel tool', error));
				}
			},
		);
	}

	private async runTool(pending: PendingClientTool): Promise<void> {
		if (!this.options.channelInfo.tools.some(tool => tool.name === pending.toolName)) {
			this.dispatchToolCompletion(pending, {
				success: false,
				pastTenseMessage: `Failed to call ${pending.toolName}`,
				error: { message: `Channel tool '${pending.toolName}' is no longer available` },
			});
			return;
		}
		const signal = AbortSignal.any([this.lifetime.signal, pending.abort.signal]);
		let args: Record<string, unknown>;
		try {
			args = parseToolInput(await readToolInput(this.options.client, pending.toolInput, signal));
		} catch (error) {
			if (this.isCurrentTool(pending)) {
				this.dispatchToolCompletion(pending, {
					success: false,
					pastTenseMessage: `Failed to call ${pending.toolName}`,
					error: { message: error instanceof Error ? error.message : String(error) },
				});
			}
			return;
		}
		if (!this.isCurrentTool(pending)) {
			return;
		}
		const result = await raceAbort(this.options.channel.callTool(pending.toolName, args), signal);
		if (this.isCurrentTool(pending)) {
			this.dispatchToolCompletion(pending, result);
		}
	}

	private isCurrentTool(pending: PendingClientTool): boolean {
		return !this.lifetime.signal.aborted
			&& !pending.abort.signal.aborted
			&& pending.turnId === this.activeTurnId
			&& this.pendingTools.get(pending.toolCallId) === pending;
	}

	private cancelTool(pending: PendingClientTool): void {
		pending.abort.abort();
		if (this.pendingTools.get(pending.toolCallId) === pending) {
			this.pendingTools.delete(pending.toolCallId);
		}
	}

	private dispatchToolCompletion(pending: PendingClientTool, result: ToolCallResult): void {
		this.options.client.dispatch(this.options.chat, {
			type: ActionType.ChatToolCallComplete,
			turnId: pending.turnId,
			toolCallId: pending.toolCallId,
			result,
		});
		this.cancelTool(pending);
		this.options.onStatus?.(`${result.success ? 'completed' : 'failed'} channel tool ${pending.toolName}`);
	}
}

export function parseToolInput(input: ChatToolCallReadyAction['toolInput']): Record<string, unknown> {
	if (input === undefined || input === '') {
		return {};
	}
	if (typeof input !== 'string') {
		throw new Error('Referenced AHP tool inputs are not supported yet');
	}
	const value: unknown = JSON.parse(input);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('AHP client tool input must be a JSON object');
	}
	return value as Record<string, unknown>;
}

function toError(label: string, error: unknown): Error {
	return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export function publishActiveClient(
	client: Pick<ChannelBridgeOptions['client'], 'dispatch'>,
	session: string,
	activeClient: SessionActiveClient,
): void {
	client.dispatch(session, {
		type: ActionType.SessionActiveClientSet,
		activeClient,
	});
}

function journalEventIds(state: ChatState): string[] {
	const ids = [
		...state.turns.map(turn => readJournalEventId(turn.message._meta)),
		readJournalEventId(state.activeTurn?.message._meta),
		readJournalEventId(state.steeringMessage?.message._meta),
		...(state.queuedMessages ?? []).map(message => readJournalEventId(message.message._meta)),
	];
	return ids.filter((id): id is string => id !== undefined);
}
