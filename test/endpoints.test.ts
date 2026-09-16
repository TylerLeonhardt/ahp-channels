import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { describeEndpoint, discoverLocalAgentHosts, selectAgentHost } from '../src/endpoints.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('local Agent Host discovery', () => {
	it('validates, redacts, and selects live endpoints', async () => {
		const registry = await mkdtemp(join(tmpdir(), 'ahp-channels-endpoint-'));
		temporaryDirectories.push(registry);
		await writeFile(join(registry, 'valid.json'), JSON.stringify({
			schemaVersion: 2,
			type: 'standalone',
			pid: process.pid,
			instanceId: 'instance',
			protocolVersion: '0.9.0',
			connectionToken: 'secret',
			endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 },
		}));
		await writeFile(join(registry, 'invalid.json'), '{}');
		await writeFile(join(registry, 'socket.json'), JSON.stringify({
			schemaVersion: 2,
			type: 'editor',
			pid: process.pid,
			instanceId: 'socket-instance',
			protocolVersion: '0.9.0',
			connectionToken: 'socket-secret',
			endpoint: { type: 'socket', path: '\\\\.\\pipe\\agent-host-test' },
		}));

		const endpoints = await discoverLocalAgentHosts({
			AHP_CHANNELS_ENDPOINT_REGISTRY: registry,
		});
		const selected = selectAgentHost(endpoints, 'standalone:');

		assert.deepEqual({
			count: endpoints.length,
			selected: selected.endpoint,
			description: describeEndpoint(selected, 0),
			exposesToken: Object.hasOwn(describeEndpoint(selected), 'connectionToken'),
		}, {
			count: 2,
			selected: { type: 'tcp', host: '127.0.0.1', port: 1234 },
			description: {
				index: 0,
				id: `standalone:${process.pid}:instance`,
				type: 'standalone',
				pid: process.pid,
				protocolVersion: '0.9.0',
				endpoint: '127.0.0.1:1234',
				registry,
			},
			exposesToken: false,
		});
		assert.equal(selectAgentHost(endpoints), endpoints[0]);
	});
});
