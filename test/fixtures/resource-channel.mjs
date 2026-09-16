import { appendFile, readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// A protocol fixture, not an extension to the channel notification contract.
const planPath = process.argv[2];
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const audit = event => appendFile(`${planPath}.audit`, `${JSON.stringify(event)}\n`);
const server = new Server({ name: 'resource-fixture', version: '1.0.0' }, {
	capabilities: {
		tools: {},
		...(plan.resources === false ? {} : { resources: {} }),
		experimental: { 'claude/channel': {} },
	},
	instructions: 'Use the discovered tools to retrieve resources and deliver files.',
});
server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: plan.tools.map(({ name, inputSchema, outputSchema }) => ({
		name, inputSchema: inputSchema ?? { type: 'object' }, ...(outputSchema ? { outputSchema } : {}),
	})),
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
	await audit({ method: 'tools/call', ...request.params });
	const tool = plan.tools.find(tool => tool.name === request.params.name);
	if (!tool) {
		throw new Error(`Unknown fixture tool: ${request.params.name}`);
	}
	if (tool.error) {
		throw new Error(tool.error);
	}
	if (tool.wait) {
		await waitForCancellation(extra.signal, 'tools/call');
	}
	return tool.result;
});
if (plan.resources !== false) {
	server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
		await audit({ method: 'resources/read', uri: request.params.uri });
		const resource = plan.resources?.[request.params.uri];
		if (!resource) {
			throw new Error('Fixture resource not found');
		}
		if (resource.error) {
			throw new Error(resource.error);
		}
		if (resource.wait) {
			await waitForCancellation(extra.signal, request.params.uri);
		}
		if (resource.file) {
			const data = await readFile(resource.file);
			return { contents: [{ uri: request.params.uri, mimeType: resource.mimeType, blob: data.toString('base64') }] };
		}
		return resource;
	});
}
await server.connect(new StdioServerTransport());
if (plan.event) {
	await server.notification({ method: 'notifications/claude/channel', params: plan.event });
}

async function waitForCancellation(signal, operation) {
	await new Promise(resolve => {
		signal.addEventListener('abort', resolve, { once: true });
		if (signal.aborted) {
			resolve();
		}
	});
	await audit({ cancelled: operation });
	throw new Error('Fixture request cancelled');
}
