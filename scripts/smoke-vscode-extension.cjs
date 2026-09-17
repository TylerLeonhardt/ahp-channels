const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const manifest = require('../vscode-extension/package.json');
const registeredCommands = new Map();
const subscriptions = [];
const disposable = { dispose() { } };
let treeDataProvider;
let home;
let refreshes = 0;
const errors = [];
const notifications = [];
const vscode = {
	EventEmitter: class {
		event() { return disposable; }
		fire() { refreshes++; }
		dispose() { }
	},
	TreeItem: class {
		constructor(label, collapsibleState) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	},
	ThemeIcon: class {
		constructor(id) { this.id = id; }
	},
	MarkdownString: class {
		appends = [];
		constructor(value = '') { this.value = value; }
		appendMarkdown(value) {
			this.appends.push({ kind: 'markdown', value });
			this.value += value;
			return this;
		}
		appendText(value) {
			this.appends.push({ kind: 'text', value });
			this.value += value;
			return this;
		}
	},
	TreeItemCollapsibleState: { Expanded: 2 },
	ProgressLocation: { Notification: 15 },
	window: {
		createOutputChannel() {
			return { ...disposable, info() { }, error(message) { errors.push(message); } };
		},
		withProgress(_options, operation) { return operation(); },
		showErrorMessage(message) {
			notifications.push(message);
			return Promise.resolve(undefined);
		},
		createTreeView(id, options) {
			assert.equal(id, 'ahpChannels.explorer');
			treeDataProvider = options.treeDataProvider;
			return disposable;
		},
	},
	commands: {
		registerCommand(id, handler) {
			assert.equal(registeredCommands.has(id), false, `Duplicate command: ${id}`);
			registeredCommands.set(id, handler);
			return { dispose() { registeredCommands.delete(id); } };
		},
	},
	workspace: {
		onDidChangeConfiguration() { return disposable; },
		getConfiguration() {
			return { get() { return home; } };
		},
	},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

async function runChecks() {
	const extension = require(resolve(__dirname, '..', 'vscode-extension', 'dist', 'extension.cjs'));
	assert.equal(typeof extension.activate, 'function');
	assert.equal(typeof extension.deactivate, 'function');
	extension.activate({ subscriptions });
	assert.ok(treeDataProvider);
	for (const { command } of manifest.contributes.commands) {
		assert.equal(typeof registeredCommands.get(command), 'function', `Unregistered command: ${command}`);
	}

	const channelMenus = manifest.contributes.menus['view/item/context'];
	for (const [command, context, groups] of [
		['stopChannel', '(viewItem == channelRunning || viewItem == channelError)', ['inline@1', 'channel@1']],
		['startChannel', 'viewItem == channelStopped', ['inline@1', 'channel@1']],
		['restartChannel', '(viewItem == channelRunning || viewItem == channelError)', ['channel@2']],
	]) {
		assert.deepEqual(
			channelMenus.filter(item => item.command === `ahpChannels.${command}`),
			groups.map(group => ({
				command: `ahpChannels.${command}`,
				when: `view == ahpChannels.explorer && ${context}`,
				group,
			})),
			`Incorrect channel actions: ${command}`,
		);
	}

	for (const [state, desired, contextValue, icon] of [
		['running', 'running', 'channelRunning', 'radio-tower'],
		['starting', 'running', 'channelRunning', 'loading~spin'],
		['stopping', 'stopped', 'channelStopped', 'loading~spin'],
		['stopped', 'stopped', 'channelStopped', 'circle-slash'],
		['stopped', 'running', 'channelStopped', 'circle-slash'],
		['error', 'running', 'channelError', 'error'],
		['error', 'stopped', 'channelStopped', 'error'],
	]) {
		const item = treeDataProvider.getTreeItem({
			kind: 'channel',
			status: {
				name: 'discord',
				state,
				desired,
				definition: {
					plugin: 'discord',
					session: 'copilotcli:/test-session',
					enabled: desired === 'running',
				},
				health: { state: state === 'error' ? 'unhealthy' : state === 'running' ? 'healthy' : 'stopped' },
			},
		});
		assert.equal(item.contextValue, contextValue, `Incorrect actions for ${state}/${desired}`);
		assert.equal(item.iconPath.id, icon, `Incorrect icon for ${state}/${desired}`);
		assert.equal(item.description, `${state} \u00b7 discord`);
	}

	const failure = '[untrusted diagnostic](command:do-not-run)\n**not markup**';
	const setupStatus = {
		name: 'discord',
		state: 'error',
		desired: 'running',
		definition: { plugin: 'discord', session: 'copilotcli:/destination', enabled: true },
		runtime: {
			name: 'discord',
			plugin: 'discord',
			session: 'copilotcli:/destination',
			chat: 'ahp-chat:/default',
			host: 'standalone:1:test',
			clientId: 'client',
			channelName: 'discord',
			startedAt: '2026-01-01T00:00:00Z',
			bindingId: '00000000-0000-4000-8000-000000000001',
			busy: false,
			mode: 'customization-only',
		},
		health: {
			state: 'degraded',
			failure: {
				stage: 'mcp-startup',
				summary: failure,
				guidance: 'Run the plugin setup skill in this session.',
				failedAt: '2026-01-01T00:00:00Z',
			},
			retry: { state: 'scheduled', attempt: 2, nextRetryAt: '2026-01-01T00:00:02Z' },
		},
	};
	const setupItem = treeDataProvider.getTreeItem({ kind: 'channel', status: setupStatus });
	assert.equal(setupItem.description, 'attached for setup \u00b7 discord');
	assert.equal(setupItem.contextValue, 'channelError');
	assert.equal(setupItem.iconPath.id, 'error');
	assert.ok(setupItem.tooltip.appends.some(part => part.kind === 'text' && part.value === failure));
	assert.ok(setupItem.tooltip.appends.some(part => part.kind === 'text' && part.value === setupStatus.health.failure.guidance));
	assert.ok(!setupItem.tooltip.appends.some(part => part.kind === 'markdown' && part.value.includes('command:')));
	assert.notEqual(setupItem.tooltip.isTrusted, true);
	assert.notEqual(setupItem.tooltip.supportHtml, true);
	assert.match(setupItem.tooltip.value, /Attempt 2/);

	const healthyItem = treeDataProvider.getTreeItem({
		kind: 'channel',
		status: {
			...setupStatus,
			state: 'running',
			runtime: { ...setupStatus.runtime, mode: 'mcp' },
			health: { state: 'healthy' },
		},
	});
	assert.equal(healthyItem.description, 'connected \u00b7 discord');
	assert.equal(healthyItem.contextValue, 'channelRunning');
	assert.ok(!healthyItem.tooltip.value.includes(failure));
	assert.ok(!healthyItem.tooltip.value.includes('Attempt 2'));
	home = await mkdtemp(join(tmpdir(), 'ahp-channels-extension-smoke-'));
	const previousRefreshes = refreshes;
	await registeredCommands.get('ahpChannels.restartChannel')({ kind: 'channel', status: setupStatus });
	assert.equal(refreshes, previousRefreshes + 1, 'Refresh the tree even after a channel command fails');
	assert.ok(errors.some(message => message.includes('Daemon is not running')));
	assert.ok(notifications.some(message => message.includes('Daemon is not running')));
	const expectedErrors = errors.length;
	const expectedNotifications = notifications.length;
	await registeredCommands.get('ahpChannels.startDaemon')();
	assert.equal(errors.length, expectedErrors, `Bundled daemon startup failed: ${errors.slice(expectedErrors).join('; ')}`);
	assert.equal(notifications.length, expectedNotifications);
	const group = (await treeDataProvider.getChildren()).find(node => node.kind === 'group' && node.group === 'daemon');
	const [running] = await treeDataProvider.getChildren(group);
	assert.equal(running.kind, 'daemon');
	assert.ok(running.status?.pid > 0, 'The extension must start its bundled daemon');
	await registeredCommands.get('ahpChannels.startDaemon')();
	const [existing] = await treeDataProvider.getChildren(group);
	assert.equal(existing.status?.pid, running.status.pid, 'Repeated start must reuse the same daemon');
	await registeredCommands.get('ahpChannels.stopDaemon')();
	const [stopped] = await treeDataProvider.getChildren(group);
	assert.equal(stopped.status, undefined, 'The extension must stop its bundled daemon');
	assert.equal(errors.length, expectedErrors);
	await writeFile(join(home, 'config.json'), JSON.stringify({
		version: 2, marketplaces: {}, plugins: {}, channels: {},
	}));
	await registeredCommands.get('ahpChannels.startDaemon')();
	assert.equal(errors.length, expectedErrors + 1);
	assert.match(notifications.at(-1), /Unsupported ahp-channels config version '2'/);
	assert.ok(!notifications.at(-1).includes('exited before startup'));
	console.log('VS Code extension activation, channel actions, and bundled daemon lifecycle passed');
}

runChecks().finally(async () => {
	if (home) {
		await registeredCommands.get('ahpChannels.stopDaemon')();
		const [daemon] = await treeDataProvider.getChildren({ kind: 'group', group: 'daemon', label: 'Daemon' });
		assert.equal(daemon.kind, 'daemon');
		assert.equal(daemon.status, undefined, `Bundled daemon may still be running; retained test state: ${home}`);
		await rm(home, { recursive: true, force: true });
	}
	for (const subscription of subscriptions.reverse()) {
		subscription.dispose();
	}
	Module._load = originalLoad;
}).catch(error => {
	console.error(error);
	process.exitCode = 1;
});
