import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type {
	ChannelPermissionRequest,
	ChannelPermissionTransport,
	PermissionTransportEvents,
} from './channelPermissions.js';

const PermissionVerdictSchema = z.object({
	method: z.literal('notifications/claude/channel/permission'),
	params: z.object({
		request_id: z.string().regex(/^[a-km-z]{5}$/),
		behavior: z.enum(['allow', 'deny']),
	}),
});

export class McpPermissionTransport implements ChannelPermissionTransport {
	readonly events = new EventEmitter<PermissionTransportEvents>();

	constructor(private readonly client: Client) {
		client.setNotificationHandler(PermissionVerdictSchema, notification => {
			if (supportsChannelPermissions(client.getServerCapabilities()?.experimental)) {
				this.events.emit('verdict', notification.params);
			}
		});
	}

	async sendRequest(request: ChannelPermissionRequest): Promise<void> {
		if (!supportsChannelPermissions(this.client.getServerCapabilities()?.experimental)) {
			throw new Error('MCP channel did not opt in to permission relay');
		}
		await this.client.notification({
			method: 'notifications/claude/channel/permission_request',
			params: { ...request },
		});
	}
}

export function supportsChannelPermissions(experimental: Record<string, unknown> | undefined): boolean {
	const capability = experimental?.['claude/channel/permission'];
	return typeof capability === 'object' && capability !== null && !Array.isArray(capability);
}
