import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChannelDaemonStatus } from '../src/daemonProtocol.js';
import { channelPresentation } from '../vscode-extension/src/channelPresentation.js';

const failedAt = '2026-01-01T00:00:00Z';
const nextRetryAt = '2026-01-01T00:00:02Z';
const setupHealth = {
	state: 'degraded',
	failure: {
		stage: 'mcp-startup',
		summary: 'MCP channel startup: credentials required',
		guidance: 'Run the plugin setup skill in the selected session.',
		failedAt,
	},
	retry: { state: 'scheduled', attempt: 2, nextRetryAt },
} as const;

function channel(overrides: Partial<ChannelDaemonStatus> = {}): ChannelDaemonStatus {
	return {
		name: 'personal',
		state: 'running',
		desired: 'running',
		definition: {
			plugin: 'test-plugin',
			session: 'ahp-session:/destination',
			host: '@local',
			enabled: true,
		},
		runtime: {
			name: 'personal',
			plugin: 'test-plugin',
			session: 'ahp-session:/destination',
			chat: 'ahp-chat:/destination',
			host: 'standalone:1:test',
			clientId: 'test-client',
			channelName: 'test-channel',
			startedAt: failedAt,
			bindingId: '00000000-0000-4000-8000-000000000001',
			busy: false,
			mode: 'mcp',
		},
		health: { state: 'healthy' },
		...overrides,
	};
}

describe('channel presentation', () => {
	it('distinguishes setup-only attachment from a running messaging server', () => {
		const healthy = channel();
		const setup = channel({
			state: 'error',
			runtime: { ...healthy.runtime!, mode: 'customization-only' },
			health: setupHealth,
		});
		const presentation = channelPresentation(setup);
		assert.equal(presentation.description, 'attached for setup \u00b7 test-plugin');
		assert.deepEqual(Object.fromEntries(presentation.details), {
			Plugin: 'test-plugin',
			State: 'error',
			Health: 'degraded',
			Session: 'ahp-session:/destination',
			'Preferred host': '@local',
			'Connected host': 'standalone:1:test',
			Chat: 'ahp-chat:/destination',
			Mode: 'Setup only: plugin skills available; channel messaging unavailable.',
			Failure: setupHealth.failure.summary,
			'Failure stage': 'mcp-startup',
			'Failed at': new Date(failedAt).toLocaleString(),
			Recovery: setupHealth.failure.guidance,
			Retry: `Attempt 2 scheduled for ${new Date(nextRetryAt).toLocaleString()}. Waits until the conversation is idle.`,
		});
		const recovered = channelPresentation(healthy);
		assert.equal(recovered.description, 'connected \u00b7 test-plugin');
		assert.ok(!recovered.details.some(([label]) => ['Failure', 'Recovery', 'Retry'].includes(label)));
	});

	it('shows an unattached failure without claiming skills are available', () => {
		const presentation = channelPresentation(channel({
			state: 'error',
			runtime: undefined,
			health: {
				state: 'unhealthy',
				failure: { ...setupHealth.failure, stage: 'agent-host-connection', summary: 'Host unavailable' },
			},
		}));
		assert.equal(presentation.description, 'error \u00b7 test-plugin');
		assert.equal(Object.fromEntries(presentation.details)['Failure'], 'Host unavailable');
		assert.ok(!presentation.details.some(([label]) => ['Mode', 'Connected host', 'Chat', 'Retry'].includes(label)));
	});

	it('preserves transitional and stopped states even if a runtime snapshot is still present', () => {
		for (const state of ['starting', 'stopping', 'stopped'] as const) {
			const presentation = channelPresentation(channel({ state }));
			assert.equal(presentation.description, `${state} \u00b7 test-plugin`);
		}
		const stopped = channelPresentation(channel({
			state: 'error',
			desired: 'stopped',
			runtime: { ...channel().runtime!, mode: 'customization-only' },
			health: { state: 'stopped' },
		}));
		assert.equal(stopped.description, 'error \u00b7 test-plugin');
	});

	it('shows exhausted retries without inventing another attempt time', () => {
		const presentation = channelPresentation(channel({
			state: 'error',
			health: { ...setupHealth, retry: { state: 'exhausted', attempt: 5 } },
		}));
		assert.equal(
			Object.fromEntries(presentation.details)['Retry'],
			'Automatic retries exhausted (attempts: 5). Resolve the failure and restart the channel.',
		);
	});

	it('can display a scheduled retry whose timestamp is not available', () => {
		const presentation = channelPresentation(channel({
			state: 'error',
			health: { ...setupHealth, retry: { state: 'scheduled', attempt: 3 } },
		}));
		assert.equal(
			Object.fromEntries(presentation.details)['Retry'],
			'Attempt 3 scheduled. Waits until the conversation is idle.',
		);
	});

	it('preserves diagnostic text for the renderer to escape instead of treating it as Markdown', () => {
		const text = '[link](command:unsafe)\n**bold** <img src="https://example.test">';
		const presentation = channelPresentation(channel({
			state: 'error',
			health: { state: 'unhealthy', failure: { ...setupHealth.failure, summary: text, guidance: text } },
		}));
		assert.equal(Object.fromEntries(presentation.details)['Failure'], text);
		assert.equal(Object.fromEntries(presentation.details)['Recovery'], text);
	});

	it('shows failed handoff context without relabeling a restored healthy connection', () => {
		const presentation = channelPresentation(channel({
			handoff: {
				requestId: '00000000-0000-4000-8000-000000000002',
				state: 'failed',
				requestedAt: failedAt,
				updatedAt: failedAt,
				source: { actualHost: 'standalone:1:test', session: 'ahp-session:/destination', resolvedChat: 'ahp-chat:/destination' },
				target: { session: 'ahp-session:/unavailable' },
				resolvedTarget: {
					actualHost: 'standalone:1:test', fallback: false, session: 'ahp-session:/unavailable',
					chat: 'ahp-chat:/unavailable', warnings: [],
				},
				error: 'Destination could not start',
			},
		}));
		assert.equal(presentation.description, 'connected \u00b7 test-plugin');
		const details = Object.fromEntries(presentation.details);
		assert.equal(details['Last handoff'], 'Failed');
		assert.equal(details['Requested session'], 'ahp-session:/unavailable');
		assert.equal(details['Handoff error'], 'Destination could not start');
		assert.ok(!('Failure' in details));
	});
});
