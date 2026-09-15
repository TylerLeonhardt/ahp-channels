import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretInputDecoder } from '../src/secretInput.js';

describe('SecretInputDecoder', () => {
	it('ignores terminal navigation escape sequences', () => {
		const decoder = new SecretInputDecoder();

		assert.equal(decoder.feed('\u001b[D\u001bOA'), 'continue');
		assert.equal(decoder.feed('token'), 'continue');
		assert.equal(decoder.feed('\r'), 'submit');
		assert.equal(decoder.value, 'token');
	});

	it('supports backspace and cancellation', () => {
		const decoder = new SecretInputDecoder();

		decoder.feed('tokX\u007fen');
		assert.equal(decoder.value, 'token');
		assert.equal(decoder.feed('\u0003'), 'cancel');
	});
});
