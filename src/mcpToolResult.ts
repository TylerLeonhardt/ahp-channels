import {
	ToolResultContentType,
	type ToolCallResult,
	type ToolResultEmbeddedResourceContent,
	type ToolResultTextContent,
} from '@microsoft/agent-host-protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	CallToolResultSchema,
	type BlobResourceContents,
	type ContentBlock,
	type ResourceLink,
	type TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';
import { MIMEType } from 'node:util';

export const MAX_MCP_CONTENT_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_RESOURCE_LINKS = 16;
export const MAX_MCP_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_ENTRY_BYTES = 1024;
const OMITTED_DIAGNOSTICS = 'Additional MCP content errors omitted after the 16 KiB diagnostic limit';
const RESOURCE_READ_TIMEOUT_MS = 10_000;
type MaterializedContent = ToolResultTextContent | ToolResultEmbeddedResourceContent;

export async function convertToolResult(
	toolName: string,
	value: unknown,
	resources: Pick<Client, 'readResource'>,
	signal: AbortSignal,
): Promise<ToolCallResult> {
	signal.throwIfAborted();
	const parsed = CallToolResultSchema.safeParse(value);
	if (!parsed.success) {
		return failedToolResult(toolName, 'MCP server returned an invalid tool result');
	}
	const result = parsed.data;
	const content: MaterializedContent[] = [];
	const diagnostics: string[] = [];
	let diagnosticBytes = 0;
	let remaining = MAX_MCP_CONTENT_BYTES;
	try {
		if (result.structuredContent) {
			remaining = consumeBytes(remaining, Buffer.byteLength(JSON.stringify(result.structuredContent)));
		}
		if (result.content.filter(block => block.type === 'resource_link').length > MAX_MCP_RESOURCE_LINKS) {
			throw new Error(`MCP tool result exceeds the ${MAX_MCP_RESOURCE_LINKS}-resource-link limit`);
		}
	} catch (error) {
		return failedToolResult(toolName, error);
	}

	const readSignal = AbortSignal.any([signal, AbortSignal.timeout(RESOURCE_READ_TIMEOUT_MS)]);
	for (const block of result.content) {
		signal.throwIfAborted();
		try {
			if (block.type !== 'resource_link') {
				const converted = convertContent(block);
				remaining = consumeBytes(remaining, contentBytes(converted));
				content.push(...converted);
				continue;
			}
			validateLink(block, remaining);
			const reference = resourceDescription('Resource link', block);
			remaining = consumeBytes(remaining, Buffer.byteLength(reference.text));
			content.push(reference);
			// Client-tool consumers currently consume text and embedded bytes, not lazy
			// AHP Resource blocks. Only the originating MCP server resolves this URI.
			const read = await resources.readResource({ uri: block.uri }, {
				signal: readSignal,
				timeout: RESOURCE_READ_TIMEOUT_MS,
			});
			signal.throwIfAborted();
			if (read.contents.length === 0) {
				throw new Error('MCP resource has no contents');
			}
			for (const resource of read.contents) {
				const converted = convertResource({
					...resource,
					...(resource.mimeType === undefined && resource.uri === block.uri && block.mimeType
						? { mimeType: block.mimeType } : {}),
				});
				remaining = consumeBytes(remaining, contentBytes(converted));
				content.push(...converted);
			}
		} catch (error) {
			signal.throwIfAborted();
			if (diagnostics.at(-1) === OMITTED_DIAGNOSTICS) {
				continue;
			}
			const subject = block.type === 'resource_link'
				? `read MCP resource ${JSON.stringify(limitUtf8Text(block.uri, 256))}`
				: `translate MCP ${block.type} content`;
			const message = formatMcpError(`Failed to ${subject}: ${formatMcpError(error)}`);
			const size = Buffer.byteLength(message) + 1;
			const entry = diagnosticBytes + size + Buffer.byteLength(OMITTED_DIAGNOSTICS) <= MAX_MCP_DIAGNOSTIC_BYTES
				? message : OMITTED_DIAGNOSTICS;
			diagnosticBytes += Buffer.byteLength(entry) + 1;
			diagnostics.push(entry);
			content.push({ type: ToolResultContentType.Text, text: entry });
		}
	}
	const isError = result.isError === true || diagnostics.length > 0;
	const errorText = diagnostics.length > 0
		? diagnostics.join('\n')
		: content.filter(item => item.type === ToolResultContentType.Text).map(item => item.text).join('\n');
	const displayName = limitUtf8Text(toolName, 128);
	return {
		success: !isError,
		pastTenseMessage: isError ? `Failed to call ${displayName}` : `Called ${displayName}`,
		...(content.length > 0 ? { content } : {}),
		...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
		...(isError ? { error: { message: limitUtf8Text(errorText || `MCP tool ${displayName} failed`, MAX_MCP_DIAGNOSTIC_BYTES) } } : {}),
	};
}

function convertContent(block: Exclude<ContentBlock, ResourceLink>): MaterializedContent[] {
	switch (block.type) {
		case 'text':
			return [{ type: ToolResultContentType.Text, text: block.text }];
		case 'image':
		case 'audio': {
			const mime = parseMimeType(block.mimeType);
			if (mime.type !== block.type) {
				throw new Error(`MCP ${block.type} content requires a ${block.type} MIME type`);
			}
			return [embeddedContent(block.data, mime.toString())];
		}
		case 'resource':
			return convertResource(block.resource);
	}
}

function convertResource(resource: TextResourceContents | BlobResourceContents): MaterializedContent[] {
	validateUri(resource.uri);
	const mime = parseMimeType(resource.mimeType ?? ('text' in resource ? 'text/plain' : 'application/octet-stream'));
	const description = resourceDescription('Resource content', { uri: resource.uri, mimeType: mime.toString() });
	if ('text' in resource) {
		return [description, { type: ToolResultContentType.Text, text: resource.text }];
	}
	const embedded = embeddedContent(resource.blob, mime.toString());
	if (mime.type === 'text' || /^(?:json|xml)$|\+(?:json|xml)$/.test(mime.subtype)) {
		const text = new TextDecoder(mime.params.get('charset') ?? 'utf-8', { fatal: true })
			.decode(Buffer.from(embedded.data, 'base64'));
		return [description, { type: ToolResultContentType.Text, text }];
	}
	return [description, embedded];
}

function embeddedContent(data: string, contentType: string): ToolResultEmbeddedResourceContent {
	if (data.length > Math.ceil(MAX_MCP_CONTENT_BYTES / 3) * 4) {
		throw new Error('MCP binary content exceeds the 8 MiB limit');
	}
	// atob validates without a recursive regular expression on multi-megabyte data.
	atob(data);
	const bytes = Buffer.from(data, 'base64');
	consumeBytes(MAX_MCP_CONTENT_BYTES, bytes.length);
	return { type: ToolResultContentType.EmbeddedResource, data: bytes.toString('base64'), contentType };
}

function validateLink(link: ResourceLink, remaining: number): void {
	validateUri(link.uri);
	if (link.mimeType !== undefined) {
		parseMimeType(link.mimeType);
	}
	if (link.size !== undefined) {
		if (!Number.isSafeInteger(link.size) || link.size < 0) {
			throw new Error('MCP resource size must be a non-negative safe integer');
		}
		consumeBytes(remaining, link.size);
	}
}

function validateUri(uri: string): void {
	if (!URL.canParse(uri) || /[\u0000-\u0020\u007f]/.test(uri)) {
		throw new Error('MCP resource URI must be an absolute URI without whitespace or control characters');
	}
}

function parseMimeType(value: string): MIMEType {
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error('MCP resource MIME type contains control characters');
	}
	return new MIMEType(value);
}

function resourceDescription(label: string, resource: {
	readonly uri: string;
	readonly name?: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
}): ToolResultTextContent {
	const { uri, name, title, description, mimeType, size } = resource;
	return {
		type: ToolResultContentType.Text,
		text: `${label}: ${JSON.stringify({ uri, name, title, description, mimeType, size })}`,
	};
}

function contentBytes(content: readonly MaterializedContent[]): number {
	return content.reduce((size, block) => size + (block.type === ToolResultContentType.Text
		? Buffer.byteLength(block.text)
		: Buffer.from(block.data, 'base64').length + Buffer.byteLength(block.contentType)), 0);
}

function consumeBytes(remaining: number, size: number): number {
	if (size > remaining) {
		throw new Error('MCP tool content exceeds the 8 MiB aggregate limit');
	}
	return remaining - size;
}

export function failedToolResult(toolName: string, error: unknown): ToolCallResult {
	return {
		success: false,
		pastTenseMessage: `Failed to call ${limitUtf8Text(toolName, 128)}`,
		error: { message: formatMcpError(error) },
	};
}

export function formatMcpError(error: unknown): string {
	return limitUtf8Text(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_ENTRY_BYTES);
}

function limitUtf8Text(value: string, maxBytes: number): string {
	const bytes = new Uint8Array(maxBytes);
	const encoder = new TextEncoder();
	const encoded = encoder.encodeInto(value, bytes);
	if (encoded.read === value.length) {
		return value;
	}
	const suffix = '... [truncated]';
	const prefix = bytes.subarray(0, maxBytes - suffix.length);
	const { written } = encoder.encodeInto(value, prefix);
	return new TextDecoder().decode(prefix.subarray(0, written)) + suffix;
}
