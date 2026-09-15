import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

export const CONFIG_VERSION = 2;
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official';
export const OFFICIAL_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official';
const CHANNEL_INSTANCE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface MarketplaceConfig {
	readonly source: string;
}

export interface InstalledPluginConfig {
	readonly marketplace: string;
	readonly path: string;
	readonly version?: string;
}

export interface ChannelInstanceConfig {
	readonly plugin: string;
	readonly session: string;
	readonly enabled: boolean;
	readonly chat?: string;
	readonly server?: string;
	readonly host?: string;
	readonly clientId?: string;
}

export interface AppConfig {
	readonly version: typeof CONFIG_VERSION;
	readonly marketplaces: Record<string, MarketplaceConfig>;
	readonly plugins: Record<string, InstalledPluginConfig>;
	readonly channels: Record<string, ChannelInstanceConfig>;
}

export function getAppHome(env: NodeJS.ProcessEnv = process.env): string {
	return env['AHP_CHANNELS_HOME'] ?? join(homedir(), '.ahp-channels');
}

export function isValidChannelInstanceName(name: string): boolean {
	return CHANNEL_INSTANCE_NAME.test(name) && !WINDOWS_RESERVED_NAME.test(name);
}

export function retargetChannelInstance(
	definition: ChannelInstanceConfig,
	session: string,
	chat?: string,
): ChannelInstanceConfig {
	return {
		plugin: definition.plugin,
		session,
		enabled: definition.enabled,
		...(chat ? { chat } : {}),
		...(definition.server ? { server: definition.server } : {}),
		...(definition.host ? { host: definition.host } : {}),
		...(definition.clientId ? { clientId: definition.clientId } : {}),
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
		return parseConfig(value);
	}

	async update(change: (config: AppConfig) => AppConfig): Promise<AppConfig> {
		return withFileLock(this.configPath, async () => {
			const updated = change(await this.read());
			await this.write(updated);
			return updated;
		});
	}

	async write(config: AppConfig): Promise<void> {
		await writeFileAtomic(this.configPath, `${JSON.stringify(config, undefined, 2)}\n`);
	}

}

function parseConfig(value: unknown): AppConfig {
	if (!isRecord(value) || value['version'] !== CONFIG_VERSION) {
		throw new Error(`Unsupported ahp-channels config version in ${JSON.stringify(value)}`);
	}
	return {
		version: CONFIG_VERSION,
		marketplaces: parseRecord(value['marketplaces'], parseMarketplace),
		plugins: parseRecord(value['plugins'], parseInstalledPlugin),
		channels: parseChannelRecord(value['channels']),
	};
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
		|| typeof value['path'] !== 'string'
		|| (value['version'] !== undefined && typeof value['version'] !== 'string')) {
		throw new Error('Invalid installed plugin configuration');
	}
	return {
		marketplace: value['marketplace'],
		path: value['path'],
		...(value['version'] ? { version: value['version'] } : {}),
	};
}

function parseChannelInstance(value: unknown): ChannelInstanceConfig {
	if (!isRecord(value)
		|| typeof value['plugin'] !== 'string'
		|| typeof value['session'] !== 'string'
		|| typeof value['enabled'] !== 'boolean'
		|| !isOptionalString(value['chat'])
		|| !isOptionalString(value['server'])
		|| !isOptionalString(value['host'])
		|| !isOptionalString(value['clientId'])) {
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
	};
}

function parseRecord<T>(value: unknown, parse: (entry: unknown) => T): Record<string, T> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, T> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = parse(entry);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
