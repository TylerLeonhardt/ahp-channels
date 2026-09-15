import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { probeDaemon } from '../src/daemonClient.js';
import { getOrCreateDaemonToken } from '../src/daemonPaths.js';
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonProtocolError,
	parseDaemonRequest,
	parseDaemonResponse,
} from '../src/daemonProtocol.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('daemon control protocol', () => {
	it('rejects unknown request fields and incomplete responses', () => {
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
	});

	it('does not create state while probing an absent daemon', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ahp-channels-token-'));
		temporaryDirectories.push(parent);
		const home = join(parent, 'missing');

		assert.equal(await probeDaemon(home), undefined);
		await assert.rejects(access(home), (error: unknown) =>
			error instanceof Error && 'code' in error && error.code === 'ENOENT'
		);
	});
});
