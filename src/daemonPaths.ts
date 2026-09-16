import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

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
	const { tokenFile } = getDaemonPaths(home);
	await mkdir(home, { recursive: true });
	try {
		const handle = await open(tokenFile, 'wx', 0o600);
		let written = false;
		try {
			const token = randomBytes(32).toString('base64url');
			await handle.writeFile(`${token}\n`, 'utf8');
			written = true;
			return token;
		} finally {
			await handle.close();
			if (!written) {
				await rm(tokenFile, { force: true });
			}
		}
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'EEXIST') {
			throw error;
		}
	}

	const deadline = Date.now() + 2000;
	while (true) {
		const token = (await readFile(tokenFile, 'utf8')).trim();
		if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
			return token;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Invalid daemon token file: ${tokenFile}`);
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
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
