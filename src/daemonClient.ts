import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { check } from 'proper-lockfile';
import { getOrCreateDaemonToken, getDaemonPaths, readDaemonToken } from './daemonPaths.js';
import { parseDaemonStartupMessage, type DaemonStartupMessage } from './daemonStartup.js';
import { FILE_LOCK_OPTIONS } from './lockedFile.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolError,
	DaemonProtocolVersionError,
	MAX_DAEMON_MESSAGE_BYTES,
	parseDaemonResponse,
	type DaemonCommandResult,
	type DaemonRequestBody,
	type DaemonResponseData,
	type DaemonStatus,
} from './daemonProtocol.js';

export async function requestDaemon(home: string, body: DaemonRequestBody, timeoutMs?: number): Promise<DaemonStatus> {
	return (await requestDaemonResult(home, body, { timeoutMs })).status;
}

export async function requestDaemonData(
	home: string,
	body: Extract<DaemonRequestBody, { command: 'catalog.sessions' | 'catalog.chats' }>,
	signal?: AbortSignal,
): Promise<DaemonResponseData> {
	const result = await requestDaemonResult(home, body, { signal });
	if (!result.data) {
		throw new DaemonProtocolError('INVALID_RESPONSE', `Daemon returned no data for ${body.command}`);
	}
	return result.data;
}

export interface DaemonRequestOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export async function requestDaemonResult(
	home: string,
	body: DaemonRequestBody,
	options: DaemonRequestOptions = {},
): Promise<DaemonCommandResult> {
	const token = await getOrCreateDaemonToken(home);
	return requestDaemonWithToken(home, token, body, options);
}

async function requestDaemonWithToken(
	home: string,
	token: string,
	body: DaemonRequestBody,
	options: DaemonRequestOptions = {},
): Promise<DaemonCommandResult> {
	const response = await sendRequest(getDaemonPaths(home).endpoint, JSON.stringify({
		version: DAEMON_PROTOCOL_VERSION,
		token,
		body,
	}), {
		connectTimeoutMs: options.timeoutMs ?? 10_000,
		responseTimeoutMs: options.timeoutMs ?? (isImmediateCommand(body) ? 10_000 : undefined),
		signal: options.signal,
	});
	let value: unknown;
	try {
		value = JSON.parse(response);
	} catch (error) {
		throw new DaemonProtocolError('INVALID_RESPONSE', 'Daemon response is not valid JSON', { cause: error });
	}
	const parsed = parseDaemonResponse(value);
	if (!parsed.ok) {
		throw new DaemonProtocolError(parsed.error.code, parsed.error.message);
	}
	return parsed.result;
}

export async function probeDaemon(home: string, timeoutMs = 500): Promise<DaemonStatus | undefined> {
	const token = await readDaemonToken(home);
	if (!token) {
		return undefined;
	}
	try {
		return (await requestDaemonWithToken(home, token, { command: 'ping' }, { timeoutMs })).status;
	} catch (error) {
		if (isUnavailableError(error)) {
			return undefined;
		}
		throw error;
	}
}

export async function ensureDaemonStarted(home: string): Promise<DaemonStatus> {
	const deadline = Date.now() + 60_000;
	let running: DaemonStatus | undefined;
	try {
		running = await probeDaemon(home, 60_000);
	} catch (error) {
		if (!(error instanceof DaemonProtocolVersionError)
			|| error.actualVersion >= DAEMON_PROTOCOL_VERSION) {
			throw error;
		}
		await stopDaemonVersion(home, error.actualVersion);
	}
	if (running) {
		return running;
	}

	await getOrCreateDaemonToken(home);
	const paths = getDaemonPaths(home);
	let lastError: unknown;
	while (Date.now() < deadline) {
		const startup = await launchDaemon(home, deadline - Date.now());
		if (startup.type === 'error') {
			throw new Error(`Daemon startup failed: ${startup.message}`);
		}
		if (startup.type === 'ready') {
			return requestDaemon(home, { command: 'status' });
		}
		while (Date.now() < deadline) {
			try {
				const status = await probeDaemon(home, Math.max(1, deadline - Date.now()));
				if (status) {
					return status;
				}
			} catch (error) {
				lastError = error;
			}
			if (!await check(paths.logFile, FILE_LOCK_OPTIONS)) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	throw new Error(`Daemon did not start within 60 seconds; see ${paths.logFile}`, { cause: lastError });
}

function launchDaemon(home: string, timeoutMs: number): Promise<DaemonStartupMessage> {
	const daemonEntry = resolveDaemonEntry();
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [daemonEntry, '--home', home], {
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			windowsHide: true,
		});
		const cleanup = () => {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('error', onError);
			child.off('exit', onExit);
			if (child.connected) {
				child.disconnect();
			}
		};
		const onError = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const onMessage = (value: unknown) => {
			let message: DaemonStartupMessage;
			try {
				message = parseDaemonStartupMessage(value);
			} catch (error) {
				onError(error);
				return;
			}
			cleanup();
			resolve(message);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
			onError(new Error(`Daemon exited before startup with ${reason}; see ${getDaemonPaths(home).logFile}`));
		};
		const timer = setTimeout(() => {
			onError(new Error(`Daemon did not start within 60 seconds; see ${getDaemonPaths(home).logFile}`));
		}, timeoutMs);
		child.once('message', onMessage);
		child.once('error', onError);
		child.once('exit', onExit);
		child.unref();
	});
}

export async function stopDaemon(home: string): Promise<void> {
	let status: DaemonStatus | undefined;
	try {
		status = await probeDaemon(home);
	} catch (error) {
		if (!(error instanceof DaemonProtocolVersionError)
			|| error.actualVersion >= DAEMON_PROTOCOL_VERSION) {
			throw error;
		}
		await stopDaemonVersion(home, error.actualVersion);
		return;
	}
	if (!status) {
		return;
	}
	await requestDaemon(home, { command: 'shutdown' });
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (!await probeDaemon(home)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error('Daemon did not stop within 30 seconds');
}

async function stopDaemonVersion(home: string, version: number): Promise<void> {
	const token = await readDaemonToken(home);
	if (!token) {
		return;
	}
	try {
		await requestDaemonVersion(home, token, version, { command: 'shutdown' }, 10_000);
	} catch (error) {
		if (!isShutdownDisconnectError(error)) {
			throw error;
		}
	}
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			await requestDaemonVersion(home, token, version, { command: 'ping' }, 500);
		} catch (error) {
			if (isUnavailableError(error)) {
				return;
			}
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Daemon protocol ${version} did not stop within 30 seconds`);
}

async function requestDaemonVersion(
	home: string,
	token: string,
	version: number,
	body: Extract<DaemonRequestBody, { command: 'ping' | 'shutdown' }>,
	timeoutMs: number,
): Promise<void> {
	const response = await sendRequest(getDaemonPaths(home).endpoint, JSON.stringify({
		version,
		token,
		body,
	}), {
		connectTimeoutMs: timeoutMs,
		responseTimeoutMs: timeoutMs,
	});
	let value: unknown;
	try {
		value = JSON.parse(response);
	} catch (error) {
		throw new DaemonProtocolError('INVALID_RESPONSE', 'Daemon response is not valid JSON', { cause: error });
	}
	if (!isRecord(value) || value['version'] !== version || typeof value['ok'] !== 'boolean') {
		throw new DaemonProtocolError('INVALID_RESPONSE', `Daemon protocol ${version} returned an invalid response`);
	}
	if (!value['ok']) {
		const responseError = value['error'];
		if (!isRecord(responseError)
			|| typeof responseError['code'] !== 'string'
			|| typeof responseError['message'] !== 'string') {
			throw new DaemonProtocolError('INVALID_RESPONSE', `Daemon protocol ${version} returned an invalid error`);
		}
		throw new DaemonProtocolError(responseError['code'], responseError['message']);
	}
}

interface SendRequestTimeouts {
	readonly connectTimeoutMs: number;
	readonly responseTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

async function sendRequest(endpoint: string, payload: string, timeouts: SendRequestTimeouts): Promise<string> {
	if (Buffer.byteLength(payload) > MAX_DAEMON_MESSAGE_BYTES) {
		throw new DaemonProtocolError('MESSAGE_TOO_LARGE', 'Daemon request exceeds the message size limit');
	}

	if (timeouts.signal?.aborted) {
		throw timeouts.signal.reason;
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let buffer = '';
		const socket = createConnection(endpoint);
		let connectTimer: NodeJS.Timeout | undefined;
		let responseTimer: NodeJS.Timeout | undefined;
		const finish = (error?: unknown, value?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			if (connectTimer) {
				clearTimeout(connectTimer);
			}
			if (responseTimer) {
				clearTimeout(responseTimer);
			}
			timeouts.signal?.removeEventListener('abort', onAbort);
			socket.destroy();
			if (error) {
				reject(error);
			} else {
				resolve(value ?? '');
			}
		};
		const onAbort = () => finish(timeouts.signal?.reason);
		timeouts.signal?.addEventListener('abort', onAbort, { once: true });

		connectTimer = setTimeout(
			() => finish(new Error(`Timed out connecting to daemon after ${timeouts.connectTimeoutMs}ms`)),
			timeouts.connectTimeoutMs,
		);
		socket.setEncoding('utf8');
		socket.once('connect', () => {
			if (connectTimer) {
				clearTimeout(connectTimer);
				connectTimer = undefined;
			}
			if (timeouts.responseTimeoutMs !== undefined) {
				responseTimer = setTimeout(
					() => finish(new Error(`Timed out waiting for daemon response after ${timeouts.responseTimeoutMs}ms`)),
					timeouts.responseTimeoutMs,
				);
			}
			socket.write(`${payload}\n`);
		});
		socket.on('data', chunk => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_DAEMON_MESSAGE_BYTES) {
				finish(new DaemonProtocolError('MESSAGE_TOO_LARGE', 'Daemon response exceeds the message size limit'));
				return;
			}
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				finish(undefined, buffer.slice(0, newline));
			}
		});
		socket.once('error', finish);
		socket.once('end', () => {
			if (!settled) {
				finish(new Error('Daemon closed the connection without a response'));
			}
		});
	});
}

function isImmediateCommand(body: DaemonRequestBody): boolean {
	return body.command === 'ping' || body.command === 'status' || body.command === 'shutdown';
}

function resolveDaemonEntry(): string {
	const adjacent = fileURLToPath(new URL('./daemonMain.js', import.meta.url));
	if (existsSync(adjacent)) {
		return adjacent;
	}
	const built = fileURLToPath(new URL('../dist/daemonMain.js', import.meta.url));
	if (existsSync(built)) {
		return built;
	}
	throw new Error('Daemon entry point was not found; run npm run build first');
}

function isUnavailableError(error: unknown): boolean {
	if (error instanceof DaemonProtocolError) {
		return false;
	}
	return isNodeError(error)
		? error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EPIPE'
		: error instanceof Error && error.message.startsWith('Timed out connecting');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}

function isShutdownDisconnectError(error: unknown): boolean {
	return isUnavailableError(error)
		|| (error instanceof Error && error.message === 'Daemon closed the connection without a response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
