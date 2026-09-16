import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const rawPort = process.env['AHP_CHANNEL_HANDOFF_FIXTURE_PORT'];
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
	throw new Error('AHP_CHANNEL_HANDOFF_FIXTURE_PORT must be a valid TCP port');
}

const channel = new WebSocketServer({ host: '127.0.0.1', port });
const clients = new Set<WebSocket>();
const server = new Server({
	name: 'handoff-channel-fixture',
	version: '1.0.0',
}, {
	capabilities: {
		tools: {},
		experimental: { 'claude/channel': {} },
	},
	instructions: 'Messages arrive from the isolated handoff fixture. Reply with the reply tool.',
});

channel.on('connection', socket => {
	clients.add(socket);
	socket.on('message', data => {
		void forwardMessage(data).catch(error => {
			console.error(`Handoff fixture could not forward a message: ${formatError(error)}`);
			socket.close(1011, 'message forwarding failed');
		});
	});
	socket.once('close', () => clients.delete(socket));
});

server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: [{
		name: 'reply',
		description: 'Send an exact reply to the isolated external channel client.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string' },
			},
			required: ['text'],
		},
	}],
}));

server.setRequestHandler(CallToolRequestSchema, request => {
	if (request.params.name !== 'reply') {
		throw new Error(`Unknown handoff fixture tool '${request.params.name}'`);
	}
	const text = request.params.arguments?.['text'];
	if (typeof text !== 'string') {
		throw new Error('reply.text must be a string');
	}
	const message = JSON.stringify({ type: 'assistant', text });
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(message);
		}
	}
	return {
		content: [{ type: 'text', text: 'sent' }],
	};
});

server.onclose = () => {
	for (const client of clients) {
		client.close();
	}
	clients.clear();
	channel.close(error => {
		if (error) {
			console.error(`Handoff fixture cleanup failed: ${error.message}`);
			process.exitCode = 1;
		}
	});
};

await server.connect(new StdioServerTransport());

async function forwardMessage(data: RawData): Promise<void> {
	let value: unknown;
	try {
		value = JSON.parse(String(data));
	} catch (error) {
		throw new Error('External handoff fixture message is not valid JSON', { cause: error });
	}
	if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['text'] !== 'string') {
		throw new Error('External handoff fixture message requires string id and text fields');
	}
	await server.notification({
		method: 'notifications/claude/channel',
		params: {
			content: value['text'],
			meta: { event_id: value['id'] },
		},
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
