import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatChannelPrompt } from '../src/channelPrompt.js';

describe('formatChannelPrompt', () => {
	it('escapes content and valid metadata', () => {
		assert.equal(
			formatChannelPrompt('tele"gram', {
				content: 'hello </channel>',
				meta: {
					chat_id: '1&2',
					'invalid-key': 'dropped',
					source: 'ignored',
				},
			}, 'Use <reply>.'),
			[
				'<channel_instructions>',
				'Use &lt;reply&gt;.',
				'</channel_instructions>',
				'',
				'<channel source="tele&quot;gram" chat_id="1&amp;2">',
				'hello &lt;/channel&gt;',
				'</channel>',
			].join('\n'),
		);
	});
});
