import type {
	ChatSummary,
	ListSessionsResult,
	ProjectInfo,
	ResourceReadParams,
	ResourceReadResult,
	SessionState,
	SessionSummary,
	StateAction,
	SubscribeResult,
} from '@microsoft/agent-host-protocol';
import type {
	DispatchHandle,
	ResourceRequestHandlers,
	SubscriptionEvent,
} from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
	AgentHostResolutionPlan,
} from './agentHosts.js';
import { connectAgentHost, resolveChat } from './ahp.js';
import { raceAbort } from './async.js';
import { sanitizeErrorSummary } from './channelHealth.js';
import type { AgentHostConnectionTarget } from './endpoints.js';

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const MAX_HOSTS = 100;
const MAX_PAGES_PER_HOST = 100;
const MAX_CATALOG_ENTRIES = 10_000;
const CURSOR_VERSION = 1;

export interface SessionCatalogSubscription extends AsyncIterable<SubscriptionEvent> {
	close(): Promise<void>;
}

export interface SessionCatalogHostClient {
	dispatch(channel: string, action: StateAction, clientSeq?: number): DispatchHandle;
	setResourceRequestHandlers(handlers: ResourceRequestHandlers | null): void;
	request(method: 'listSessions', params: {
		readonly channel: 'ahp-root://';
		readonly cursor?: string;
		readonly limit?: number;
	}): Promise<ListSessionsResult>;
	request(method: 'resourceRead', params: ResourceReadParams): Promise<ResourceReadResult>;
	subscribe(uri: string): Promise<{
		readonly result: SubscribeResult;
		readonly subscription: SessionCatalogSubscription;
	}>;
	unsubscribe(uri: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface SessionCatalogHostConnection {
	readonly client: SessionCatalogHostClient;
	readonly clientId: string;
}

export interface AgentHostConnector {
	connect(target: AgentHostConnectionTarget, clientId: string): Promise<SessionCatalogHostConnection>;
}

export interface SessionCatalogHostResolver {
	configuredSelectors(): Promise<readonly string[]>;
	resolve(selector?: string): Promise<AgentHostConnectionTarget>;
	resolveCandidates(selector?: string): Promise<AgentHostResolutionPlan>;
}

export class ProtocolAgentHostConnector implements AgentHostConnector {
	async connect(target: AgentHostConnectionTarget, clientId: string): Promise<SessionCatalogHostConnection> {
		return connectAgentHost(target, clientId);
	}
}

export interface CatalogHost {
	readonly preferred?: string;
	readonly actual: string;
	readonly fallback: boolean;
}

export interface CatalogProject {
	readonly uri: string;
	readonly displayName: string;
}

export interface SessionCatalogEntry {
	readonly host: CatalogHost;
	readonly resource: string;
	readonly title: string;
	readonly provider: string;
	readonly status: number;
	readonly createdAt: string;
	readonly modifiedAt: string;
	readonly activity?: string;
	readonly project?: CatalogProject;
	readonly workingDirectories?: readonly string[];
}

export interface ChatCatalogEntry {
	readonly resource: string;
	readonly title: string;
	readonly status: number;
	readonly modifiedAt: string;
	readonly activity?: string;
	readonly workingDirectories?: readonly string[];
	readonly isDefault: boolean;
}

export interface CatalogFailure {
	readonly preferred?: string;
	readonly error: string;
}

export type CatalogOutcome = 'ok' | 'empty' | 'partial' | 'failed';

export interface SessionDiscoveryResult {
	readonly kind: 'sessions';
	readonly outcome: CatalogOutcome;
	readonly items: readonly SessionCatalogEntry[];
	readonly failures: readonly CatalogFailure[];
	readonly nextCursor?: string;
}

export interface ChatDiscoveryResult {
	readonly kind: 'chats';
	readonly outcome: Extract<CatalogOutcome, 'ok' | 'empty'>;
	readonly host: CatalogHost;
	readonly session: {
		readonly resource: string;
		readonly title: string;
		readonly provider: string;
		readonly status: number;
		readonly activity?: string;
		readonly project?: CatalogProject;
		readonly workingDirectories?: readonly string[];
	};
	readonly defaultChat?: string;
	readonly items: readonly ChatCatalogEntry[];
	readonly warnings: readonly string[];
	readonly nextCursor?: string;
}

export interface SessionDiscoveryRequest {
	readonly host?: string;
	readonly currentHost?: string | null;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface ChatDiscoveryRequest {
	readonly host?: string;
	readonly session: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface ChannelBindingTarget {
	readonly host?: string;
	readonly session: string;
	readonly chat?: string;
}

export interface OpenSessionRequest extends ChannelBindingTarget {
	readonly clientId?: string;
}

export interface ResolvedChannelBinding {
	readonly preferredHost?: string;
	readonly actualHost: string;
	readonly fallback: boolean;
	readonly session: string;
	readonly chat: string;
	readonly warnings: readonly string[];
}

export interface OpenedSession {
	readonly host: CatalogHost;
	readonly connection: SessionCatalogHostConnection;
	readonly subscription: SessionCatalogSubscription;
	readonly state: SessionState;
	readonly warnings: readonly string[];
}

export class SessionHostResolutionError extends Error {
	constructor(
		readonly stage: 'discovery' | 'connection' | 'session',
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

const CatalogHostSchema = z.strictObject({
	preferred: z.string().min(1).optional(),
	actual: z.string().min(1),
	fallback: z.boolean(),
});

const CatalogProjectSchema = z.strictObject({
	uri: z.string().min(1),
	displayName: z.string(),
});

const SessionCatalogEntrySchema = z.strictObject({
	host: CatalogHostSchema,
	resource: z.string().min(1),
	title: z.string(),
	provider: z.string(),
	status: z.number().int(),
	createdAt: z.string(),
	modifiedAt: z.string(),
	activity: z.string().optional(),
	project: CatalogProjectSchema.optional(),
	workingDirectories: z.array(z.string()).optional(),
});

const ChatCatalogEntrySchema = z.strictObject({
	resource: z.string().min(1),
	title: z.string(),
	status: z.number().int(),
	modifiedAt: z.string(),
	activity: z.string().optional(),
	workingDirectories: z.array(z.string()).optional(),
	isDefault: z.boolean(),
});

const CatalogFailureSchema = z.strictObject({
	preferred: z.string().min(1).optional(),
	error: z.string().min(1),
});

export const SessionDiscoveryResultSchema = z.strictObject({
	kind: z.literal('sessions'),
	outcome: z.enum(['ok', 'empty', 'partial', 'failed']),
	items: z.array(SessionCatalogEntrySchema),
	failures: z.array(CatalogFailureSchema),
	nextCursor: z.string().min(1).optional(),
});

export const ChatDiscoveryResultSchema = z.strictObject({
	kind: z.literal('chats'),
	outcome: z.enum(['ok', 'empty']),
	host: CatalogHostSchema,
	session: z.strictObject({
		resource: z.string().min(1),
		title: z.string(),
		provider: z.string(),
		status: z.number().int(),
		activity: z.string().optional(),
		project: CatalogProjectSchema.optional(),
		workingDirectories: z.array(z.string()).optional(),
	}),
	defaultChat: z.string().min(1).optional(),
	items: z.array(ChatCatalogEntrySchema),
	warnings: z.array(z.string()),
	nextCursor: z.string().min(1).optional(),
});

const SessionCursorSchema = z.strictObject({
	version: z.literal(CURSOR_VERSION),
	kind: z.literal('sessions'),
	hosts: z.array(z.string().nullable()).min(1).max(MAX_HOSTS),
	offset: z.number().int().nonnegative().max(MAX_CATALOG_ENTRIES),
});

const ChatCursorSchema = z.strictObject({
	version: z.literal(CURSOR_VERSION),
	kind: z.literal('chats'),
	host: z.string().nullable(),
	session: z.string().min(1),
	offset: z.number().int().nonnegative(),
});

type SessionCursor = z.infer<typeof SessionCursorSchema>;

export class SessionCatalogService {
	constructor(
		private readonly agentHosts: SessionCatalogHostResolver,
		private readonly connector: AgentHostConnector = new ProtocolAgentHostConnector(),
	) { }

	async discoverSessions(
		request: SessionDiscoveryRequest = {},
		signal?: AbortSignal,
	): Promise<SessionDiscoveryResult> {
		const limit = pageLimit(request.limit);
		const decodedCursor = request.cursor ? decodeSessionCursor(request.cursor) : undefined;
		const hosts = decodedCursor
			? decodedCursor.hosts.map(value => value ?? undefined)
			: await this.discoveryHosts(request);
		const initial: SessionCursor = decodedCursor
			? decodedCursor
			: {
				version: CURSOR_VERSION,
				kind: 'sessions' as const,
				hosts: hosts.map(host => host ?? null),
				offset: 0,
			};
		if (request.host || Object.hasOwn(request, 'currentHost')) {
			const expectedHosts = (await this.discoveryHosts(request)).map(host => host ?? null);
			if (!arraysEqual(initial.hosts, expectedHosts)) {
				throw new Error('Session catalog cursor does not match the requested hosts');
			}
		}

		const catalog: SessionCatalogEntry[] = [];
		const failures: CatalogFailure[] = [];
		let successfulHosts = 0;
		for (const preferred of hosts) {
			throwIfAborted(signal);
			try {
				const items = await this.listHostSessions(preferred, signal);
				successfulHosts++;
				if (catalog.length + items.length > MAX_CATALOG_ENTRIES) {
					throw new Error(`Combined session catalog exceeds ${MAX_CATALOG_ENTRIES} entries`);
				}
				catalog.push(...items);
			} catch (error) {
				throwIfAborted(signal);
				failures.push({
					...(preferred ? { preferred } : {}),
					error: sanitizeErrorSummary(errorMessage(error)),
				});
			}
		}

		if (initial.offset > catalog.length
			|| (initial.offset > 0 && initial.offset === catalog.length)) {
			throw new Error('Session catalog cursor is beyond the available catalog');
		}
		const items = catalog.slice(initial.offset, initial.offset + limit);
		const nextOffset = initial.offset + items.length;
		const nextCursor = nextOffset < catalog.length
			? encodeCursor({ ...initial, offset: nextOffset })
			: undefined;
		return {
			kind: 'sessions',
			outcome: discoveryOutcome(items.length, failures.length, successfulHosts),
			items,
			failures,
			...(nextCursor ? { nextCursor } : {}),
		};
	}

	async discoverChats(request: ChatDiscoveryRequest, signal?: AbortSignal): Promise<ChatDiscoveryResult> {
		const limit = pageLimit(request.limit);
		const offset = request.cursor ? decodeChatCursor(request.cursor, request).offset : 0;
		const opened = await this.openSession({
			host: request.host,
			session: request.session,
		}, signal);
		let result: ChatDiscoveryResult;
		let operationError: unknown;
		try {
			const chats = opened.state.chats.map(chat => toChatEntry(chat, opened.state.defaultChat));
			if (offset > chats.length) {
				throw new Error('Chat catalog cursor is beyond the available catalog');
			}
			const items = chats.slice(offset, offset + limit);
			const nextOffset = offset + items.length;
			result = {
				kind: 'chats',
				outcome: items.length === 0 ? 'empty' : 'ok',
				host: opened.host,
				session: sessionDetails(opened.state, request.session),
				...(opened.state.defaultChat ? { defaultChat: opened.state.defaultChat } : {}),
				items,
				warnings: opened.warnings,
				...(nextOffset < chats.length ? {
					nextCursor: encodeCursor({
						version: CURSOR_VERSION,
						kind: 'chats',
						host: request.host ?? null,
						session: request.session,
						offset: nextOffset,
					}),
				} : {}),
			};
		} catch (error) {
			operationError = error;
			throw error;
		} finally {
			await closeOpenedSession(opened, operationError);
		}
		return result;
	}

	async validateBinding(target: ChannelBindingTarget, signal?: AbortSignal): Promise<ResolvedChannelBinding> {
		const opened = await this.openSession(target, signal);
		let operationError: unknown;
		try {
			return {
				...(opened.host.preferred ? { preferredHost: opened.host.preferred } : {}),
				actualHost: opened.host.actual,
				fallback: opened.host.fallback,
				session: target.session,
				chat: resolveChat(opened.state, target.chat, target.session),
				warnings: opened.warnings,
			};
		} catch (error) {
			operationError = error;
			throw error;
		} finally {
			await closeOpenedSession(opened, operationError);
		}
	}

	async openSession(target: OpenSessionRequest, signal?: AbortSignal): Promise<OpenedSession> {
		throwIfAborted(signal);
		let plan: AgentHostResolutionPlan;
		try {
			plan = await abortable(this.agentHosts.resolveCandidates(target.host), signal);
		} catch (error) {
			throwIfAborted(signal);
			throw new SessionHostResolutionError('discovery', errorMessage(error), { cause: error });
		}
		const errors: Error[] = [];
		let failureStage: SessionHostResolutionError['stage'] = 'connection';
		for (const candidate of plan.candidates) {
			throwIfAborted(signal);
			let connection: SessionCatalogHostConnection | undefined;
			let subscription: SessionCatalogSubscription | undefined;
			const errorStart = errors.length;
			try {
				connection = await connectHost(
					this.connector,
					candidate.target,
					target.clientId ?? randomUUID(),
					signal,
				);
				try {
					if (candidate.verifySessionCatalog
						&& !await hostHasSession(connection.client, target.session, signal)) {
						throw new Error('Session is not present in this Agent Host catalog');
					}
					const subscribed = await subscribeHost(connection.client, target.session, signal);
					subscription = subscribed.subscription;
					if (!subscribed.result.snapshot || !isSessionState(subscribed.result.snapshot.state)) {
						throw new Error('Agent Host returned no valid session state snapshot');
					}
					return {
						host: {
							...(plan.preferredHost ? { preferred: plan.preferredHost } : {}),
							actual: candidate.target.id,
							fallback: candidate.fallback,
						},
						connection,
						subscription,
						state: subscribed.result.snapshot.state,
						warnings: candidate.fallback && plan.preferredHost
							? [
								...plan.warnings,
								`Host alias '${plan.preferredHost}' did not connect; using local fallback ${candidate.target.id} for ${target.session}`,
							]
							: plan.warnings,
					};
				} catch (error) {
					failureStage = 'session';
					throw error;
				}
			} catch (error) {
				errors.push(new Error(
					`${candidate.target.id}: ${sanitizeErrorSummary(errorMessage(error))}`,
					{ cause: error },
				));
				await cleanupConnection(subscription, connection, errors);
				if (signal?.aborted && errors.length > errorStart + 1) {
					throw new AggregateError(
						errors.slice(errorStart),
						`Failed to cancel Agent Host session resolution for ${candidate.target.id}`,
					);
				}
				throwIfAborted(signal);
			}
		}
		throw new SessionHostResolutionError(
			failureStage,
			`No Agent Host candidate owns session ${target.session}: ${errors.map(error => error.message).join('; ')}`,
			{ cause: new AggregateError(errors) },
		);
	}

	private async discoveryHosts(request: SessionDiscoveryRequest): Promise<readonly (string | undefined)[]> {
		if (request.host) {
			return [request.host];
		}
		const configured = await this.agentHosts.configuredSelectors();
		const requestedCurrent = Object.hasOwn(request, 'currentHost')
			? request.currentHost ?? undefined
			: undefined;
		const candidates = Object.hasOwn(request, 'currentHost')
			? [requestedCurrent, ...configured]
			: configured.length > 0
				? configured
				: [undefined];
		return deduplicateHosts(candidates);
	}

	private async listHostSessions(
		preferred: string | undefined,
		signal?: AbortSignal,
	): Promise<readonly SessionCatalogEntry[]> {
		const target = await abortable(this.agentHosts.resolve(preferred), signal);
		const connection = await connectHost(this.connector, target, randomUUID(), signal);
		let operationError: unknown;
		try {
			const items: SessionCatalogEntry[] = [];
			const seenCursors = new Set<string>();
			let cursor: string | undefined;
			for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_HOST; pageIndex++) {
				const page = parseSessionPage(await abortable(connection.client.request('listSessions', {
					channel: 'ahp-root://',
					limit: MAX_PAGE_LIMIT,
					...(cursor ? { cursor } : {}),
				}), signal));
				if (items.length + page.items.length > MAX_CATALOG_ENTRIES) {
					throw new Error(`Agent Host session catalog exceeds ${MAX_CATALOG_ENTRIES} entries`);
				}
				items.push(...page.items.map(summary => toSessionEntry(summary, {
					...(preferred ? { preferred } : {}),
					actual: target.id,
					fallback: false,
				})));
				if (!page.nextCursor) {
					return items;
				}
				if (seenCursors.has(page.nextCursor)) {
					throw new Error('Agent Host returned a repeated session cursor');
				}
				seenCursors.add(page.nextCursor);
				cursor = page.nextCursor;
			}
			throw new Error(`Agent Host session catalog exceeded ${MAX_PAGES_PER_HOST} pages`);
		} catch (error) {
			operationError = error;
			throw error;
		} finally {
			try {
				await connection.client.shutdown();
			} catch (error) {
				throw new AggregateError(
					operationError
						? [
							toError('session catalog request', operationError),
							toError('Agent Host discovery connection', error),
						]
						: [toError('Agent Host discovery connection', error)],
					'Failed to finish Agent Host session discovery',
				);
			}
		}
	}
}

async function hostHasSession(
	client: SessionCatalogHostClient,
	session: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES_PER_HOST; page++) {
		const result = parseSessionPage(await abortable(client.request('listSessions', {
			channel: 'ahp-root://',
			limit: MAX_PAGE_LIMIT,
			...(cursor ? { cursor } : {}),
		}), signal));
		if (result.items.some(candidate => candidate.resource === session)) {
			return true;
		}
		if (!result.nextCursor) {
			return false;
		}
		if (seenCursors.has(result.nextCursor)) {
			throw new Error('Agent Host returned a repeated session cursor');
		}
		seenCursors.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	throw new Error(`Agent Host session catalog exceeded ${MAX_PAGES_PER_HOST} pages`);
}

function parseSessionPage(value: unknown): {
	readonly items: readonly SessionSummary[];
	readonly nextCursor?: string;
} {
	if (!isRecord(value)
		|| !Array.isArray(value['items'])
		|| !value['items'].every(isSessionSummary)
		|| (value['nextCursor'] !== undefined
			&& (typeof value['nextCursor'] !== 'string' || value['nextCursor'].length === 0))) {
		throw new Error('Agent Host returned a malformed session catalog page');
	}
	return {
		items: value['items'],
		...(value['nextCursor'] ? { nextCursor: value['nextCursor'] } : {}),
	};
}

function isSessionSummary(value: unknown): value is SessionSummary {
	return isRecord(value)
		&& typeof value['resource'] === 'string'
		&& value['resource'].length > 0
		&& typeof value['title'] === 'string'
		&& typeof value['provider'] === 'string'
		&& Number.isInteger(value['status'])
		&& typeof value['createdAt'] === 'string'
		&& typeof value['modifiedAt'] === 'string'
		&& isOptionalString(value['activity'])
		&& isOptionalProject(value['project'])
		&& isOptionalStringArray(value['workingDirectories']);
}

function isSessionState(value: unknown): value is SessionState {
	return isRecord(value)
		&& typeof value['title'] === 'string'
		&& typeof value['provider'] === 'string'
		&& Number.isInteger(value['status'])
		&& Array.isArray(value['chats'])
		&& value['chats'].every(isChatSummary)
		&& isOptionalString(value['defaultChat'])
		&& isOptionalString(value['activity'])
		&& isOptionalProject(value['project'])
		&& isOptionalStringArray(value['workingDirectories']);
}

function isChatSummary(value: unknown): value is ChatSummary {
	return isRecord(value)
		&& typeof value['resource'] === 'string'
		&& value['resource'].length > 0
		&& typeof value['title'] === 'string'
		&& Number.isInteger(value['status'])
		&& typeof value['modifiedAt'] === 'string'
		&& isOptionalString(value['activity'])
		&& isOptionalStringArray(value['workingDirectories']);
}

function isOptionalProject(value: unknown): value is ProjectInfo | undefined {
	return value === undefined
		|| (isRecord(value)
			&& typeof value['uri'] === 'string'
			&& typeof value['displayName'] === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
	return value === undefined
		|| (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function toSessionEntry(summary: SessionSummary, host: CatalogHost): SessionCatalogEntry {
	return {
		host,
		resource: summary.resource,
		title: summary.title,
		provider: summary.provider,
		status: summary.status,
		createdAt: summary.createdAt,
		modifiedAt: summary.modifiedAt,
		...(summary.activity ? { activity: summary.activity } : {}),
		...(summary.project ? { project: toProject(summary.project) } : {}),
		...(summary.workingDirectories ? { workingDirectories: [...summary.workingDirectories] } : {}),
	};
}

function toChatEntry(chat: ChatSummary, defaultChat: string | undefined): ChatCatalogEntry {
	return {
		resource: chat.resource,
		title: chat.title,
		status: chat.status,
		modifiedAt: chat.modifiedAt,
		...(chat.activity ? { activity: chat.activity } : {}),
		...(chat.workingDirectories ? { workingDirectories: [...chat.workingDirectories] } : {}),
		isDefault: chat.resource === defaultChat,
	};
}

function sessionDetails(state: SessionState, resource: string): ChatDiscoveryResult['session'] {
	return {
		resource,
		title: state.title,
		provider: state.provider,
		status: state.status,
		...(state.activity ? { activity: state.activity } : {}),
		...(state.project ? { project: toProject(state.project) } : {}),
		...(state.workingDirectories ? { workingDirectories: [...state.workingDirectories] } : {}),
	};
}

function toProject(project: ProjectInfo): CatalogProject {
	return {
		uri: project.uri,
		displayName: project.displayName,
	};
}

function pageLimit(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_PAGE_LIMIT;
	}
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
		throw new Error(`Catalog limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
	}
	return value;
}

function discoveryOutcome(
	itemCount: number,
	failureCount: number,
	successfulHosts: number,
): CatalogOutcome {
	if (failureCount > 0 && successfulHosts === 0) {
		return 'failed';
	}
	if (failureCount > 0) {
		return 'partial';
	}
	return itemCount > 0 ? 'ok' : 'empty';
}

function encodeCursor(value: object): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSessionCursor(value: string): SessionCursor {
	const decoded = decodeCursor(value);
	const parsed = SessionCursorSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error('Invalid session catalog cursor');
	}
	return parsed.data;
}

function decodeChatCursor(value: string, request: ChatDiscoveryRequest): z.infer<typeof ChatCursorSchema> {
	const parsed = ChatCursorSchema.safeParse(decodeCursor(value));
	if (!parsed.success
		|| parsed.data.host !== (request.host ?? null)
		|| parsed.data.session !== request.session) {
		throw new Error('Invalid chat catalog cursor');
	}
	return parsed.data;
}

function decodeCursor(value: string): unknown {
	try {
		return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
	} catch (error) {
		throw new Error('Invalid catalog cursor', { cause: error });
	}
}

function deduplicateHosts(hosts: readonly (string | undefined)[]): readonly (string | undefined)[] {
	const result: Array<string | undefined> = [];
	const seen = new Set<string>();
	for (const host of hosts) {
		const key = host?.toLowerCase() ?? '';
		if (!seen.has(key)) {
			seen.add(key);
			result.push(host);
		}
	}
	if (result.length > MAX_HOSTS) {
		throw new Error(`Session discovery supports at most ${MAX_HOSTS} configured hosts`);
	}
	return result;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function closeOpenedSession(opened: OpenedSession, operationError?: unknown): Promise<void> {
	const errors: Error[] = [];
	await cleanup('session subscription', () => opened.subscription.close(), errors);
	await cleanup('Agent Host connection', () => opened.connection.client.shutdown(), errors);
	if (errors.length > 0) {
		throw new AggregateError(
			operationError ? [toError('session discovery', operationError), ...errors] : errors,
			'Failed to close session discovery',
		);
	}
}

async function cleanup(
	label: string,
	operation: () => Promise<unknown>,
	errors: Error[],
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(new Error(`${label}: ${sanitizeErrorSummary(errorMessage(error))}`, { cause: error }));
	}
}

async function cleanupConnection(
	subscription: SessionCatalogSubscription | undefined,
	connection: SessionCatalogHostConnection | undefined,
	errors: Error[],
): Promise<void> {
	if (subscription) {
		await cleanup('session subscription', () => subscription.close(), errors);
	}
	if (connection) {
		await cleanup('Agent Host connection', () => connection.client.shutdown(), errors);
	}
}

async function connectHost(
	connector: AgentHostConnector,
	target: AgentHostConnectionTarget,
	clientId: string,
	signal?: AbortSignal,
): Promise<SessionCatalogHostConnection> {
	const operation = connector.connect(target, clientId);
	try {
		return await abortable(operation, signal);
	} catch (error) {
		if (signal?.aborted) {
			observeLateCleanup(
				operation.then(
					connection => connection.client.shutdown(),
					() => undefined,
				),
				`cancelled Agent Host connection ${target.id}`,
			);
		}
		throw error;
	}
}

async function subscribeHost(
	client: SessionCatalogHostClient,
	session: string,
	signal?: AbortSignal,
): Promise<{
	readonly result: SubscribeResult;
	readonly subscription: SessionCatalogSubscription;
}> {
	const operation = client.subscribe(session);
	try {
		return await abortable(operation, signal);
	} catch (error) {
		if (signal?.aborted) {
			observeLateCleanup(
				operation.then(
					result => result.subscription.close(),
					() => undefined,
				),
				`cancelled session subscription ${session}`,
			);
		}
		throw error;
	}
}

function observeLateCleanup(operation: Promise<unknown>, label: string): void {
	void operation.catch(error => {
		process.emitWarning(`${label} cleanup failed: ${sanitizeErrorSummary(errorMessage(error))}`);
	});
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	return signal ? raceAbort(operation, signal) : operation;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toError(label: string, error: unknown): Error {
	return new Error(`${label}: ${sanitizeErrorSummary(errorMessage(error))}`, { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
