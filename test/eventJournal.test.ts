import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { FileChannelEventJournal } from '../src/eventJournal.js';
import { FILE_LOCK_OPTIONS } from '../src/lockedFile.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('FileChannelEventJournal', () => {
	it('deduplicates stable events across pending, delivered, and process restarts', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);
		const event = {
			content: 'hello',
			meta: { chat_id: '42', message_id: '7' },
		};
		const journal = new FileChannelEventJournal(home, 'telegram');

		const concurrent = await Promise.all([
			journal.enqueue('telegram', event),
			journal.enqueue('telegram', event),
			journal.enqueue('telegram', event),
		]);
		const accepted = concurrent.filter(candidate => candidate !== undefined);
		assert.equal(accepted.length, 1);
		const acceptedEvent = accepted[0];
		assert.ok(acceptedEvent);
		assert.equal(acceptedEvent.stableIdentity, true);
		assert.equal((await journal.pending()).length, 1);

		await journal.markDelivered([acceptedEvent.id]);
		const reopened = new FileChannelEventJournal(home, 'telegram');
		assert.equal((await reopened.pending()).length, 0);
		assert.equal(await reopened.enqueue('telegram', event), undefined);
	});

	it('journals events without stable metadata without claiming deduplication', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);
		const journal = new FileChannelEventJournal(home, 'webhook');

		const first = await journal.enqueue('webhook', { content: 'same' });
		const second = await journal.enqueue('webhook', { content: 'same' });

		assert.equal(first?.stableIdentity, false);
		assert.equal(second?.stableIdentity, false);
		assert.notEqual(first?.id, second?.id);
		assert.equal((await journal.pending()).length, 2);
	});

	it('waits for an ongoing journal update before reading pending events', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);
		const journal = new FileChannelEventJournal(home, 'channel');
		const queued = await journal.enqueue('channel', { content: 'hello' });
		assert.ok(queued);

		const release = await lock(join(home, 'instances', 'channel', 'events.json'), FILE_LOCK_OPTIONS);
		const reading = journal.pending();
		try {
			assert.equal(await Promise.race([
				reading.then(() => 'read'),
				setTimeout(100, 'locked'),
			]), 'locked');
		} finally {
			await release();
			await reading;
		}
		assert.deepEqual(await reading, [queued]);
	});

	it('preserves delivery and deduplication with concurrent pending reads', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);
		const event = {
			content: 'hello',
			meta: { chat_id: 'scope', message_id: 'one' },
		};
		const journal = new FileChannelEventJournal(home, 'channel');
		const queued = await journal.enqueue('channel', event);
		assert.ok(queued);

		const reader = new FileChannelEventJournal(home, 'channel');
		await Promise.all([
			journal.markDelivered([queued.id]),
			...Array.from({ length: 8 }, () => reader.pending()),
		]);

		assert.deepEqual(await reader.pending(), []);
		assert.equal(await reader.enqueue('channel', event), undefined);
	});

	it('fails explicitly on corrupt durable state', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);
		const directory = join(home, 'instances', 'telegram');
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, 'events.json'), '{broken', 'utf8');

		await assert.rejects(
			new FileChannelEventJournal(home, 'telegram').pending(),
			/Failed to read channel event journal/,
		);
	});

	it('bounds the size of pending durable events', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ahp-channels-events-'));
		temporaryDirectories.push(home);

		await assert.rejects(
			new FileChannelEventJournal(home, 'webhook').enqueue('webhook', {
				content: 'x'.repeat(1024 * 1024),
			}),
			/exceeds the 1048576-byte journal limit/,
		);
	});
});
