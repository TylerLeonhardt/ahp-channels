import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpChannelProcess, convertToolResult, createChannelEnvironment } from '../src/mcpChannel.js';

const silentLogWriter = {
	write(_chunk: string): void { },
};

describe('McpChannelProcess', () => {
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

	it('converts MCP failures', () => {
		assert.deepEqual(convertToolResult('reply', {
			isError: true,
			content: [{ type: 'text', text: 'nope' }],
		}), {
			success: false,
			pastTenseMessage: 'Failed to call reply',
			content: [{ type: 'text', text: 'nope' }],
			error: { message: 'nope' },
		});
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
