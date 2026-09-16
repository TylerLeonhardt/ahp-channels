import { randomBytes, createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from './lockedFile.js';

export interface DaemonPaths {
	readonly endpoint: string;
	readonly tokenFile: string;
	readonly logFile: string;
}

export function getDaemonPaths(home: string, platform: NodeJS.Platform = process.platform): DaemonPaths {
	const suffix = createHash('sha256').update(home).digest('hex').slice(0, 20);
	return {
		endpoint: platform === 'win32'
			? `\\\\.\\pipe\\ahp-channels-${suffix}`
			: join(home, 'daemon.sock'),
		tokenFile: join(home, 'daemon-token'),
		logFile: join(home, 'daemon.log'),
	};
}

export async function removeStaleDaemonSocket(home: string): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}
	const endpoint = getDaemonPaths(home).endpoint;
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(endpoint);
		socket.once('connect', () => {
			socket.destroy();
			reject(new Error(`A daemon is already listening on ${endpoint}`));
		});
		socket.once('error', error => {
			socket.destroy();
			if (isNodeError(error) && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) {
				resolve();
			} else {
				reject(error);
			}
		});
	});
	await rm(endpoint, { force: true });
}

export async function getOrCreateDaemonToken(home: string): Promise<string> {
	const existing = await readDaemonToken(home);
	if (existing !== undefined) {
		return existing;
	}
	const { tokenFile } = getDaemonPaths(home);
	return withFileLock(tokenFile, async () => {
		const current = await readDaemonToken(home);
		if (current !== undefined) {
			return current;
		}
		const token = randomBytes(32).toString('base64url');
		await writeFileAtomic(tokenFile, `${token}\n`);
		return token;
	});
}

export async function readDaemonToken(home: string): Promise<string | undefined> {
	const { tokenFile } = getDaemonPaths(home);
	let token: string;
	try {
		token = (await readFile(tokenFile, 'utf8')).trim();
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
		throw new Error(`Invalid daemon token file: ${tokenFile}`);
	}
	return token;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
