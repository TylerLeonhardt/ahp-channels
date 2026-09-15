#!/usr/bin/env node

import { ConfigStore, getAppHome } from './config.js';
import { createChannelRuntimeServices } from './channelRuntime.js';
import { getOrCreateDaemonToken, getDaemonPaths } from './daemonPaths.js';
import { createDaemonRuntimeFactory, DaemonServer } from './daemonServer.js';
import { PluginManager } from './plugins.js';

const home = readHomeArgument(process.argv.slice(2)) ?? getAppHome();
const configStore = new ConfigStore(home);
const plugins = new PluginManager(configStore);
const token = await getOrCreateDaemonToken(home);
const daemon = new DaemonServer(
	home,
	token,
	configStore,
	createDaemonRuntimeFactory(createChannelRuntimeServices(plugins, { home }), plugins),
);

const shutdown = () => {
	void daemon.close().catch(error => {
		console.error(`[daemon] Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
	await daemon.start();
	console.log(`[daemon] Ready on ${getDaemonPaths(home).endpoint}`);
	await daemon.whenClosed;
} catch (error) {
	console.error(`[daemon] Startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
	await daemon.close().catch(closeError => {
		console.error(`[daemon] Cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
	});
}

function readHomeArgument(args: readonly string[]): string | undefined {
	const index = args.indexOf('--home');
	if (index < 0) {
		return undefined;
	}
	const home = args[index + 1];
	if (!home) {
		throw new Error('--home requires a path');
	}
	return home;
}
