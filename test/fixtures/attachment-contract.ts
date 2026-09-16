// Fixture-only protocol, samples, and assertions. None of these names or
// scripted tool choices are production channel APIs or real-model verdicts.
import { ToolResultContentType, type ToolCallResult } from '@microsoft/agent-host-protocol';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';

export const ATTACHMENT_FIXTURE_VERSION = '0.1.0-attachments-fixture';
export const ATTACHMENT_SCOPE_NOTE = 'Fixture-only readable plugin resource; never writable.\n';
export const ATTACHMENT_SCOPE_FILE = 'attachment-scope.txt';
export const ATTACHMENT_OUTSIDE_FILE = 'attachment-outside.txt';
export const ATTACHMENT_MARKER = /\bFAKECHAT_ATTACHMENT_(REFERENCE_TEXT|REFERENCE_PNG|SHARED_TEXT)_[0-9a-f-]{36}\b/;
export const ATTACHMENT_TEXT = 'Uploaded content, not prompt text: caf\u00e9, \u65e5\u672c\u8a9e, \u03c0.\r\nSecond line: <hello> & goodbye.\r\n';
export const ATTACHMENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAIAAABdtOgoAAAAvUlEQVR4nOXOUQkAIABEsetfWkP4MeTBAmxn+5ofxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/EjQ/eXDg64dLPh7lZAAAAAElFTkSuQmCC',
	'base64',
);

export type AttachmentKind = 'REFERENCE_TEXT' | 'REFERENCE_PNG' | 'SHARED_TEXT';
export type AttachmentPhase = 'read' | 'return';
export interface AttachmentScenario {
	readonly kind: AttachmentKind;
	readonly marker: string;
	readonly resourceId: string;
	readonly name: string;
	readonly sharedPath?: string;
}

const resourceIdSchema = { type: 'string', format: 'uuid' };
const outputSchema: NonNullable<Tool['outputSchema']> = {
	type: 'object',
	$defs: { resourceId: resourceIdSchema },
	properties: {
		resource_id: { $ref: '#/$defs/resourceId' },
		byte_length: { type: 'integer', minimum: 1 },
		sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
	},
	required: ['resource_id', 'byte_length', 'sha256'],
	additionalProperties: false,
};
export const attachmentFixtureTools: Tool[] = [{
	name: 'fixture_open_upload',
	description: 'Fixture only: read an uploaded attachment by opaque resource_id, never a filesystem path.',
	inputSchema: {
		type: 'object',
		$defs: { resourceId: resourceIdSchema },
		properties: { resource_id: { $ref: '#/$defs/resourceId' } },
		required: ['resource_id'],
		additionalProperties: false,
	},
	outputSchema,
}, {
	name: 'fixture_return_upload',
	description: 'Fixture only: return an uploaded attachment to fakechat using resource_id and caption.',
	inputSchema: {
		type: 'object',
		$defs: { resourceId: resourceIdSchema },
		properties: {
			resource_id: { $ref: '#/$defs/resourceId' },
			caption: { type: 'string', minLength: 1 },
		},
		required: ['resource_id', 'caption'],
		additionalProperties: false,
	},
	outputSchema,
}];

export function attachmentSample(kind: AttachmentKind): {
	readonly filename: string;
	readonly mimeType: string;
	readonly bytes: Buffer;
} {
	switch (kind) {
		case 'REFERENCE_TEXT':
			return { filename: 'fixture-reference-text.txt', mimeType: 'text/plain; charset=utf-16le', bytes: Buffer.from(ATTACHMENT_TEXT, 'utf16le') };
		case 'REFERENCE_PNG':
			return { filename: 'fixture-reference-image.png', mimeType: 'image/png', bytes: ATTACHMENT_PNG };
		case 'SHARED_TEXT':
			return { filename: 'fixture-shared-text.txt', mimeType: 'text/plain; charset=utf-8', bytes: Buffer.from(ATTACHMENT_TEXT) };
	}
}

export function attachmentResourceUri(resourceId: string): string {
	return `fakechat-upload://fixture/${resourceId}`;
}

export function attachmentFingerprint(resourceId: string, bytes: Uint8Array): Record<string, unknown> {
	return { resource_id: resourceId, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function attachmentScenarioFromMessage(text: string): AttachmentScenario | undefined {
	const match = ATTACHMENT_MARKER.exec(text);
	if (!match) {
		return undefined;
	}
	const tag = /<channel ([^>]*)>/.exec(text)?.[1] ?? '';
	const attributes = Object.fromEntries([...tag.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g)]
		.map(([, key, value]) => [key, value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
			.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')]));
	const kind = match[1] as AttachmentKind;
	assert.equal(attributes['user'], 'web');
	assert.equal(attributes['chat_id'], 'web');
	assert.equal(attributes['fixture_attachment_kind'], kind);
	assert.match(attributes['fixture_resource_id'] ?? '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
	assert.match(attributes['fixture_upload_name'] ?? '', /^\d+\.(txt|png)$/);
	if (kind !== 'SHARED_TEXT') {
		assert.equal(attributes['file_path'], undefined, 'Reference uploads must not expose the official filesystem path');
		assert.ok(!text.includes(ATTACHMENT_TEXT), 'The uploaded payload must not be supplied through the prompt');
	} else {
		assert.ok(attributes['file_path'], 'The separate shared-filesystem case must retain official metadata');
	}
	return {
		kind,
		marker: match[0],
		resourceId: attributes['fixture_resource_id'],
		name: attributes['fixture_upload_name'],
		...(attributes['file_path'] ? { sharedPath: attributes['file_path'] } : {}),
	};
}

export function attachmentInvocation(scenario: AttachmentScenario, phase: AttachmentPhase): {
	readonly name: string;
	readonly input: Record<string, unknown>;
} {
	if (scenario.kind === 'SHARED_TEXT') {
		assert.equal(phase, 'return');
		return { name: 'reply', input: { text: scenario.marker, files: [scenario.sharedPath] } };
	}
	return phase === 'read'
		? { name: 'fixture_open_upload', input: { resource_id: scenario.resourceId } }
		: { name: 'fixture_return_upload', input: { resource_id: scenario.resourceId, caption: scenario.marker } };
}

export function assertMaterializedAttachment(result: ToolCallResult, scenario: AttachmentScenario): void {
	const sample = attachmentSample(scenario.kind);
	assert.equal(result.success, true, JSON.stringify(result));
	assert.deepEqual(result.structuredContent, attachmentFingerprint(scenario.resourceId, sample.bytes));
	const content = result.content ?? [];
	const linkHeader = content.find(part => part.type === ToolResultContentType.Text && part.text.startsWith('Resource link: '));
	assert.ok(linkHeader?.type === ToolResultContentType.Text, 'AHP must preserve the resource_link metadata');
	assert.deepEqual(JSON.parse(linkHeader.text.slice('Resource link: '.length)), {
		uri: attachmentResourceUri(scenario.resourceId),
		name: scenario.name,
		description: 'Fixture-only upload received through official fakechat HTTP /upload.',
		mimeType: sample.mimeType,
		size: sample.bytes.length,
	});
	assert.ok(content.some(part => part.type === ToolResultContentType.Text
		&& part.text.startsWith('Resource content: ')
		&& JSON.parse(part.text.slice('Resource content: '.length)).uri === attachmentResourceUri(scenario.resourceId)),
	'The originating MCP resources/read must have materialized the uploaded content');
	assert.ok(content.every(part => part.type !== ToolResultContentType.Resource), 'Lazy AHP resources are not enough for this provider boundary');
	if (scenario.kind === 'REFERENCE_PNG') {
		const embedded = content.filter(part => part.type === ToolResultContentType.EmbeddedResource);
		assert.equal(embedded.length, 1, 'The actual PNG must reach AHP as embedded bytes');
		assert.equal(embedded[0].contentType, 'image/png');
		assert.deepEqual(Buffer.from(embedded[0].data, 'base64'), sample.bytes);
	} else {
		assert.ok(content.some(part => part.type === ToolResultContentType.Text && part.text === ATTACHMENT_TEXT),
			'AHP must contain the exact uploaded Unicode text decoded with its declared charset');
	}
}

export function assertReturnedAttachment(result: ToolCallResult, scenario: AttachmentScenario): void {
	assert.equal(result.success, true, JSON.stringify(result));
	assert.ok(result.content?.some(part => part.type === ToolResultContentType.Text && /^sent \(m.+\)$/.test(part.text)),
		'The outbound tool must actually call the official reply/files tool');
	if (scenario.kind !== 'SHARED_TEXT') {
		assert.deepEqual(result.structuredContent, attachmentFingerprint(scenario.resourceId, attachmentSample(scenario.kind).bytes));
	}
}

export function assertSharedAttachmentRead(result: ToolCallResult): void {
	assert.equal(result.success, true, JSON.stringify(result));
	assert.ok(result.content?.some(part => part.type === ToolResultContentType.Text && part.text === ATTACHMENT_TEXT),
		'The fixture host must expose the actual shared-filesystem text at the AHP tool boundary');
}

export function assertValidAttachmentPng(): void {
	assert.equal(createHash('sha256').update(ATTACHMENT_PNG).digest('hex'), '7946f7dda180244e347a05e1b741169803fb333d8270b8488f2c234c041ec0c6');
	assert.deepEqual(ATTACHMENT_PNG.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const chunks = new Map<string, Buffer>();
	for (let offset = 8; offset < ATTACHMENT_PNG.length;) {
		const size = ATTACHMENT_PNG.readUInt32BE(offset);
		const type = ATTACHMENT_PNG.toString('ascii', offset + 4, offset + 8);
		const body = ATTACHMENT_PNG.subarray(offset + 8, offset + 8 + size);
		assert.equal(crc32(ATTACHMENT_PNG.subarray(offset + 4, offset + 8 + size)), ATTACHMENT_PNG.readUInt32BE(offset + 8 + size));
		chunks.set(type, body);
		offset += size + 12;
	}
	assert.deepEqual([...chunks.keys()], ['IHDR', 'IDAT', 'IEND']);
	assert.deepEqual(chunks.get('IHDR'), Buffer.from([0, 0, 0, 128, 0, 0, 0, 64, 8, 2, 0, 0, 0]));
	const row = Buffer.alloc(1 + 128 * 3);
	for (let x = 0; x < 128; x++) {
		row[1 + x * 3 + (x < 64 ? 0 : 1)] = 255;
	}
	assert.deepEqual(inflateSync(chunks.get('IDAT')!), Buffer.concat(Array.from({ length: 64 }, () => row)),
		'PNG pixels must decode to two solid panels, red then green');
}
