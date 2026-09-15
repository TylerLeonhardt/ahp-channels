import { AsyncEntry, type EntryOptions } from '@napi-rs/keyring';

const SECRET_SERVICE = 'ahp-channels';
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretStore {
	get(channel: string, key: string): Promise<string | undefined>;
	set(channel: string, key: string, value: string): Promise<void>;
	delete(channel: string, key: string): Promise<boolean>;
}

export class KeyringSecretStore implements SecretStore {
	async get(channel: string, key: string): Promise<string | undefined> {
		validateSecretKey(key);
		return await entry(channel, key).getPassword() ?? undefined;
	}

	async set(channel: string, key: string, value: string): Promise<void> {
		validateSecretKey(key);
		if (!value) {
			throw new Error('Secret value must not be empty');
		}
		await entry(channel, key).setPassword(value);
	}

	async delete(channel: string, key: string): Promise<boolean> {
		validateSecretKey(key);
		return entry(channel, key).deleteCredential();
	}
}

export class InMemorySecretStore implements SecretStore {
	private readonly values = new Map<string, string>();

	async get(channel: string, key: string): Promise<string | undefined> {
		return this.values.get(account(channel, key));
	}

	async set(channel: string, key: string, value: string): Promise<void> {
		this.values.set(account(channel, key), value);
	}

	async delete(channel: string, key: string): Promise<boolean> {
		return this.values.delete(account(channel, key));
	}
}

export function validateSecretKey(key: string): void {
	if (!ENVIRONMENT_KEY.test(key)) {
		throw new Error(`Invalid secret environment variable name '${key}'`);
	}
}

function account(channel: string, key: string): string {
	return `${channel}/${key}`;
}

function entry(channel: string, key: string): AsyncEntry {
	const options: EntryOptions | undefined = process.platform === 'linux'
		? { linux: { store: 'secret-service' } }
		: undefined;
	return new AsyncEntry(SECRET_SERVICE, account(channel, key), options);
}
