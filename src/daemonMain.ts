#!/usr/bin/env node

import { ConsoleDaemonLogger, RotatingDaemonLogger, type DaemonLogger } from './daemonLog.js';
import { getOrCreateDaemonToken, getDaemonPaths, removeStaleDaemonSocket } from './daemonPaths.js';
import type { DaemonServer } from './daemonServer.js';
import type { DaemonStartupMessage } from './daemonStartup.js';

await main();

async function main(): Promise<void> {
	let logger: DaemonLogger = new ConsoleDaemonLogger();
	let daemon: DaemonServer | undefined;
	const shutdown = () => {
		void daemon?.close().catch(error => {
			writeDiagnostic(logger, `[daemon] Shutdown failed: ${formatError(error)}`);
			process.exitCode = 1;
		});
	};
	const onWarning = (warning: Error) => writeDiagnostic(logger, `[daemon] Warning: ${formatError(warning)}`);
	const onUncaughtException = (error: Error, origin: string) => {
		writeDiagnostic(logger, `[daemon] ${origin}: ${formatError(error)}`);
	};
	process.on('warning', onWarning);
	// Observe fatal errors without suppressing Node's non-zero exit.
	process.on('uncaughtExceptionMonitor', onUncaughtException);

	try {
		const home = readHomeArgument(process.argv.slice(2)) ?? (await import('./config.js')).getAppHome();
		const paths = getDaemonPaths(home);
		try {
			logger = new RotatingDaemonLogger(paths.logFile);
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
				logger.error(`[daemon] Another daemon owns ${paths.logFile}`);
				sendStartupMessage({ type: 'busy' });
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		await removeStaleDaemonSocket(home);
		const [
			{ ConfigStore },
			{ createChannelRuntimeServices },
			{ createDaemonRuntimeFactory, DaemonServer },
			{ PluginManager },
		] = await Promise.all([
			import('./config.js'),
			import('./channelRuntime.js'),
			import('./daemonServer.js'),
			import('./plugins.js'),
		]);
		const configStore = new ConfigStore(home);
		const plugins = new PluginManager(configStore);
		const token = await getOrCreateDaemonToken(home);
		daemon = new DaemonServer(
			home,
			token,
			configStore,
			createDaemonRuntimeFactory(createChannelRuntimeServices(plugins, { home, stderr: logger }), plugins),
			logger,
		);
		process.once('SIGINT', shutdown);
		process.once('SIGTERM', shutdown);
		await daemon.start();
		logger.info(`[daemon] Ready on ${paths.endpoint}`);
		sendStartupMessage({ type: 'ready' });
		await daemon.whenClosed;
	} catch (error) {
		writeDiagnostic(logger, `[daemon] Startup failed: ${formatError(error)}`);
		sendStartupMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	} finally {
		await daemon?.close().catch(closeError => {
			writeDiagnostic(logger, `[daemon] Cleanup failed: ${formatError(closeError)}`);
			process.exitCode = 1;
		});
		process.off('SIGINT', shutdown);
		process.off('SIGTERM', shutdown);
		process.off('warning', onWarning);
		process.off('uncaughtExceptionMonitor', onUncaughtException);
		logger.close();
	}
}

function sendStartupMessage(message: DaemonStartupMessage): void {
	if (process.connected) {
		process.send?.(message, error => {
			if (error) {
				console.error(`[daemon] Could not report startup status: ${formatError(error)}`);
			}
		});
	}
}

function writeDiagnostic(logger: DaemonLogger, message: string): void {
	try {
		logger.error(message);
	} catch (error) {
		console.error(`${message}\n[daemon] Could not write diagnostic: ${formatError(error)}`);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
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
