import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ChannelOperationError, failureFromError } from '../src/channelHealth.js';
import { McpChannelProcess, createChannelEnvironment } from '../src/mcpChannel.js';

const temporaryDirectories: string[] = [];
const fixtureServer = fileURLToPath(new URL('./fixtures/fake-plugin/server.mjs', import.meta.url));
const silentLogWriter = {
	write(_chunk: string): void { },
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('McpChannelProcess', () => {
	it('reports a missing runtime with installation and daemon PATH guidance, without exposing arguments or environment', async () => {
		const command = `ahp-missing-runtime-${randomUUID()}`;
		const channel = new McpChannelProcess({
			command,
			args: ['secret-argument'],
			env: { SECRET: 'secret-environment' },
		}, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof ChannelOperationError);
				assert.equal(error.stage, 'mcp-startup');
				assert.ok(error.message.includes(command));
				assert.match(error.guidance, /[Ii]nstall/);
				assert.match(error.guidance, /daemon.*PATH/);
				assert.match(error.guidance, /[Rr]estart the daemon/);
				const serialized = JSON.stringify(failureFromError(error));
				assert.ok(!serialized.includes('secret-argument'));
				assert.ok(!serialized.includes('secret-environment'));
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('reports a missing working directory without telling the user to install an existing runtime', async () => {
		const cwd = join(tmpdir(), `ahp-missing-cwd-${randomUUID()}`);
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [fixtureServer],
			cwd,
		}, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof ChannelOperationError);
				assert.match(error.message, /working directory/);
				assert.ok(error.message.includes(cwd));
				assert.doesNotMatch(error.guidance, /[Ii]nstall/);
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('reports a working-directory path that is a file', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-runtime-cwd-'));
		temporaryDirectories.push(home);
		const cwd = join(home, 'not-a-directory');
		await writeFile(cwd, '');
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [fixtureServer],
			cwd,
		}, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof ChannelOperationError);
				assert.match(error.message, /working directory/);
				assert.doesNotMatch(error.guidance, /[Ii]nstall/);
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('detects a runtime installed between attempts using the configured PATH and cwd', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-runtime-path-'));
		temporaryDirectories.push(home);
		const bin = join(home, 'bin');
		await mkdir(bin);
		const name = `ahp-runtime-${randomUUID()}${process.platform === 'win32' ? '.exe' : ''}`;
		const config = { command: name, args: [fixtureServer], cwd: home, env: { PATH: bin } };
		const missing = new McpChannelProcess(config, silentLogWriter);
		try {
			await assert.rejects(missing.start(), (error: unknown) => error instanceof ChannelOperationError);
		} finally {
			await missing.close();
		}
		const executable = join(bin, name);
		await copyFile(process.execPath, executable);
		await chmod(executable, 0o755);

		const installed = new McpChannelProcess(config, silentLogWriter);
		try {
			assert.equal((await installed.start()).name, 'fake-channel');
		} finally {
			await installed.close();
		}

		const relative = new McpChannelProcess({
			command: `.${sep}bin${sep}${name}`,
			args: [fixtureServer],
			cwd: home,
			env: { PATH: '' },
		}, silentLogWriter);
		try {
			assert.equal((await relative.start()).name, 'fake-channel');
		} finally {
			await relative.close();
		}
	});

	it('identifies an absent absolute executable without requiring PATH lookup', async () => {
		const command = join(tmpdir(), `ahp-missing-runtime-${randomUUID()}`);
		const channel = new McpChannelProcess({ command, args: [], env: { PATH: '' } }, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof ChannelOperationError);
				assert.ok(error.message.includes(command));
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('does not mistake a plugin that exits after spawn for a missing executable', async () => {
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: ['-e', 'process.exit(1)'],
		}, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(!(error instanceof ChannelOperationError));
				assert.match(error.message, /[Cc]onnection closed/);
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('preserves permission failures rather than claiming the executable is missing', {
		skip: process.platform === 'win32',
	}, async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-runtime-permission-'));
		temporaryDirectories.push(home);
		const command = join(home, 'not-executable');
		await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
		const channel = new McpChannelProcess({ command, args: [] }, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) =>
				error instanceof Error && 'code' in error && error.code === 'EACCES',
			);
		} finally {
			await channel.close();
		}
	});

	it('recognizes that ENOENT can refer to an executable script with a missing interpreter', {
		skip: process.platform === 'win32',
	}, async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-runtime-interpreter-'));
		temporaryDirectories.push(home);
		const command = join(home, 'script');
		await writeFile(command, `#!${join(home, 'missing-interpreter')}\n`, { mode: 0o755 });
		const channel = new McpChannelProcess({ command, args: [] }, silentLogWriter);
		try {
			await assert.rejects(channel.start(), (error: unknown) => {
				assert.ok(error instanceof ChannelOperationError);
				assert.match(error.message, /interpreter/);
				assert.match(error.guidance, /required interpreter/);
				return true;
			});
		} finally {
			await channel.close();
		}
	});

	it('inherits the parent environment with server overrides', () => {
		const key = 'AHP_CHANNELS_ENVIRONMENT_TEST';
		const previous = process.env[key];
		process.env[key] = 'parent';
		try {
			assert.deepEqual({
				inherited: createChannelEnvironment()[key],
				overridden: createChannelEnvironment({ [key]: 'server' })[key],
			}, {
				inherited: 'parent',
				overridden: 'server',
			});
		} finally {
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		}
	});

	it('receives channel notifications and calls tools', async () => {
		const server = fileURLToPath(new URL('./fixtures/fake-plugin/server.mjs', import.meta.url));
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [server],
		}, silentLogWriter);
		try {
			const info = await channel.start();
			const event = new Promise<{ content: string; meta?: Readonly<Record<string, string>> }>(resolve => {
				void channel.setChannelHandler(resolve);
			});
			const reply = await channel.callTool('reply', { text: 'pong' });
			const receivedEvent = await event;
			assert.match(receivedEvent.meta?.['message_id'] ?? '', /^[0-9a-f-]{36}$/);

			assert.deepEqual({
				info,
				event: receivedEvent,
				reply,
			}, {
				info: {
					name: 'fake-channel',
					instructions: 'Anything the sender should see must be sent with the reply tool.',
					tools: [{
						name: 'reply',
						description: 'Send a reply to the channel sender',
						inputSchema: {
							type: 'object',
							properties: { text: { type: 'string' } },
							required: ['text'],
						},
					}],
				},
				event: {
					content: 'hello',
					meta: {
						chat_id: '42',
						message_id: receivedEvent.meta?.['message_id'],
					},
				},
				reply: {
					success: true,
					pastTenseMessage: 'Called reply',
					content: [{ type: 'text', text: 'sent pong' }],
				},
			});
		} finally {
			await channel.close();
		}
	});

	it('reports an unexpected MCP process exit', async () => {
		const server = fileURLToPath(new URL('./fixtures/fake-plugin/server.mjs', import.meta.url));
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [server],
			env: { AHP_CHANNELS_FAKE_EXIT_MS: '500' },
		}, silentLogWriter);
		await channel.start();

		await Promise.race([
			channel.whenStopped,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP channel did not report its exit')), 3000)),
		]);
		await channel.close();
	});
});
