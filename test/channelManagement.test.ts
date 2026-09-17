import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DaemonChannelManagementService, MANAGEMENT_TOOL_NAMES } from '../src/channelManagement.js';

describe('channel management errors', () => {
	for (const testCase of [{
		name: MANAGEMENT_TOOL_NAMES.handoff,
		args: {},
		error: /session must be a non-empty string/,
	}, {
		name: MANAGEMENT_TOOL_NAMES.handoffStatus,
		args: { request_id: '' },
		error: /request_id must be a non-empty string/,
	}, {
		name: MANAGEMENT_TOOL_NAMES.cancelHandoff,
		args: {},
		error: /request_id must be a non-empty string/,
	}]) {
		it(`returns a failed result for invalid ${testCase.name} arguments`, async context => {
			const home = await mkdtemp(join(tmpdir(), 'ahp-management-'));
			context.after(() => rm(home, { recursive: true, force: true }));
			const management = new DaemonChannelManagementService(home).bind({
				channel: 'personal',
				bindingId: randomUUID(),
				session: 'ahp-session:/source',
				chat: 'ahp-chat:/source',
			});
			const result = await management.callTool(testCase.name, testCase.args, new AbortController().signal);
			assert.equal(result.success, false);
			assert.match(result.error?.message ?? '', testCase.error);
		});
	}

	it('returns transport failures as tool errors while propagating cancellation', async context => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-management-'));
		context.after(() => rm(home, { recursive: true, force: true }));
		const management = new DaemonChannelManagementService(home).bind({
			channel: 'personal',
			bindingId: randomUUID(),
			session: 'ahp-session:/source',
			chat: 'ahp-chat:/source',
		});
		const result = await management.callTool(
			MANAGEMENT_TOOL_NAMES.handoffStatus, {}, new AbortController().signal,
		);
		assert.equal(result.success, false);
		assert.match(result.error?.message ?? '', /ENOENT|ECONNREFUSED/);

		const cancelled = new AbortController();
		cancelled.abort(new Error('cancel management request'));
		await assert.rejects(
			management.callTool(MANAGEMENT_TOOL_NAMES.handoffStatus, {}, cancelled.signal),
			/cancel management request/,
		);
	});
});
