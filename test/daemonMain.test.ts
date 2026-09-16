import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { requestDaemon } from '../src/daemonClient.js';
import {
	DEFAULT_DAEMON_LOG_MAX_BYTES,
	DEFAULT_DAEMON_LOG_RETAINED_FILES,
	RotatingDaemonLogger,
} from '../src/daemonLog.js';
import { getDaemonPaths } from '../src/daemonPaths.js';
import { parseDaemonStartupMessage, type DaemonStartupMessage } from '../src/daemonStartup.js';

interface TestDaemon {
	readonly child: ChildProcess;
	readonly startup: Promise<DaemonStartupMessage>;
	readonly exited: Promise<number | null>;
}

const directories: string[] = [];
const daemons: TestDaemon[] = [];

afterEach(async () => {
	await Promise.all(daemons.splice(0).map(async daemon => {
		if (daemon.child.pid && daemon.child.exitCode === null && daemon.child.signalCode === null) {
			daemon.child.kill('SIGKILL');
		}
		await daemon.exited;
	}));
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('daemon process logging', () => {
	it('gives overlapping starts one owner and keeps runtime rotations bounded', { timeout: 20_000 }, async () => {
		const home = await createHome();
		const { logFile } = getDaemonPaths(home);
		await writeFile(logFile, 'a'.repeat(DEFAULT_DAEMON_LOG_MAX_BYTES));
		const candidates = [startDaemon(home), startDaemon(home)];
		const messages = await Promise.all(candidates.map(daemon => daemon.startup));
		assert.deepEqual(messages.map(message => message.type).sort(), ['busy', 'ready']);
		const owner = candidates[messages.findIndex(message => message.type === 'ready')];
		const loser = candidates[messages.findIndex(message => message.type === 'busy')];
		loser.child.disconnect();
		assert.equal(await loser.exited, 1);

		const warningsDone = once(owner.child, 'message');
		owner.child.send('warnings');
		const [message] = await warningsDone;
		assert.deepEqual(message, { type: 'fixture-warnings-done' });
		const status = await requestDaemon(home, { command: 'status' });
		assert.equal(status.pid, owner.child.pid);

		const files = (await readdir(home)).filter(name => /^daemon\.log(?:\.\d+)?$/.test(name));
		assert.equal(files.length, DEFAULT_DAEMON_LOG_RETAINED_FILES + 1);
		for (const file of files) {
			assert.ok((await stat(join(home, file))).size <= DEFAULT_DAEMON_LOG_MAX_BYTES, file);
		}
		assert.match(await readFile(logFile, 'utf8'), /warning-49/);
		await requestDaemon(home, { command: 'shutdown' });
		owner.child.disconnect();
		assert.equal(await owner.exited, 0);
		await assert.rejects(access(`${logFile}.lock`), { code: 'ENOENT' });
	});

	for (const origin of ['uncaughtException', 'unhandledRejection'] as const) {
		it(`retains ${origin} diagnostics and releases ownership on crash`, { timeout: 15_000 }, async () => {
			const home = await createHome();
			const daemon = startDaemon(home);
			assert.equal((await daemon.startup).type, 'ready');
			daemon.child.send(origin);
			assert.equal(await daemon.exited, 1);

			const { logFile } = getDaemonPaths(home);
			const output = await readFile(logFile, 'utf8');
			assert.match(output, /Ready on/);
			assert.ok(output.includes(`[daemon] ${origin}: Error: fixture`), output);
			assert.ok(output.includes('daemon-diagnostics.mjs'), output);
			const restarted = new RotatingDaemonLogger(logFile);
			restarted.close();
		});
	}

	it('retains module-loading failures and reports their cause over IPC', { timeout: 15_000 }, async () => {
		const home = await createHome();
		const daemon = startDaemon(home, 'daemon-import-failure.mjs');
		const startup = await daemon.startup;
		assert.ok(startup.type === 'error');
		assert.match(startup.message, /fixture runtime import failure/);
		if (daemon.child.connected) {
			daemon.child.disconnect();
		}
		assert.equal(await daemon.exited, 1);
		assert.match(await readFile(getDaemonPaths(home).logFile, 'utf8'), /Startup failed: Error: fixture runtime import failure/);
	});

	it('reports an unusable log path over IPC without leaking its lock', { timeout: 15_000 }, async () => {
		const home = await createHome();
		const { logFile } = getDaemonPaths(home);
		await mkdir(logFile);
		const daemon = startDaemon(home);
		const startup = await daemon.startup;
		assert.ok(startup.type === 'error');
		assert.match(startup.message, /daemon\.log/);
		if (daemon.child.connected) {
			daemon.child.disconnect();
		}
		assert.equal(await daemon.exited, 1);
		await assert.rejects(access(`${logFile}.lock`), { code: 'ENOENT' });
	});
});

async function createHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), 'ahp-log-'));
	directories.push(home);
	return home;
}

function startDaemon(home: string, fixture = 'daemon-diagnostics.mjs'): TestDaemon {
	const child = spawn(process.execPath, [
		'--unhandled-rejections=throw',
		'--import', 'tsx',
		'--import', new URL(`./fixtures/${fixture}`, import.meta.url).href,
		fileURLToPath(new URL('../src/daemonMain.ts', import.meta.url)),
		'--home', home,
	], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		windowsHide: true,
	});
	const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
	const startup = new Promise<DaemonStartupMessage>((resolve, reject) => {
		child.once('message', value => {
			try {
				resolve(parseDaemonStartupMessage(value));
			} catch (error) {
				reject(error);
			}
		});
		child.once('error', reject);
		child.once('exit', code => reject(new Error(`Daemon exited before reporting startup (code ${code})`)));
	});
	const daemon = { child, startup, exited };
	daemons.push(daemon);
	return daemon;
}
