import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_VERSION = 1;
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official';
export const OFFICIAL_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official';

export interface MarketplaceConfig {
	readonly source: string;
}

export interface InstalledPluginConfig {
	readonly marketplace: string;
	readonly path: string;
	readonly version?: string;
}

export interface AppConfig {
	readonly version: typeof CONFIG_VERSION;
	readonly marketplaces: Record<string, MarketplaceConfig>;
	readonly plugins: Record<string, InstalledPluginConfig>;
}

export function getAppHome(env: NodeJS.ProcessEnv = process.env): string {
	return env['AHP_CHANNELS_HOME'] ?? join(homedir(), '.ahp-channels');
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
		const updated = change(await this.read());
		await this.write(updated);
		return updated;
	}

	async write(config: AppConfig): Promise<void> {
		await mkdir(dirname(this.configPath), { recursive: true });
		const temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(config, undefined, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(temporaryPath, this.configPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
