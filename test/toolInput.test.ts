import { ContentEncoding } from '@microsoft/agent-host-protocol';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_TOOL_INPUT_BYTES, readToolInput } from '../src/toolInput.js';
import { raceAbort } from '../src/async.js';

describe('tool input reads', () => {
	it('reads inline and referenced UTF-8 or base64 input', async () => {
		const signal = new AbortController().signal;
		const input = '{"command":"echo hello"}';
		assert.equal(await readToolInput({}, input, signal), input);
		for (const encoding of [ContentEncoding.Utf8, ContentEncoding.Base64]) {
			assert.equal(await readToolInput({
				async request(method, params) {
					assert.equal(method, 'resourceRead');
					assert.equal(params.uri, 'test:/input');
					return { encoding, data: encoding === ContentEncoding.Base64 ? Buffer.from(input).toString('base64') : input };
				},
			}, { uri: 'test:/input' }, signal), input);
		}
	});

	it('rejects unreadable or oversized inputs instead of offering an incomplete approval', async () => {
		const signal = new AbortController().signal;
		await assert.rejects(readToolInput({}, { uri: 'test:/input' }, signal), /cannot read/);
		await assert.rejects(readToolInput({}, 'x'.repeat(MAX_TOOL_INPUT_BYTES + 1), signal), /limit/);
		await assert.rejects(readToolInput({}, { uri: 'test:/input', sizeHint: MAX_TOOL_INPUT_BYTES + 1 }, signal), /limit/);
		await assert.rejects(readToolInput({
			async request() { return { encoding: ContentEncoding.Base64, data: 'not base64!' }; },
		}, { uri: 'test:/input' }, signal), /encoding/);
	});

	it('accepts exactly the production size limit in both encodings', async () => {
		const input = 'x'.repeat(MAX_TOOL_INPUT_BYTES);
		const signal = new AbortController().signal;
		assert.equal(await readToolInput({}, input, signal), input);
		assert.equal(await readToolInput({
			async request() {
				return { encoding: ContentEncoding.Base64, data: Buffer.from(input).toString('base64') };
			},
		}, { uri: 'test:/input', sizeHint: MAX_TOOL_INPUT_BYTES }, signal), input);
	});

	it('refuses base64 data that is not UTF-8 text', async () => {
		await assert.rejects(readToolInput({
			async request() {
				return { encoding: ContentEncoding.Base64, data: Buffer.from([0xff]).toString('base64') };
			},
		}, { uri: 'test:/input' }, new AbortController().signal), /encoded data|encoding/i);
	});

	it('cancels a pending read and observes a later underlying rejection', async () => {
		const abort = new AbortController();
		let rejectRead!: (error: Error) => void;
		const input = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
		const result = readToolInput({ request: () => input }, { uri: 'test:/input' }, abort.signal);
		abort.abort(new Error('stopped'));
		await assert.rejects(result, /stopped/);
		rejectRead(new Error('late transport failure'));
		await new Promise<void>(resolve => setImmediate(resolve));
	});

	it('observes already rejected operations even when cancellation happened first', async () => {
		const abort = new AbortController();
		abort.abort(new Error('already stopped'));
		await assert.rejects(raceAbort(Promise.reject(new Error('late')), abort.signal), /already stopped/);
	});
});
