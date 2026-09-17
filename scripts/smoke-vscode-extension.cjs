const assert = require('node:assert/strict');
const Module = require('node:module');
const { resolve } = require('node:path');

const manifest = require('../vscode-extension/package.json');
const registeredCommands = new Map();
const subscriptions = [];
const disposable = { dispose() { } };
let treeDataProvider;
const vscode = {
	EventEmitter: class {
		event() { return disposable; }
		fire() { }
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
		constructor(value) { this.value = value; }
	},
	TreeItemCollapsibleState: { Expanded: 2 },
	window: {
		createOutputChannel() { return disposable; },
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
	},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
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
	console.log('VS Code extension activation and channel actions passed');
} finally {
	for (const subscription of subscriptions.reverse()) {
		subscription.dispose();
	}
	Module._load = originalLoad;
}
