import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { SocketWebSocketTransport } from '../src/socketWebSocketTransport.js';

let server: Server | undefined;
let webSocketServer: WebSocketServer | undefined;
let socketPath: string | undefined;

afterEach(async () => {
	if (webSocketServer) {
		await new Promise<void>(resolve => webSocketServer?.close(() => resolve()));
	}
	if (server) {
		await new Promise<void>(resolve => server?.close(() => resolve()));
	}
	if (socketPath && process.platform !== 'win32') {
		await rm(socketPath, { force: true });
	}
	server = undefined;
	webSocketServer = undefined;
	socketPath = undefined;
});

describe('SocketWebSocketTransport', () => {
	it('carries AHP frames over a named pipe or Unix socket', async () => {
		socketPath = process.platform === 'win32'
			? `\\\\.\\pipe\\ahp-channels-test-${randomUUID()}`
			: join(tmpdir(), `ahp-channels-test-${randomUUID()}.sock`);
		server = createServer();
		webSocketServer = new WebSocketServer({ server });
		const connected = new Promise<void>(resolve => {
			webSocketServer?.once('connection', (socket, request) => {
				assert.equal(new URL(request.url ?? '/', 'http://localhost').searchParams.get('tkn'), 'secret');
				socket.once('message', data => {
					socket.send(data.toString());
					socket.send(Buffer.from([1, 2, 3]));
				});
				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server?.once('error', reject);
			server?.listen(socketPath, resolve);
		});

		const transport = await SocketWebSocketTransport.connect(socketPath, 'secret');
		await connected;
		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'ping',
			params: { channel: 'ahp-root://' },
		});
		const text = await transport.recv();
		const binary = await transport.recv();
		await transport.close();

		assert.deepEqual({
			text,
			binary: binary?.kind === 'binary' ? [...binary.data] : binary,
		}, {
			text: {
				kind: 'text',
				text: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"channel":"ahp-root://"}}',
			},
			binary: [1, 2, 3],
		});
	});

	it('treats a completed close without a status code as clean', async () => {
		socketPath = process.platform === 'win32'
			? `\\\\.\\pipe\\ahp-channels-test-${randomUUID()}`
			: join(tmpdir(), `ahp-channels-test-${randomUUID()}.sock`);
		server = createServer();
		webSocketServer = new WebSocketServer({ server });
		webSocketServer.once('connection', socket => socket.close());
		await new Promise<void>((resolve, reject) => {
			server?.once('error', reject);
			server?.listen(socketPath, resolve);
		});

		const transport = await SocketWebSocketTransport.connect(socketPath, 'secret');

		assert.equal(await transport.recv(), null);
	});
});
