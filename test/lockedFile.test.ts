import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { raceAbort } from '../src/async.js';
import { withFileLock } from '../src/lockedFile.js';

const realDelay = delay;

describe('file lock ownership', () => {
	it('queues local contenders without requiring retry timers to advance', { timeout: 5000 }, async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-file-lock-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		context.mock.timers.enable({ apis: ['setTimeout'] });
		const path = join(home, 'state.json');
		const operations: string[] = [];
		let entered!: () => void;
		let release!: () => void;
		const firstEntered = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const first = withFileLock(path, async () => {
			operations.push('first');
			entered();
			await gate;
		});
		let second: Promise<void> | undefined;
		try {
			await raceAbort(firstEntered, context.signal);
			second = withFileLock(path, async () => {
				operations.push('second');
			});
			await realDelay(100);
			assert.deepEqual(operations, ['first']);
			release();
			await raceAbort(Promise.all([first, second]), context.signal);
			assert.deepEqual(operations, ['first', 'second']);
		} finally {
			release();
			await first;
			context.mock.timers.tick(1000);
			context.mock.timers.reset();
			await second;
		}
		await assert.rejects(access(`${path}.lock`), (error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'ENOENT',
		);
	});

	it('propagates a failed operation without poisoning the next owner', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-file-lock-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		const path = join(home, 'state.json');
		const failure = new Error('first operation failed');
		const first = withFileLock(path, async () => { throw failure; });
		const failed = assert.rejects(first, error => error === failure);
		const second = withFileLock(path, async () => 'recovered');
		await failed;
		assert.equal(await second, 'recovered');
		assert.equal(await withFileLock(path, async () => 'third'), 'third');
	});
});
