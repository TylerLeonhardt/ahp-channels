import {
	ActionType,
	ConfirmationOptionKind,
	MessageKind,
	PendingMessageKind,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	type ActionEnvelope,
	type ChatState,
	type ChatToolCallReadyAction,
	type ChatToolCallStartAction,
	type StateAction,
	type ToolCallResult,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { formatChannelPrompt, type ChannelEvent } from './channelPrompt.js';
import type { McpChannelProcess, StartedMcpChannel } from './mcpChannel.js';

interface PendingClientTool {
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	toolInput?: ChatToolCallReadyAction['toolInput'];
	executed: boolean;
}

export interface ChannelBridgeOptions {
	readonly client: {
		dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
		unsubscribe?(channel: string): Promise<void>;
	};
	readonly clientId: string;
	readonly session: string;
	readonly chat: string;
	readonly chatState: ChatState;
	readonly chatSubscription: AsyncIterable<SubscriptionEvent> & { close(): Promise<void> };
	readonly channel: Pick<McpChannelProcess, 'setChannelHandler' | 'callTool' | 'close'>;
	readonly channelInfo: StartedMcpChannel;
	readonly autoApproveTools?: boolean;
	readonly onStatus?: (message: string) => void;
}

export class ChannelBridge {
	private activeTurnId: string | undefined;
	private readonly pendingTools = new Map<string, PendingClientTool>();
	private actionLoop: Promise<void> | undefined;
	private closed = false;

	constructor(private readonly options: ChannelBridgeOptions) {
		this.activeTurnId = options.chatState.activeTurn?.id;
	}

	async start(): Promise<void> {
		const { client, clientId, session, channelInfo } = this.options;
		client.dispatch(session, {
			type: ActionType.SessionActiveClientSet,
			activeClient: {
				clientId,
				displayName: `ahp-channels (${channelInfo.name})`,
				tools: [...channelInfo.tools],
			},
		});
		await this.options.channel.setChannelHandler(event => this.handleChannelEvent(event));
		this.actionLoop = this.consumeChatActions();
		this.options.onStatus?.(`bridging ${channelInfo.name} to ${this.options.chat}`);
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			this.options.client.dispatch(this.options.session, {
				type: ActionType.SessionActiveClientRemoved,
				clientId: this.options.clientId,
			});
		} catch (error) {
			this.options.onStatus?.(`failed to remove active client: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (this.options.client.unsubscribe) {
			await this.options.client.unsubscribe(this.options.chat);
		} else {
			await this.options.chatSubscription.close();
		}
		await this.actionLoop;
		await this.options.channel.close();
	}

	private handleChannelEvent(event: ChannelEvent): void {
		const message = {
			text: formatChannelPrompt(this.options.channelInfo.name, event, this.options.channelInfo.instructions),
			origin: { kind: MessageKind.User },
		};
		if (this.activeTurnId) {
			this.options.client.dispatch(this.options.chat, {
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: randomUUID(),
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
			if (event.params.rejectionReason) {
				if (event.params.action.type === ActionType.ChatTurnStarted
					&& this.activeTurnId === event.params.action.turnId) {
					this.activeTurnId = undefined;
				}
				this.options.onStatus?.(`action rejected: ${event.params.rejectionReason}`);
				continue;
			}
			await this.handleAction(event.params);
		}
	}

	private async handleAction(envelope: ActionEnvelope): Promise<void> {
		const action = envelope.action;
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				this.activeTurnId = action.turnId;
				break;
			case ActionType.ChatTurnComplete:
			case ActionType.ChatTurnCancelled:
			case ActionType.ChatError:
				if (this.activeTurnId === action.turnId) {
					this.activeTurnId = undefined;
				}
				break;
			case ActionType.ChatToolCallStart:
				this.trackToolStart(action);
				break;
			case ActionType.ChatToolCallReady:
				await this.trackToolReady(action);
				break;
			case ActionType.ChatToolCallConfirmed:
				if (action.approved) {
					await this.executeTool(action.toolCallId);
				}
				break;
		}
	}

	private trackToolStart(action: ChatToolCallStartAction): void {
		if (action.contributor?.kind !== ToolCallContributorKind.Client
			|| action.contributor.clientId !== this.options.clientId) {
			return;
		}
		this.pendingTools.set(action.toolCallId, {
			turnId: action.turnId,
			toolCallId: action.toolCallId,
			toolName: action.toolName,
			executed: false,
		});
	}

	private async trackToolReady(action: ChatToolCallReadyAction): Promise<void> {
		const pending = this.pendingTools.get(action.toolCallId);
		if (!pending) {
			return;
		}
		pending.toolInput = action.toolInput;
		if (action.confirmed !== undefined) {
			await this.executeTool(action.toolCallId);
		} else if (this.options.autoApproveTools) {
			const selectedOptionId = action.options?.find(option =>
				option.kind === ConfirmationOptionKind.Approve && /once/i.test(option.id)
			)?.id ?? action.options?.find(option => option.kind === ConfirmationOptionKind.Approve)?.id;
			this.options.client.dispatch(this.options.chat, {
				type: ActionType.ChatToolCallConfirmed,
				turnId: action.turnId,
				toolCallId: action.toolCallId,
				approved: true,
				confirmed: ToolCallConfirmationReason.UserAction,
				...(selectedOptionId ? { selectedOptionId } : {}),
			});
			this.options.onStatus?.(`approved channel tool ${pending.toolName}`);
		}
	}

	private async executeTool(toolCallId: string): Promise<void> {
		const pending = this.pendingTools.get(toolCallId);
		if (!pending || pending.executed) {
			return;
		}
		pending.executed = true;

		let args: Record<string, unknown>;
		try {
			args = parseToolInput(pending.toolInput);
		} catch (error) {
			this.dispatchToolCompletion(pending, {
				success: false,
				pastTenseMessage: `Failed to call ${pending.toolName}`,
				error: { message: error instanceof Error ? error.message : String(error) },
			});
			return;
		}

		const result = await this.options.channel.callTool(pending.toolName, args);
		this.dispatchToolCompletion(pending, result);
	}

	private dispatchToolCompletion(pending: PendingClientTool, result: ToolCallResult): void {
		this.options.client.dispatch(this.options.chat, {
			type: ActionType.ChatToolCallComplete,
			turnId: pending.turnId,
			toolCallId: pending.toolCallId,
			result,
		});
		this.pendingTools.delete(pending.toolCallId);
		this.options.onStatus?.(`completed channel tool ${pending.toolName}`);
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
