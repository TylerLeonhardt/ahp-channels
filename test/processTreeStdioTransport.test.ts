import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ProcessTreeStdioClientTransport } from '../src/processTreeStdioTransport.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ProcessTreeStdioClientTransport', () => {
	it('terminates descendants when the stdio parent does not stop them', {
		skip: process.platform === 'win32',
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-process-tree-'));
		temporaryDirectories.push(root);
		const pidFile = join(root, 'descendant.pid');
		const parentScript = [
			'const { spawn } = require("node:child_process");',
			'const { writeFileSync } = require("node:fs");',
			'const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
			'writeFileSync(process.argv[1], String(child.pid));',
			'setInterval(() => {}, 1000);',
		].join('');
		const transport = new ProcessTreeStdioClientTransport({
			command: process.execPath,
			args: ['--eval', parentScript, pidFile],
			stderr: 'pipe',
		});
		let descendantPid: number | undefined;
		try {
			await transport.start();
			descendantPid = await waitForPid(pidFile);
			assert.equal(isProcessAlive(descendantPid), true);

			await transport.close();

			assert.equal(isProcessAlive(descendantPid), false);
		} finally {
			await transport.close();
			if (descendantPid && isProcessAlive(descendantPid)) {
				process.kill(descendantPid, 'SIGKILL');
			}
		}
	});
});

async function waitForPid(path: string): Promise<number> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			const value = Number(await readFile(path, 'utf8'));
			if (Number.isSafeInteger(value) && value > 0) {
				return value;
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== 'ENOENT') {
				throw error;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error('Timed out waiting for descendant PID');
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
