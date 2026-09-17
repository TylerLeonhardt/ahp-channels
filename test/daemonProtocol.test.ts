import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { probeDaemon, stopDaemon } from '../src/daemonClient.js';
import { getDaemonPaths, getOrCreateDaemonToken, readDaemonToken } from '../src/daemonPaths.js';
import { parseDaemonStartupMessage } from '../src/daemonStartup.js';
import { FILE_LOCK_OPTIONS } from '../src/lockedFile.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolError,
	DaemonProtocolVersionError,
	parseDaemonRequest,
	parseDaemonResponse,
} from '../src/daemonProtocol.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('daemon control protocol', () => {
	it('validates startup messages', () => {
		assert.deepEqual(parseDaemonStartupMessage({ type: 'ready' }), { type: 'ready' });
		assert.deepEqual(parseDaemonStartupMessage({ type: 'busy' }), { type: 'busy' });
		assert.deepEqual(parseDaemonStartupMessage({ type: 'error', message: 'cannot open log' }), {
			type: 'error',
			message: 'cannot open log',
		});
		for (const value of [null, {}, { type: 'unknown' }, { type: 'error', message: 42 }]) {
			assert.throws(() => parseDaemonStartupMessage(value), /Invalid daemon startup message/);
		}
	});

	it('rejects unknown request fields and incomplete responses', () => {
		assert.throws(
			() => parseDaemonResponse({
				version: DAEMON_PROTOCOL_VERSION - 1,
				ok: false,
				error: { code: 'VERSION_MISMATCH', message: 'upgrade' },
			}),
			(error: unknown) => error instanceof DaemonProtocolVersionError
				&& error.actualVersion === DAEMON_PROTOCOL_VERSION - 1,
		);
		assert.throws(
			() => parseDaemonRequest({
				version: DAEMON_PROTOCOL_VERSION,
				token: 'x'.repeat(32),
				body: { command: 'ping', unexpected: true },
			}),
			(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_REQUEST',
		);
		assert.throws(
			() => parseDaemonResponse({
				version: DAEMON_PROTOCOL_VERSION,
				ok: true,
				result: { pid: 1, startedAt: 'now', channels: [{ name: 'incomplete' }] },
			}),
			(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_RESPONSE',
		);
		assert.throws(
			() => parseDaemonResponse({
				version: DAEMON_PROTOCOL_VERSION,
				ok: true,
				result: {
					pid: 1,
					startedAt: new Date(0).toISOString(),
					channels: [{
						name: 'personal',
						desired: 'running',
						state: 'error',
						definition: {
							plugin: 'fake',
							session: 'ahp-session:/one',
							enabled: true,
						},
						health: {
							state: 'unhealthy',
							failure: {
								stage: 'message-text-guessed-stage',
								summary: 'failed',
								failedAt: new Date(0).toISOString(),
								guidance: 'fix it',
							},
						},
					}],
				},
			}),
			(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_RESPONSE',
		);
		assert.throws(
			() => parseDaemonRequest({
				version: DAEMON_PROTOCOL_VERSION,
				token: 'x'.repeat(32),
				body: {
					command: 'channel.repin',
					name: 'personal',
					installation: '../outside',
				},
			}),
			(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_REQUEST',
		);
		assert.deepEqual(
			parseDaemonRequest({
				version: DAEMON_PROTOCOL_VERSION,
				token: 'x'.repeat(32),
				body: {
					command: 'channel.rehost',
					name: 'personal',
					host: '@local',
				},
			}).body,
			{
				command: 'channel.rehost',
				name: 'personal',
				host: '@local',
			},
		);
		const sourceBindingId = randomUUID();
		assert.deepEqual(
			parseDaemonRequest({
				version: DAEMON_PROTOCOL_VERSION,
				token: 'x'.repeat(32),
				body: {
					command: 'channel.handoff.request',
					name: 'personal',
					sourceBindingId,
					target: {
						host: '@destination',
						session: 'ahp-session:/destination',
						chat: 'ahp-chat:/destination',
					},
				},
			}).body,
			{
				command: 'channel.handoff.request',
				name: 'personal',
				sourceBindingId,
				target: {
					host: '@destination',
					session: 'ahp-session:/destination',
					chat: 'ahp-chat:/destination',
				},
			},
		);
		assert.throws(
			() => parseDaemonRequest({
				version: DAEMON_PROTOCOL_VERSION,
				token: 'x'.repeat(32),
				body: {
					command: 'channel.handoff.cancel',
					name: 'personal',
					sourceBindingId: 'not-a-binding-id',
					requestId: randomUUID(),
				},
			}),
			(error: unknown) => error instanceof DaemonProtocolError && error.code === 'INVALID_REQUEST',
		);
	});

	it('creates one stable token under concurrent access', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-token-'));
		temporaryDirectories.push(home);

		const tokens = await Promise.all([
			getOrCreateDaemonToken(home),
			getOrCreateDaemonToken(home),
			getOrCreateDaemonToken(home),
		]);

		assert.equal(new Set(tokens).size, 1);
		assert.match(tokens[0], /^[A-Za-z0-9_-]{43}$/);
		assert.equal(await readDaemonToken(home), tokens[0]);
		if (process.platform !== 'win32') {
			assert.equal((await stat(getDaemonPaths(home).tokenFile)).mode & 0o777, 0o600);
		}
	});

	it('waits for the token creation lock without exposing an unfinished token', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-token-'));
		temporaryDirectories.push(home);
		const { tokenFile } = getDaemonPaths(home);
		const release = await lock(tokenFile, FILE_LOCK_OPTIONS);
		const creating = getOrCreateDaemonToken(home);
		try {
			assert.equal(await Promise.race([
				creating.then(() => 'created'),
				setTimeout(100, 'locked'),
			]), 'locked');
			assert.equal(await readDaemonToken(home), undefined);
			assert.equal(await probeDaemon(home), undefined);
		} finally {
			await release();
			await creating;
		}
		const token = await creating;
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(await readDaemonToken(home), token);
		assert.equal(await getOrCreateDaemonToken(home), token);
	});

	for (const invalid of ['', 'not-a-token']) {
		it(`rejects ${invalid ? 'malformed' : 'empty'} existing token files without replacing them`, async () => {
			const home = await mkdtemp(join(tmpdir(), 'ahp-channels-token-'));
			temporaryDirectories.push(home);
			const { tokenFile } = getDaemonPaths(home);
			await writeFile(tokenFile, invalid, { mode: 0o600 });

			await assert.rejects(readDaemonToken(home), /Invalid daemon token file/);
			await assert.rejects(getOrCreateDaemonToken(home), /Invalid daemon token file/);
			assert.equal(await readFile(tokenFile, 'utf8'), invalid);
		});
	}

	it('does not create state while probing an absent daemon', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ahp-channels-token-'));
		temporaryDirectories.push(parent);
		const home = join(parent, 'missing');

		assert.equal(await probeDaemon(home), undefined);
		await assert.rejects(access(home), (error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'ENOENT'
		);
	});

	it('stops an older daemon using its advertised protocol version', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-old-daemon-'));
		temporaryDirectories.push(home);
		const token = await getOrCreateDaemonToken(home);
		const requests: Array<{ readonly version: number; readonly command: string }> = [];
		const server = createServer(socket => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buffer += chunk;
				const newline = buffer.indexOf('\n');
				if (newline < 0) {
					return;
				}
				const request = JSON.parse(buffer.slice(0, newline)) as {
					readonly version: number;
					readonly token: string;
					readonly body: { readonly command: string };
				};
				assert.equal(request.token, token);
				requests.push({ version: request.version, command: request.body.command });
				if (request.version === DAEMON_PROTOCOL_VERSION) {
					socket.end(`${JSON.stringify({
						version: DAEMON_PROTOCOL_VERSION - 1,
						ok: false,
						error: { code: 'INVALID_REQUEST', message: 'unsupported protocol' },
					})}\n`);
					return;
				}
				assert.equal(request.version, DAEMON_PROTOCOL_VERSION - 1);
				assert.equal(request.body.command, 'shutdown');
				socket.end();
				server.close();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(getDaemonPaths(home).endpoint, resolve);
		});

		try {
			await stopDaemon(home);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			}
		}

		assert.deepEqual(requests, [
			{ version: DAEMON_PROTOCOL_VERSION, command: 'ping' },
			{ version: DAEMON_PROTOCOL_VERSION - 1, command: 'shutdown' },
		]);
	});
});
