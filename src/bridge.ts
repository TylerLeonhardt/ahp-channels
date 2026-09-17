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
	type ToolDefinition,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { raceAbort } from './async.js';
import { formatChannelPrompt, type ChannelEvent } from './channelPrompt.js';
import { ChannelPermissionRelay, isChannelToolContributor } from './channelPermissions.js';
import type { BoundChannelManagement } from './channelManagement.js';
import {
	readJournalEventId,
	withJournalEventId,
	type ChannelEventJournal,
} from './eventJournal.js';
import type { McpChannelClient, StartedMcpChannel } from './mcpChannel.js';
import type { StatusReporter } from './status.js';
import { readToolInput, type ToolInputReader } from './toolInput.js';

interface PendingClientTool {
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly abort: AbortController;
	readonly restored: boolean;
	toolInput?: ChatToolCallReadyAction['toolInput'];
	phase: 'awaiting-confirmation' | 'ready' | 'executing';
}

interface PendingBridgeHandoff {
	readonly id: string;
	readonly heldEventIds: Set<string>;
	readonly ready: Promise<void>;
	readonly resolveReady: () => void;
	readiness?: Promise<void>;
}

type ReplayCompletion =
	| { readonly kind: 'activation' }
	| { readonly kind: 'handoff-cancellation'; readonly handoff: PendingBridgeHandoff };

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
	readonly management?: BoundChannelManagement;
	readonly customizations: readonly ClientPluginCustomization[];
	readonly eventJournal?: ChannelEventJournal;
	readonly status?: StatusReporter;
}

export class ChannelBridge {
	private activeTurnId: string | undefined;
	private readonly queuedMessageIds: Set<string>;
	private readonly pendingTools = new Map<string, PendingClientTool>();
	private readonly inFlightEventHandlers = new Set<Promise<void>>();
	private readonly inFlightToolExecutions = new Set<Promise<void>>();
	private actionLoop: Promise<void> | undefined;
	private acceptingEvents = false;
	private activationState: 'new' | 'paused' | 'activating' | 'active' | 'closed' = 'new';
	private readonly activationHeldEventIds = new Set<string>();
	private pendingHandoff: PendingBridgeHandoff | undefined;
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
				const pending = this.trackToolStart({ ...part.toolCall, turnId: turn.id }, true);
				if (pending) {
					pending.toolInput = part.toolCall.toolInput;
					if (part.toolCall.status === ToolCallStatus.Running) {
						pending.phase = 'ready';
					}
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
			options.management?.tools ?? [],
		);
		this.permissionRelay.events.on('status', message => options.status?.report(message));
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
		if (this.pendingHandoff) {
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

	beginHandoff(id: string): void {
		if (!this.options.eventJournal) {
			throw new Error('Safe agent handoff requires the daemon event journal');
		}
		if (this.lifetime.signal.aborted) {
			throw new Error('Cannot request a handoff from a stopped channel bridge');
		}
		if (this.pendingHandoff) {
			throw new Error(`Handoff ${this.pendingHandoff.id} is already pending`);
		}
		let resolveReady!: () => void;
		const ready = new Promise<void>(resolve => {
			resolveReady = resolve;
		});
		this.pendingHandoff = {
			id,
			heldEventIds: new Set(),
			ready,
			resolveReady,
		};
		this.acceptingEvents = false;
		this.checkHandoffReadiness();
	}

	waitForHandoffReady(id: string, signal: AbortSignal): Promise<void> {
		const pending = this.pendingHandoff;
		if (!pending || pending.id !== id) {
			throw new Error(`Handoff ${id} is not pending in this channel bridge`);
		}
		return raceAbort(
			pending.ready,
			AbortSignal.any([signal, this.lifetime.signal]),
		);
	}

	async cancelHandoff(id: string): Promise<void> {
		const pending = this.pendingHandoff;
		if (!pending || pending.id !== id) {
			throw new Error(`Handoff ${id} is not pending in this channel bridge`);
		}
		if (!this.options.eventJournal || pending.heldEventIds.size === 0) {
			this.pendingHandoff = undefined;
			this.acceptingEvents = true;
			return;
		}
		await this.replayHeldEvents(
			pending.heldEventIds,
			{ kind: 'handoff-cancellation', handoff: pending },
		);
	}

	async quiesceHandoff(id: string): Promise<boolean> {
		const pending = this.pendingHandoff;
		if (!pending || pending.id !== id || this.lifetime.signal.aborted) {
			return false;
		}
		await pending.ready;
		await this.drainEventHandlers();
		return this.pendingHandoff === pending
			&& !this.busy
			&& this.inFlightToolExecutions.size === 0;
	}

	async start(): Promise<void> {
		await this.startWithActivation(false);
	}

	async startPaused(): Promise<void> {
		await this.startWithActivation(true);
	}

	async activate(): Promise<void> {
		if (this.activationState === 'active') {
			return;
		}
		if (this.activationState !== 'paused') {
			throw new Error(`Cannot activate a channel bridge in state '${this.activationState}'`);
		}
		this.publishClient();
		this.activationState = 'activating';
		this.permissionRelay.start();
		for (const toolCallId of this.pendingTools.keys()) {
			this.executeTool(toolCallId);
		}
		if (this.options.eventJournal) {
			await this.replayHeldEvents(
				this.activationHeldEventIds,
				{ kind: 'activation' },
				true,
			);
		} else {
			this.activationState = 'active';
			this.acceptingEvents = true;
		}
	}

	private async startWithActivation(paused: boolean): Promise<void> {
		if (this.activationState !== 'new') {
			throw new Error(`Cannot start a channel bridge in state '${this.activationState}'`);
		}
		combinedTools(this.options.channelInfo.tools, this.options.management?.tools ?? []);
		this.activationState = paused ? 'paused' : 'active';
		this.acceptingEvents = !paused;
		if (!paused) {
			this.publishClient();
		}
		this.actionLoop = this.consumeChatActions();
		if (!paused) {
			this.permissionRelay.start();
			for (const toolCallId of this.pendingTools.keys()) {
				this.executeTool(toolCallId);
			}
		}
		if (this.options.eventJournal) {
			await this.options.eventJournal.markDelivered(journalEventIds(this.options.chatState));
			if (!paused) {
				for (const pending of await this.options.eventJournal.pending()) {
					this.dispatchChannelEvent(pending.event, pending.id);
				}
			}
		}
		await this.options.channel.setChannelHandler(event => this.trackChannelEvent(event));
		this.options.status?.report(`registered ${this.options.channelInfo.name} client for ${this.options.chat}`);
	}

	async close(): Promise<void> {
		if (this.lifetime.signal.aborted) {
			return;
		}
		this.lifetime.abort();
		this.acceptingEvents = false;
		this.activationState = 'closed';
		this.pendingHandoff = undefined;
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
			this.options.status?.report(`failed to remove active client: ${error instanceof Error ? error.message : String(error)}`);
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
				this.options.status?.report('ignored channel event while the bridge was stopping');
			}
			return;
		}
		const journaled = await this.options.eventJournal.enqueue(this.options.channelInfo.name, event);
		if (!journaled) {
			this.options.status?.report('ignored duplicate channel event');
			return;
		}
		if (!this.acceptingEvents) {
			if (this.pendingHandoff) {
				this.pendingHandoff.heldEventIds.add(journaled.id);
				this.options.status?.report('held inbound channel message until the pending handoff finishes');
			} else if (this.activationState === 'paused' || this.activationState === 'activating') {
				this.activationHeldEventIds.add(journaled.id);
				this.options.status?.report('held inbound channel message until the destination binding commits');
			} else {
				this.options.status?.report('journaled channel event for replay after restart');
			}
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
			this.options.status?.report('queued inbound channel message');
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
		this.options.status?.report(`started turn ${turnId}`);
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
				this.options.status?.report(`action rejected: ${event.params.rejectionReason}`);
				if (rejectedEventId && this.options.eventJournal) {
					throw new Error(`Journaled channel event ${rejectedEventId} was rejected: ${event.params.rejectionReason}`);
				}
				this.checkHandoffReadiness();
				continue;
			}
			await this.handleAction(event.params);
			this.checkHandoffReadiness();
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
					if (pending.phase !== 'executing') {
						pending.phase = 'ready';
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
		restored = false,
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
			restored,
			phase: 'awaiting-confirmation',
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
			if (pending.phase !== 'executing') {
				pending.phase = 'ready';
			}
			this.executeTool(action.toolCallId);
		}
	}

	private executeTool(toolCallId: string): void {
		const pending = this.pendingTools.get(toolCallId);
		if ((this.activationState !== 'active' && this.activationState !== 'activating')
			|| !pending || pending.phase !== 'ready' || !this.isCurrentTool(pending)) {
			return;
		}
		pending.phase = 'executing';
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
		const isChannelTool = this.options.channelInfo.tools.some(tool => tool.name === pending.toolName);
		const isManagementTool = this.options.management?.tools.some(tool => tool.name === pending.toolName) ?? false;
		if (!isChannelTool && !isManagementTool) {
			this.dispatchToolCompletion(pending, {
				success: false,
				pastTenseMessage: `Failed to call ${pending.toolName}`,
				error: { message: `Channel tool '${pending.toolName}' is no longer available` },
			});
			return;
		}
		if (pending.restored && isManagementTool) {
			this.dispatchToolCompletion(pending, {
				success: false,
				pastTenseMessage: `Interrupted ${pending.toolName}`,
				error: { message: 'Channel management tool calls are not resumed across bridge restarts' },
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
		const result = isChannelTool
			? await raceAbort(this.options.channel.callTool(pending.toolName, args, signal), signal)
			: await this.options.management!.callTool(pending.toolName, args, signal);
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
		this.options.status?.report(`${result.success ? 'completed' : 'failed'} channel tool ${pending.toolName}`);
	}

	private checkHandoffReadiness(): void {
		const pending = this.pendingHandoff;
		if (!pending || pending.readiness || this.busy) {
			return;
		}
		const readiness = this.resolveHandoffReadiness(pending);
		pending.readiness = readiness;
		void readiness.catch(error => this.resolveEventFailure(toError('handoff readiness', error)));
	}

	private async resolveHandoffReadiness(pending: PendingBridgeHandoff): Promise<void> {
		await this.drainEventHandlers();
		while (this.inFlightToolExecutions.size > 0) {
			await Promise.allSettled([...this.inFlightToolExecutions]);
		}
		if (this.pendingHandoff === pending && !this.busy) {
			pending.resolveReady();
		} else if (this.pendingHandoff === pending) {
			pending.readiness = undefined;
		}
	}

	private async replayHeldEvents(
		heldEventIds: Set<string>,
		completion: ReplayCompletion,
		includeExisting = false,
	): Promise<void> {
		const journal = this.options.eventJournal;
		if (!journal) {
			return;
		}
		const replayed = new Set<string>();
		while (true) {
			await this.drainEventHandlers();
			const pendingEvents = await journal.pending();
			for (const event of pendingEvents) {
				if (replayed.has(event.id) || (!includeExisting && !heldEventIds.has(event.id))) {
					continue;
				}
				replayed.add(event.id);
				heldEventIds.delete(event.id);
				this.dispatchChannelEvent(event.event, event.id);
			}
			if (this.inFlightEventHandlers.size === 0 && heldEventIds.size === 0) {
				if (completion.kind === 'activation') {
					this.activationState = 'active';
				} else {
					if (this.pendingHandoff !== completion.handoff) {
						throw new Error(`Handoff ${completion.handoff.id} changed while held events were replaying`);
					}
					this.pendingHandoff = undefined;
				}
				this.acceptingEvents = true;
				return;
			}
		}
	}

	private publishClient(): void {
		const { client, clientId, session, channelInfo } = this.options;
		const tools = combinedTools(channelInfo.tools, this.options.management?.tools ?? []);
		publishActiveClient(client, session, {
			clientId,
			displayName: `ahp-channels (${channelInfo.name})`,
			tools,
			customizations: [...this.options.customizations],
		});
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

function combinedTools(
	channelTools: readonly ToolDefinition[],
	managementTools: readonly ToolDefinition[],
): ToolDefinition[] {
	const names = new Set(channelTools.map(tool => tool.name));
	const collisions = managementTools.filter(tool => names.has(tool.name)).map(tool => tool.name);
	if (collisions.length > 0) {
		throw new Error(`Channel plugin tool name conflicts with bridge management tool(s): ${collisions.join(', ')}`);
	}
	return [...channelTools, ...managementTools];
}
