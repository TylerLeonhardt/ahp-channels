import {
	CustomizationEnablementKind,
	CustomizationType,
	type ClientPluginCustomization,
} from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigStore, type AppConfig, type InstalledPluginConfig } from './config.js';
import { runProcess } from './process.js';

const MARKETPLACE_MANIFESTS = [
	'marketplace.json',
	'.plugin/marketplace.json',
	'.github/plugin/marketplace.json',
	'.claude-plugin/marketplace.json',
] as const;

export interface MarketplacePlugin {
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly source: string;
}

export interface StdioMcpServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface ClaudePlugin {
	readonly name: string;
	readonly path: string;
	readonly description?: string;
	readonly version?: string;
	readonly servers: Readonly<Record<string, StdioMcpServerConfig>>;
}

export interface ResolvedPluginServer {
	readonly name: string;
	readonly config: StdioMcpServerConfig;
}

export class PluginManager {
	constructor(private readonly store: ConfigStore) { }

	async addMarketplace(name: string, source: string): Promise<void> {
		assertSafeName(name, 'marketplace');
		await this.store.update(config => ({
			...config,
			marketplaces: {
				...config.marketplaces,
				[name]: { source },
			},
		}));
	}

	async install(spec: string): Promise<ClaudePlugin> {
		const { pluginName, marketplaceName } = parsePluginSpec(spec);
		const config = await this.store.read();
		const marketplace = config.marketplaces[marketplaceName];
		if (!marketplace) {
			throw new Error(`Unknown marketplace '${marketplaceName}'`);
		}

		const marketplacePath = await this.ensureMarketplace(marketplaceName, marketplace.source);
		const plugins = await readMarketplacePlugins(marketplacePath);
		const descriptor = plugins.find(plugin => plugin.name === pluginName);
		if (!descriptor) {
			throw new Error(`Plugin '${pluginName}' was not found in marketplace '${marketplaceName}'`);
		}

		const pluginPath = resolveMarketplacePluginPath(marketplacePath, descriptor);
		const plugin = await inspectPlugin(pluginPath);
		await this.store.update(current => ({
			...current,
			plugins: {
				...current.plugins,
				[pluginName]: {
					marketplace: marketplaceName,
					path: pluginPath,
					...(plugin.version ? { version: plugin.version } : {}),
				},
			},
		}));
		return plugin;
	}

	async resolvePlugin(nameOrPath: string): Promise<ClaudePlugin> {
		if (isAbsolute(nameOrPath) || nameOrPath.startsWith('.')) {
			return inspectPlugin(resolve(nameOrPath));
		}
		const installed = (await this.store.read()).plugins[nameOrPath];
		if (!installed) {
			throw new Error(`Plugin '${nameOrPath}' is not installed`);
		}
		return inspectPlugin(installed.path);
	}

	private async ensureMarketplace(name: string, source: string): Promise<string> {
		const localSource = resolveLocalSource(source);
		if (localSource) {
			return localSource;
		}

		const target = join(this.store.home, 'marketplaces', name);
		try {
			const targetStat = await stat(target);
			if (!targetStat.isDirectory()) {
				throw new Error(`Marketplace cache exists but is not a directory: ${target}`);
			}
			return target;
		} catch (error) {
			if (!isNodeError(error) || error.code !== 'ENOENT') {
				throw error;
			}
		}

		await mkdir(join(this.store.home, 'marketplaces'), { recursive: true });
		await runProcess('git', ['clone', '--depth', '1', normalizeGitSource(source), target]);
		return target;
	}
}

export async function readMarketplacePlugins(marketplacePath: string): Promise<readonly MarketplacePlugin[]> {
	for (const relativePath of MARKETPLACE_MANIFESTS) {
		const manifestPath = join(marketplacePath, ...relativePath.split('/'));
		try {
			const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
			if (!isRecord(value) || !Array.isArray(value['plugins'])) {
				throw new Error(`Invalid marketplace manifest: ${manifestPath}`);
			}
			return value['plugins'].flatMap(entry => {
				const plugin = parseMarketplacePlugin(entry);
				return plugin ? [plugin] : [];
			});
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				continue;
			}
			throw error;
		}
	}
	throw new Error(`No supported marketplace manifest found in ${marketplacePath}`);
}

export async function inspectPlugin(pluginPath: string): Promise<ClaudePlugin> {
	const pluginManifestPath = join(pluginPath, '.claude-plugin', 'plugin.json');
	let manifest: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(await readFile(pluginManifestPath, 'utf8'));
		if (!isRecord(value)) {
			throw new Error(`Invalid Claude plugin manifest: ${pluginManifestPath}`);
		}
		manifest = value;
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	const mcpPath = join(pluginPath, '.mcp.json');
	const mcpValue: unknown = JSON.parse(await readFile(mcpPath, 'utf8'));
	if (!isRecord(mcpValue) || !isRecord(mcpValue['mcpServers'])) {
		throw new Error(`Invalid MCP configuration: ${mcpPath}`);
	}

	const servers: Record<string, StdioMcpServerConfig> = {};
	for (const [name, value] of Object.entries(mcpValue['mcpServers'])) {
		servers[name] = parseStdioServer(value, mcpPath);
	}
	if (Object.keys(servers).length === 0) {
		throw new Error(`Plugin contains no MCP servers: ${pluginPath}`);
	}

	return {
		name: typeof manifest['name'] === 'string' ? manifest['name'] : basename(pluginPath),
		path: pluginPath,
		...(typeof manifest['description'] === 'string' ? { description: manifest['description'] } : {}),
		...(typeof manifest['version'] === 'string' ? { version: manifest['version'] } : {}),
		servers,
	};
}

export function resolveServerConfig(plugin: ClaudePlugin, serverName?: string): StdioMcpServerConfig {
	return resolvePluginServer(plugin, serverName).config;
}

export function resolvePluginServer(plugin: ClaudePlugin, serverName?: string): ResolvedPluginServer {
	const selectedName = serverName ?? (Object.keys(plugin.servers).length === 1 ? Object.keys(plugin.servers)[0] : undefined);
	if (!selectedName) {
		throw new Error(`Plugin '${plugin.name}' has multiple MCP servers; specify one of: ${Object.keys(plugin.servers).join(', ')}`);
	}
	const server = plugin.servers[selectedName];
	if (!server) {
		throw new Error(`Plugin '${plugin.name}' has no MCP server named '${selectedName}'`);
	}
	return {
		name: selectedName,
		config: expandServerConfig(server, plugin.path),
	};
}

export function listInstalledPlugins(config: AppConfig): ReadonlyArray<[string, InstalledPluginConfig]> {
	return Object.entries(config.plugins).sort(([a], [b]) => a.localeCompare(b));
}

export function createPluginCustomization(
	plugin: ClaudePlugin,
	clientId: string,
	proxiedServerName: string,
): ClientPluginCustomization {
	if (!plugin.servers[proxiedServerName]) {
		throw new Error(`Plugin '${plugin.name}' has no MCP server named '${proxiedServerName}'`);
	}
	return {
		type: CustomizationType.Plugin,
		id: `${clientId}:plugin:${plugin.name}`,
		uri: pathToFileURL(plugin.path).href,
		name: plugin.name,
		...(plugin.version ? { version: plugin.version } : {}),
		enablement: [{
			kind: CustomizationEnablementKind.Global,
			enabled: true,
		}],
		nonce: randomUUID(),
		childEnablement: {
			[proxiedServerName]: [{
				kind: CustomizationEnablementKind.Global,
				enabled: false,
			}],
		},
	};
}

function parsePluginSpec(spec: string): { pluginName: string; marketplaceName: string } {
	const separator = spec.lastIndexOf('@');
	if (separator <= 0 || separator === spec.length - 1) {
		throw new Error(`Plugin must be written as <name>@<marketplace>: ${spec}`);
	}
	const pluginName = spec.slice(0, separator);
	const marketplaceName = spec.slice(separator + 1);
	assertSafeName(pluginName, 'plugin');
	assertSafeName(marketplaceName, 'marketplace');
	return { pluginName, marketplaceName };
}

function parseMarketplacePlugin(value: unknown): MarketplacePlugin | undefined {
	if (!isRecord(value) || typeof value['name'] !== 'string') {
		return undefined;
	}
	if (typeof value['source'] !== 'string') {
		return undefined;
	}
	return {
		name: value['name'],
		source: value['source'],
		...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
		...(typeof value['version'] === 'string' ? { version: value['version'] } : {}),
	};
}

function resolveMarketplacePluginPath(marketplacePath: string, plugin: MarketplacePlugin): string {
	if (!plugin.source.startsWith('./') && !plugin.source.startsWith('../')) {
		throw new Error(`Plugin '${plugin.name}' does not use a relative marketplace source`);
	}
	const resolved = resolve(marketplacePath, plugin.source);
	const relativePath = relative(resolve(marketplacePath), resolved);
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
		throw new Error(`Plugin '${plugin.name}' resolves outside its marketplace`);
	}
	return resolved;
}

function parseStdioServer(value: unknown, source: string): StdioMcpServerConfig {
	if (!isRecord(value) || typeof value['command'] !== 'string') {
		throw new Error(`Only stdio MCP servers are supported in ${source}`);
	}
	const args = value['args'];
	const env = value['env'];
	return {
		command: value['command'],
		args: Array.isArray(args) && args.every(item => typeof item === 'string') ? args : [],
		...(typeof value['cwd'] === 'string' ? { cwd: value['cwd'] } : {}),
		...(isStringRecord(env) ? { env } : {}),
	};
}

function expandServerConfig(server: StdioMcpServerConfig, pluginPath: string): StdioMcpServerConfig {
	const expand = (value: string) => value
		.replaceAll('${CLAUDE_PLUGIN_ROOT}/', `${pluginPath}${sep}`)
		.replaceAll('${PLUGIN_ROOT}/', `${pluginPath}${sep}`)
		.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginPath)
		.replaceAll('${PLUGIN_ROOT}', pluginPath);
	return {
		command: expand(server.command),
		args: server.args.map(expand),
		...(server.cwd ? { cwd: expand(server.cwd) } : {}),
		...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])) } : {}),
	};
}

function resolveLocalSource(source: string): string | undefined {
	if (source.startsWith('file://')) {
		return fileURLToPath(source);
	}
	if (isAbsolute(source) || source.startsWith('.')) {
		return resolve(source);
	}
	return undefined;
}

function normalizeGitSource(source: string): string {
	if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
		return `https://github.com/${source}.git`;
	}
	if (/^(?:https?|ssh|git):/.test(source) || source.startsWith('git@')) {
		return source;
	}
	throw new Error(`Unsupported marketplace source: ${source}`);
}

function assertSafeName(value: string, kind: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error(`Invalid ${kind} name: ${value}`);
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
