import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpChannelProcess } from '../src/mcpChannel.js';
import { supportsChannelPermissions } from '../src/mcpPermissions.js';
import type { ChannelPermissionVerdict } from '../src/channelPermissions.js';
import { normalizeChannelInitialization } from '../src/channelStdioTransport.js';

describe('MCP permission capability', () => {
	it('requires an explicit object capability and honors false opt-out', () => {
		assert.equal(supportsChannelPermissions({ 'claude/channel/permission': {} }), true);
		for (const value of [false, true, null, [], 'yes', 1, undefined]) {
			assert.equal(supportsChannelPermissions({ 'claude/channel/permission': value }), false);
		}
		assert.equal(supportsChannelPermissions(undefined), false);
	});

	it('normalizes only the permission opt-out without mutating the initialize result', () => {
		const message = {
			jsonrpc: '2.0' as const,
			id: 1,
			result: {
				capabilities: {
					experimental: { 'claude/channel': {}, 'claude/channel/permission': false, unrelated: { enabled: true } },
					tools: {},
				},
			},
		};
		const normalized = normalizeChannelInitialization(message);
		assert.deepEqual(normalized.result, {
			capabilities: { experimental: { 'claude/channel': {}, unrelated: { enabled: true } }, tools: {} },
		});
		assert.equal(message.result.capabilities.experimental['claude/channel/permission'], false);
	});

	it('uses the native permission notifications over MCP stdio', async () => {
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [fileURLToPath(new URL('./fixtures/fake-plugin/permissions.mjs', import.meta.url))],
		});
		try {
			await channel.start();
			const permissions = channel.permissions;
			assert.ok(permissions);
			const outbound = new Promise<string>(resolve => {
				void channel.setChannelHandler(event => resolve(event.content));
			});
			await permissions.sendRequest({
				request_id: 'abcde', tool_name: 'shell', description: 'Run a command', input_preview: '{"command":"echo hi"}',
			});
			assert.equal(await outbound, '{"command":"echo hi"}');
			const verdict = new Promise<ChannelPermissionVerdict>(resolve => {
				const receive = (value: ChannelPermissionVerdict) => {
					permissions.events.off('verdict', receive);
					resolve(value);
				};
				permissions.events.on('verdict', receive);
			});
			await channel.callTool('verdict', { request_id: 'abcde', behavior: 'deny' });
			assert.deepEqual(await verdict, { request_id: 'abcde', behavior: 'deny' });
		} finally {
			await channel.close();
		}
	});

	it('does not expose a relay when the server explicitly opts out', async () => {
		const channel = new McpChannelProcess({
			command: process.execPath,
			args: [fileURLToPath(new URL('./fixtures/fake-plugin/permissions.mjs', import.meta.url))],
			env: { FAKE_PERMISSION_CAPABILITY: 'false' },
		});
		try {
			await channel.start();
			assert.equal(channel.permissions, undefined);
		} finally {
			await channel.close();
		}
	});
});
