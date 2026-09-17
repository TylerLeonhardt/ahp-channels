import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http, { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { createHttpPatch, LogLevel, type ProxyAgentParams } from '@vscode/proxy-agent';
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
		socketPath = createSocketPath();
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
		socketPath = createSocketPath();
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

	for (const proxySupport of ['on', 'override', 'fallback'] as const) {
		it(`keeps the local socket endpoint with VS Code proxy support '${proxySupport}'`, async context => {
			const params: ProxyAgentParams = {
				resolveProxy: async () => 'DIRECT',
				getProxyURL: () => undefined,
				getProxySupport: () => proxySupport,
				isAdditionalFetchSupportEnabled: () => false,
				isWebSocketPatchEnabled: () => false,
				addCertificatesV1: () => false,
				addCertificatesV2: () => false,
				loadSystemCertificatesFromNode: () => false,
				loadAdditionalCertificates: async () => [],
				log: { trace() { }, debug() { }, info() { }, warn() { }, error() { } },
				getLogLevel: () => LogLevel.Off,
				proxyResolveTelemetry() { },
				isUseHostProxyEnabled: () => false,
				env: {},
			};
			const patch = createHttpPatch(params, http, (_flags, _request, _options, _url, callback) => callback('DIRECT'));
			context.mock.method(http, 'request', patch.request);
			socketPath = createSocketPath();
			server = createServer();
			webSocketServer = new WebSocketServer({ server });
			webSocketServer.once('connection', (socket, request) => {
				assert.equal(new URL(request.url ?? '/', 'http://localhost').searchParams.get('auth'), 'test-token');
				socket.on('message', (data, isBinary) => {
					socket.send(data, { binary: isBinary });
					socket.send(Buffer.from([1, 2, 3]));
				});
			});
			await new Promise<void>((resolve, reject) => {
				server?.once('error', reject);
				server?.listen(socketPath, resolve);
			});

			const transport = await SocketWebSocketTransport.connect(socketPath, 'test-token', 'auth');
			try {
				await transport.send('hello');
				assert.deepEqual(await transport.recv(), { kind: 'text', text: 'hello' });
				assert.deepEqual(await transport.recv(), { kind: 'binary', data: new Uint8Array([1, 2, 3]) });
			} finally {
				await transport.close();
			}
		});
	}

	it('reports a missing socket without leaking its connection token', async () => {
		await assert.rejects(
			SocketWebSocketTransport.connect(createSocketPath(), 'test-token'),
			(error: unknown) => error instanceof Error
				&& /websocket failed to open/.test(error.message)
				&& /ENOENT/.test(error.message)
				&& !error.message.includes('test-token'),
		);
	});
});

function createSocketPath(): string {
	return process.platform === 'win32'
		? `\\\\.\\pipe\\ahp-channels-test-${randomUUID()}`
		: join(tmpdir(), `ahp-${randomUUID()}.sock`);
}
