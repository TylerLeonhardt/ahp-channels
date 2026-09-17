import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	ConfigStore,
	isValidHostAliasName,
	type AppConfig,
	type HostAliasConfig,
	type SocketHostAliasConfig,
	type VsCodeLocalHostAliasConfig,
	type WebSocketHostAliasConfig,
} from './config.js';
import {
	describeEndpoint,
	discoverAgentHostsInRegistryDirectories,
	discoverLocalAgentHosts,
	selectAgentHost,
	type AgentHostConnectionTarget,
	type AgentHostEndpoint,
} from './endpoints.js';
import { sanitizeErrorSummary } from './channelHealth.js';

export type HostAliasResolutionErrorCode = 'ambiguous' | 'invalid' | 'unavailable' | 'unknown';

export class HostAliasResolutionError extends Error {
	constructor(
		readonly code: HostAliasResolutionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export interface HostAliasInspection {
	readonly name: string;
	readonly selector: string;
	readonly kind: HostAliasConfig['kind'];
	readonly target: Record<string, unknown>;
	readonly state: 'ambiguous' | 'available' | 'configured' | 'unavailable';
	readonly endpoint?: Record<string, unknown>;
	readonly error?: string;
}

export interface AgentHostCandidate {
	readonly target: AgentHostConnectionTarget;
	readonly fallback: boolean;
	readonly verifySessionCatalog: boolean;
}

export interface AgentHostResolutionPlan {
	readonly preferredHost?: string;
	readonly candidates: readonly AgentHostCandidate[];
	readonly warnings: readonly string[];
}

export class AgentHostService {
	constructor(
		private readonly configStore: ConfigStore,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) { }

	discover(): Promise<readonly AgentHostEndpoint[]> {
		return discoverLocalAgentHosts(this.env);
	}

	async resolve(selector?: string): Promise<AgentHostConnectionTarget> {
		const aliasName = selector && parseHostAliasSelector(selector);
		if (aliasName) {
			return this.resolveAlias(aliasName);
		}
		return selectAgentHost(await this.discover(), selector);
	}

	async configuredSelectors(): Promise<readonly string[]> {
		return Object.keys((await this.configStore.read()).hostAliases)
			.sort((a, b) => a.localeCompare(b))
			.map(formatHostAliasSelector);
	}

	async resolveCandidates(selector?: string): Promise<AgentHostResolutionPlan> {
		if (!selector) {
			const endpoints = await this.discover();
			if (endpoints.length === 0) {
				throw new Error('No running local Agent Host endpoints were discovered');
			}
			return {
				candidates: endpoints.map(target => ({
					target,
					fallback: false,
					verifySessionCatalog: true,
				})),
				warnings: [],
			};
		}

		if (!isHostAliasSelector(selector)) {
			return {
				preferredHost: selector,
				candidates: [{
					target: await this.resolve(selector),
					fallback: false,
					verifySessionCatalog: false,
				}],
				warnings: [],
			};
		}

		const warnings: string[] = [];
		let preferred: AgentHostConnectionTarget | undefined;
		try {
			preferred = await this.resolve(selector);
		} catch (error) {
			if (!(error instanceof HostAliasResolutionError) || error.code !== 'unavailable') {
				throw error;
			}
			warnings.push(`${error.message}; searching other local Agent Hosts for the bound session`);
		}

		let fallbackEndpoints: readonly AgentHostEndpoint[] = [];
		try {
			fallbackEndpoints = await this.discover();
		} catch (error) {
			if (!preferred) {
				throw error;
			}
			warnings.push(`Local Agent Host fallback discovery failed: ${sanitizeErrorSummary(errorMessage(error))}`);
		}

		const candidates: AgentHostCandidate[] = [];
		if (preferred) {
			candidates.push({
				target: preferred,
				fallback: false,
				verifySessionCatalog: false,
			});
		}
		for (const target of fallbackEndpoints) {
			if (target.id === preferred?.id) {
				continue;
			}
			candidates.push({
				target,
				fallback: true,
				verifySessionCatalog: true,
			});
		}
		if (candidates.length === 0) {
			throw new Error(`Host alias '${selector}' is unavailable and no fallback Agent Hosts were discovered`);
		}
		return {
			preferredHost: selector,
			candidates,
			warnings,
		};
	}

	async resolveAlias(name: string): Promise<AgentHostConnectionTarget> {
		const { canonicalName, target } = requireHostAlias(await this.configStore.read(), name);
		return resolveConfiguredTarget(canonicalName, target);
	}

	async addDiscoveredAlias(name: string, selector: string): Promise<HostAliasInspection> {
		assertHostAliasName(name);
		if (parseHostAliasSelector(selector)) {
			throw new HostAliasResolutionError(
				'invalid',
				'Create a host alias from a discovered endpoint index or ID, not from another alias',
			);
		}
		const endpoints = await this.discover();
		const selected = selectAgentHost(endpoints, selector);
		const target: VsCodeLocalHostAliasConfig = {
			kind: 'vscode-local',
			registry: dirname(selected.registryFile),
			hostType: selected.type,
			...(selected.quality ? { quality: selected.quality } : {}),
		};
		const matches = endpoints.filter(endpoint => matchesVsCodeTarget(endpoint, target));
		if (matches.length !== 1) {
			throw new HostAliasResolutionError(
				'ambiguous',
				`Discovered host '${selected.id}' shares its stable local scope with ${matches.length - 1} other live endpoint(s)`,
			);
		}
		await this.addAlias(name, target);
		return this.inspect(name);
	}

	async addExplicitAlias(
		name: string,
		target: WebSocketHostAliasConfig | SocketHostAliasConfig,
	): Promise<HostAliasInspection> {
		assertHostAliasName(name);
		await this.addAlias(name, target);
		return this.inspect(name);
	}

	async removeAlias(name: string): Promise<string> {
		assertHostAliasName(name);
		let removedName: string | undefined;
		await this.configStore.update(config => {
			const canonicalName = findHostAliasName(config, name);
			if (!canonicalName) {
				throw new HostAliasResolutionError('unknown', `Host alias '@${name}' does not exist`);
			}
			const references = Object.entries(config.channels)
				.filter(([, channel]) => channel.host?.toLowerCase() === `@${canonicalName.toLowerCase()}`)
				.map(([channelName]) => channelName);
			if (references.length > 0) {
				throw new HostAliasResolutionError(
					'invalid',
					`Host alias '@${canonicalName}' is referenced by channel(s): ${references.join(', ')}`,
				);
			}
			const hostAliases = { ...config.hostAliases };
			delete hostAliases[canonicalName];
			removedName = canonicalName;
			return { ...config, hostAliases };
		});
		if (!removedName) {
			throw new Error(`Failed to remove host alias '@${name}'`);
		}
		return removedName;
	}

	async list(): Promise<readonly HostAliasInspection[]> {
		const config = await this.configStore.read();
		const names = Object.keys(config.hostAliases).sort((a, b) => a.localeCompare(b));
		return Promise.all(names.map(name => this.inspectConfiguredAlias(name, config.hostAliases[name])));
	}

	async inspect(name: string): Promise<HostAliasInspection> {
		const { canonicalName, target } = requireHostAlias(await this.configStore.read(), name);
		return this.inspectConfiguredAlias(canonicalName, target);
	}

	private async addAlias(name: string, target: HostAliasConfig): Promise<void> {
		await this.configStore.update(config => {
			if (findHostAliasName(config, name)) {
				throw new HostAliasResolutionError('invalid', `Host alias '@${name}' already exists`);
			}
			return {
				...config,
				hostAliases: {
					...config.hostAliases,
					[name]: target,
				},
			};
		});
	}

	private async inspectConfiguredAlias(name: string, target: HostAliasConfig): Promise<HostAliasInspection> {
		try {
			const resolved = await resolveConfiguredTarget(name, target);
			return {
				name,
				selector: formatHostAliasSelector(name),
				kind: target.kind,
				target: describeAliasTarget(target),
				state: target.kind === 'vscode-local' ? 'available' : 'configured',
				endpoint: describeConnectionTarget(resolved),
			};
		} catch (error) {
			if (!(error instanceof HostAliasResolutionError)
				|| (error.code !== 'ambiguous' && error.code !== 'unavailable')) {
				throw error;
			}
			return {
				name,
				selector: formatHostAliasSelector(name),
				kind: target.kind,
				target: describeAliasTarget(target),
				state: error.code,
				error: error.message,
			};
		}
	}
}

export function formatHostAliasSelector(name: string): string {
	return `@${name}`;
}

export function parseHostAliasSelector(selector: string): string | undefined {
	if (!selector.startsWith('@')) {
		return undefined;
	}
	const name = selector.slice(1);
	if (!isValidHostAliasName(name)) {
		throw new HostAliasResolutionError('invalid', `Invalid host alias selector '${selector}'`);
	}
	return name;
}

export function isHostAliasSelector(selector: string | undefined): boolean {
	return selector?.startsWith('@') ?? false;
}

function assertHostAliasName(name: string): void {
	if (!isValidHostAliasName(name)) {
		throw new HostAliasResolutionError('invalid', `Invalid host alias name '${name}'`);
	}
}

function requireHostAlias(
	config: AppConfig,
	name: string,
): { readonly canonicalName: string; readonly target: HostAliasConfig } {
	assertHostAliasName(name);
	const canonicalName = findHostAliasName(config, name);
	if (!canonicalName) {
		throw new HostAliasResolutionError('unknown', `Host alias '@${name}' does not exist`);
	}
	return { canonicalName, target: config.hostAliases[canonicalName] };
}

function findHostAliasName(config: AppConfig, name: string): string | undefined {
	return Object.keys(config.hostAliases).find(candidate => candidate.toLowerCase() === name.toLowerCase());
}

function resolveConfiguredTarget(name: string, target: HostAliasConfig): Promise<AgentHostConnectionTarget> {
	switch (target.kind) {
		case 'vscode-local':
			return resolveVsCodeTarget(name, target);
		case 'websocket':
			return resolveWebSocketTarget(name, target);
		case 'socket':
			return resolveSocketTarget(name, target);
	}
}

async function resolveVsCodeTarget(
	name: string,
	target: VsCodeLocalHostAliasConfig,
): Promise<AgentHostEndpoint> {
	let endpoints: readonly AgentHostEndpoint[];
	try {
		endpoints = await discoverAgentHostsInRegistryDirectories([target.registry]);
	} catch (error) {
		throw new HostAliasResolutionError(
			'unavailable',
			`Host alias '@${name}' could not read its VS Code endpoint registry`,
			{ cause: error },
		);
	}
	const matches = endpoints.filter(endpoint => matchesVsCodeTarget(endpoint, target));
	if (matches.length === 0) {
		throw new HostAliasResolutionError(
			'unavailable',
			`Host alias '@${name}' has no live endpoint in its configured VS Code registry`,
		);
	}
	if (matches.length > 1) {
		throw new HostAliasResolutionError(
			'ambiguous',
			`Host alias '@${name}' matches ${matches.length} live endpoints: ${matches.map(endpoint => endpoint.id).join(', ')}`,
		);
	}
	return matches[0];
}

function matchesVsCodeTarget(endpoint: AgentHostEndpoint, target: VsCodeLocalHostAliasConfig): boolean {
	return dirname(endpoint.registryFile) === target.registry
		&& endpoint.type === target.hostType
		&& (target.quality === undefined || endpoint.quality === target.quality);
}

async function resolveWebSocketTarget(
	name: string,
	target: WebSocketHostAliasConfig,
): Promise<AgentHostConnectionTarget> {
	return {
		id: formatHostAliasSelector(name),
		endpoint: { type: 'websocket', url: target.url },
		...await resolveAuthentication(name, target),
	};
}

async function resolveSocketTarget(
	name: string,
	target: SocketHostAliasConfig,
): Promise<AgentHostConnectionTarget> {
	return {
		id: formatHostAliasSelector(name),
		endpoint: { type: 'socket', path: target.path },
		...await resolveAuthentication(name, target),
	};
}

async function resolveAuthentication(
	name: string,
	target: WebSocketHostAliasConfig | SocketHostAliasConfig,
): Promise<{
	readonly connectionToken?: string;
	readonly connectionTokenQueryParameter?: string;
}> {
	if (target.withoutAuthentication) {
		return {};
	}
	let token: string;
	try {
		token = (await readFile(target.tokenFile, 'utf8')).trim();
	} catch (error) {
		throw new HostAliasResolutionError(
			'unavailable',
			`Host alias '@${name}' could not read its token file '${target.tokenFile}'`,
			{ cause: error },
		);
	}
	if (token.length === 0) {
		throw new HostAliasResolutionError(
			'unavailable',
			`Host alias '@${name}' has an empty token file '${target.tokenFile}'`,
		);
	}
	return {
		connectionToken: token,
		connectionTokenQueryParameter: target.tokenQueryParameter,
	};
}

function describeAliasTarget(target: HostAliasConfig): Record<string, unknown> {
	switch (target.kind) {
		case 'vscode-local':
			return {
				registry: target.registry,
				hostType: target.hostType,
				...(target.quality ? { quality: target.quality } : {}),
			};
		case 'websocket':
			return {
				url: target.url,
				...(target.tokenFile
					? {
						tokenFile: target.tokenFile,
						tokenQueryParameter: target.tokenQueryParameter,
					}
					: { authentication: 'disabled' }),
			};
		case 'socket':
			return {
				path: target.path,
				...(target.tokenFile
					? {
						tokenFile: target.tokenFile,
						tokenQueryParameter: target.tokenQueryParameter,
					}
					: { authentication: 'disabled' }),
			};
	}
}

function describeConnectionTarget(target: AgentHostConnectionTarget): Record<string, unknown> {
	if (isDiscoveredEndpoint(target)) {
		return describeEndpoint(target);
	}
	return {
		id: target.id,
		endpoint: target.endpoint.type === 'websocket'
			? target.endpoint.url
			: target.endpoint.type === 'socket'
				? target.endpoint.path
				: `${target.endpoint.host}:${target.endpoint.port}`,
	};
}

function isDiscoveredEndpoint(target: AgentHostConnectionTarget): target is AgentHostEndpoint {
	return 'registryFile' in target;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
