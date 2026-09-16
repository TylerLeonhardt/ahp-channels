import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { inspectPlugin, resolvePluginServer } from '../../src/plugins.js';
import { createChannelEnvironment } from '../../src/mcpChannel.js';

// A test-only native-permission extension around the unmodified official
// fakechat server. Core bridge code never selects behavior by plugin name.
const pluginPath = process.argv[2];
if (!pluginPath) {
	throw new Error('Expected the installed official fakechat directory');
}
const config = resolvePluginServer(await inspectPlugin(pluginPath)).config;
const official = new Client({ name: 'fakechat-permission-fixture', version: '1.0.0' });
const server = new Server({ name: 'fakechat', version: '0.1.0-permissions-fixture' }, {
	capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
	instructions: 'Messages are from the fakechat web UI. Reply using the reply tool. Permission verdicts are handled separately.',
});
const requestSchema = z.object({
	request_id: z.string().regex(/^[a-km-z]{5}$/),
	tool_name: z.string(),
	description: z.string(),
	input_preview: z.string(),
});
type PermissionRequest = z.infer<typeof requestSchema>;
const pending = new Map<string, PermissionRequest>();

async function displayRequest(request: PermissionRequest): Promise<void> {
	const result = await official.callTool({
		name: 'reply',
		arguments: {
			text: [
				`Permission request ${request.request_id}: ${request.tool_name}`,
				request.description,
				request.input_preview,
				`Reply "yes ${request.request_id}" to allow once or "no ${request.request_id}" to deny.`,
			].join('\n'),
		},
	});
	if (result.isError) {
		throw new Error('Official fakechat could not display the permission request');
	}
}

official.setNotificationHandler(z.object({
	method: z.literal('notifications/claude/channel'),
	params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
}), async notification => {
	const { content, meta } = notification.params;
	if (meta?.user !== 'web' || meta.chat_id !== 'web') {
		throw new Error('Permission fixture accepts only the local fakechat user');
	}
	// Fakechat has no message history. This fixture command reproduces the
	// history a real chat platform retains when its UI reconnects.
	if (content === '/permissions') {
		for (const request of pending.values()) {
			await displayRequest(request);
		}
		return;
	}
	const verdict = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i.exec(content);
	if (verdict) {
		const requestId = verdict[2].toLowerCase();
		pending.delete(requestId);
		await server.notification({
			method: 'notifications/claude/channel/permission',
			params: { request_id: requestId, behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' },
		});
		return;
	}
	await server.notification(notification);
});
server.setRequestHandler(ListToolsRequestSchema, () => official.listTools());
server.setRequestHandler(CallToolRequestSchema, request => official.callTool(request.params));
server.setNotificationHandler(z.object({
	method: z.literal('notifications/claude/channel/permission_request'),
	params: requestSchema,
}), async ({ params }) => {
	pending.set(params.request_id, params);
	await displayRequest(params);
});

await official.connect(new StdioClientTransport({
	...config,
	args: [...config.args],
	env: createChannelEnvironment(config.env),
	stderr: 'inherit',
}));
server.onclose = () => {
	void official.close().catch(error => {
		console.error(`Permission fixture cleanup failed: ${String(error)}`);
		process.exitCode = 1;
	});
};
await server.connect(new StdioServerTransport());
