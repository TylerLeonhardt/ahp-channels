import { ToolResultContentType, type ToolCallResult } from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, type TestContext } from 'node:test';
import { formatChannelPrompt } from '../src/channelPrompt.js';
import { McpChannelProcess } from '../src/mcpChannel.js';
import { MAX_MCP_CONTENT_BYTES, MAX_MCP_DIAGNOSTIC_BYTES, MAX_MCP_RESOURCE_LINKS } from '../src/mcpToolResult.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/resource-channel.mjs', import.meta.url));
const text = (value: string) => ({ type: 'text', text: value });
const link = (uri: string, fields: Record<string, unknown> = {}) => ({ type: 'resource_link', name: 'test resource', uri, ...fields });

describe('MCP tool content through McpChannelProcess', () => {
	it('preserves text, structured data, image/audio bytes, and resource identity and MIME types', async context => {
		const image = Buffer.from([0, 1, 2, 253, 254, 255]);
		const audio = Buffer.from('audio fixture');
		const { channel } = await startFixture(context, {
			tools: [{ name: 'payload', result: {
				content: [
					text('unchanged <text>'),
					{ type: 'image', data: ` ${image.toString('base64')}\n`, mimeType: 'IMAGE/PNG' },
					{ type: 'audio', data: audio.toString('base64').replace(/=+$/, ''), mimeType: 'audio/wav' },
					{ type: 'resource', resource: { uri: 'fixture:///notes', text: 'decoded text', mimeType: 'text/markdown' } },
					{ type: 'resource', resource: { uri: 'fixture:///document', blob: 'JVBERg==', mimeType: 'application/pdf' } },
					{ type: 'resource', resource: { uri: 'fixture:///unknown', blob: 'AAEC' } },
					{ type: 'resource', resource: { uri: 'fixture:///latin', blob: Buffer.from([0xe9]).toString('base64'), mimeType: 'text/plain; charset=windows-1252' } },
					{ type: 'resource', resource: { uri: 'fixture:///json', blob: Buffer.from('{"snow":"\u96ea"}').toString('base64'), mimeType: 'application/vnd.example+json' } },
				],
				structuredContent: { delivered: true, count: 2 },
			} }],
		});
		const result = await channel.callTool('payload', {});
		assert.equal(result.success, true);
		assert.deepEqual(result.structuredContent, { delivered: true, count: 2 });
		assert.deepEqual(result.content?.slice(0, 3), [
			{ type: 'text', text: 'unchanged <text>' },
			{ type: 'embeddedResource', data: image.toString('base64'), contentType: 'image/png' },
			{ type: 'embeddedResource', data: audio.toString('base64'), contentType: 'audio/wav' },
		]);
		assert.ok(texts(result).includes('decoded text'));
		assert.ok(texts(result).includes('\u00e9'));
		assert.ok(texts(result).includes('{"snow":"\u96ea"}'));
		assert.match(texts(result).join('\n'), /fixture:\/\/\/notes.*text\/markdown/);
		assert.ok(result.content?.some(block => block.type === ToolResultContentType.EmbeddedResource
			&& block.data === 'AAEC' && block.contentType === 'application/octet-stream'));
		assert.ok(result.content?.some(block => block.type === ToolResultContentType.EmbeddedResource
			&& block.data === 'JVBERg==' && block.contentType === 'application/pdf'));
	});

	it('reads links only from their originating MCP server, including bundles and MIME hints', async context => {
		const uri = 'opaque:bundle';
		const { channel, audit } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [
				text('before'),
				link(uri, { title: 'Bundle title', description: 'Bundle description', size: 12 }),
				link('https://example.invalid/picture', { mimeType: 'image/png' }),
				text('after'),
			] } }],
			resources: {
				[uri]: { contents: [
					{ uri: 'opaque:text', text: 'bundle text', mimeType: 'text/plain' },
					{ uri: 'opaque:bytes', blob: 'AAEC' },
				] },
				'https://example.invalid/picture': { contents: [{ uri: 'https://example.invalid/picture', blob: 'AQID' }] },
			},
		});
		const result = await channel.callTool('payload', {});
		assert.equal(result.success, true);
		assert.equal(texts(result)[0], 'before');
		assert.equal(texts(result).at(-1), 'after');
		assert.match(texts(result).join('\n'), /Bundle title.*Bundle description.*"size":12/);
		assert.ok(texts(result).includes('bundle text'));
		assert.ok(result.content?.some(block => block.type === ToolResultContentType.EmbeddedResource
			&& block.contentType === 'image/png' && block.data === 'AQID'));
		assert.deepEqual((await audit()).filter(event => event.method === 'resources/read').map(event => event.uri),
			[uri, 'https://example.invalid/picture']);
	});

	it('preserves plugin-defined file schemas and arguments without inventing outbound operations', async context => {
		const schema = {
			type: 'object',
			properties: {
				deliveries: { type: 'array', items: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
				note: { type: 'string' },
			},
			anyOf: [{ required: ['deliveries'] }, { required: ['note'] }],
			additionalProperties: false,
		};
		const outputSchema = {
			type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'], additionalProperties: false,
		};
		const { channel, info, audit } = await startFixture(context, {
			tools: [{ name: 'transfer_items', inputSchema: schema, outputSchema, result: { content: [text('sent')], structuredContent: { sent: true } } }],
		});
		const args = { deliveries: [{ location: 'C:\\disposable\\file.txt' }] };
		assert.deepEqual(info.tools[0]?.inputSchema, schema);
		assert.deepEqual(info.tools[0]?.outputSchema, outputSchema);
		assert.equal((await channel.callTool('transfer_items', args)).success, true);
		assert.deepEqual((await audit())[0], { method: 'tools/call', name: 'transfer_items', arguments: args });
	});

	it('keeps channel text and metadata opaque rather than treating them as filesystem grants', async context => {
		const outside = join(tmpdir(), 'not-a-channel-resource.txt');
		const { channel, info, audit } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [link(pathToFileURL(outside).href)] } }],
			event: {
				content: 'Read using the plugin instructions, not metadata heuristics.',
				meta: { file: outside, attachment: 'not-base64', mime_type: 'image/png', source: 'untrusted' },
			},
		});
		const received: string[] = [];
		await channel.setChannelHandler(event => {
			received.push(formatChannelPrompt(info.name, event, info.instructions));
		});
		assert.equal(received.length, 1);
		assert.match(received[0], /source="resource-fixture"/);
		assert.match(received[0], /file=".*not-a-channel-resource.txt"/);
		assert.equal((await audit()).length, 0);
		const result = await channel.callTool('payload', {});
		assert.equal(result.success, false);
		assert.match(result.error?.message ?? '', /Fixture resource not found/);
		assert.equal((await audit()).filter(event => event.method === 'resources/read').length, 1);
	});

	it('preserves tool failures and structured output', async context => {
		const { channel } = await startFixture(context, {
			tools: [{ name: 'payload', result: { isError: true, content: [text('nope')], structuredContent: { reason: 'denied' } } }],
		});
		assert.deepEqual(await channel.callTool('payload', {}), {
			success: false, pastTenseMessage: 'Failed to call payload',
			content: [text('nope')], structuredContent: { reason: 'denied' }, error: { message: 'nope' },
		});
		assert.equal((await channel.callTool('missing_tool', {})).success, false);
	});

	for (const [name, resource] of Object.entries({
		missing: undefined,
		unreadable: { file: dirname(fixtureServer) },
		empty: { contents: [] },
		malformed: { contents: [{ uri: 'fixture:///linked', blob: '?' }] },
	})) {
		it(`reports ${name} resources without losing adjacent text or the original tool error`, async context => {
			const { channel } = await startFixture(context, {
				tools: [{ name: 'payload', result: { isError: true, content: [text('original error'), link('fixture:///linked'), text('after')] } }],
				resources: { 'fixture:///linked': resource },
			});
			const result = await channel.callTool('payload', {});
			assert.equal(result.success, false);
			assert.ok(texts(result).includes('original error'));
			assert.ok(texts(result).includes('after'));
			assert.match(result.error?.message ?? '', /Failed to read MCP resource/);
		});
	}

	it('fails explicitly if a linked-resource server does not support resources/read', async context => {
		const { channel } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [link('fixture:///linked')] } }], resources: false,
		});
		assert.equal((await channel.callTool('payload', {})).success, false);
	});

	for (const [name, block] of Object.entries({
		'unknown type': { type: 'unsupported', value: 'no loss hidden as success' },
		'non-string text': { type: 'text', text: 42 },
		'invalid base64': { type: 'image', data: '%%%=', mimeType: 'image/png' },
		'invalid MIME': { type: 'image', data: 'AA==', mimeType: 'not-a-mime-type' },
		'MIME controls': { type: 'image', data: 'AA==', mimeType: 'image/png\r\nx: header' },
		'mismatched MIME': { type: 'audio', data: 'AA==', mimeType: 'image/png' },
		'invalid UTF-8': { type: 'resource', resource: { uri: 'fixture:///text', blob: '/w==', mimeType: 'text/plain' } },
		'unknown charset': { type: 'resource', resource: { uri: 'fixture:///text', blob: 'AA==', mimeType: 'text/plain; charset=not-a-charset' } },
		'missing resource URI': { type: 'resource', resource: { blob: 'AA==' } },
		'relative URI': link('relative/file.txt'),
		'URI controls': link('fixture:///a\nb'),
		'negative size': link('fixture:///file', { size: -1 }),
		'fractional size': link('fixture:///file', { size: 1.5 }),
	})) {
		it(`rejects ${name} rather than silently dropping content`, async context => {
			const { channel, audit } = await startFixture(context, {
				tools: [{ name: 'payload', result: { content: [block] } }],
			});
			const result = await channel.callTool('payload', {});
			assert.equal(result.success, false);
			assert.ok(result.error?.message);
			assert.equal((await audit()).filter(event => event.method === 'resources/read').length, 0);
		});
	}

	it('enforces real decoded byte boundaries for text, binary, and aggregate content', async context => {
		const { channel } = await startFixture(context, {
			tools: [
				{ name: 'text_limit', result: { content: [text('\u00e9'.repeat(MAX_MCP_CONTENT_BYTES / 2))] } },
				{ name: 'text_over', result: { content: [text('\u00e9'.repeat(MAX_MCP_CONTENT_BYTES / 2) + 'x')] } },
				{ name: 'escaped_limit', result: { content: [text('\n'.repeat(MAX_MCP_CONTENT_BYTES))] } },
				{ name: 'binary_limit', result: { content: [{ type: 'image', data: Buffer.alloc(MAX_MCP_CONTENT_BYTES - 'image/png'.length).toString('base64'), mimeType: 'image/png' }] } },
				{ name: 'binary_over', result: { content: [{ type: 'image', data: Buffer.alloc(MAX_MCP_CONTENT_BYTES - 'image/png'.length + 1).toString('base64'), mimeType: 'image/png' }] } },
				{ name: 'aggregate_over', result: { content: [text('x'.repeat(MAX_MCP_CONTENT_BYTES / 2)), text('y'.repeat(MAX_MCP_CONTENT_BYTES / 2 + 1))] } },
				{ name: 'structured_over', result: { content: [], structuredContent: { data: 'x'.repeat(MAX_MCP_CONTENT_BYTES) } } },
			],
		});
		for (const name of ['text_limit', 'binary_limit', 'escaped_limit']) {
			const result = await channel.callTool(name, {});
			assert.equal(result.success, true, `${name}: ${result.error?.message}`);
		}
		for (const name of ['text_over', 'binary_over', 'aggregate_over', 'structured_over']) {
			const result = await channel.callTool(name, {});
			assert.equal(result.success, false, name);
			assert.match(result.error?.message ?? '', /8 MiB/);
		}
	});

	it('counts retained MIME parameters against the real aggregate limit', async context => {
		const { channel } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [
				{ type: 'image', data: 'AA==', mimeType: `image/png;name=${'x'.repeat(MAX_MCP_CONTENT_BYTES + 1)}` },
			] } }],
		});
		const result = await channel.callTool('payload', {});
		assert.equal(result.success, false);
		assert.match(result.error?.message ?? '', /8 MiB/);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048, 'The rejected MIME payload must not be re-emitted');
	});

	it('bounds rejected URIs and server errors before emitting diagnostics', async context => {
		const hugeUri = `fixture:${'x'.repeat(MAX_MCP_CONTENT_BYTES + 1)}`;
		const hugeError = `server failure: ${'\u96ea'.repeat(MAX_MCP_CONTENT_BYTES / 2)}`;
		const { channel, audit } = await startFixture(context, {
			tools: [
				{ name: 'uri', result: { content: [link(hugeUri)] } },
				{ name: 'read_error', result: { content: [link('fixture:///error')] } },
				{ name: 'call_error', error: hugeError },
			],
			resources: { 'fixture:///error': { error: hugeError } },
		});
		for (const name of ['uri', 'read_error', 'call_error']) {
			const result = await channel.callTool(name, {});
			assert.equal(result.success, false);
			assert.match(result.error?.message ?? '', /\[truncated\]/);
			assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096, name);
			assert.equal(result.error?.message.includes('\ufffd'), false, 'Diagnostic truncation must preserve UTF-8 characters');
		}
		assert.deepEqual((await audit()).filter(event => event.method === 'resources/read').map(event => event.uri),
			['fixture:///error']);
	});

	it('caps aggregate diagnostics and keeps the failure visible after valid text', async context => {
		const original = 'valid text '.repeat(10_000);
		const { channel } = await startFixture(context, {
			tools: [
				{ name: 'many_errors', result: { content: [
					text(original),
					...Array.from({ length: 500 }, () => ({ type: 'image', data: 'AA==', mimeType: 'invalid' })),
				] } },
				{ name: 'original_error', result: { isError: true, content: [text(original)] } },
			],
		});
		const result = await channel.callTool('many_errors', {});
		assert.equal(result.success, false);
		assert.equal(texts(result)[0], original);
		assert.ok(Buffer.byteLength(texts(result).slice(1).join('\n')) <= MAX_MCP_DIAGNOSTIC_BYTES);
		assert.match(texts(result).at(-1) ?? '', /errors omitted/);
		assert.match(result.error?.message ?? '', /^Failed to translate MCP image/);
		assert.ok(Buffer.byteLength(result.error?.message ?? '') <= MAX_MCP_DIAGNOSTIC_BYTES);
		const originalError = await channel.callTool('original_error', {});
		assert.deepEqual(texts(originalError), [original]);
		assert.ok(Buffer.byteLength(originalError.error?.message ?? '') <= MAX_MCP_DIAGNOSTIC_BYTES);
		assert.match(originalError.error?.message ?? '', /\[truncated\]$/);
	});

	it('bounds resource reads using hints, actual contents, and the link count', async context => {
		const { channel, audit } = await startFixture(context, {
			tools: [
				{ name: 'hint', result: { content: [link('fixture:///large', { size: MAX_MCP_CONTENT_BYTES + 1 })] } },
				{ name: 'actual', result: { content: [link('fixture:///large', { size: 1 })] } },
				{ name: 'many', result: { content: Array.from({ length: MAX_MCP_RESOURCE_LINKS + 1 }, () => link('fixture:///large')) } },
			],
			resources: { 'fixture:///large': { contents: [{ uri: 'fixture:///large', text: 'x'.repeat(MAX_MCP_CONTENT_BYTES + 1) }] } },
		});
		for (const name of ['hint', 'actual', 'many']) {
			assert.equal((await channel.callTool(name, {})).success, false);
		}
		assert.equal((await audit()).filter(event => event.method === 'resources/read').length, 1);
	});

	it('accepts exactly the resource-link count limit', async context => {
		const { channel, audit } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: Array.from({ length: MAX_MCP_RESOURCE_LINKS }, () => link('fixture:///small')) } }],
			resources: { 'fixture:///small': { contents: [{ uri: 'fixture:///small', text: 'x' }] } },
		});
		assert.equal((await channel.callTool('payload', {})).success, true);
		assert.equal((await audit()).filter(event => event.method === 'resources/read').length, MAX_MCP_RESOURCE_LINKS);
	});

	it('times out a real pending resource read and cancels it without starting the next one', { timeout: 20_000 }, async context => {
		const { channel, audit } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [link('fixture:///slow'), link('fixture:///next')] } }],
			resources: { 'fixture:///slow': { wait: true } },
		});
		const result = await channel.callTool('payload', {});
		assert.equal(result.success, false);
		assert.match(result.error?.message ?? '', /timeout|timed out/i);
		await waitForAudit(audit, event => event.cancelled === 'fixture:///slow');
		assert.deepEqual((await audit()).filter(event => event.method === 'resources/read').map(event => event.uri), ['fixture:///slow']);
	});

	for (const operation of ['tools/call', 'resources/read']) {
		it(`cancels ${operation} at the MCP boundary and does not start a subsequent read`, async context => {
			const { channel, audit } = await startFixture(context, {
				tools: [{ name: 'payload', wait: operation === 'tools/call', result: { content: [link('fixture:///slow'), link('fixture:///next')] } }],
				resources: { 'fixture:///slow': { wait: true } },
			});
			const abort = new AbortController();
			const pending = channel.callTool('payload', {}, abort.signal);
			const rejected = assert.rejects(pending, /abort/i);
			await waitForAudit(audit, event => event.method === operation);
			abort.abort();
			await rejected;
			await waitForAudit(audit, event => event.cancelled !== undefined);
			assert.equal((await audit()).some(event => event.uri === 'fixture:///next'), false);
		});
	}

	it('rejects already-aborted calls and closes pending resource reads promptly', async context => {
		const { channel, audit } = await startFixture(context, {
			tools: [{ name: 'payload', result: { content: [link('fixture:///slow')] } }],
			resources: { 'fixture:///slow': { wait: true } },
		});
		await assert.rejects(channel.callTool('payload', {}, AbortSignal.abort()), /abort/i);
		assert.deepEqual(await audit(), []);
		const pending = assert.rejects(channel.callTool('payload', {}), /abort/i);
		await waitForAudit(audit, event => event.method === 'resources/read');
		await channel.close();
		await pending;
		await channel.close();
	});
});

async function startFixture(context: TestContext, plan: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), 'ahp-resource-test-'));
	const path = join(root, 'plan.json');
	const channel = new McpChannelProcess({
		command: process.execPath, args: [fixtureServer, path],
	});
	context.after(async () => {
		try {
			await channel.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	await writeFile(path, JSON.stringify(plan));
	const info = await channel.start();
	const audit = async (): Promise<Record<string, unknown>[]> => {
		try {
			const data = await readFile(`${path}.audit`, 'utf8');
			return data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	};
	return { channel, info, audit };
}

function texts(result: ToolCallResult): string[] {
	return (result.content ?? []).filter(block => block.type === ToolResultContentType.Text).map(block => block.text);
}

async function waitForAudit(audit: () => Promise<Record<string, unknown>[]>, condition: (event: Record<string, unknown>) => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if ((await audit()).some(condition)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail('Timed out waiting for the MCP fixture audit');
}
