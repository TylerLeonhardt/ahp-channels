import { z } from 'zod';
import { ChannelFailureStageSchema, type ChannelHealth } from './channelHealth.js';
import type { ChannelInstanceConfig } from './config.js';
import type { ChannelRuntimeSnapshot } from './channelRuntime.js';

export const DAEMON_PROTOCOL_VERSION = 5;
export const MAX_DAEMON_MESSAGE_BYTES = 1024 * 1024;

const ChannelInstanceSchema = z.strictObject({
	plugin: z.string().min(1),
	session: z.string().min(1),
	enabled: z.boolean(),
	chat: z.string().min(1).optional(),
	server: z.string().min(1).optional(),
	host: z.string().min(1).optional(),
	clientId: z.string().min(1).optional(),
	installation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const RequestBodySchema = z.discriminatedUnion('command', [
	z.strictObject({ command: z.literal('ping') }),
	z.strictObject({ command: z.literal('status') }),
	z.strictObject({ command: z.literal('shutdown') }),
	z.strictObject({
		command: z.literal('channel.create'),
		name: z.string().min(1),
		definition: ChannelInstanceSchema,
		start: z.boolean(),
	}),
	z.strictObject({
		command: z.literal('channel.start'),
		name: z.string().min(1),
	}),
	z.strictObject({
		command: z.literal('channel.stop'),
		name: z.string().min(1),
	}),
	z.strictObject({
		command: z.literal('channel.restart'),
		name: z.string().min(1),
	}),
	z.strictObject({
		command: z.literal('channel.switch'),
		name: z.string().min(1),
		session: z.string().min(1),
		chat: z.string().min(1).optional(),
	}),
	z.strictObject({
		command: z.literal('channel.rehost'),
		name: z.string().min(1),
		host: z.string().min(1),
	}),
	z.strictObject({
		command: z.literal('channel.repin'),
		name: z.string().min(1),
		installation: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	z.strictObject({
		command: z.literal('channel.delete'),
		name: z.string().min(1),
	}),
]);

const RequestSchema = z.strictObject({
	version: z.literal(DAEMON_PROTOCOL_VERSION),
	token: z.string().min(32),
	body: RequestBodySchema,
});

const RuntimeSnapshotSchema = z.strictObject({
	name: z.string(),
	plugin: z.string(),
	session: z.string(),
	chat: z.string(),
	host: z.string(),
	clientId: z.string(),
	channelName: z.string(),
	startedAt: z.string(),
	busy: z.boolean(),
	mode: z.enum(['mcp', 'customization-only']),
});

const ChannelFailureSchema = z.strictObject({
	stage: ChannelFailureStageSchema,
	summary: z.string().min(1),
	failedAt: z.iso.datetime(),
	guidance: z.string().min(1),
});

const ChannelRetrySchema = z.discriminatedUnion('state', [
	z.strictObject({
		attempt: z.number().int().positive(),
		state: z.literal('scheduled'),
		nextRetryAt: z.iso.datetime(),
	}),
	z.strictObject({
		attempt: z.number().int().nonnegative(),
		state: z.literal('exhausted'),
	}),
]);

const ChannelHealthSchema = z.discriminatedUnion('state', [
	z.strictObject({ state: z.literal('healthy') }),
	z.strictObject({ state: z.literal('stopped') }),
	z.strictObject({
		state: z.literal('degraded'),
		failure: ChannelFailureSchema,
		retry: ChannelRetrySchema.optional(),
	}),
	z.strictObject({
		state: z.literal('unhealthy'),
		failure: ChannelFailureSchema,
		retry: ChannelRetrySchema.optional(),
	}),
]);

const ChannelStatusSchema = z.strictObject({
	name: z.string(),
	desired: z.enum(['running', 'stopped']),
	state: z.enum(['stopped', 'starting', 'running', 'stopping', 'error']),
	definition: ChannelInstanceSchema,
	runtime: RuntimeSnapshotSchema.optional(),
	health: ChannelHealthSchema,
});

const DaemonStatusSchema = z.strictObject({
	pid: z.number().int().positive(),
	startedAt: z.string(),
	channels: z.array(ChannelStatusSchema),
});

const ResponseSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		version: z.literal(DAEMON_PROTOCOL_VERSION),
		ok: z.literal(true),
		result: DaemonStatusSchema,
	}),
	z.strictObject({
		version: z.literal(DAEMON_PROTOCOL_VERSION),
		ok: z.literal(false),
		error: z.strictObject({
			code: z.string(),
			message: z.string(),
		}),
	}),
]);

export type DaemonRequestBody = z.infer<typeof RequestBodySchema>;
export type DaemonRequest = z.infer<typeof RequestSchema>;

export type ChannelDaemonState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ChannelDaemonStatus {
	readonly name: string;
	readonly desired: 'running' | 'stopped';
	readonly state: ChannelDaemonState;
	readonly definition: ChannelInstanceConfig;
	readonly runtime?: ChannelRuntimeSnapshot;
	readonly health: ChannelHealth;
}

export interface DaemonStatus {
	readonly pid: number;
	readonly startedAt: string;
	readonly channels: readonly ChannelDaemonStatus[];
}

export interface DaemonSuccessResponse {
	readonly version: typeof DAEMON_PROTOCOL_VERSION;
	readonly ok: true;
	readonly result: DaemonStatus;
}

export interface DaemonErrorResponse {
	readonly version: typeof DAEMON_PROTOCOL_VERSION;
	readonly ok: false;
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}

export type DaemonResponse = DaemonSuccessResponse | DaemonErrorResponse;

export function parseDaemonRequest(value: unknown): DaemonRequest {
	const parsed = RequestSchema.safeParse(value);
	if (!parsed.success) {
		throw new DaemonProtocolError('INVALID_REQUEST', z.prettifyError(parsed.error));
	}
	return parsed.data;
}

export function parseDaemonResponse(value: unknown): DaemonResponse {
	const parsed = ResponseSchema.safeParse(value);
	if (!parsed.success) {
		throw new DaemonProtocolError('INVALID_RESPONSE', z.prettifyError(parsed.error));
	}
	return parsed.data;
}

export class DaemonProtocolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}
