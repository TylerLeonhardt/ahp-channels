import {
	ContentEncoding,
	type ResourceReadParams,
	type ResourceReadResult,
	type ToolInput,
} from '@microsoft/agent-host-protocol';
import { raceAbort } from './async.js';

export interface ToolInputReader {
	request(method: 'resourceRead', params: ResourceReadParams): Promise<ResourceReadResult>;
}

export const MAX_TOOL_INPUT_BYTES = 1024 * 1024;

export async function readToolInput(
	reader: Partial<ToolInputReader>,
	input: ToolInput | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	signal.throwIfAborted();
	if (input === undefined) {
		return undefined;
	}
	if (typeof input === 'string') {
		return boundedInput(input);
	}
	if (input.sizeHint !== undefined && input.sizeHint > MAX_TOOL_INPUT_BYTES) {
		throw new Error('Referenced tool input exceeds the 1 MiB limit');
	}
	if (!reader.request) {
		throw new Error('Agent Host client cannot read referenced tool input');
	}
	const result = await raceAbort(reader.request('resourceRead', {
		channel: 'ahp-root://',
		uri: input.uri,
		encoding: ContentEncoding.Utf8,
	}), AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
	if (result.encoding === ContentEncoding.Utf8) {
		return boundedInput(result.data);
	}
	if (result.encoding !== ContentEncoding.Base64
		|| result.data.length > Math.ceil(MAX_TOOL_INPUT_BYTES / 3) * 4
		|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)) {
		throw new Error('Agent Host returned unsupported tool input encoding or size');
	}
	return boundedInput(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.data, 'base64')));
}

function boundedInput(input: string): string {
	if (Buffer.byteLength(input) > MAX_TOOL_INPUT_BYTES) {
		throw new Error('Tool input exceeds the 1 MiB limit');
	}
	return input;
}
