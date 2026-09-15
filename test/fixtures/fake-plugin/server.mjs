import { appendFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
	{ name: 'fake-channel', version: '1.0.0' },
	{
		capabilities: {
			experimental: { 'claude/channel': {} },
			tools: {},
		},
		instructions: 'Anything the sender should see must be sent with the reply tool.',
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [{
		name: 'reply',
		description: 'Send a reply to the channel sender',
		inputSchema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
		},
	}],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
	const text = String(request.params.arguments?.text ?? '');
	if (process.env.AHP_CHANNELS_FAKE_OUTPUT) {
		await appendFile(process.env.AHP_CHANNELS_FAKE_OUTPUT, `${text}\n`, 'utf8');
	}
	return {
		content: [{
			type: 'text',
			text: `sent ${text}`,
		}],
	};
});

await server.connect(new StdioServerTransport());
if (process.env.AHP_CHANNELS_FAKE_EXIT_MS) {
	setTimeout(() => process.exit(17), Number(process.env.AHP_CHANNELS_FAKE_EXIT_MS));
}
setTimeout(() => {
	void server.notification({
		method: 'notifications/claude/channel',
		params: {
			content: process.env.AHP_CHANNELS_FAKE_MESSAGE ?? 'hello',
			meta: { chat_id: '42' },
		},
	});
}, 20);
