import {
	ToolResultContentType,
	type ToolCallResult,
	type ToolDefinition,
} from '@microsoft/agent-host-protocol';
import {
	requestDaemonData,
	requestDaemonResult,
} from './daemonClient.js';
import type {
	ChannelDaemonStatus,
	DaemonResponseData,
} from './daemonProtocol.js';

export const MANAGEMENT_TOOL_NAMES = {
	listSessions: 'ahp_channels_list_sessions',
	listChats: 'ahp_channels_list_chats',
	handoff: 'ahp_channels_handoff',
	handoffStatus: 'ahp_channels_handoff_status',
	cancelHandoff: 'ahp_channels_cancel_handoff',
} as const;

export interface ChannelManagementContext {
	readonly channel: string;
	readonly bindingId: string;
	readonly preferredHost?: string;
	readonly session: string;
	readonly chat: string;
}

export interface BoundChannelManagement {
	readonly tools: readonly ToolDefinition[];
	callTool(
		name: string,
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<ToolCallResult>;
}

export interface ChannelManagementService {
	bind(context: ChannelManagementContext): BoundChannelManagement;
}

export class DaemonChannelManagementService implements ChannelManagementService {
	constructor(private readonly home: string) { }

	bind(context: ChannelManagementContext): BoundChannelManagement {
		return new BoundDaemonChannelManagement(this.home, context);
	}
}

export const CHANNEL_MANAGEMENT_TOOLS: readonly ToolDefinition[] = [{
	name: MANAGEMENT_TOOL_NAMES.listSessions,
	title: 'List channel sessions',
	description: 'List existing AHP sessions available to this channel across configured local Agent Hosts. Use returned host selectors and exact session URIs for handoff.',
	inputSchema: {
		type: 'object',
		properties: {
			host: { type: 'string', description: 'Optional configured local host selector, such as @work.' },
			cursor: { type: 'string', description: 'Opaque cursor returned by a previous call.' },
			limit: { type: 'integer', minimum: 1, maximum: 100 },
		},
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
}, {
	name: MANAGEMENT_TOOL_NAMES.listChats,
	title: 'List session chats',
	description: 'List existing chats in one AHP session. Omit chat during handoff to retain that session host’s default-chat semantics.',
	inputSchema: {
		type: 'object',
		properties: {
			host: { type: 'string', description: 'Optional configured local host selector, such as @work.' },
			session: { type: 'string', description: 'Exact AHP session URI.' },
			cursor: { type: 'string', description: 'Opaque cursor returned by a previous call.' },
			limit: { type: 'integer', minimum: 1, maximum: 100 },
		},
		required: ['session'],
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
}, {
	name: MANAGEMENT_TOOL_NAMES.handoff,
	title: 'Redirect this channel',
	description: 'Request one safe handoff of this named channel to an existing session and optional chat. The accepted result is pending until the current turn and in-flight channel tools finish.',
	inputSchema: {
		type: 'object',
		properties: {
			host: { type: 'string', description: 'Optional configured local host selector. Omit to preserve the current preferred host.' },
			session: { type: 'string', description: 'Exact destination AHP session URI.' },
			chat: { type: 'string', description: 'Exact destination AHP chat URI. Omit to use the destination session default chat.' },
		},
		required: ['session'],
	},
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
}, {
	name: MANAGEMENT_TOOL_NAMES.handoffStatus,
	title: 'Check channel handoff',
	description: 'Report the latest pending, applied, failed, or cancelled handoff for this named channel.',
	inputSchema: {
		type: 'object',
		properties: {
			request_id: { type: 'string', description: 'Optional handoff request ID to match.' },
		},
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
}, {
	name: MANAGEMENT_TOOL_NAMES.cancelHandoff,
	title: 'Cancel channel handoff',
	description: 'Cancel the owning source binding’s pending handoff before it commits.',
	inputSchema: {
		type: 'object',
		properties: {
			request_id: { type: 'string', description: 'Pending handoff request ID.' },
		},
		required: ['request_id'],
	},
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
}];

class BoundDaemonChannelManagement implements BoundChannelManagement {
	readonly tools = CHANNEL_MANAGEMENT_TOOLS;

	constructor(
		private readonly home: string,
		private readonly context: ChannelManagementContext,
	) { }

	async callTool(
		name: string,
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<ToolCallResult> {
		try {
			switch (name) {
				case MANAGEMENT_TOOL_NAMES.listSessions:
					return dataResult(await this.listSessions(args, signal));
				case MANAGEMENT_TOOL_NAMES.listChats:
					return dataResult(await this.listChats(args, signal));
				case MANAGEMENT_TOOL_NAMES.handoff:
					return await this.requestHandoff(args, signal);
				case MANAGEMENT_TOOL_NAMES.handoffStatus:
					return await this.handoffStatus(args, signal);
				case MANAGEMENT_TOOL_NAMES.cancelHandoff:
					return await this.cancelHandoff(args, signal);
				default:
					return failedResult(`Unknown channel management tool '${name}'`);
			}
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			return failedResult(errorMessage(error));
		}
	}

	private async listSessions(
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<DaemonResponseData> {
		const host = optionalString(args, 'host');
		const cursor = optionalString(args, 'cursor');
		const limit = optionalLimit(args);
		const data = await requestDaemonData(this.home, {
			command: 'catalog.sessions',
			name: this.context.channel,
			sourceBindingId: this.context.bindingId,
			...(host ? { host } : {}),
			...(cursor ? { cursor } : {}),
			...(limit ? { limit } : {}),
		}, signal);
		if (data.kind !== 'sessions') {
			throw new Error('Daemon returned chat data for a session catalog request');
		}
		return data;
	}

	private async listChats(
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<DaemonResponseData> {
		const session = requiredString(args, 'session');
		const host = optionalString(args, 'host');
		const cursor = optionalString(args, 'cursor');
		const limit = optionalLimit(args);
		const data = await requestDaemonData(this.home, {
			command: 'catalog.chats',
			name: this.context.channel,
			sourceBindingId: this.context.bindingId,
			session,
			...(host ? { host } : {}),
			...(cursor ? { cursor } : {}),
			...(limit ? { limit } : {}),
		}, signal);
		if (data.kind !== 'chats') {
			throw new Error('Daemon returned session data for a chat catalog request');
		}
		return data;
	}

	private async requestHandoff(
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<ToolCallResult> {
		const session = requiredString(args, 'session');
		const host = optionalString(args, 'host');
		const chat = optionalString(args, 'chat');
		const result = await requestDaemonResult(this.home, {
			command: 'channel.handoff.request',
			name: this.context.channel,
			sourceBindingId: this.context.bindingId,
			target: {
				session,
				...(host ? { host } : {}),
				...(chat ? { chat } : {}),
			},
		}, { signal });
		const channel = requireChannel(result.status.channels, this.context.channel);
		if (!channel.handoff || channel.handoff.state !== 'pending') {
			return failedResult('Daemon did not commit a pending handoff request');
		}
		return structuredResult(
			`Accepted handoff ${channel.handoff.requestId}; it is pending until the current turn and channel tools finish.`,
			channel.handoff,
			'Accepted channel handoff',
		);
	}

	private async handoffStatus(
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<ToolCallResult> {
		const requestId = optionalString(args, 'request_id');
		const result = await requestDaemonResult(this.home, { command: 'status' }, { signal });
		const handoff = requireChannel(result.status.channels, this.context.channel).handoff;
		if (!handoff) {
			return failedResult('This channel has no recorded handoff');
		}
		if (requestId && requestId !== handoff.requestId) {
			return failedResult(`The latest handoff is ${handoff.requestId}, not ${requestId}`);
		}
		return structuredResult(
			`Handoff ${handoff.requestId} is ${handoff.state}${handoff.error ? `: ${handoff.error}` : '.'}`,
			handoff,
			'Checked channel handoff',
		);
	}

	private async cancelHandoff(
		args: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<ToolCallResult> {
		const requestId = requiredString(args, 'request_id');
		const result = await requestDaemonResult(this.home, {
			command: 'channel.handoff.cancel',
			name: this.context.channel,
			sourceBindingId: this.context.bindingId,
			requestId,
		}, { signal });
		const handoff = requireChannel(result.status.channels, this.context.channel).handoff;
		if (!handoff || handoff.requestId !== requestId || handoff.state !== 'cancelled') {
			return failedResult(`Daemon did not cancel handoff ${requestId}`);
		}
		return structuredResult(
			`Cancelled handoff ${requestId}; held messages will continue to the source binding.`,
			handoff,
			'Cancelled channel handoff',
		);
	}
}

function dataResult(data: DaemonResponseData): ToolCallResult {
	const failure = data.kind === 'sessions' && data.outcome === 'failed';
	return failure
		? failedResult(
			data.failures.map(item => `${item.preferred ?? 'automatic'}: ${item.error}`).join('; ')
				|| 'Session discovery failed',
			data,
		)
		: structuredResult(
			JSON.stringify(data),
			data,
			data.kind === 'sessions' ? 'Listed channel sessions' : 'Listed session chats',
		);
}

function structuredResult(
	text: string,
	value: object,
	pastTenseMessage: string,
): ToolCallResult {
	return {
		success: true,
		pastTenseMessage,
		content: [{ type: ToolResultContentType.Text, text }],
		structuredContent: Object.fromEntries(Object.entries(value)),
	};
}

function failedResult(message: string, value?: object): ToolCallResult {
	return {
		success: false,
		pastTenseMessage: 'Failed channel management operation',
		content: [{ type: ToolResultContentType.Text, text: message }],
		...(value ? { structuredContent: Object.fromEntries(Object.entries(value)) } : {}),
		error: { message },
	};
}

function requireChannel(
	channels: readonly ChannelDaemonStatus[],
	name: string,
): ChannelDaemonStatus {
	const channel = channels.find(candidate => candidate.name === name);
	if (!channel) {
		throw new Error(`Daemon returned no status for channel '${name}'`);
	}
	return channel;
}

function requiredString(args: Readonly<Record<string, unknown>>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}

function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
	const value = args[name];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${name} must be a non-empty string when provided`);
	}
	return value;
}

function optionalLimit(args: Readonly<Record<string, unknown>>): number | undefined {
	const value = args['limit'];
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
		throw new Error('limit must be an integer between 1 and 100');
	}
	return value as number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
