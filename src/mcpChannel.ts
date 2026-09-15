import {
	ToolResultContentType,
	type ToolCallResult,
	type ToolDefinition,
	type ToolResultContent,
} from '@microsoft/agent-host-protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { ChannelEvent } from './channelPrompt.js';
import type { StdioMcpServerConfig } from './plugins.js';
import { VERSION } from './version.js';

const ChannelNotificationSchema = z.object({
	method: z.literal('notifications/claude/channel'),
	params: z.object({
		content: z.string(),
		meta: z.record(z.string(), z.string()).optional(),
	}),
});

export interface StartedMcpChannel {
	readonly name: string;
	readonly instructions?: string;
	readonly tools: readonly ToolDefinition[];
}

export interface McpChannelClient {
	readonly whenStopped: Promise<void>;
	start(): Promise<StartedMcpChannel>;
	setChannelHandler(handler: (event: ChannelEvent) => void | Promise<void>): Promise<void>;
	callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
	close(): Promise<void>;
}

export class McpChannelProcess implements McpChannelClient {
	private readonly client = new Client({
		name: 'ahp-channels',
		version: VERSION,
	});
	private transport: StdioClientTransport | undefined;
	private channelHandler: ((event: ChannelEvent) => void | Promise<void>) | undefined;
	private readonly pendingEvents: ChannelEvent[] = [];
	private resolveStopped!: () => void;
	private stopped = false;
	readonly whenStopped = new Promise<void>(resolve => {
		this.resolveStopped = resolve;
	});

	constructor(
		private readonly config: StdioMcpServerConfig,
		private readonly onStderr: (chunk: string) => void = chunk => process.stderr.write(chunk),
	) {
		this.client.onclose = () => {
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

	async start(): Promise<StartedMcpChannel> {
		this.transport = new StdioClientTransport({
			command: this.config.command,
			args: [...this.config.args],
			...(this.config.cwd ? { cwd: this.config.cwd } : {}),
			env: createChannelEnvironment(this.config.env),
			stderr: 'pipe',
		});
		this.transport.stderr?.on('data', chunk => this.onStderr(String(chunk)));
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
				inputSchema: {
					type: 'object',
					...(tool.inputSchema.properties ? { properties: tool.inputSchema.properties } : {}),
					...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
				},
				...(tool.outputSchema ? {
					outputSchema: {
						type: 'object',
						...(tool.outputSchema.properties ? { properties: tool.outputSchema.properties } : {}),
						...(tool.outputSchema.required ? { required: tool.outputSchema.required } : {}),
					},
				} : {}),
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

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
		try {
			const raw: unknown = await this.client.callTool({ name, arguments: args });
			return convertToolResult(name, raw);
		} catch (error) {
			return {
				success: false,
				pastTenseMessage: `Failed to call ${name}`,
				error: { message: error instanceof Error ? error.message : String(error) },
			};
		}
	}

	async close(): Promise<void> {
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

export function convertToolResult(toolName: string, value: unknown): ToolCallResult {
	if (!isRecord(value) || !Array.isArray(value['content'])) {
		return {
			success: false,
			pastTenseMessage: `Failed to call ${toolName}`,
			error: { message: 'MCP server returned an unsupported tool result' },
		};
	}

	const content = value['content'].flatMap(convertContent);
	const isError = value['isError'] === true;
	const errorText = content
		.filter(item => item.type === ToolResultContentType.Text)
		.map(item => item.text)
		.join('\n');
	return {
		success: !isError,
		pastTenseMessage: isError ? `Failed to call ${toolName}` : `Called ${toolName}`,
		...(content.length > 0 ? { content } : {}),
		...(isRecord(value['structuredContent']) ? { structuredContent: value['structuredContent'] } : {}),
		...(isError ? { error: { message: errorText || `MCP tool ${toolName} failed` } } : {}),
	};
}

function convertContent(value: unknown): ToolResultContent[] {
	if (!isRecord(value) || typeof value['type'] !== 'string') {
		return [];
	}
	if (value['type'] === 'text' && typeof value['text'] === 'string') {
		return [{ type: ToolResultContentType.Text, text: value['text'] }];
	}
	if ((value['type'] === 'image' || value['type'] === 'audio')
		&& typeof value['data'] === 'string'
		&& typeof value['mimeType'] === 'string') {
		return [{
			type: ToolResultContentType.EmbeddedResource,
			data: value['data'],
			contentType: value['mimeType'],
		}];
	}
	if (value['type'] === 'resource' && isRecord(value['resource'])) {
		const resource = value['resource'];
		if (typeof resource['text'] === 'string') {
			return [{ type: ToolResultContentType.Text, text: resource['text'] }];
		}
		if (typeof resource['blob'] === 'string' && typeof resource['mimeType'] === 'string') {
			return [{
				type: ToolResultContentType.EmbeddedResource,
				data: resource['blob'],
				contentType: resource['mimeType'],
			}];
		}
	}
	if (value['type'] === 'resource_link' && typeof value['uri'] === 'string') {
		return [{
			type: ToolResultContentType.Text,
			text: typeof value['name'] === 'string' ? `${value['name']}: ${value['uri']}` : value['uri'],
		}];
	}
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
