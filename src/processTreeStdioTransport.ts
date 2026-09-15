import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';

const GRACEFUL_EXIT_TIMEOUT_MS = 1_000;
const TERMINATE_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_POLL_MS = 25;

export class ProcessTreeStdioClientTransport implements Transport {
	private readonly readBuffer: ReadBuffer;
	private readonly stderrStream: PassThrough | null;
	private child: ChildProcess | undefined;
	private processTreePid: number | undefined;
	private exitPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	constructor(private readonly server: StdioServerParameters) {
		this.readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
		this.stderrStream = server.stderr === 'pipe' || server.stderr === 'overlapped'
			? new PassThrough()
			: null;
	}

	get stderr(): Stream | null {
		return this.stderrStream ?? this.child?.stderr ?? null;
	}

	async start(): Promise<void> {
		if (this.child || this.exitPromise) {
			throw new Error('Process tree stdio transport already started');
		}
		const child = spawn(this.server.command, this.server.args ?? [], {
			env: {
				...getDefaultEnvironment(),
				...this.server.env,
			},
			stdio: ['pipe', 'pipe', this.server.stderr ?? 'inherit'],
			shell: false,
			windowsHide: process.platform === 'win32',
			cwd: this.server.cwd,
			detached: process.platform !== 'win32',
		});
		this.child = child;
		this.processTreePid = child.pid;
		this.exitPromise = new Promise(resolve => {
			child.once('close', () => {
				if (this.child === child) {
					this.child = undefined;
				}
				resolve();
				this.onclose?.();
			});
		});
		child.stdin?.on('error', error => this.onerror?.(error));
		child.stdout?.on('data', chunk => this.processOutput(chunk));
		child.stdout?.on('error', error => this.onerror?.(error));
		if (this.stderrStream && child.stderr) {
			child.stderr.pipe(this.stderrStream);
		}

		await new Promise<void>((resolve, reject) => {
			let spawned = false;
			child.once('spawn', () => {
				spawned = true;
				resolve();
			});
			child.on('error', error => {
				if (!spawned) {
					reject(error);
				}
				this.onerror?.(error);
			});
		});
	}

	send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin) {
			throw new Error('Process tree stdio transport is not connected');
		}
		return new Promise(resolve => {
			if (stdin.write(serializeMessage(message))) {
				resolve();
			} else {
				stdin.once('drain', resolve);
			}
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeProcessTree();
		return this.closePromise;
	}

	private processOutput(chunk: Buffer): void {
		try {
			this.readBuffer.append(chunk);
			while (true) {
				const message = this.readBuffer.readMessage();
				if (message === null) {
					return;
				}
				this.onmessage?.(message);
			}
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			void this.close();
		}
	}

	private async closeProcessTree(): Promise<void> {
		try {
			this.child?.stdin?.end();
			const pid = this.processTreePid;
			if (!pid) {
				await this.exitPromise;
				return;
			}
			if (process.platform === 'win32') {
				await closeWindowsProcess(this.child, this.exitPromise);
				return;
			}
			if (await waitForProcessGroupExit(pid, GRACEFUL_EXIT_TIMEOUT_MS)) {
				return;
			}
			signalProcessGroup(pid, 'SIGTERM');
			if (await waitForProcessGroupExit(pid, TERMINATE_TIMEOUT_MS)) {
				return;
			}
			signalProcessGroup(pid, 'SIGKILL');
			if (!await waitForProcessGroupExit(pid, TERMINATE_TIMEOUT_MS)) {
				throw new Error(`Plugin process group ${pid} did not terminate`);
			}
		} finally {
			this.child = undefined;
			this.processTreePid = undefined;
			this.readBuffer.clear();
		}
	}
}

async function closeWindowsProcess(
	child: ChildProcess | undefined,
	exitPromise: Promise<void> | undefined,
): Promise<void> {
	if (!child || !exitPromise || await settlesWithin(exitPromise, GRACEFUL_EXIT_TIMEOUT_MS)) {
		return;
	}
	child.kill('SIGTERM');
	if (await settlesWithin(exitPromise, TERMINATE_TIMEOUT_MS)) {
		return;
	}
	child.kill('SIGKILL');
	await settlesWithin(exitPromise, TERMINATE_TIMEOUT_MS);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(pid)) {
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(PROCESS_EXIT_POLL_MS);
	}
	return true;
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === 'ESRCH') {
			return false;
		}
		if (isNodeError(error) && error.code === 'EPERM') {
			return true;
		}
		throw error;
	}
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'ESRCH') {
			throw error;
		}
	}
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>(resolve => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
