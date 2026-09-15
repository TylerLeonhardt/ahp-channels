import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lock } from 'proper-lockfile';

const LOCK_OPTIONS = {
	realpath: false,
	stale: 30_000,
	update: 10_000,
	retries: {
		retries: 100,
		factor: 1.2,
		minTimeout: 20,
		maxTimeout: 100,
		randomize: true,
	},
} as const;

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const release = await lock(path, LOCK_OPTIONS);
	try {
		return await operation();
	} finally {
		await release();
	}
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporaryPath, content, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
