import { createConnection } from 'node:net';
import { TransportError, type AhpTransport, type JsonRpcMessage, type TransportFrame } from '@microsoft/agent-host-protocol/client';
import WebSocket, { type RawData } from 'ws';

interface PendingRead {
	resolve(value: TransportFrame | null): void;
	reject(error: Error): void;
}

export class SocketWebSocketTransport implements AhpTransport {
	private readonly inbox: Array<TransportFrame | null> = [];
	private readonly waiters: PendingRead[] = [];
	private error: TransportError | undefined;
	private closed = false;

	static connect(
		socketPath: string,
		connectionToken?: string,
		connectionTokenQueryParameter = 'tkn',
	): Promise<SocketWebSocketTransport> {
		return new Promise((resolve, reject) => {
			const url = new URL('ws://localhost/');
			if (connectionToken !== undefined) {
				url.searchParams.set(connectionTokenQueryParameter, connectionToken);
			}
			const socket = new WebSocket(url, {
				createConnection: () => createConnection(socketPath),
				handshakeTimeout: 10_000,
				perMessageDeflate: false,
			});

			const cleanup = () => {
				socket.off('open', onOpen);
				socket.off('error', onError);
				socket.off('close', onClose);
			};
			const onOpen = () => {
				cleanup();
				resolve(new SocketWebSocketTransport(socket));
			};
			const onError = (error: Error) => {
				cleanup();
				socket.terminate();
				reject(new TransportError('io', `websocket failed to open: ${error.message}`, { cause: error }));
			};
			const onClose = (code: number) => {
				cleanup();
				reject(new TransportError('closed', `websocket closed before open (code=${code})`));
			};
			socket.once('open', onOpen);
			socket.once('error', onError);
			socket.once('close', onClose);
		});
	}

	private constructor(private readonly socket: WebSocket) {
		socket.on('message', (data, isBinary) => {
			if (isBinary) {
				this.deliver({ kind: 'binary', data: toUint8Array(data) });
			} else {
				this.deliver({ kind: 'text', text: rawDataToString(data) });
			}
		});
		socket.on('error', error => {
			const transportError = new TransportError('io', `websocket error: ${error.message}`, { cause: error });
			this.error = transportError;
			this.drainWithError(transportError);
		});
		socket.on('close', (code, reason) => {
			this.closed = true;
			if (this.error) {
				return;
			}
			if (code === 1000 || code === 1005) {
				this.drainWithNull();
			} else {
				const transportError = new TransportError(
					'closed',
					`websocket closed abnormally (code=${code}, reason=${reason.toString()})`,
				);
				this.error = transportError;
				this.drainWithError(transportError);
			}
		});
	}

	send(message: JsonRpcMessage | string): Promise<void> {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new TransportError('closed', 'transport closed');
		}
		if (this.error) {
			throw this.error;
		}
		const payload = typeof message === 'string' ? message : JSON.stringify(message);
		return new Promise((resolve, reject) => {
			this.socket.send(payload, error => {
				if (error) {
					reject(new TransportError('io', `websocket send failed: ${error.message}`, { cause: error }));
				} else {
					resolve();
				}
			});
		});
	}

	recv(): Promise<TransportFrame | null> {
		if (this.error) {
			return Promise.reject(this.error);
		}
		const frame = this.inbox.shift();
		if (frame !== undefined) {
			return Promise.resolve(frame);
		}
		if (this.closed) {
			return Promise.resolve(null);
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	async close(): Promise<void> {
		if (this.closed || this.socket.readyState === WebSocket.CLOSED) {
			return;
		}
		if (this.socket.readyState === WebSocket.CONNECTING) {
			this.socket.terminate();
			return;
		}

		await new Promise<void>(resolve => {
			const timeout = setTimeout(() => {
				this.socket.terminate();
				resolve();
			}, 2000);
			timeout.unref();
			this.socket.once('close', () => {
				clearTimeout(timeout);
				resolve();
			});
			this.socket.close(1000);
		});
	}

	private deliver(frame: TransportFrame | null): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve(frame);
		} else {
			this.inbox.push(frame);
		}
	}

	private drainWithError(error: TransportError): void {
		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(error);
		}
	}

	private drainWithNull(): void {
		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve(null);
		}
	}
}

function rawDataToString(data: RawData): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return data instanceof ArrayBuffer
		? Buffer.from(data).toString('utf8')
		: data.toString('utf8');
}

function toUint8Array(data: RawData): Uint8Array {
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	return data instanceof ArrayBuffer
		? new Uint8Array(data)
		: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
