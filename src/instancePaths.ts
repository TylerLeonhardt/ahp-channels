import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isValidChannelInstanceName } from './config.js';

export function getInstanceRoot(home: string, name: string): string {
	if (!isValidChannelInstanceName(name)) {
		throw new Error(`Invalid channel name '${name}'`);
	}
	const instances = resolve(home, 'instances');
	const instance = resolve(instances, name);
	if (dirname(instance) !== instances) {
		throw new Error(`Channel instance path escapes ${instances}`);
	}
	return instance;
}

export async function removeInstanceState(home: string, name: string): Promise<void> {
	await rm(getInstanceRoot(home, name), { recursive: true, force: true });
}
