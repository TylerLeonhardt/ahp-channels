import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getInstanceRoot, removeInstanceState } from '../src/instancePaths.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('instance paths', () => {
	it('purges only the validated channel instance directory', async () => {
		const home = join(tmpdir(), `ahp-channels-instance-${crypto.randomUUID()}`);
		roots.push(home);
		const instance = getInstanceRoot(home, 'telegram');
		const sibling = join(home, 'keep.txt');
		await mkdir(instance, { recursive: true });
		await writeFile(join(instance, 'access.json'), '{}');
		await writeFile(sibling, 'keep');

		await removeInstanceState(home, 'telegram');

		await assert.rejects(access(instance));
		await assert.doesNotReject(access(sibling));
		assert.throws(() => getInstanceRoot(home, '..'), /Invalid channel name/);
	});
});
