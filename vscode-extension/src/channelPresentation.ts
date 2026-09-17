import type { ChannelDaemonStatus } from '../../src/daemonProtocol.js';

export interface ChannelPresentation {
	readonly description: string;
	readonly details: readonly (readonly [label: string, value: string])[];
}

export function channelPresentation(status: ChannelDaemonStatus): ChannelPresentation {
	const { definition, runtime, health, handoff } = status;
	const details: Array<readonly [string, string]> = [
		['Plugin', definition.plugin],
		['State', status.state],
		['Health', health.state],
		['Session', definition.session],
	];
	if (definition.host) {
		details.push(['Preferred host', definition.host]);
	}
	if (runtime) {
		details.push(
			['Connected host', runtime.host],
			['Chat', runtime.chat],
			['Mode', runtime.mode === 'customization-only'
				? 'Setup only: plugin skills available; channel messaging unavailable.'
				: 'MCP channel server running.'],
		);
	}
	if (health.failure) {
		details.push(
			['Failure', health.failure.summary],
			['Failure stage', health.failure.stage],
			['Failed at', new Date(health.failure.failedAt).toLocaleString()],
			['Recovery', health.failure.guidance],
		);
	}
	if (health.retry) {
		const retry = health.retry;
		if (retry.state === 'exhausted') {
			details.push(['Retry', `Automatic retries exhausted (attempts: ${retry.attempt}). Resolve the failure and restart the channel.`]);
		} else {
			const at = retry.nextRetryAt ? ` for ${new Date(retry.nextRetryAt).toLocaleString()}` : '';
			details.push(['Retry', `Attempt ${retry.attempt} scheduled${at}. Waits until the conversation is idle.`]);
		}
	}
	if (handoff?.state === 'failed') {
		details.push(['Last handoff', 'Failed'], ['Requested session', handoff.target.session]);
		if (handoff.error) {
			details.push(['Handoff error', handoff.error]);
		}
	}
	return {
		description: `${channelStateLabel(status)} \u00b7 ${definition.plugin}`,
		details,
	};
}

function channelStateLabel(status: ChannelDaemonStatus): string {
	if (status.desired === 'running' && (status.state === 'running' || status.state === 'error')) {
		if (status.runtime?.mode === 'customization-only') {
			return 'attached for setup';
		}
		if (status.state === 'running' && status.health.state === 'healthy' && status.runtime?.mode === 'mcp') {
			return 'connected';
		}
	}
	return status.state;
}
