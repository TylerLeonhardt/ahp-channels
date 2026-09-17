import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { raceAbort } from '../../src/async.js';
import { HANDOFF_RESOURCE_TOOL, handoffResourceContents, handoffResourceUri } from './handoff-resource.js';

const rawPort = process.env['AHP_CHANNEL_HANDOFF_FIXTURE_PORT'];
const port = Number(rawPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
	throw new Error('AHP_CHANNEL_HANDOFF_FIXTURE_PORT must be a valid TCP port');
}

const channel = new WebSocketServer({ host: '127.0.0.1', port });
const clients = new Set<WebSocket>();
const pendingReads = new Map<string, { release(): void }>();
const server = new Server({
	name: 'handoff-channel-fixture',
	version: '1.0.0',
}, {
	capabilities: {
		tools: {},
		resources: {},
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
	}, {
		name: HANDOFF_RESOURCE_TOOL,
		description: 'Return a fixture resource link whose read is controlled by the isolated E2E client.',
		inputSchema: {
			type: 'object',
			properties: { resource_id: { type: 'string' } },
			required: ['resource_id'],
		},
	}],
}));

server.setRequestHandler(CallToolRequestSchema, request => {
	if (request.params.name === HANDOFF_RESOURCE_TOOL) {
		const id = request.params.arguments?.['resource_id'];
		if (typeof id !== 'string' || !/^[a-f0-9-]+$/.test(id)) {
			throw new Error('resource_id must be a fixture UUID');
		}
		return {
			content: [{
				type: 'resource_link',
				name: `handoff-${id}`,
				uri: handoffResourceUri(id),
			}],
		};
	}
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

server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
	const uri = request.params.uri;
	if (!/^handoff-resource:\/[a-f0-9-]+$/.test(uri) || pendingReads.has(uri)) {
		throw new Error('Unexpected or duplicate handoff fixture resource read');
	}
	let release!: () => void;
	const ready = new Promise<void>(resolve => {
		release = resolve;
	});
	pendingReads.set(uri, { release });
	broadcast({ type: 'resource-read-started', uri, pid: process.pid });
	try {
		await raceAbort(ready, extra.signal);
		return { contents: handoffResourceContents(uri) };
	} catch (error) {
		broadcast({ type: 'resource-read-cancelled', uri });
		throw error;
	} finally {
		pendingReads.delete(uri);
	}
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
	if (isRecord(value) && value['type'] === 'release-resource') {
		const uri = value['uri'];
		const pending = typeof uri === 'string' ? pendingReads.get(uri) : undefined;
		if (!pending) {
			throw new Error('Cannot release an unknown handoff fixture resource read');
		}
		pending.release();
		return;
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

function broadcast(message: Readonly<Record<string, unknown>>): void {
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify(message));
		}
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
