import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { lockSync } from 'proper-lockfile';
import { FILE_LOCK_OPTIONS } from './lockedFile.js';

export const DEFAULT_DAEMON_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_DAEMON_LOG_RETAINED_FILES = 3;

export interface LogWriter {
	write(chunk: string): void;
}

export interface DaemonLogger extends LogWriter {
	info(message: string): void;
	error(message: string): void;
	close(): void;
}

export class RotatingDaemonLogger implements DaemonLogger {
	private descriptor: number | undefined;
	private releaseLock: (() => void) | undefined;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.releaseLock = lockSync(path, FILE_LOCK_OPTIONS);
		try {
			this.descriptor = openSync(path, 'a+', 0o600);
			const metadata = fstatSync(this.descriptor);
			if (!metadata.isFile()) {
				throw new Error(`Daemon log is not a regular file: ${path}`);
			}
			const size = metadata.size;
			if (size > DEFAULT_DAEMON_LOG_MAX_BYTES) {
				this.retainNewestBytes(this.descriptor, size);
			}
		} catch (error) {
			try {
				this.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], `Failed to open and clean up daemon log: ${path}`);
			}
			throw error;
		}
	}

	write(chunk: string): void {
		let descriptor = this.descriptor;
		if (descriptor === undefined) {
			throw new Error('Daemon log is closed');
		}
		let content = Buffer.from(chunk);
		if (content.length > DEFAULT_DAEMON_LOG_MAX_BYTES) {
			content = content.subarray(content.length - DEFAULT_DAEMON_LOG_MAX_BYTES);
		}
		const size = fstatSync(descriptor).size;
		if (size > 0 && size + content.length > DEFAULT_DAEMON_LOG_MAX_BYTES) {
			descriptor = this.rotate(descriptor);
		}
		writeAll(descriptor, content);
	}

	info(message: string): void {
		this.write(`${message}\n`);
	}

	error(message: string): void {
		this.write(`${message}\n`);
	}

	close(): void {
		const descriptor = this.descriptor;
		const releaseLock = this.releaseLock;
		this.descriptor = undefined;
		this.releaseLock = undefined;
		try {
			if (descriptor !== undefined) {
				closeSync(descriptor);
			}
		} finally {
			releaseLock?.();
		}
	}

	private retainNewestBytes(descriptor: number, size: number): void {
		const content = Buffer.alloc(DEFAULT_DAEMON_LOG_MAX_BYTES);
		let offset = 0;
		while (offset < content.length) {
			const length = readSync(descriptor, content, offset, content.length - offset, size - content.length + offset);
			if (length === 0) {
				throw new Error(`Daemon log changed while reading its retained tail: ${this.path}`);
			}
			offset += length;
		}
		closeSync(descriptor);
		this.descriptor = undefined;
		writeFileSync(this.path, content, { mode: 0o600 });
		this.descriptor = openSync(this.path, 'a', 0o600);
	}

	private rotate(descriptor: number): number {
		closeSync(descriptor);
		this.descriptor = undefined;
		try {
			rmSync(rotatedPath(this.path, DEFAULT_DAEMON_LOG_RETAINED_FILES), { force: true });
			for (let index = DEFAULT_DAEMON_LOG_RETAINED_FILES - 1; index >= 1; index--) {
				const source = rotatedPath(this.path, index);
				if (existsSync(source)) {
					renameSync(source, rotatedPath(this.path, index + 1));
				}
			}
			if (existsSync(this.path)) {
				renameSync(this.path, rotatedPath(this.path, 1));
			}
			this.descriptor = openSync(this.path, 'a', 0o600);
			return this.descriptor;
		} catch (error) {
			try {
				this.descriptor = openSync(this.path, 'a', 0o600);
			} catch (reopenError) {
				throw new AggregateError([error, reopenError], `Failed to rotate and reopen daemon log: ${this.path}`);
			}
			throw error;
		}
	}
}

export class ConsoleDaemonLogger implements DaemonLogger {
	write(chunk: string): void {
		process.stderr.write(chunk);
	}

	info(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	error(message: string): void {
		process.stderr.write(`${message}\n`);
	}

	close(): void { }
}

export function rotatedPath(path: string, index: number): string {
	return `${path}.${index}`;
}

function writeAll(descriptor: number, content: Buffer): void {
	let offset = 0;
	while (offset < content.length) {
		const length = writeSync(descriptor, content, offset);
		if (length === 0) {
			throw new Error('Daemon log write made no progress');
		}
		offset += length;
	}
}
