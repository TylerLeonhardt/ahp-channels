import {
	type ToolCallResult,
	type ToolDefinition,
} from '@microsoft/agent-host-protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import type { ChannelEvent } from './channelPrompt.js';
import type { ChannelPermissionTransport } from './channelPermissions.js';
import type { LogWriter } from './daemonLog.js';
import { McpPermissionTransport, supportsChannelPermissions } from './mcpPermissions.js';
import type { StdioMcpServerConfig } from './plugins.js';
import { ChannelStdioClientTransport } from './channelStdioTransport.js';
import { convertToolResult, failedToolResult, formatMcpError, MAX_MCP_CONTENT_BYTES } from './mcpToolResult.js';
import { VERSION } from './version.js';

const ChannelNotificationSchema = z.object({
	method: z.literal('notifications/claude/channel'),
	params: z.object({
		content: z.string(),
		meta: z.record(z.string(), z.string()).optional(),
	}),
});

// JSON can expand a decoded text byte to a six-byte escape; allow framing too.
const MAX_CHANNEL_MESSAGE_BYTES = MAX_MCP_CONTENT_BYTES * 6 + 64 * 1024;

export interface StartedMcpChannel {
	readonly name: string;
	readonly instructions?: string;
	readonly tools: readonly ToolDefinition[];
}

export interface McpChannelClient {
	readonly whenStopped: Promise<void>;
	readonly permissions?: ChannelPermissionTransport;
	start(): Promise<StartedMcpChannel>;
	setChannelHandler(handler: (event: ChannelEvent) => void | Promise<void>): Promise<void>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>;
	close(): Promise<void>;
}

const standardErrorWriter: LogWriter = {
	write(chunk: string): void {
		process.stderr.write(chunk);
	},
};

export class McpChannelProcess implements McpChannelClient {
	private readonly client = new Client({
		name: 'ahp-channels',
		version: VERSION,
	});
	private readonly permissionTransport = new McpPermissionTransport(this.client);
	private readonly lifetime = new AbortController();
	private transport: ChannelStdioClientTransport | undefined;
	private channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
	private readonly pendingEvents: ChannelEvent[] = [];
	private resolveStopped!: () => void;
	private stopped = false;
	readonly whenStopped = new Promise<void>(resolve => {
		this.resolveStopped = resolve;
	});

	constructor(
		private readonly config: StdioMcpServerConfig,
		private readonly stderr: LogWriter = standardErrorWriter,
	) {
		this.client.onerror = error => this.stderr.write(`MCP channel error: ${formatMcpError(error)}\n`);
		this.client.onclose = () => {
			this.lifetime.abort(new Error('MCP channel connection closed'));
			this.stopped = true;
			this.resolveStopped();
		};
		this.client.setNotificationHandler(ChannelNotificationSchema, async notification => {
			const event: ChannelEvent = {
				content: notification.params.content,
				...(notification.params.meta ? { meta: notification.params.meta } : {}),
			};
			if (this.channelHandler) {
				await this.channelHandler(event);
			} else {
				this.pendingEvents.push(event);
			}
		});
	}

	get permissions(): ChannelPermissionTransport | undefined {
		return supportsChannelPermissions(this.client.getServerCapabilities()?.experimental)
			? this.permissionTransport
			: undefined;
	}

	async start(): Promise<StartedMcpChannel> {
		this.transport = new ChannelStdioClientTransport({
			command: this.config.command,
			args: [...this.config.args],
			...(this.config.cwd ? { cwd: this.config.cwd } : {}),
			env: createChannelEnvironment(this.config.env),
			stderr: 'pipe',
			maxBufferSize: MAX_CHANNEL_MESSAGE_BYTES,
		});
		this.transport.stderr?.on('data', chunk => this.stderr.write(String(chunk)));
		await this.client.connect(this.transport);

		const capabilities = this.client.getServerCapabilities();
		const channelCapability = capabilities?.experimental?.['claude/channel'];
		if (typeof channelCapability !== 'object' || channelCapability === null || Array.isArray(channelCapability)) {
			await this.client.close();
			throw new Error('MCP server does not declare experimental capability claude/channel');
		}
		const listed = capabilities?.tools ? await this.client.listTools() : { tools: [] };
		return {
			name: this.client.getServerVersion()?.name ?? 'channel',
			...(this.client.getInstructions() ? { instructions: this.client.getInstructions() } : {}),
			tools: listed.tools.map(tool => ({
				name: tool.name,
				...(tool.title ? { title: tool.title } : {}),
				...(tool.description ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema,
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
			})),
		};
	}

	async setChannelHandler(handler: (event: ChannelEvent) => void | Promise<void>): Promise<void> {
		this.channelHandler = handler;
		while (this.pendingEvents.length > 0) {
			const event = this.pendingEvents.shift();
			if (event) {
				await handler(event);
			}
		}
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult> {
		const requestSignal = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
		requestSignal.throwIfAborted();
		try {
			const raw: unknown = await this.client.callTool({ name, arguments: args }, undefined, { signal: requestSignal });
			return await convertToolResult(name, raw, this.client, requestSignal);
		} catch (error) {
			requestSignal.throwIfAborted();
			return failedToolResult(name, error);
		}
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		if (this.stopped) {
			return;
		}
		try {
			await this.client.close();
		} catch (error) {
			if (!this.stopped) {
				throw error;
			}
		}
	}
}

export function createChannelEnvironment(
	overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	return { ...environment, ...overrides };
}
