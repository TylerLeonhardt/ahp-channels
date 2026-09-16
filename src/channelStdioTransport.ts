import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	type JSONRPCMessage,
	type JSONRPCResultResponse,
	type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { Stream } from 'node:stream';
import { ProcessTreeStdioClientTransport } from './processTreeStdioTransport.js';

export class ChannelStdioClientTransport implements Transport {
	private readonly transport: ProcessTreeStdioClientTransport;
	private initializeRequestId: RequestId | undefined;
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	constructor(server: StdioServerParameters) {
		this.transport = new ProcessTreeStdioClientTransport(server);
		this.transport.onclose = () => this.onclose?.();
		this.transport.onerror = error => this.onerror?.(error);
		this.transport.onmessage = message => {
			if (isJSONRPCResultResponse(message) && message.id === this.initializeRequestId) {
				this.initializeRequestId = undefined;
				message = normalizeChannelInitialization(message);
			}
			this.onmessage?.(message);
		};
	}

	get stderr(): Stream | null {
		return this.transport.stderr;
	}

	start(): Promise<void> {
		return this.transport.start();
	}

	send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		if (isJSONRPCRequest(message) && message.method === 'initialize') {
			this.initializeRequestId = message.id;
		}
		return this.transport.send(message, options);
	}

	close(): Promise<void> {
		return this.transport.close();
	}
}

export function normalizeChannelInitialization(message: JSONRPCResultResponse): JSONRPCResultResponse {
	const capabilities = message.result['capabilities'];
	if (!isRecord(capabilities) || !isRecord(capabilities['experimental'])) {
		return message;
	}
	const experimental = capabilities['experimental'];
	if (experimental['claude/channel/permission'] !== false) {
		return message;
	}
	// The channel contract permits false as opt-out, while MCP SDK 1.x
	// validates experimental capability values as objects.
	const normalized = { ...experimental };
	delete normalized['claude/channel/permission'];
	return {
		...message,
		result: { ...message.result, capabilities: { ...capabilities, experimental: normalized } },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
