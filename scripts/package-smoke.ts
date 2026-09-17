import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { VERSION } from '../src/version.js';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'ahp-channels-package-'));
let tarball: string | undefined;
let cliEntry: string | undefined;
let daemonStarted = false;
const environment = {
	...process.env,
	AHP_CHANNELS_HOME: join(temporary, 'state'),
};

try {
	const packed = await runNpm(['pack', '--json', '--silent'], root);
	const result: unknown = JSON.parse(packed.stdout);
	if (!Array.isArray(result) || !isRecord(result[0]) || typeof result[0]['filename'] !== 'string') {
		throw new Error(`npm pack returned an unexpected result: ${packed.stdout}`);
	}
	const packedFiles = result[0]['files'];
	if (!Array.isArray(packedFiles)
		|| !packedFiles.some(file => isRecord(file) && file['path'] === 'LICENSE')) {
		throw new Error('Packed npm artifact does not contain LICENSE');
	}
	tarball = join(root, result[0]['filename']);
	if (basename(tarball) !== `ahp-channels-${VERSION}.tgz`) {
		throw new Error(`Expected package tarball ahp-channels-${VERSION}.tgz, received ${basename(tarball)}`);
	}
	await runNpm(['install', '--prefix', temporary, tarball], root);
	cliEntry = join(temporary, 'node_modules', 'ahp-channels', 'dist', 'cli.js');
	const version = await run(process.execPath, [cliEntry, '--version'], root, environment);
	if (version.stdout.trim() !== VERSION) {
		throw new Error(`Expected CLI version ${VERSION}, received ${version.stdout.trim()}`);
	}
	daemonStarted = true;
	const starts = await Promise.all([
		run(process.execPath, [cliEntry, 'daemon', 'start'], root, environment),
		run(process.execPath, [cliEntry, 'daemon', 'start'], root, environment),
		run(process.execPath, [cliEntry, 'daemon', 'start'], root, environment),
	]);
	const pids = starts.map(result => {
		const match = /Daemon running \(pid (\d+)\)/.exec(result.stdout);
		assert.ok(match, result.stdout);
		return match[1];
	});
	assert.equal(new Set(pids).size, 1, 'Concurrent starts must return the same daemon');
	await run(process.execPath, [cliEntry, 'daemon', 'status', '--json'], root, environment);
	await run(process.execPath, [cliEntry, 'daemon', 'stop'], root, environment);
	daemonStarted = false;
	const invalidHome = join(temporary, 'invalid-state');
	await mkdir(join(invalidHome, 'daemon.log'), { recursive: true });
	const failedStart = Date.now();
	await assert.rejects(
		run(process.execPath, [cliEntry, 'daemon', 'start'], root, { ...environment, AHP_CHANNELS_HOME: invalidHome }),
		/Daemon startup failed:.*daemon\.log/,
	);
	assert.ok(Date.now() - failedStart < 10_000, 'Log failures must not wait for the 60-second startup timeout');
	console.log(`Package smoke test passed: ${basename(tarball)}`);
} finally {
	if (daemonStarted && cliEntry) {
		await run(process.execPath, [cliEntry, 'daemon', 'stop'], root, environment).catch(error => {
			console.error(`Failed to stop package-smoke daemon: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	if (tarball) {
		await rm(tarball, { force: true });
	}
	await rm(temporary, { recursive: true, force: true });
}

function runNpm(args: readonly string[], cwd: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
	const npmEntry = process.env['npm_execpath'];
	if (!npmEntry) {
		throw new Error('npm_execpath is unavailable; run this smoke test through npm');
	}
	return run(process.execPath, [npmEntry, ...args], cwd);
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', chunk => stderr += chunk);
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolveRun({ stdout, stderr });
			} else {
				reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stderr}`));
			}
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
