import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemorySecretStore, validateSecretKey } from '../src/secrets.js';

describe('SecretStore', () => {
	it('stores secrets by channel and key without cross-channel collisions', async () => {
		const store = new InMemorySecretStore();
		await store.set('personal', 'TOKEN', 'one');
		await store.set('work', 'TOKEN', 'two');

		assert.deepEqual({
			personal: await store.get('personal', 'TOKEN'),
			work: await store.get('work', 'TOKEN'),
			deleted: await store.delete('personal', 'TOKEN'),
			afterDelete: await store.get('personal', 'TOKEN'),
		}, {
			personal: 'one',
			work: 'two',
			deleted: true,
			afterDelete: undefined,
		});
	});

	it('rejects names that cannot be environment variables', () => {
		assert.throws(() => validateSecretKey('BAD-NAME'), /Invalid secret environment variable/);
		assert.doesNotThrow(() => validateSecretKey('TELEGRAM_BOT_TOKEN'));
	});
});
