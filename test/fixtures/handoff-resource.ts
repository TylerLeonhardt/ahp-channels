import { ToolResultContentType, type ToolCallResult } from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { attachmentSample } from './attachment-contract.js';

export const HANDOFF_RESOURCE_TOOL = 'fixture_read_handoff_resource';

export function handoffResourceUri(id: string): string {
	return `handoff-resource:/${id}`;
}

export function handoffResourceContents(uri: string) {
	const image = attachmentSample('REFERENCE_PNG');
	return [{
		uri,
		mimeType: 'text/plain',
		text: `HANDOFF_RESOURCE_CONTENT ${uri}`,
	}, {
		uri: `${uri}/image`,
		mimeType: image.mimeType,
		blob: image.bytes.toString('base64'),
	}];
}

export function assertHandoffResource(result: ToolCallResult, id: string): void {
	assert.equal(result.success, true, JSON.stringify(result.error));
	const uri = handoffResourceUri(id);
	assert.ok(result.content?.some(content =>
		content.type === ToolResultContentType.Text && content.text === `HANDOFF_RESOURCE_CONTENT ${uri}`
	), 'The source must consume the exact resource text before completing its turn');
	const image = result.content?.find(content => content.type === ToolResultContentType.EmbeddedResource);
	assert.ok(image?.type === ToolResultContentType.EmbeddedResource, 'The source must receive materialized image bytes');
	const sample = attachmentSample('REFERENCE_PNG');
	assert.equal(image.contentType, sample.mimeType);
	assert.deepEqual(Buffer.from(image.data, 'base64'), sample.bytes);
}
