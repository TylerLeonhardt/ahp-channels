import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { lock } from 'proper-lockfile';

export const FILE_LOCK_OPTIONS = {
	realpath: false,
	stale: 30_000,
	update: 10_000,
} as const;

const LOCK_OPTIONS = {
	...FILE_LOCK_OPTIONS,
	retries: {
		retries: 100,
		factor: 1.2,
		minTimeout: 20,
		maxTimeout: 100,
		randomize: true,
	},
} as const;

const pendingOperations = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const key = resolve(path);
	const preceding = pendingOperations.get(key) ?? Promise.resolve();
	// Local contenders can wait for ownership directly instead of racing through
	// timer-based retries. The filesystem lock still protects other processes.
	const current = preceding.then(acquire, acquire);
	pendingOperations.set(key, current);
	try {
		return await current;
	} finally {
		if (pendingOperations.get(key) === current) {
			pendingOperations.delete(key);
		}
	}

	async function acquire(): Promise<T> {
		await mkdir(dirname(key), { recursive: true });
		const release = await lock(key, LOCK_OPTIONS);
		try {
			return await operation();
		} finally {
			await release();
		}
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
