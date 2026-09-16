import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import WebSocket from 'ws';
import { DeterministicAgentHost } from '../scripts/deterministic-agent-host.js';
import { discoverLocalAgentHosts } from '../src/endpoints.js';

it('logs long fixture errors and closes the connection without exceeding WebSocket limits', { timeout: 10_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), 'ahp-host-test-'));
	const host = new DeterministicAgentHost(root);
	context.after(async () => {
		try {
			await host.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const log = context.mock.method(console, 'error', () => undefined);
	await host.start();
	const [endpoint] = await discoverLocalAgentHosts({ AHP_CHANNELS_ENDPOINT_REGISTRY: root });
	assert.ok(endpoint?.endpoint.type === 'tcp');
	const url = new URL(`ws://${endpoint.endpoint.host}:${endpoint.endpoint.port}/`);
	url.searchParams.set('tkn', endpoint.connectionToken);
	const socket = new WebSocket(url);
	context.after(() => socket.terminate());
	await once(socket, 'open');
	const closed = once(socket, 'close');
	socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'x'.repeat(256), params: null }));
	const [code, reason] = await closed;
	assert.equal(code, 1011);
	assert.ok(Buffer.isBuffer(reason));
	assert.equal(reason.toString(), 'Message handling failed');
	assert.ok(reason.byteLength <= 123);
	assert.equal(log.mock.callCount(), 1);
	const error: unknown = log.mock.calls[0].arguments[1];
	assert.ok(error instanceof Error);
	assert.match(error.message, /^Invalid x+ params$/);
	assert.ok(Buffer.byteLength(error.message) > 123, 'The full failure must be logged separately');
});
