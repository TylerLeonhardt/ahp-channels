import {
	CustomizationEnablementKind,
	CustomizationType,
	type ClientPluginCustomization,
} from '@microsoft/agent-host-protocol';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	ConfigStore,
	isValidChannelInstanceName,
	type AppConfig,
	type ChannelInstanceConfig,
	type InstalledPluginConfig,
	type PluginInstallationConfig,
} from './config.js';
import {
	installPluginSnapshot,
	removePluginInstallation,
} from './pluginInstallations.js';
import { runProcess, runProcessOutput } from './process.js';

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

export interface InstalledPluginResult {
	readonly plugin: ClaudePlugin;
	readonly installation: string;
	readonly config: PluginInstallationConfig;
	readonly created: boolean;
}

export interface PluginReference {
	readonly plugin: string;
	readonly installation?: string;
}

export interface PluginVersion {
	readonly id: string;
	readonly active: boolean;
	readonly config: PluginInstallationConfig;
	readonly channels: readonly string[];
}

export interface RemovedPluginInstallation {
	readonly marketplace: string;
	readonly plugin: string;
	readonly installation: string;
	readonly path: string;
	readonly config: PluginInstallationConfig;
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

	async install(spec: string): Promise<InstalledPluginResult> {
		const { pluginName, marketplaceName } = parsePluginSpec(spec);
		const config = await this.store.read();
		if (config.plugins[pluginName]) {
			throw new Error(`Plugin '${pluginName}' is already installed; use plugin upgrade`);
		}
		const marketplace = config.marketplaces[marketplaceName];
		if (!marketplace) {
			throw new Error(`Unknown marketplace '${marketplaceName}'`);
		}
		const marketplacePath = await this.updateMarketplace(marketplaceName);
		return this.installFromMarketplace(pluginName, marketplaceName, marketplacePath);
	}

	async upgrade(pluginName: string): Promise<InstalledPluginResult> {
		const installed = await this.getInstalledPlugin(pluginName);
		const marketplacePath = await this.updateMarketplace(installed.marketplace);
		return this.installFromMarketplace(pluginName, installed.marketplace, marketplacePath);
	}

	async updateMarketplace(name: string): Promise<string> {
		const marketplace = (await this.store.read()).marketplaces[name];
		if (!marketplace) {
			throw new Error(`Unknown marketplace '${name}'`);
		}
		const marketplacePath = await this.ensureMarketplace(name, marketplace.source);
		if (!resolveLocalSource(marketplace.source)) {
			await runProcess('git', ['-C', marketplacePath, 'pull', '--ff-only']);
		}
		return marketplacePath;
	}

	async activate(pluginName: string, installation: string): Promise<PluginInstallationConfig> {
		const installed = await this.getInstalledPlugin(pluginName);
		const candidate = installed.installations[installation];
		if (!candidate) {
			throw new Error(`Plugin '${pluginName}' has no installation '${installation}'`);
		}
		await inspectPlugin(candidate.path);
		let result: PluginInstallationConfig | undefined;
		await this.store.update(config => {
			const plugin = config.plugins[pluginName];
			const selected = plugin?.installations[installation];
			if (!plugin || !selected) {
				throw new Error(`Plugin '${pluginName}' has no installation '${installation}'`);
			}
			result = selected;
			return {
				...config,
				plugins: {
					...config.plugins,
					[pluginName]: {
						...plugin,
						activeInstallation: installation,
					},
				},
			};
		});
		if (!result) {
			throw new Error(`Failed to activate plugin '${pluginName}' installation '${installation}'`);
		}
		return result;
	}

	async pinPlugin(nameOrPath: string, installation?: string): Promise<PluginReference> {
		if (isPluginPath(nameOrPath)) {
			if (installation) {
				throw new Error('An installation ID cannot be used with a plugin path');
			}
			const path = resolve(nameOrPath);
			await inspectPlugin(path);
			return { plugin: path };
		}
		const installed = await this.getInstalledPlugin(nameOrPath);
		const selected = installation ?? installed.activeInstallation;
		if (!installed.installations[selected]) {
			throw new Error(`Plugin '${nameOrPath}' has no installation '${selected}'`);
		}
		return { plugin: nameOrPath, installation: selected };
	}

	async resolvePlugin(nameOrPath: string, installation?: string): Promise<ClaudePlugin> {
		if (isPluginPath(nameOrPath)) {
			if (installation) {
				throw new Error('An installation ID cannot be used with a plugin path');
			}
			return inspectPlugin(resolve(nameOrPath));
		}
		const installed = await this.getInstalledPlugin(nameOrPath);
		const selected = installation ?? installed.activeInstallation;
		const version = installed.installations[selected];
		if (!version) {
			throw new Error(`Plugin '${nameOrPath}' has no installation '${selected}'`);
		}
		return inspectPlugin(version.path);
	}

	async versions(pluginName: string): Promise<readonly PluginVersion[]> {
		const config = await this.store.read();
		const plugin = config.plugins[pluginName];
		if (!plugin) {
			throw new Error(`Plugin '${pluginName}' is not installed`);
		}
		return Object.entries(plugin.installations)
			.map(([id, installation]) => ({
				id,
				active: id === plugin.activeInstallation,
				config: installation,
				channels: referencedChannels(config.channels, pluginName, id),
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	async prune(pluginName?: string): Promise<readonly RemovedPluginInstallation[]> {
		const removals: RemovedPluginInstallation[] = [];
		await this.store.update(config => {
			const plugins = { ...config.plugins };
			const selectedPlugins = pluginName
				? [[pluginName, config.plugins[pluginName]] as const]
				: Object.entries(config.plugins);
			if (pluginName && !config.plugins[pluginName]) {
				throw new Error(`Plugin '${pluginName}' is not installed`);
			}
			for (const [name, plugin] of selectedPlugins) {
				if (!plugin) {
					continue;
				}
				const installations = { ...plugin.installations };
				for (const [id, installation] of Object.entries(plugin.installations)) {
					if (id === plugin.activeInstallation
						|| referencedChannels(config.channels, name, id).length > 0
						|| Object.values(config.channels).some(channel =>
							isPluginPath(channel.plugin) && resolve(channel.plugin) === installation.path
						)) {
						continue;
					}
					delete installations[id];
					removals.push({
						marketplace: plugin.marketplace,
						plugin: name,
						installation: id,
						path: installation.path,
						config: installation,
					});
				}
				plugins[name] = { ...plugin, installations };
			}
			return { ...config, plugins };
		});

		const results = await Promise.allSettled(removals.map(removal =>
			removePluginInstallation(
				this.store.home,
				removal.marketplace,
				removal.plugin,
				removal.installation,
			)
		));
		const failed = results.flatMap((result, index) =>
			result.status === 'rejected' && removals[index]
				? [{ removal: removals[index], error: result.reason }]
				: []
		);
		const errors = failed.map(({ removal, error }) =>
			new Error(`${removal.path}: ${formatError(error)}`, { cause: error })
		);
		if (errors.length > 0) {
			await this.store.update(config => {
				const plugins = { ...config.plugins };
				for (const { removal } of failed) {
					const plugin = plugins[removal.plugin];
					if (!plugin) {
						continue;
					}
					plugins[removal.plugin] = {
						...plugin,
						installations: {
							...plugin.installations,
							[removal.installation]: removal.config,
						},
					};
				}
				return { ...config, plugins };
			});
			throw new AggregateError(errors, 'Plugin metadata was pruned but some installation directories remain');
		}
		return removals;
	}

	private async installFromMarketplace(
		pluginName: string,
		marketplaceName: string,
		marketplacePath: string,
	): Promise<InstalledPluginResult> {
		const plugins = await readMarketplacePlugins(marketplacePath);
		const descriptor = plugins.find(plugin => plugin.name === pluginName);
		if (!descriptor) {
			throw new Error(`Plugin '${pluginName}' was not found in marketplace '${marketplaceName}'`);
		}

		const sourcePath = resolveMarketplacePluginPath(marketplacePath, descriptor);
		const sourcePlugin = await inspectPlugin(sourcePath);
		const provenance = await marketplaceProvenance(marketplacePath, sourcePath);
		const snapshot = await installPluginSnapshot(this.store.home, sourcePath, {
			marketplace: marketplaceName,
			plugin: pluginName,
			source: descriptor.source,
			...(sourcePlugin.version ? { version: sourcePlugin.version } : {}),
			...(provenance.revision ? { marketplaceRevision: provenance.revision } : {}),
		}, provenance.trackedFiles);
		const plugin = await inspectPlugin(snapshot.config.path);
		await this.store.update(current => ({
			...current,
			plugins: {
				...current.plugins,
				[pluginName]: {
					marketplace: marketplaceName,
					activeInstallation: snapshot.id,
					installations: {
						...current.plugins[pluginName]?.installations,
						[snapshot.id]: snapshot.config,
					},
				},
			},
		}));
		return {
			plugin,
			installation: snapshot.id,
			config: snapshot.config,
			created: snapshot.created,
		};
	}

	private async getInstalledPlugin(pluginName: string): Promise<InstalledPluginConfig> {
		const installed = (await this.store.read()).plugins[pluginName];
		if (!installed) {
			throw new Error(`Plugin '${pluginName}' is not installed`);
		}
		return installed;
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

export function activeInstallation(plugin: InstalledPluginConfig): PluginInstallationConfig {
	const installation = plugin.installations[plugin.activeInstallation];
	if (!installation) {
		throw new Error(`Active plugin installation '${plugin.activeInstallation}' does not exist`);
	}
	return installation;
}

export function createPluginCustomization(
	plugin: ClaudePlugin,
	clientId: string,
	proxiedServerName: string,
	nonce: string = randomUUID(),
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
		nonce,
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

function referencedChannels(
	channels: Readonly<Record<string, ChannelInstanceConfig>>,
	plugin: string,
	installation: string,
): string[] {
	return Object.entries(channels)
		.filter(([, channel]) => channel.plugin === plugin && channel.installation === installation)
		.map(([name]) => name)
		.sort();
}

interface MarketplaceProvenance {
	readonly revision?: string;
	readonly trackedFiles?: readonly string[];
}

async function marketplaceProvenance(path: string, pluginPath: string): Promise<MarketplaceProvenance> {
	try {
		await stat(join(path, '.git'));
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
	const status = await runProcessOutput('git', [
		'-C',
		path,
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=normal',
	]);
	const changes = status.stdout
		.split('\0')
		.filter(Boolean)
		.filter(entry => {
			const changedPath = entry.length > 3 ? entry.slice(3) : entry;
			return !changedPath.split('/').includes('node_modules');
		});
	if (changes.length > 0) {
		throw new Error(`Marketplace has local changes; refusing reproducible installation: ${changes.join(', ')}`);
	}
	const result = await runProcessOutput('git', ['-C', path, 'rev-parse', 'HEAD']);
	const revision = result.stdout.trim();
	if (!/^[a-f0-9]{40,64}$/i.test(revision)) {
		throw new Error(`Git returned an invalid marketplace revision: ${revision}`);
	}
	const relativePluginPath = normalizeRelativePath(relative(path, pluginPath));
	const tracked = await runProcessOutput('git', [
		'-C',
		path,
		'ls-files',
		'-z',
		'--',
		relativePluginPath || '.',
	]);
	const prefix = relativePluginPath ? `${relativePluginPath}/` : '';
	const trackedFiles = tracked.stdout
		.split('\0')
		.filter(file => !prefix || file.startsWith(prefix))
		.map(file => file.slice(prefix.length));
	if (trackedFiles.length === 0) {
		throw new Error(`Plugin '${pluginPath}' contains no Git-tracked files`);
	}
	return {
		revision: revision.toLowerCase(),
		trackedFiles,
	};
}

function isPluginPath(value: string): boolean {
	return isAbsolute(value) || value.startsWith('.');
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeRelativePath(path: string): string {
	return path.split(sep).join('/');
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
	if (!isValidChannelInstanceName(value)) {
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
