import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import {
	AgentHostService,
	HostAliasResolutionError,
} from '../src/agentHosts.js';
import { connectAgentHost } from '../src/ahp.js';
import { ConfigStore } from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('AgentHostService', () => {
	it('creates, refreshes, inspects, and removes a VS Code local alias', async () => {
		const { home, registry } = await createTestState();
		const firstToken = 'first-connection-secret';
		const secondToken = 'second-connection-secret';
		await writeEndpoint(registry, 'first.json', {
			instanceId: 'first-instance',
			protocolVersion: '0.1.0',
			connectionToken: firstToken,
			port: 41001,
		});
		const service = createService(home, registry);
		assert.equal((await service.resolve('standalone:')).id, `standalone:${process.pid}:first-instance`);

		const created = await service.addDiscoveredAlias('work', 'standalone:');
		assert.equal(created.state, 'available');
		assert.equal(created.endpoint?.['protocolVersion'], '0.1.0');
		assert.doesNotMatch(JSON.stringify(created), /connection-secret/);
		const stored = await new ConfigStore(home).read();
		assert.deepEqual(stored.hostAliases, {
			work: {
				kind: 'vscode-local',
				registry,
				hostType: 'standalone',
				quality: 'insider',
			},
		});
		assert.doesNotMatch(JSON.stringify(stored), /connection-secret/);

		await rm(join(registry, 'first.json'));
		await writeEndpoint(registry, 'stale.json', {
			pid: 2_147_483_647,
			instanceId: 'stale-instance',
			connectionToken: 'stale-connection-secret',
			port: 41002,
		});
		await writeEndpoint(registry, 'second.json', {
			instanceId: 'second-instance',
			connectionToken: secondToken,
			port: 41003,
		});

		const refreshed = await service.resolve('@work');
		assert.equal(refreshed.id, `standalone:${process.pid}:second-instance`);
		assert.equal(refreshed.connectionToken, secondToken);
		const inspected = await service.inspect('WORK');
		assert.equal(inspected.endpoint?.['endpoint'], '127.0.0.1:41003');
		assert.doesNotMatch(JSON.stringify(inspected), /connection-secret/);

		assert.equal(await service.removeAlias('Work'), 'work');
		await assert.rejects(
			service.resolve('@work'),
			(error: unknown) => error instanceof HostAliasResolutionError && error.code === 'unknown',
		);
	});

	it('reports unavailable and ambiguous aliases without selecting another endpoint', async () => {
		const { home, registry } = await createTestState();
		await writeEndpoint(registry, 'first.json', {
			instanceId: 'first-instance',
			connectionToken: 'first-secret',
			port: 42001,
		});
		const service = createService(home, registry);
		await service.addDiscoveredAlias('work', '0');

		await writeEndpoint(registry, 'second.json', {
			instanceId: 'second-instance',
			connectionToken: 'second-secret',
			port: 42002,
		});
		await assert.rejects(
			service.resolve('@work'),
			(error: unknown) => error instanceof HostAliasResolutionError
				&& error.code === 'ambiguous'
				&& !error.message.includes('secret'),
		);
		assert.equal((await service.inspect('work')).state, 'ambiguous');

		await rm(join(registry, 'first.json'));
		await rm(join(registry, 'second.json'));
		await assert.rejects(
			service.resolve('@work'),
			(error: unknown) => error instanceof HostAliasResolutionError && error.code === 'unavailable',
		);
		assert.equal((await service.inspect('work')).state, 'unavailable');
	});

	it('refreshes generic local credentials and rejects remote or secret-bearing URLs', async () => {
		const { home } = await createTestState();
		const tokenFile = join(home, 'host.token');
		await writeFile(tokenFile, 'first-token\n');
		const observedTokens: Array<string | null> = [];
		let initializationError: string | undefined;
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		server.on('connection', (socket, request) => {
			observedTokens.push(new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams.get('authToken'));
			socket.on('message', raw => {
				const request = JSON.parse(raw.toString()) as { readonly id?: number; readonly method?: string };
				if (request.method === 'initialize' && request.id !== undefined) {
					socket.send(JSON.stringify({
						jsonrpc: '2.0',
						id: request.id,
						...(initializationError
							? { error: { code: -32_603, message: initializationError } }
							: {
								result: {
									protocolVersion: '0.9.0',
									serverSeq: 0,
									snapshots: [],
								},
							}),
					}));
				}
			});
		});
		await once(server, 'listening');
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const service = new AgentHostService(new ConfigStore(home), {});
		await service.addExplicitAlias('generic', {
			kind: 'websocket',
			url: `ws://127.0.0.1:${address.port}/ahp?mode=local`,
			tokenFile,
			tokenQueryParameter: 'authToken',
		});

		try {
			const first = await service.resolve('@generic');
			assert.equal(first.connectionToken, 'first-token');
			const firstConnection = await connectAgentHost(first);
			await firstConnection.client.shutdown();
			await writeFile(tokenFile, 'second-token\n');
			const second = await service.resolve('@generic');
			assert.equal(second.connectionToken, 'second-token');
			assert.equal(second.endpoint.type, 'websocket');
			const secondConnection = await connectAgentHost(second);
			await secondConnection.client.shutdown();
			assert.deepEqual(observedTokens, ['first-token', 'second-token']);
			assert.doesNotMatch(JSON.stringify(await service.inspect('generic')), /first-token|second-token/);

			initializationError = 'token=third-token refused';
			await writeFile(tokenFile, 'third-token\n');
			await assert.rejects(
				connectAgentHost(await service.resolve('@generic')),
				(error: unknown) => error instanceof Error
					&& error.message.includes('token=[redacted]')
					&& !error.message.includes('third-token'),
			);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}

		await assert.rejects(
			service.addExplicitAlias('remote', {
				kind: 'websocket',
				url: 'wss://example.com/ahp',
				withoutAuthentication: true,
			}),
			/Invalid local WebSocket host alias URL/,
		);
		assert.equal((await new ConfigStore(home).read()).hostAliases['remote'], undefined);
		await assert.rejects(
			service.addExplicitAlias('embedded', {
				kind: 'websocket',
				url: 'ws://localhost:43002/?token=do-not-print',
				withoutAuthentication: true,
			}),
			(error: unknown) => error instanceof Error
				&& /Invalid local WebSocket host alias URL/.test(error.message)
				&& !error.message.includes('do-not-print'),
		);
	});

	it('keeps aliases referenced by persisted channels', async () => {
		const { home } = await createTestState();
		const store = new ConfigStore(home);
		const service = new AgentHostService(store, {});
		await service.addExplicitAlias('generic', {
			kind: 'socket',
			path: join(home, 'agent-host.sock'),
			withoutAuthentication: true,
		});
		await store.update(config => ({
			...config,
			channels: {
				personal: {
					plugin: 'fake',
					session: 'ahp-session:/one',
					chat: 'ahp-chat:/one',
					host: '@generic',
					enabled: false,
				},
			},
		}));

		await assert.rejects(
			service.removeAlias('generic'),
			/referenced by channel\(s\): personal/,
		);
		assert.ok((await store.read()).hostAliases['generic']);
		assert.equal((await store.read()).channels['personal'].session, 'ahp-session:/one');
		assert.equal((await store.read()).channels['personal'].chat, 'ahp-chat:/one');
	});

	it('wires alias lifecycle through the CLI without exposing tokens', async () => {
		const { home, registry } = await createTestState();
		const secret = 'cli-connection-secret';
		await writeEndpoint(registry, 'host.json', {
			instanceId: 'cli-instance',
			connectionToken: secret,
			port: 44001,
		});
		const environment = {
			AHP_CHANNELS_HOME: home,
			AHP_CHANNELS_ENDPOINT_REGISTRY: registry,
		};

		const added = await runCli(['host', 'alias', 'add', 'cli-host', '--host', '0'], environment);
		assert.equal(added.code, 0, added.stderr);
		assert.match(added.stdout, /@cli-host/);
		assert.doesNotMatch(`${added.stdout}${added.stderr}`, new RegExp(secret));

		const listed = await runCli(['host', 'alias', 'list', '--json'], environment);
		assert.equal(listed.code, 0, listed.stderr);
		assert.equal(JSON.parse(listed.stdout)[0]?.selector, '@cli-host');
		assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, new RegExp(secret));

		const removed = await runCli(['host', 'alias', 'remove', 'cli-host'], environment);
		assert.equal(removed.code, 0, removed.stderr);
		assert.match(removed.stdout, /Removed host alias @cli-host/);

		const tokenFile = join(home, 'generic.token');
		await writeFile(tokenFile, `${secret}\n`);
		const missingParameter = await runCli([
			'host', 'alias', 'add', 'generic',
			'--url', 'ws://127.0.0.1:44002/',
			'--token-file', tokenFile,
		], environment);
		assert.equal(missingParameter.code, 1);
		assert.match(missingParameter.stderr, /requires --token-query-parameter/);
		assert.doesNotMatch(missingParameter.stderr, new RegExp(secret));

		const generic = await runCli([
			'host', 'alias', 'add', 'generic',
			'--url', 'ws://127.0.0.1:44002/',
			'--token-file', tokenFile,
			'--token-query-parameter', 'authToken',
		], environment);
		assert.equal(generic.code, 0, generic.stderr);
		assert.match(generic.stdout, /generic/);
		assert.doesNotMatch(`${generic.stdout}${generic.stderr}`, new RegExp(secret));
		const stored = await new ConfigStore(home).read();
		assert.equal(stored.hostAliases['generic'].kind, 'websocket');
		assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));
	});
});

async function createTestState(): Promise<{ readonly home: string; readonly registry: string }> {
	const root = await mkdtemp(join(tmpdir(), 'ahp-channels-hosts-'));
	temporaryDirectories.push(root);
	const home = join(root, 'home');
	const registry = join(root, 'registry');
	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(registry, { recursive: true }),
	]);
	return { home, registry };
}

function createService(home: string, registry: string): AgentHostService {
	return new AgentHostService(new ConfigStore(home), {
		AHP_CHANNELS_ENDPOINT_REGISTRY: registry,
	});
}

async function writeEndpoint(
	registry: string,
	file: string,
	options: {
		readonly pid?: number;
		readonly instanceId: string;
		readonly protocolVersion?: string;
		readonly connectionToken: string;
		readonly port: number;
	},
): Promise<void> {
	await writeFile(join(registry, file), JSON.stringify({
		schemaVersion: 2,
		type: 'standalone',
		pid: options.pid ?? process.pid,
		instanceId: options.instanceId,
		protocolVersion: options.protocolVersion ?? '0.9.0',
		connectionToken: options.connectionToken,
		endpoint: {
			type: 'tcp',
			host: '127.0.0.1',
			port: options.port,
		},
		quality: 'insider',
	}));
}

function runCli(
	args: readonly string[],
	environment: Readonly<Record<string, string>>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [
			'--import',
			'tsx',
			join(import.meta.dirname, '..', 'src', 'cli.ts'),
			...args,
		], {
			cwd: join(import.meta.dirname, '..'),
			env: { ...process.env, ...environment },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', chunk => stderr += chunk);
		child.once('error', reject);
		child.once('exit', code => resolveRun({ code, stdout, stderr }));
	});
}
