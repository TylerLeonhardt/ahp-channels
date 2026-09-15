import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentHostEndpointAddress =
	| { readonly type: 'tcp'; readonly host: string; readonly port: number }
	| { readonly type: 'socket'; readonly path: string };

export interface AgentHostEndpoint {
	readonly id: string;
	readonly type: 'editor' | 'standalone';
	readonly pid: number;
	readonly protocolVersion: string;
	readonly connectionToken: string;
	readonly endpoint: AgentHostEndpointAddress;
	readonly registryFile: string;
	readonly modifiedAt: number;
	readonly quality?: string;
	readonly tunnelName?: string;
}

export async function discoverLocalAgentHosts(env: NodeJS.ProcessEnv = process.env): Promise<readonly AgentHostEndpoint[]> {
	const entries: AgentHostEndpoint[] = [];
	for (const directory of registryDirectories(env)) {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') {
				continue;
			}
			throw error;
		}

		for (const name of names.filter(candidate => candidate.endsWith('.json'))) {
			const registryFile = join(directory, name);
			try {
				const [raw, fileStat] = await Promise.all([
					readFile(registryFile, 'utf8'),
					stat(registryFile),
				]);
				const endpoint = parseEndpoint(JSON.parse(raw), registryFile, fileStat.mtimeMs);
				if (endpoint && isProcessAlive(endpoint.pid)) {
					entries.push(endpoint);
				}
			} catch {
				// Registry files are untrusted and independently owned.
			}
		}
	}

	return deduplicate(entries).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function selectAgentHost(endpoints: readonly AgentHostEndpoint[], selector?: string): AgentHostEndpoint {
	if (endpoints.length === 0) {
		throw new Error('No running local Agent Host endpoints were discovered');
	}
	if (!selector) {
		return endpoints[0];
	}
	const index = Number(selector);
	if (Number.isSafeInteger(index) && index >= 0 && index < endpoints.length) {
		return endpoints[index];
	}
	const matches = endpoints.filter(endpoint => endpoint.id === selector || endpoint.id.startsWith(selector));
	if (matches.length === 1) {
		return matches[0];
	}
	if (matches.length > 1) {
		throw new Error(`Host selector '${selector}' is ambiguous`);
	}
	throw new Error(`No discovered host matches '${selector}'`);
}

export function describeEndpoint(endpoint: AgentHostEndpoint, index?: number): Record<string, unknown> {
	return {
		...(index !== undefined ? { index } : {}),
		id: endpoint.id,
		type: endpoint.type,
		pid: endpoint.pid,
		protocolVersion: endpoint.protocolVersion,
		endpoint: endpoint.endpoint.type === 'tcp'
			? `${endpoint.endpoint.host}:${endpoint.endpoint.port}`
			: endpoint.endpoint.path,
		...(endpoint.quality ? { quality: endpoint.quality } : {}),
		...(endpoint.tunnelName ? { tunnelName: endpoint.tunnelName } : {}),
	};
}

function registryDirectories(env: NodeJS.ProcessEnv): readonly string[] {
	if (env['AHP_CHANNELS_ENDPOINT_REGISTRY']) {
		return [env['AHP_CHANNELS_ENDPOINT_REGISTRY']];
	}

	const result = new Set<string>();
	const appData = env['APPDATA'];
	if (appData) {
		for (const product of ['Code', 'Code - Insiders']) {
			result.add(join(appData, product, 'agent-host', 'local-endpoint', 'entries'));
		}
	}

	const home = homedir();
	for (const root of [
		join(home, '.config', 'Code'),
		join(home, '.config', 'Code - Insiders'),
		join(home, 'Library', 'Application Support', 'Code'),
		join(home, 'Library', 'Application Support', 'Code - Insiders'),
		join(home, '.vscode-server', 'data'),
		join(home, '.vscode-server-insiders', 'data'),
	]) {
		result.add(join(root, 'agent-host', 'local-endpoint', 'entries'));
	}
	return [...result];
}

function parseEndpoint(value: unknown, registryFile: string, modifiedAt: number): AgentHostEndpoint | undefined {
	if (!isRecord(value)
		|| value['schemaVersion'] !== 2
		|| (value['type'] !== 'editor' && value['type'] !== 'standalone')
		|| !Number.isSafeInteger(value['pid'])
		|| typeof value['instanceId'] !== 'string'
		|| typeof value['protocolVersion'] !== 'string'
		|| typeof value['connectionToken'] !== 'string'
		|| !isRecord(value['endpoint'])) {
		return undefined;
	}

	const endpoint = parseAddress(value['endpoint']);
	if (!endpoint) {
		return undefined;
	}
	return {
		id: `${value['type']}:${value['pid']}:${value['instanceId']}`,
		type: value['type'],
		pid: value['pid'] as number,
		protocolVersion: value['protocolVersion'],
		connectionToken: value['connectionToken'],
		endpoint,
		registryFile,
		modifiedAt,
		...(typeof value['quality'] === 'string' ? { quality: value['quality'] } : {}),
		...(typeof value['tunnelName'] === 'string' ? { tunnelName: value['tunnelName'] } : {}),
	};
}

function parseAddress(value: Record<string, unknown>): AgentHostEndpointAddress | undefined {
	if (value['type'] === 'tcp'
		&& typeof value['host'] === 'string'
		&& Number.isSafeInteger(value['port'])
		&& (value['port'] as number) > 0
		&& (value['port'] as number) <= 65535) {
		return { type: 'tcp', host: value['host'], port: value['port'] as number };
	}
	if (value['type'] === 'socket' && typeof value['path'] === 'string') {
		return { type: 'socket', path: value['path'] };
	}
	return undefined;
}

function deduplicate(entries: readonly AgentHostEndpoint[]): AgentHostEndpoint[] {
	const result = new Map<string, AgentHostEndpoint>();
	for (const entry of entries) {
		const current = result.get(entry.id);
		if (!current || entry.modifiedAt > current.modifiedAt) {
			result.set(entry.id, entry);
		}
	}
	return [...result.values()];
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code === 'EPERM';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
