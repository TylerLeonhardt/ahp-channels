// Fixture-only adapter. The official fakechat HTTP UI, uploads, reply/files,
// and downloads run unmodified in a child MCP server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { createChannelEnvironment } from '../../src/mcpChannel.js';
import { inspectPlugin, resolvePluginServer } from '../../src/plugins.js';
import {
	ATTACHMENT_FIXTURE_VERSION,
	ATTACHMENT_MARKER,
	attachmentFingerprint,
	attachmentFixtureTools,
	attachmentResourceUri,
	attachmentSample,
	type AttachmentKind,
} from './attachment-contract.js';

const pluginPath = process.argv[2];
if (!pluginPath) {
	throw new Error('Expected the installed official fakechat directory');
}
const config = resolvePluginServer(await inspectPlugin(pluginPath)).config;
const official = new Client({ name: 'fakechat-attachment-fixture', version: '1.0.0' });
const server = new Server({ name: 'fakechat', version: ATTACHMENT_FIXTURE_VERSION }, {
	capabilities: { tools: {}, resources: {}, experimental: { 'claude/channel': {} } },
	instructions: 'Fixture-only attachment extension around official fakechat. In REFERENCE mode, use fixture_open_upload with fixture_resource_id from metadata; then fixture_return_upload with the same resource_id and the requested caption. Never use host filesystem tools for references. The separately labeled SHARED_TEXT case retains official upload metadata for a host read and reply/files.',
});
const uploads = new Map<string, { readonly path: string; readonly kind: AttachmentKind }>();
const resourceArgs = z.object({ resource_id: z.string().uuid() }).strict();
const returnArgs = resourceArgs.extend({ caption: z.string().min(1) });

async function uploadedResource(uri: string): Promise<{
	readonly path: string;
	readonly bytes: Buffer;
	readonly name: string;
	readonly mimeType: string;
}> {
	const upload = uploads.get(uri);
	if (!upload) {
		throw new Error('Fixture resource was not received as an official fakechat upload');
	}
	const path = await realpath(upload.path);
	if (path !== upload.path) {
		throw new Error('Fixture upload path changed after registration');
	}
	return { path, bytes: await readFile(path), name: basename(path), mimeType: attachmentSample(upload.kind).mimeType };
}

official.setNotificationHandler(z.object({
	method: z.literal('notifications/claude/channel'),
	params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
}), async ({ params: { content, meta } }) => {
	if (meta?.user !== 'web' || meta.chat_id !== 'web' || !meta.file_path) {
		throw new Error('Attachment fixture requires an actual official fakechat upload');
	}
	const match = ATTACHMENT_MARKER.exec(content);
	if (!match) {
		throw new Error('Attachment fixture requires a labeled upload scenario');
	}
	const kind = match[1] as AttachmentKind;
	const [inbox, path] = await Promise.all([
		realpath(join(homedir(), '.claude', 'channels', 'fakechat', 'inbox')),
		realpath(meta.file_path),
	]);
	const within = relative(inbox, path);
	if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
		throw new Error('Attachment fixture refuses an upload outside the official inbox');
	}
	const metadata = await stat(path);
	if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1024 * 1024
		|| extname(path) !== extname(attachmentSample(kind).filename)) {
		throw new Error('Attachment fixture accepts only small, correctly typed uploaded files');
	}
	const resourceId = randomUUID();
	uploads.set(attachmentResourceUri(resourceId), { path, kind });
	const { file_path, ...referenceMeta } = meta;
	await server.notification({
		method: 'notifications/claude/channel',
		params: {
			content,
			meta: {
				...referenceMeta,
				...(kind === 'SHARED_TEXT' ? { file_path } : {}),
				fixture_attachment_kind: kind,
				fixture_resource_id: resourceId,
				fixture_upload_name: basename(path),
			},
		},
	});
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [...(await official.listTools()).tools, ...attachmentFixtureTools],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: await Promise.all([...uploads.keys()].map(async uri => {
		const upload = await uploadedResource(uri);
		return { uri, name: upload.name, mimeType: upload.mimeType };
	})),
}));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params: { uri } }) => {
	const upload = await uploadedResource(uri);
	// Text deliberately uses a blob plus declared UTF-16 charset to exercise
	// decoding, while PNG must remain exact binary content.
	return { contents: [{ uri, mimeType: upload.mimeType, blob: upload.bytes.toString('base64') }] };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
	if (!attachmentFixtureTools.some(tool => tool.name === params.name)) {
		return official.callTool(params);
	}
	try {
		const args = (params.name === 'fixture_return_upload' ? returnArgs : resourceArgs).parse(params.arguments);
		const uri = attachmentResourceUri(args.resource_id);
		const upload = await uploadedResource(uri);
		const structuredContent = attachmentFingerprint(args.resource_id, upload.bytes);
		if (params.name === 'fixture_open_upload') {
			return {
				content: [{
					type: 'resource_link',
					uri,
					name: upload.name,
					description: 'Fixture-only upload received through official fakechat HTTP /upload.',
					mimeType: upload.mimeType,
					size: upload.bytes.length,
				}],
				structuredContent,
			};
		}
		return {
			...await official.callTool({
				name: 'reply',
				arguments: { text: returnArgs.parse(args).caption, files: [upload.path] },
			}),
			structuredContent,
		};
	} catch (error) {
		return { content: [{ type: 'text', text: String(error) }], isError: true };
	}
});

server.onclose = () => {
	void official.close().catch(error => {
		console.error(`Attachment fixture cleanup failed: ${String(error)}`);
		process.exitCode = 1;
	});
};
try {
	await official.connect(new StdioClientTransport({
		...config,
		args: [...config.args],
		env: createChannelEnvironment(config.env),
		stderr: 'inherit',
	}));
	await server.connect(new StdioServerTransport());
} catch (error) {
	await official.close();
	throw error;
}
