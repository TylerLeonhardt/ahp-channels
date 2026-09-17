import * as vscode from 'vscode';
import { SessionStatus } from '@microsoft/agent-host-protocol';
import { AgentHostService } from '../../src/agentHosts.js';
import { ChannelBindingService } from '../../src/channelBindings.js';
import { FileChannelHandoffStore } from '../../src/channelHandoff.js';
import { validateChannelDefinition } from '../../src/channelRuntime.js';
import {
	ConfigStore,
	getAppHome,
	isValidChannelInstanceName,
	rebindChannelInstance,
	type AppConfig,
	type ChannelInstanceConfig,
} from '../../src/config.js';
import {
	ensureDaemonStarted,
	probeDaemon,
	requestDaemon,
	stopDaemon,
} from '../../src/daemonClient.js';
import { getDaemonPaths } from '../../src/daemonPaths.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolVersionError,
	type ChannelDaemonStatus,
	type DaemonStatus,
} from '../../src/daemonProtocol.js';
import { activeInstallation, listInstalledPlugins, PluginManager } from '../../src/plugins.js';
import {
	SessionCatalogService,
	type SessionCatalogEntry,
} from '../../src/sessionCatalog.js';
import { channelPresentation } from './channelPresentation.js';

const VIEW_ID = 'ahpChannels.explorer';

type GroupKind = 'daemon' | 'channels' | 'plugins' | 'sessions';

interface GroupNode {
	readonly kind: 'group';
	readonly group: GroupKind;
	readonly label: string;
	readonly icon: string;
}

async function pickPluginServer(service: AhpChannelsService, pluginName: string): Promise<string | undefined | null> {
	const servers = await service.pluginServers(pluginName);
	if (servers.length <= 1) {
		return servers[0];
	}
	const selection = await vscode.window.showQuickPick(servers, {
		title: 'Select the channel MCP server',
	});
	return selection ?? null;
}

interface DaemonNode {
	readonly kind: 'daemon';
	readonly status?: DaemonStatus;
}

interface ChannelNode {
	readonly kind: 'channel';
	readonly status: ChannelDaemonStatus;
}

interface PluginNode {
	readonly kind: 'plugin';
	readonly name: string;
	readonly marketplace: string;
	readonly version?: string;
}

interface SessionNode {
	readonly kind: 'session';
	readonly entry: SessionCatalogEntry;
}

interface MessageNode {
	readonly kind: 'message';
	readonly label: string;
	readonly icon: string;
}

type ExplorerNode = GroupNode | DaemonNode | ChannelNode | PluginNode | SessionNode | MessageNode;

const ROOT_GROUPS: readonly GroupNode[] = [
	{ kind: 'group', group: 'daemon', label: 'Daemon', icon: 'server-process' },
	{ kind: 'group', group: 'channels', label: 'Channels', icon: 'radio-tower' },
	{ kind: 'group', group: 'plugins', label: 'Plugins', icon: 'extensions' },
	{ kind: 'group', group: 'sessions', label: 'Sessions', icon: 'comment-discussion' },
];

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('AHP Channels', { log: true });
	const service = new AhpChannelsService(output);
	const provider = new AhpChannelsTreeProvider(service);
	const tree = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		output,
		tree,
		provider,
		vscode.commands.registerCommand('ahpChannels.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('ahpChannels.startDaemon', () =>
			runCommand(output, provider, 'Starting AHP Channels daemon', () => service.startDaemon())),
		vscode.commands.registerCommand('ahpChannels.stopDaemon', () =>
			runCommand(output, provider, 'Stopping AHP Channels daemon', () => service.stopDaemon())),
		vscode.commands.registerCommand('ahpChannels.restartDaemon', () =>
			runCommand(output, provider, 'Restarting AHP Channels daemon', () => service.restartDaemon())),
		vscode.commands.registerCommand('ahpChannels.openDaemonLog', () => service.openDaemonLog()),
		vscode.commands.registerCommand('ahpChannels.installPlugin', () =>
			installPlugin(service, provider, output)),
		vscode.commands.registerCommand('ahpChannels.createChannel', () =>
			createChannel(service, provider, output)),
		vscode.commands.registerCommand('ahpChannels.startChannel', (node?: ChannelNode) =>
			withChannel(node, service, provider, output, 'Starting channel', name => service.startChannel(name))),
		vscode.commands.registerCommand('ahpChannels.stopChannel', (node?: ChannelNode) =>
			withChannel(node, service, provider, output, 'Stopping channel', name => service.stopChannel(name))),
		vscode.commands.registerCommand('ahpChannels.restartChannel', (node?: ChannelNode) =>
			withChannel(node, service, provider, output, 'Restarting channel', name => service.restartChannel(name))),
		vscode.commands.registerCommand('ahpChannels.selectSession', (node?: ChannelNode) =>
			selectSessionForChannel(service, provider, output, node)),
		vscode.commands.registerCommand('ahpChannels.attachSession', (node?: SessionNode) =>
			attachChannelToSession(service, provider, output, node)),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('ahpChannels.home')) {
				provider.refresh();
			}
		}),
	);
}

export function deactivate(): void { }

class AhpChannelsService {
	constructor(private readonly output: vscode.LogOutputChannel) { }

	async daemonStatus(): Promise<DaemonStatus | undefined> {
		return this.compatibleDaemonStatus();
	}

	async startDaemon(): Promise<void> {
		const status = await ensureDaemonStarted(this.home);
		this.output.info(`Daemon running with pid ${status.pid}`);
	}

	async stopDaemon(): Promise<void> {
		await stopDaemon(this.home);
		this.output.info('Daemon stopped');
	}

	async restartDaemon(): Promise<void> {
		await stopDaemon(this.home);
		const status = await ensureDaemonStarted(this.home);
		this.output.info(`Daemon restarted with pid ${status.pid}`);
	}

	async openDaemonLog(): Promise<void> {
		const logFile = getDaemonPaths(this.home).logFile;
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logFile));
			await vscode.window.showTextDocument(document);
		} catch (error) {
			this.reportError('Opening daemon log', error);
		}
	}

	async channelStatuses(): Promise<readonly ChannelDaemonStatus[]> {
		const running = await this.compatibleDaemonStatus();
		if (running) {
			return running.channels;
		}
		return offlineChannelStatuses(await this.store.read());
	}

	async installedPlugins(): Promise<readonly PluginNode[]> {
		return listInstalledPlugins(await this.store.read()).map(([name, installed]) => ({
			kind: 'plugin',
			name,
			marketplace: installed.marketplace,
			version: activeInstallation(installed).version,
		}));
	}

	async sessions(): Promise<readonly SessionCatalogEntry[]> {
		const agentHosts = new AgentHostService(this.store);
		const endpoints = await agentHosts.discover();
		if (endpoints.length === 0) {
			throw new Error('No running local Agent Host endpoints were discovered');
		}
		const catalog = new SessionCatalogService(agentHosts);
		const sessions: SessionCatalogEntry[] = [];
		const seen = new Set<string>();
		const failures: string[] = [];
		let successfulHosts = 0;
		for (const endpoint of endpoints) {
			let cursor: string | undefined;
			for (let page = 0; page < 100; page++) {
				const result = await catalog.discoverSessions({
					host: endpoint.id,
					...(cursor ? { cursor } : {}),
					limit: 100,
				});
				for (const failure of result.failures) {
					const message = failure.preferred ? `${failure.preferred}: ${failure.error}` : failure.error;
					failures.push(message);
					this.output.warn(message);
				}
				if (result.outcome === 'failed') {
					break;
				}
				if (page === 0) {
					successfulHosts++;
				}
				for (const item of result.items) {
					const key = `${item.host.actual}\0${item.resource}`;
					if (!seen.has(key)) {
						seen.add(key);
						sessions.push(item);
					}
				}
				if (!result.nextCursor) {
					break;
				}
				cursor = result.nextCursor;
			}
		}
		if (successfulHosts === 0) {
			throw new Error(failures.join('; ') || 'Session discovery failed');
		}
		return sessions.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
	}

	async installPlugin(spec: string): Promise<void> {
		const installed = await this.plugins.install(spec);
		const version = installed.plugin.version ? ` ${installed.plugin.version}` : '';
		this.output.info(`Installed ${installed.plugin.name}${version}`);
	}

	async pluginServers(pluginName: string): Promise<readonly string[]> {
		return Object.keys((await this.plugins.resolvePlugin(pluginName)).servers).sort();
	}

	async createChannel(
		name: string,
		pluginName: string,
		session: SessionCatalogEntry,
		server?: string,
	): Promise<void> {
		if (!isValidChannelInstanceName(name)) {
			throw new Error(`Invalid channel name '${name}'`);
		}
		const config = await this.store.read();
		if (findChannelName(config, name)) {
			throw new Error(`Channel '${name}' already exists`);
		}
		const reference = await this.plugins.pinPlugin(pluginName);
		const definition: ChannelInstanceConfig = {
			plugin: reference.plugin,
			session: session.resource,
			enabled: true,
			host: session.host.preferred ?? session.host.actual,
			...(server ? { server } : {}),
			...(reference.installation ? { installation: reference.installation } : {}),
		};
		await validateChannelDefinition(this.plugins, definition);
		await ensureDaemonStarted(this.home);
		await requestDaemon(this.home, {
			command: 'channel.create',
			name,
			definition,
			start: true,
		});
		this.output.info(`Created channel ${name}`);
	}

	async startChannel(name: string): Promise<void> {
		await ensureDaemonStarted(this.home);
		await requestDaemon(this.home, { command: 'channel.start', name });
	}

	async stopChannel(name: string): Promise<void> {
		if (await probeDaemon(this.home)) {
			await requestDaemon(this.home, { command: 'channel.stop', name });
			return;
		}
		await this.store.update(config => setChannelEnabled(config, name, false));
	}

	async restartChannel(name: string): Promise<void> {
		if (!await probeDaemon(this.home)) {
			throw new Error('Daemon is not running');
		}
		await requestDaemon(this.home, { command: 'channel.restart', name });
	}

	async attachChannel(name: string, session: SessionCatalogEntry): Promise<void> {
		const target = {
			host: session.host.preferred ?? session.host.actual,
			session: session.resource,
		};
		if (await probeDaemon(this.home)) {
			await requestDaemon(this.home, { command: 'channel.handoff', name, target });
			this.output.info(`Pointed ${name} at ${session.resource}`);
			return;
		}
		const bindings = this.bindings;
		const { definition: current } = await bindings.recover(name);
		const next = rebindChannelInstance(current, target);
		await validateChannelDefinition(this.plugins, next);
		const resolved = await this.catalog.validateBinding(next);
		for (const warning of resolved.warnings) {
			this.output.warn(warning);
		}
		await bindings.replace(name, current, next);
		this.output.info(`Pointed ${name} at ${session.resource}`);
	}

	reportError(action: string, error: unknown): void {
		this.logError(action, error);
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`${action} failed: ${message}`, 'Show Output').then(selection => {
			if (selection === 'Show Output') {
				this.output.show();
			}
		});
	}

	logError(action: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.output.error(`${action}: ${message}`, error instanceof Error ? error : undefined);
	}

	private get home(): string {
		const configured = vscode.workspace.getConfiguration('ahpChannels').get<string>('home')?.trim();
		return configured || getAppHome();
	}

	private get store(): ConfigStore {
		return new ConfigStore(this.home);
	}

	private get plugins(): PluginManager {
		return new PluginManager(this.store);
	}

	private get catalog(): SessionCatalogService {
		const store = this.store;
		return new SessionCatalogService(new AgentHostService(store));
	}

	private get bindings(): ChannelBindingService {
		const store = this.store;
		return new ChannelBindingService(store, new FileChannelHandoffStore(store.home));
	}

	private async compatibleDaemonStatus(): Promise<DaemonStatus | undefined> {
		try {
			return await probeDaemon(this.home);
		} catch (error) {
			if (error instanceof DaemonProtocolVersionError
				&& error.actualVersion < DAEMON_PROTOCOL_VERSION) {
				this.output.info(
					`Replacing daemon protocol ${error.actualVersion} with protocol ${DAEMON_PROTOCOL_VERSION}`,
				);
				return ensureDaemonStarted(this.home);
			}
			throw error;
		}
	}
}

class AhpChannelsTreeProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
	private readonly didChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined>();
	readonly onDidChangeTreeData = this.didChangeTreeData.event;

	constructor(private readonly service: AhpChannelsService) { }

	refresh(): void {
		this.didChangeTreeData.fire(undefined);
	}

	dispose(): void {
		this.didChangeTreeData.dispose();
	}

	getTreeItem(element: ExplorerNode): vscode.TreeItem {
		switch (element.kind) {
			case 'group':
				return groupTreeItem(element);
			case 'daemon':
				return daemonTreeItem(element);
			case 'channel':
				return channelTreeItem(element);
			case 'plugin':
				return pluginTreeItem(element);
			case 'session':
				return sessionTreeItem(element);
			case 'message':
				return messageTreeItem(element);
		}
	}

	async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
		if (!element) {
			return [...ROOT_GROUPS];
		}
		if (element.kind !== 'group') {
			return [];
		}
		try {
			switch (element.group) {
				case 'daemon':
					return [{ kind: 'daemon', status: await this.service.daemonStatus() }];
				case 'channels': {
					const channels = await this.service.channelStatuses();
					return channels.length > 0
						? channels.map(status => ({ kind: 'channel', status }))
						: [{ kind: 'message', label: 'No channels configured', icon: 'info' }];
				}
				case 'plugins': {
					const plugins = await this.service.installedPlugins();
					return plugins.length > 0
						? [...plugins]
						: [{ kind: 'message', label: 'No plugins installed', icon: 'info' }];
				}
				case 'sessions': {
					const sessions = await this.service.sessions();
					return sessions.length > 0
						? sessions.map(entry => ({ kind: 'session', entry }))
						: [{ kind: 'message', label: 'No sessions discovered', icon: 'info' }];
				}
			}
		} catch (error) {
			this.service.logError(`Loading ${element.label.toLowerCase()}`, error);
			return [{ kind: 'message', label: error instanceof Error ? error.message : String(error), icon: 'error' }];
		}
	}
}

function groupTreeItem(node: GroupNode): vscode.TreeItem {
	const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
	item.iconPath = new vscode.ThemeIcon(node.icon);
	item.contextValue = `group.${node.group}`;
	return item;
}

function daemonTreeItem(node: DaemonNode): vscode.TreeItem {
	const running = node.status !== undefined;
	const item = new vscode.TreeItem(running ? 'Running' : 'Stopped');
	item.description = running ? `pid ${node.status.pid}` : undefined;
	item.contextValue = running ? 'daemonRunning' : 'daemonStopped';
	item.iconPath = new vscode.ThemeIcon(running ? 'pass-filled' : 'circle-slash');
	item.tooltip = running
		? `Started ${new Date(node.status.startedAt).toLocaleString()}`
		: 'The AHP Channels daemon is not running';
	return item;
}

function channelTreeItem(node: ChannelNode): vscode.TreeItem {
	const { status } = node;
	const presentation = channelPresentation(status);
	const item = new vscode.TreeItem(status.name);
	item.description = presentation.description;
	item.contextValue = status.state === 'stopped' || status.desired === 'stopped'
		? 'channelStopped'
		: status.state === 'error'
			? 'channelError'
			: 'channelRunning';
	item.iconPath = new vscode.ThemeIcon(channelIcon(status));
	const tooltip = new vscode.MarkdownString();
	for (const [label, value] of presentation.details) {
		tooltip.appendMarkdown(`**${label}:** `).appendText(value).appendMarkdown('\n\n');
	}
	item.tooltip = tooltip;
	return item;
}

function pluginTreeItem(node: PluginNode): vscode.TreeItem {
	const item = new vscode.TreeItem(node.name);
	item.description = node.version ?? node.marketplace;
	item.contextValue = 'plugin';
	item.iconPath = new vscode.ThemeIcon('extensions');
	item.tooltip = `Marketplace: ${node.marketplace}`;
	return item;
}

function sessionTreeItem(node: SessionNode): vscode.TreeItem {
	const { entry } = node;
	const item = new vscode.TreeItem(entry.title || entry.resource);
	item.description = entry.project?.displayName ?? entry.provider;
	item.contextValue = 'session';
	item.iconPath = new vscode.ThemeIcon(sessionIcon(entry.status));
	item.command = {
		command: 'ahpChannels.attachSession',
		title: 'Point Channel Here',
		arguments: [node],
	};
	item.tooltip = new vscode.MarkdownString([
		`**Provider:** ${entry.provider}`,
		`**Session:** \`${entry.resource}\``,
		`**Host:** \`${entry.host.preferred ?? entry.host.actual}\``,
		...(entry.activity ? [`**Activity:** ${entry.activity}`] : []),
	].join('\n\n'));
	return item;
}

function messageTreeItem(node: MessageNode): vscode.TreeItem {
	const item = new vscode.TreeItem(node.label);
	item.iconPath = new vscode.ThemeIcon(node.icon);
	return item;
}

function channelIcon(status: ChannelDaemonStatus): string {
	switch (status.state) {
		case 'running':
			return 'radio-tower';
		case 'error':
			return 'error';
		case 'starting':
		case 'stopping':
			return 'loading~spin';
		case 'stopped':
			return 'circle-slash';
	}
}

function sessionIcon(status: number): string {
	if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) {
		return 'bell';
	}
	if ((status & SessionStatus.InProgress) !== 0) {
		return 'sync~spin';
	}
	if ((status & SessionStatus.Error) !== 0) {
		return 'error';
	}
	return 'comment-discussion';
}

async function installPlugin(
	service: AhpChannelsService,
	provider: AhpChannelsTreeProvider,
	output: vscode.LogOutputChannel,
): Promise<void> {
	const spec = await vscode.window.showInputBox({
		title: 'Install AHP Channel Plugin',
		prompt: 'Enter plugin@marketplace',
		placeHolder: 'fakechat@claude-plugins-official',
		ignoreFocusOut: true,
		validateInput: value => value.trim() ? undefined : 'Enter a plugin specification',
	});
	if (!spec) {
		return;
	}
	await runCommand(output, provider, `Installing ${spec}`, () => service.installPlugin(spec.trim()));
}

async function createChannel(
	service: AhpChannelsService,
	provider: AhpChannelsTreeProvider,
	output: vscode.LogOutputChannel,
): Promise<void> {
	try {
		const plugin = await pickPlugin(service);
		if (!plugin) {
			return;
		}
		const server = await pickPluginServer(service, plugin.name);
		if (server === null) {
			return;
		}
		const session = await pickSession(service);
		if (!session) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Create AHP Channel',
			prompt: 'Choose a unique channel name',
			value: plugin.name,
			ignoreFocusOut: true,
			validateInput: value => isValidChannelInstanceName(value)
				? undefined
				: 'Use letters, numbers, dots, underscores, or hyphens',
		});
		if (!name) {
			return;
		}
		await runCommand(output, provider, `Creating channel ${name}`, () =>
			service.createChannel(name, plugin.name, session, server));
	} catch (error) {
		service.reportError('Creating channel', error);
	}
}

async function selectSessionForChannel(
	service: AhpChannelsService,
	provider: AhpChannelsTreeProvider,
	output: vscode.LogOutputChannel,
	node?: ChannelNode,
): Promise<void> {
	try {
		const channel = node ?? await pickChannel(service);
		if (!channel) {
			return;
		}
		const session = await pickSession(service);
		if (!session) {
			return;
		}
		await runCommand(output, provider, `Pointing ${channel.status.name} at ${session.title}`, () =>
			service.attachChannel(channel.status.name, session));
	} catch (error) {
		service.reportError('Selecting session', error);
	}
}

async function attachChannelToSession(
	service: AhpChannelsService,
	provider: AhpChannelsTreeProvider,
	output: vscode.LogOutputChannel,
	node?: SessionNode,
): Promise<void> {
	if (!node) {
		return selectSessionForChannel(service, provider, output);
	}
	try {
		const channel = await pickChannel(service);
		if (!channel) {
			return;
		}
		await runCommand(output, provider, `Pointing ${channel.status.name} at ${node.entry.title}`, () =>
			service.attachChannel(channel.status.name, node.entry));
	} catch (error) {
		service.reportError('Pointing channel at session', error);
	}
}

async function pickPlugin(service: AhpChannelsService): Promise<PluginNode | undefined> {
	const plugins = await service.installedPlugins();
	if (plugins.length === 0) {
		void vscode.window.showWarningMessage('Install a plugin before creating a channel.');
		return undefined;
	}
	const selection = await vscode.window.showQuickPick(
		plugins.map(plugin => ({
			label: plugin.name,
			description: plugin.version,
			detail: plugin.marketplace,
			plugin,
		})),
		{ title: 'Select a channel plugin', matchOnDescription: true, matchOnDetail: true },
	);
	return selection?.plugin;
}

async function pickChannel(service: AhpChannelsService): Promise<ChannelNode | undefined> {
	const channels = await service.channelStatuses();
	if (channels.length === 0) {
		void vscode.window.showWarningMessage('Create a channel before selecting a session.');
		return undefined;
	}
	const selection = await vscode.window.showQuickPick(
		channels.map(status => ({
			label: status.name,
			description: status.state,
			detail: status.definition.session,
			node: { kind: 'channel' as const, status },
		})),
		{ title: 'Select a channel', matchOnDescription: true, matchOnDetail: true },
	);
	return selection?.node;
}

async function pickSession(service: AhpChannelsService): Promise<SessionCatalogEntry | undefined> {
	const sessions = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Window,
		title: 'Discovering AHP sessions',
	}, () => service.sessions());
	if (sessions.length === 0) {
		void vscode.window.showWarningMessage('No AHP sessions were discovered.');
		return undefined;
	}
	const selection = await vscode.window.showQuickPick(
		sessions.map(session => ({
			label: session.title || session.resource,
			description: session.project?.displayName ?? session.provider,
			detail: session.resource,
			session,
		})),
		{ title: 'Select an AHP session', matchOnDescription: true, matchOnDetail: true },
	);
	return selection?.session;
}

async function withChannel(
	node: ChannelNode | undefined,
	service: AhpChannelsService,
	provider: AhpChannelsTreeProvider,
	output: vscode.LogOutputChannel,
	action: string,
	operation: (name: string) => Promise<void>,
): Promise<void> {
	try {
		const selected = node ?? await pickChannel(service);
		if (!selected) {
			return;
		}
		await runCommand(output, provider, `${action} ${selected.status.name}`, () =>
			operation(selected.status.name));
	} catch (error) {
		service.reportError(action, error);
	}
}

async function runCommand(
	output: vscode.LogOutputChannel,
	provider: AhpChannelsTreeProvider,
	title: string,
	operation: () => Promise<void>,
): Promise<void> {
	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title,
		}, operation);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		output.error(`${title}: ${message}`, error instanceof Error ? error : undefined);
		void vscode.window.showErrorMessage(`${title} failed: ${message}`, 'Show Output').then(selection => {
			if (selection === 'Show Output') {
				output.show();
			}
		});
	} finally {
		provider.refresh();
	}
}

function offlineChannelStatuses(config: AppConfig): readonly ChannelDaemonStatus[] {
	return Object.entries(config.channels)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, definition]) => ({
			name,
			desired: definition.enabled ? 'running' : 'stopped',
			state: 'stopped',
			definition,
			health: { state: 'stopped' },
		}));
}

function findChannelName(config: AppConfig, name: string): string | undefined {
	return Object.keys(config.channels).find(candidate => candidate.toLowerCase() === name.toLowerCase());
}

function setChannelEnabled(
	config: AppConfig,
	name: string,
	enabled: boolean,
): AppConfig {
	const existingName = findChannelName(config, name);
	if (!existingName) {
		throw new Error(`Channel '${name}' does not exist`);
	}
	const definition = config.channels[existingName];
	return {
		...config,
		channels: {
			...config.channels,
			[existingName]: { ...definition, enabled },
		},
	};
}
