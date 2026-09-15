import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChannelClientId } from '../src/ahp.js';

describe('createChannelClientId', () => {
	it('is stable and scoped to a plugin and session', () => {
		assert.deepEqual({
			first: createChannelClientId('telegram', 'ahp-session:/one'),
			repeated: createChannelClientId('telegram', 'ahp-session:/one'),
			otherPlugin: createChannelClientId('discord', 'ahp-session:/one'),
			otherSession: createChannelClientId('telegram', 'ahp-session:/two'),
		}, {
			first: '5831a13f-2bb4-c3c0-ef94-f869a5d618a0',
			repeated: '5831a13f-2bb4-c3c0-ef94-f869a5d618a0',
			otherPlugin: '9dd0707f-2e74-87f9-6ba1-4c1b20aa2baa',
			otherSession: '6ee51439-3686-6c95-362f-6931b27467f2',
		});
	});
});
