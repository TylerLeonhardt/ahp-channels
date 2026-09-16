import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	DEFAULT_DAEMON_LOG_MAX_BYTES,
	DEFAULT_DAEMON_LOG_RETAINED_FILES,
	RotatingDaemonLogger,
	rotatedPath,
} from '../src/daemonLog.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('RotatingDaemonLogger', () => {
	it('keeps exclusive ownership until the writer closes', async () => {
		const path = await createLogPath();
		const logger = new RotatingDaemonLogger(path);
		try {
			logger.write('a'.repeat(DEFAULT_DAEMON_LOG_MAX_BYTES));
			assert.throws(() => {
				const competing = new RotatingDaemonLogger(path);
				competing.close();
			}, { code: 'ELOCKED' });
			logger.info('still owned by the first writer');
		} finally {
			logger.close();
		}

		const restarted = new RotatingDaemonLogger(path);
		try {
			restarted.info('reopened after release');
		} finally {
			restarted.close();
		}
		assert.equal(await readFile(path, 'utf8'), 'still owned by the first writer\nreopened after release\n');
		assert.equal((await stat(rotatedPath(path, 1))).size, DEFAULT_DAEMON_LOG_MAX_BYTES);
	});

	it('rotates active output and bounds retained files', async () => {
		const path = await createLogPath();
		const logger = new RotatingDaemonLogger(path);
		const last = DEFAULT_DAEMON_LOG_RETAINED_FILES + 2;
		try {
			for (let index = 0; index <= last; index++) {
				logger.write(`${String(index).repeat(DEFAULT_DAEMON_LOG_MAX_BYTES - 1)}\n`);
			}
		} finally {
			logger.close();
		}

		assert.equal(await readFile(path, 'utf8'), `${String(last).repeat(DEFAULT_DAEMON_LOG_MAX_BYTES - 1)}\n`);
		for (let index = 1; index <= DEFAULT_DAEMON_LOG_RETAINED_FILES; index++) {
			assert.equal(
				await readFile(rotatedPath(path, index), 'utf8'),
				`${String(last - index).repeat(DEFAULT_DAEMON_LOG_MAX_BYTES - 1)}\n`,
			);
		}
		await assert.rejects(
			readFile(rotatedPath(path, DEFAULT_DAEMON_LOG_RETAINED_FILES + 1), 'utf8'),
			{ code: 'ENOENT' },
		);
	});

	it('retains only the newest bytes from oversized writes', async () => {
		const path = await createLogPath();
		const logger = new RotatingDaemonLogger(path);
		logger.write(`old${'n'.repeat(DEFAULT_DAEMON_LOG_MAX_BYTES)}`);
		logger.close();

		assert.equal((await readFile(path, 'utf8')).at(0), 'n');
		assert.equal((await stat(path)).size, DEFAULT_DAEMON_LOG_MAX_BYTES);
	});

	it('bounds a legacy log when opening it', async () => {
		const path = await createLogPath();
		await writeFile(path, `old${'n'.repeat(DEFAULT_DAEMON_LOG_MAX_BYTES)}`);

		const logger = new RotatingDaemonLogger(path);
		logger.close();

		assert.equal((await readFile(path, 'utf8')).at(0), 'n');
		assert.equal((await stat(path)).size, DEFAULT_DAEMON_LOG_MAX_BYTES);
	});

	it('rejects writes after close', async () => {
		const path = await createLogPath();
		const logger = new RotatingDaemonLogger(path);
		logger.close();

		assert.throws(() => logger.write('late'), /closed/);
	});
});

async function createLogPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ahp-channels-log-'));
	temporaryDirectories.push(directory);
	return join(directory, 'daemon.log');
}
