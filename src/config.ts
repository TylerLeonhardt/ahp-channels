import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

export const CONFIG_VERSION = 4;
const LEGACY_CONFIG_VERSION = 3;
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official';
export const OFFICIAL_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official';
const CHANNEL_INSTANCE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PLUGIN_INSTALLATION_ID = /^[a-f0-9]{64}$/;
const TOKEN_QUERY_PARAMETER = /^[A-Za-z][A-Za-z0-9._~-]*$/;
const SENSITIVE_URL_PARAMETER = /^(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|key|password|secret|sig(?:nature)?|tkn|token)$/i;

export interface MarketplaceConfig {
	readonly source: string;
}

export interface PluginInstallationConfig {
	readonly source: string;
	readonly version?: string;
	readonly marketplaceRevision?: string;
}

export interface InstalledPluginConfig {
	readonly marketplace: string;
	readonly activeInstallation: string;
	readonly installations: Readonly<Record<string, PluginInstallationConfig>>;
}

export interface ChannelInstanceConfig {
	readonly plugin: string;
	readonly session: string;
	readonly enabled: boolean;
	readonly chat?: string;
	readonly server?: string;
	readonly host?: string;
	readonly clientId?: string;
	readonly installation?: string;
}

export interface ChannelBindingSelection {
	readonly host?: string | null;
	readonly session: string;
	readonly chat?: string;
}

export interface VsCodeLocalHostAliasConfig {
	readonly kind: 'vscode-local';
	readonly registry: string;
	readonly hostType: 'editor' | 'standalone';
	readonly quality?: string;
}

interface AuthenticatedHostAliasConfig {
	readonly tokenFile: string;
	readonly tokenQueryParameter: string;
	readonly withoutAuthentication?: never;
}

interface UnauthenticatedHostAliasConfig {
	readonly tokenFile?: never;
	readonly tokenQueryParameter?: never;
	readonly withoutAuthentication: true;
}

export type WebSocketHostAliasConfig = {
	readonly kind: 'websocket';
	readonly url: string;
} & (AuthenticatedHostAliasConfig | UnauthenticatedHostAliasConfig);

export type SocketHostAliasConfig = {
	readonly kind: 'socket';
	readonly path: string;
} & (AuthenticatedHostAliasConfig | UnauthenticatedHostAliasConfig);

export type HostAliasConfig =
	| VsCodeLocalHostAliasConfig
	| WebSocketHostAliasConfig
	| SocketHostAliasConfig;

export interface AppConfig {
	readonly version: typeof CONFIG_VERSION;
	readonly marketplaces: Record<string, MarketplaceConfig>;
	readonly plugins: Record<string, InstalledPluginConfig>;
	readonly hostAliases: Record<string, HostAliasConfig>;
	readonly channels: Record<string, ChannelInstanceConfig>;
}

export function getAppHome(env: NodeJS.ProcessEnv = process.env): string {
	return env['AHP_CHANNELS_HOME'] ?? join(homedir(), '.ahp-channels');
}

export function isValidChannelInstanceName(name: string): boolean {
	return CHANNEL_INSTANCE_NAME.test(name) && !WINDOWS_RESERVED_NAME.test(name);
}

export function isValidHostAliasName(name: string): boolean {
	return isValidChannelInstanceName(name);
}

export function isValidPluginInstallationId(id: string): boolean {
	return PLUGIN_INSTALLATION_ID.test(id);
}

export function retargetChannelInstance(
	definition: ChannelInstanceConfig,
	session: string,
	chat?: string,
): ChannelInstanceConfig {
	return rebindChannelInstance(definition, { session, ...(chat ? { chat } : {}) });
}

export function rebindChannelInstance(
	definition: ChannelInstanceConfig,
	target: ChannelBindingSelection,
): ChannelInstanceConfig {
	const host = target.host === null ? undefined : target.host ?? definition.host;
	return {
		plugin: definition.plugin,
		session: target.session,
		enabled: definition.enabled,
		...(target.chat ? { chat: target.chat } : {}),
		...(definition.server ? { server: definition.server } : {}),
		...(host ? { host } : {}),
		...(definition.clientId ? { clientId: definition.clientId } : {}),
		...(definition.installation ? { installation: definition.installation } : {}),
	};
}

export function defaultConfig(): AppConfig {
	return {
		version: CONFIG_VERSION,
		marketplaces: {
			[OFFICIAL_MARKETPLACE_NAME]: {
				source: OFFICIAL_MARKETPLACE_SOURCE,
			},
		},
		plugins: {},
		hostAliases: {},
		channels: {},
	};
}

export class ConfigStore {
	readonly configPath: string;

	constructor(readonly home: string = getAppHome()) {
		this.configPath = join(home, 'config.json');
	}

	async read(): Promise<AppConfig> {
		let raw: string;
		try {
			raw = await readFile(this.configPath, 'utf8');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				return defaultConfig();
			}
			throw error;
		}

		const value: unknown = JSON.parse(raw);
		return validateAppConfig(value);
	}

	async update(change: (config: AppConfig) => AppConfig): Promise<AppConfig> {
		return withFileLock(this.configPath, async () => {
			const updated = change(await this.read());
			await this.write(updated);
			return updated;
		});
	}

	async write(config: AppConfig): Promise<void> {
		const parsed = validateAppConfig(config);
		await writeFileAtomic(this.configPath, `${JSON.stringify(parsed, undefined, 2)}\n`);
	}

}

export function validateAppConfig(value: unknown): AppConfig {
	const config = parseConfig(value);
	validateReferences(config);
	return config;
}

function parseConfig(value: unknown): AppConfig {
	if (!isRecord(value)
		|| (value['version'] !== CONFIG_VERSION && value['version'] !== LEGACY_CONFIG_VERSION)) {
		const version = isRecord(value) ? value['version'] : undefined;
		throw new Error(`Unsupported ahp-channels config version '${String(version)}'`);
	}
	const marketplaces = parseNamedRecord(value['marketplaces'], 'marketplace', parseMarketplace);
	const plugins = parseNamedRecord(value['plugins'], 'plugin', parseInstalledPlugin);
	return {
		version: CONFIG_VERSION,
		marketplaces,
		plugins,
		hostAliases: value['version'] === LEGACY_CONFIG_VERSION
			? {}
			: parseHostAliasRecord(value['hostAliases']),
		channels: parseChannelRecord(value['channels']),
	};
}

function validateReferences(config: AppConfig): void {
	for (const [name, plugin] of Object.entries(config.plugins)) {
		if (!config.marketplaces[plugin.marketplace]) {
			throw new Error(`Plugin '${name}' references unknown marketplace '${plugin.marketplace}'`);
		}
	}
	for (const [name, channel] of Object.entries(config.channels)) {
		const alias = channel.host && hostAliasNameFromSelector(channel.host);
		if (alias && !findHostAliasName(config, alias)) {
			throw new Error(`Channel '${name}' references unknown host alias '@${alias}'`);
		}
		if (!channel.installation) {
			continue;
		}
		const plugin = config.plugins[channel.plugin];
		if (!plugin?.installations[channel.installation]) {
			throw new Error(
				`Channel '${name}' references missing ${channel.plugin} installation '${channel.installation}'`,
			);
		}
	}
}

function parseMarketplace(value: unknown): MarketplaceConfig {
	if (!isRecord(value) || typeof value['source'] !== 'string') {
		throw new Error('Invalid marketplace configuration');
	}
	return { source: value['source'] };
}

function parseInstalledPlugin(value: unknown): InstalledPluginConfig {
	if (!isRecord(value)
		|| typeof value['marketplace'] !== 'string'
		|| !isValidChannelInstanceName(value['marketplace'])
		|| typeof value['activeInstallation'] !== 'string'
		|| !isValidPluginInstallationId(value['activeInstallation'])
		|| !isRecord(value['installations'])) {
		throw new Error('Invalid installed plugin configuration');
	}
	const installations: Record<string, PluginInstallationConfig> = {};
	for (const [id, installation] of Object.entries(value['installations'])) {
		if (!isValidPluginInstallationId(id)) {
			throw new Error(`Invalid plugin installation ID '${id}'`);
		}
		installations[id] = parsePluginInstallation(installation);
	}
	if (!installations[value['activeInstallation']]) {
		throw new Error(`Active plugin installation '${value['activeInstallation']}' does not exist`);
	}
	return {
		marketplace: value['marketplace'],
		activeInstallation: value['activeInstallation'],
		installations,
	};
}

function parsePluginInstallation(value: unknown): PluginInstallationConfig {
	if (!isRecord(value)
		|| typeof value['source'] !== 'string'
		|| value['source'].length === 0
		|| (value['version'] !== undefined && typeof value['version'] !== 'string')
		|| (value['marketplaceRevision'] !== undefined
			&& (typeof value['marketplaceRevision'] !== 'string'
				|| !/^[a-f0-9]{40,64}$/i.test(value['marketplaceRevision'])))) {
		throw new Error('Invalid plugin installation');
	}
	return {
		source: value['source'],
		...(value['version'] ? { version: value['version'] } : {}),
		...(value['marketplaceRevision'] ? { marketplaceRevision: value['marketplaceRevision'] } : {}),
	};
}

function parseChannelInstance(value: unknown): ChannelInstanceConfig {
	if (!isRecord(value)
		|| typeof value['plugin'] !== 'string'
		|| (!isAbsolute(value['plugin']) && !isValidChannelInstanceName(value['plugin']))
		|| typeof value['session'] !== 'string'
		|| typeof value['enabled'] !== 'boolean'
		|| !isOptionalString(value['chat'])
		|| !isOptionalString(value['server'])
		|| !isOptionalString(value['host'])
		|| !isOptionalString(value['clientId'])
		|| !isOptionalInstallation(value['installation'])
		|| (isAbsolute(value['plugin']) && value['installation'] !== undefined)) {
		throw new Error('Invalid channel instance configuration');
	}
	return {
		plugin: value['plugin'],
		session: value['session'],
		enabled: value['enabled'],
		...(value['chat'] ? { chat: value['chat'] } : {}),
		...(value['server'] ? { server: value['server'] } : {}),
		...(value['host'] ? { host: value['host'] } : {}),
		...(value['clientId'] ? { clientId: value['clientId'] } : {}),
		...(value['installation'] ? { installation: value['installation'] } : {}),
	};
}

function parseHostAlias(value: unknown): HostAliasConfig {
	if (!isRecord(value)) {
		throw new Error('Invalid host alias configuration');
	}
	if (value['kind'] === 'vscode-local') {
		if (typeof value['registry'] !== 'string'
			|| !isAbsolute(value['registry'])
			|| (value['hostType'] !== 'editor' && value['hostType'] !== 'standalone')
			|| !isOptionalNonemptyString(value['quality'])) {
			throw new Error('Invalid VS Code local host alias configuration');
		}
		return {
			kind: 'vscode-local',
			registry: value['registry'],
			hostType: value['hostType'],
			...(value['quality'] ? { quality: value['quality'] } : {}),
		};
	}
	if (value['kind'] === 'websocket') {
		const authentication = parseHostAuthentication(value);
		if (typeof value['url'] !== 'string'
			|| !isValidLocalWebSocketUrl(value['url'], authentication.tokenQueryParameter)) {
			throw new Error('Invalid local WebSocket host alias URL');
		}
		return {
			kind: 'websocket',
			url: value['url'],
			...authentication,
		};
	}
	if (value['kind'] === 'socket') {
		if (typeof value['path'] !== 'string' || !isAbsolute(value['path'])) {
			throw new Error('Invalid local socket host alias path');
		}
		return {
			kind: 'socket',
			path: value['path'],
			...parseHostAuthentication(value),
		};
	}
	throw new Error('Invalid host alias kind');
}

function parseHostAuthentication(
	value: Record<string, unknown>,
): AuthenticatedHostAliasConfig | UnauthenticatedHostAliasConfig {
	if (typeof value['tokenFile'] === 'string'
		&& isAbsolute(value['tokenFile'])
		&& typeof value['tokenQueryParameter'] === 'string'
		&& TOKEN_QUERY_PARAMETER.test(value['tokenQueryParameter'])
		&& value['withoutAuthentication'] === undefined) {
		return {
			tokenFile: value['tokenFile'],
			tokenQueryParameter: value['tokenQueryParameter'],
		};
	}
	if (value['tokenFile'] === undefined
		&& value['tokenQueryParameter'] === undefined
		&& value['withoutAuthentication'] === true) {
		return { withoutAuthentication: true };
	}
	throw new Error(
		'Host alias must configure an absolute token file and token query parameter, or explicitly disable authentication',
	);
}

function parseNamedRecord<T>(
	value: unknown,
	label: string,
	parse: (entry: unknown) => T,
): Record<string, T> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isValidChannelInstanceName(key)) {
			throw new Error(`Invalid ${label} name '${key}' in configuration`);
		}
		result[key] = parse(entry);
	}
	return result;
}

function parseHostAliasRecord(value: unknown): Record<string, HostAliasConfig> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, HostAliasConfig> = {};
	const canonicalNames = new Set<string>();
	for (const [name, entry] of Object.entries(value)) {
		if (!isValidHostAliasName(name)) {
			throw new Error(`Invalid host alias name '${name}' in configuration`);
		}
		const canonical = name.toLowerCase();
		if (canonicalNames.has(canonical)) {
			throw new Error(`Duplicate host alias name '${name}' differs only by case`);
		}
		canonicalNames.add(canonical);
		result[name] = parseHostAlias(entry);
	}
	return result;
}

function parseChannelRecord(value: unknown): Record<string, ChannelInstanceConfig> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, ChannelInstanceConfig> = {};
	const canonicalNames = new Set<string>();
	for (const [name, entry] of Object.entries(value)) {
		if (!isValidChannelInstanceName(name)) {
			throw new Error(`Invalid channel name '${name}' in configuration`);
		}
		const canonical = name.toLowerCase();
		if (canonicalNames.has(canonical)) {
			throw new Error(`Duplicate channel name '${name}' differs only by case`);
		}
		canonicalNames.add(canonical);
		result[name] = parseChannelInstance(entry);
	}
	return result;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function isOptionalNonemptyString(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isOptionalInstallation(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === 'string' && isValidPluginInstallationId(value));
}

function isValidLocalWebSocketUrl(value: string, tokenQueryParameter?: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if ((url.protocol !== 'ws:' && url.protocol !== 'wss:')
		|| url.username.length > 0
		|| url.password.length > 0
		|| url.hash.length > 0
		|| !isLoopbackHostname(url.hostname)
		|| (tokenQueryParameter !== undefined && url.searchParams.has(tokenQueryParameter))) {
		return false;
	}
	return [...url.searchParams.keys()].every(name => !SENSITIVE_URL_PARAMETER.test(name));
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
		return true;
	}
	if (normalized === '[::1]' || normalized === '::1') {
		return true;
	}
	const octets = normalized.split('.');
	return octets.length === 4
		&& octets[0] === '127'
		&& octets.every(octet => /^(?:0|[1-9][0-9]{0,2})$/.test(octet)
			&& Number(octet) <= 255);
}

function hostAliasNameFromSelector(selector: string): string | undefined {
	return selector.startsWith('@') ? selector.slice(1) : undefined;
}

function findHostAliasName(config: AppConfig, name: string): string | undefined {
	return Object.keys(config.hostAliases).find(candidate => candidate.toLowerCase() === name.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
