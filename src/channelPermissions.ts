import {
	ActionType,
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	ToolCallStatus,
	chatReducer,
	type ActionEnvelope,
	type ChatAction,
	type ChatState,
	type ChatToolCallStartAction,
	type StateAction,
	type ToolCallPendingConfirmationState,
	type ToolDefinition,
} from '@microsoft/agent-host-protocol';
import type { DispatchHandle } from '@microsoft/agent-host-protocol/client';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { raceAbort } from './async.js';
import { formatPermissionInput, sanitizePermissionText } from './permissionPreview.js';
import { readToolInput, type ToolInputReader } from './toolInput.js';

export const PERMISSION_REQUEST_TTL_MS = 5 * 60_000;
const REQUEST_ALPHABET = 'abcdefghijkmnopqrstuvwxyz';
const MAX_PENDING_REQUESTS = 128;
const MAX_ISSUED_REQUESTS = 65_536;

export interface ChannelPermissionRequest {
	readonly request_id: string;
	readonly tool_name: string;
	readonly description: string;
	readonly input_preview: string;
}

export interface ChannelPermissionVerdict {
	readonly request_id: string;
	readonly behavior: 'allow' | 'deny';
}

export interface PermissionTransportEvents {
	verdict: [verdict: ChannelPermissionVerdict];
}

export interface ChannelPermissionTransport {
	readonly events: Pick<EventEmitter<PermissionTransportEvents>, 'on' | 'off'>;
	sendRequest(request: ChannelPermissionRequest): Promise<void>;
}

export interface PermissionHost extends Partial<ToolInputReader> {
	dispatch(channel: string, action: StateAction): DispatchHandle;
}

export function isChannelToolCall(
	tool: Pick<ChatToolCallStartAction, 'toolName' | 'contributor'>,
	clientId: string,
	tools: readonly ToolDefinition[],
): boolean {
	return isChannelToolContributor(tool, clientId)
		&& tools.some(definition => definition.name === tool.toolName);
}

export function isChannelToolContributor(
	tool: Pick<ChatToolCallStartAction, 'contributor'>,
	clientId: string,
): boolean {
	return tool.contributor?.kind === ToolCallContributorKind.Client
		&& tool.contributor.clientId === clientId;
}

interface PendingPermission {
	readonly id: string;
	readonly turnId: string;
	readonly tool: ToolCallPendingConfirmationState;
	readonly expiresAt: number;
	readonly abort: AbortController;
	readonly timer: NodeJS.Timeout;
	phase: 'preparing' | 'awaiting' | 'responding';
	input?: string;
	clientSeq?: number;
}

export class ChannelPermissionRelay {
	readonly events = new EventEmitter<{ status: [message: string]; failure: [error: Error] }>();
	private readonly requests = new Map<string, PendingPermission>();
	private readonly issuedIds = new Set<string>();
	private readonly offered = new WeakSet<ToolCallPendingConfirmationState>();
	private readonly tasks = new Set<Promise<void>>();
	private readonly lifetime = new AbortController();
	private readonly onVerdict = (verdict: ChannelPermissionVerdict) => {
		const pending = this.requests.get(verdict.request_id);
		if (!pending || pending.phase !== 'awaiting' || !this.isCurrent(pending)) {
			this.events.emit('status', 'ignored expired, consumed, or unknown permission verdict');
			return;
		}
		pending.phase = 'responding';
		this.track(this.respond(pending, verdict.behavior), pending);
	};

	constructor(
		private readonly host: PermissionHost,
		private readonly clientId: string,
		private readonly chat: string,
		private readonly transport: ChannelPermissionTransport | undefined,
		private state: ChatState,
		private readonly channelTools: readonly ToolDefinition[],
	) {
		if (state.resource !== chat) {
			throw new Error('Permission relay snapshot does not match its bound chat');
		}
		transport?.events.on('verdict', this.onVerdict);
	}

	start(): void {
		this.reconcile();
		if (this.transport) {
			this.events.emit('status', 'tool permission relay enabled for this chat; sender authorization is owned by the channel plugin');
		}
	}

	observe(envelope: ActionEnvelope): void {
		if (this.lifetime.signal.aborted || envelope.channel !== this.chat || !isChatAction(envelope.action)) {
			return;
		}
		if (envelope.rejectionReason) {
			const rejected = [...this.requests.values()].find(request =>
				request.clientSeq !== undefined
				&& request.clientSeq === envelope.origin?.clientSeq
				&& envelope.origin.clientId === this.clientId
			);
			if (rejected) {
				this.invalidate(rejected);
				this.events.emit('failure', new Error(`Agent Host rejected the permission decision: ${envelope.rejectionReason}`));
			} else {
				const action = envelope.action;
				if (action.type === ActionType.ChatToolCallConfirmed
					&& envelope.origin?.clientId === this.clientId
					&& action.turnId === this.state.activeTurn?.id
					&& this.pendingTools().some(tool =>
						tool.toolCallId === action.toolCallId
						&& this.offered.has(tool)
						&& isChannelToolContributor(tool, this.clientId)
					)) {
					this.events.emit('failure', new Error(`Agent Host rejected automatic channel tool decision: ${envelope.rejectionReason}`));
				}
			}
			return;
		}
		this.state = chatReducer(this.state, envelope.action);
		this.reconcile();
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		this.transport?.events.off('verdict', this.onVerdict);
		for (const request of this.requests.values()) {
			this.invalidate(request);
		}
		await Promise.allSettled([...this.tasks]);
		this.events.removeAllListeners();
	}

	private pendingTools(): ToolCallPendingConfirmationState[] {
		return this.state.activeTurn?.responseParts.flatMap(part =>
			part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.PendingConfirmation
				? [part.toolCall]
				: [],
		) ?? [];
	}

	private reconcile(): void {
		if (this.lifetime.signal.aborted) {
			return;
		}
		for (const request of this.requests.values()) {
			if (!this.isCurrent(request)) {
				this.invalidate(request);
			}
		}
		const turn = this.state.activeTurn;
		if (!turn) {
			return;
		}
		let reportedCapacity = false;
		for (const tool of this.pendingTools()) {
			if (this.offered.has(tool)) {
				continue;
			}
			if (isChannelToolContributor(tool, this.clientId)) {
				this.offered.add(tool);
				const available = isChannelToolCall(tool, this.clientId, this.channelTools);
				const reasonMessage = `Channel tool '${sanitizePermissionText(tool.toolName)}' is no longer available`;
				this.host.dispatch(this.chat, available ? {
					type: ActionType.ChatToolCallConfirmed,
					turnId: turn.id,
					toolCallId: tool.toolCallId,
					approved: true,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				} : {
					type: ActionType.ChatToolCallConfirmed,
					turnId: turn.id,
					toolCallId: tool.toolCallId,
					approved: false,
					reason: ToolCallCancellationReason.Denied,
					reasonMessage,
				});
				this.events.emit('status', available
					? `requested automatic approval for channel tool ${sanitizePermissionText(tool.toolName)}; awaiting Agent Host confirmation`
					: `${reasonMessage}; requested denial from the Agent Host`);
				continue;
			}
			if (!this.transport) {
				continue;
			}
			if (this.requests.size >= MAX_PENDING_REQUESTS || this.issuedIds.size >= MAX_ISSUED_REQUESTS) {
				if (!reportedCapacity) {
					this.events.emit('status', 'permission relay capacity reached; use Agent Host approval or restart the channel');
					reportedCapacity = true;
				}
				continue;
			}
			const id = this.createRequestId();
			this.offered.add(tool);
			const abort = new AbortController();
			const timer = setTimeout(() => {
				const pending = this.requests.get(id);
				if (pending) {
					this.invalidate(pending);
					this.events.emit('status', 'permission request expired; Agent Host approval remains available');
				}
			}, PERMISSION_REQUEST_TTL_MS);
			timer.unref();
			const pending: PendingPermission = {
				id,
				turnId: turn.id,
				tool,
				expiresAt: Date.now() + PERMISSION_REQUEST_TTL_MS,
				abort,
				timer,
				phase: 'preparing',
			};
			this.requests.set(id, pending);
			this.track(this.prepare(pending, this.transport), pending);
		}
	}

	private async prepare(pending: PendingPermission, transport: ChannelPermissionTransport): Promise<void> {
		let input: string | undefined;
		try {
			input = await readToolInput(this.host, pending.tool.toolInput, pending.abort.signal);
		} catch (error) {
			if (!pending.abort.signal.aborted) {
				this.invalidate(pending);
				this.events.emit('status', `cannot relay this tool's input; use Agent Host approval: ${formatError(error)}`);
			}
			return;
		}
		if (!this.isCurrent(pending)) {
			return;
		}
		pending.input = input;
		const invocation = typeof pending.tool.invocationMessage === 'string'
			? pending.tool.invocationMessage
			: pending.tool.invocationMessage.markdown;
		const context = pending.tool.intention && pending.tool.intention !== invocation
			? `\nContext: ${pending.tool.intention}`
			: '';
		const preview = formatPermissionInput(input);
		const edits = pending.tool.edits
			? `\nEdits: ${formatPermissionInput(JSON.stringify(pending.tool.edits))}`
			: '';
		pending.phase = 'awaiting';
		await raceAbort(transport.sendRequest({
			request_id: pending.id,
			tool_name: sanitizePermissionText(pending.tool.toolName),
			description: sanitizePermissionText(`${invocation}${context} (Approve this call only; expires ${new Date(pending.expiresAt).toISOString()})`),
			input_preview: `${preview}${edits}`,
		}), pending.abort.signal);
		this.events.emit('status', 'sent a tool permission request to the channel');
	}

	private async respond(pending: PendingPermission, behavior: ChannelPermissionVerdict['behavior']): Promise<void> {
		if (behavior === 'allow' && typeof pending.tool.toolInput === 'object') {
			let latestInput: string | undefined;
			try {
				latestInput = await readToolInput(this.host, pending.tool.toolInput, pending.abort.signal);
			} catch (error) {
				if (!pending.abort.signal.aborted) {
					this.invalidate(pending);
					this.events.emit('status', `permission was not applied because tool input could not be re-read: ${formatError(error)}`);
				}
				return;
			}
			if (!this.isCurrent(pending)) {
				return;
			}
			if (latestInput !== pending.input) {
				this.invalidate(pending);
				this.offered.delete(pending.tool);
				this.events.emit('status', 'tool input changed; a new permission decision is required');
				this.reconcile();
				return;
			}
		}
		if (!this.isCurrent(pending)) {
			return;
		}
		const action: StateAction = behavior === 'allow'
			? {
				type: ActionType.ChatToolCallConfirmed,
				turnId: pending.turnId,
				toolCallId: pending.tool.toolCallId,
				approved: true,
				confirmed: ToolCallConfirmationReason.UserAction,
			}
			: {
				type: ActionType.ChatToolCallConfirmed,
				turnId: pending.turnId,
				toolCallId: pending.tool.toolCallId,
				approved: false,
				reason: ToolCallCancellationReason.Denied,
			};
		// No selectedOptionId: a remote verdict must not select session-wide policies.
		pending.clientSeq = this.host.dispatch(this.chat, action).clientSeq;
		this.events.emit('status', `relayed ${behavior} for a pending tool; awaiting Agent Host confirmation`);
	}

	private isCurrent(pending: PendingPermission): boolean {
		return !pending.abort.signal.aborted
			&& !this.lifetime.signal.aborted
			&& Date.now() < pending.expiresAt
			&& this.state.activeTurn?.id === pending.turnId
			&& this.pendingTools().includes(pending.tool);
	}

	private invalidate(pending: PendingPermission): void {
		clearTimeout(pending.timer);
		pending.abort.abort();
		this.requests.delete(pending.id);
	}

	private track(task: Promise<void>, pending: PendingPermission): void {
		this.tasks.add(task);
		void task.then(
			() => this.tasks.delete(task),
			error => {
				this.tasks.delete(task);
				if (!pending.abort.signal.aborted) {
					this.invalidate(pending);
					this.events.emit('failure', new Error(
						`Permission relay failed: ${sanitizePermissionText(formatError(error))}`,
						{ cause: error },
					));
				}
			},
		);
	}

	private createRequestId(): string {
		for (let attempt = 0; attempt < 32; attempt++) {
			const id = Array.from({ length: 5 }, () => REQUEST_ALPHABET[randomInt(REQUEST_ALPHABET.length)]).join('');
			if (!this.issuedIds.has(id)) {
				this.issuedIds.add(id);
				return id;
			}
		}
		throw new Error('Could not allocate an unused permission request ID');
	}
}

function isChatAction(action: StateAction): action is ChatAction {
	return action.type.startsWith('chat/');
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
