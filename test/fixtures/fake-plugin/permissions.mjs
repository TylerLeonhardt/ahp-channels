import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server({ name: 'permission-channel', version: '1.0.0' }, {
	capabilities: {
		experimental: {
			'claude/channel': {},
			'claude/channel/permission': JSON.parse(process.env.FAKE_PERMISSION_CAPABILITY ?? '{}'),
		},
		tools: {},
	},
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [{ name: 'verdict', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
	await server.notification({ method: 'notifications/claude/channel/permission', params: request.params.arguments });
	return { content: [{ type: 'text', text: 'verdict sent' }] };
});
server.setNotificationHandler(z.object({
	method: z.literal('notifications/claude/channel/permission_request'),
	params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
}), async ({ params }) => {
	await server.notification({
		method: 'notifications/claude/channel',
		params: { content: params.input_preview, meta: { request_id: params.request_id, tool_name: params.tool_name } },
	});
});
await server.connect(new StdioServerTransport());
