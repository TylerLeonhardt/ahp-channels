import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const temporaryDirectories: string[] = [];
const cli = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('plugin lifecycle CLI', () => {
	it('pins channels until they explicitly upgrade', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-cli-'));
		temporaryDirectories.push(root);
		const home = join(root, 'home');
		const marketplace = join(root, 'marketplace');
		const plugin = join(marketplace, 'plugins', 'fake');
		await mkdir(marketplace, { recursive: true });
		await writeFile(join(marketplace, 'marketplace.json'), JSON.stringify({
			plugins: [{ name: 'fake', source: './plugins/fake' }],
		}));
		await writePlugin(plugin, '1.0.0');

		await runCli(home, ['marketplace', 'add', 'test', marketplace]);
		await runCli(home, ['plugin', 'install', 'fake@test']);
		await runCli(home, [
			'channel',
			'create',
			'personal',
			'--plugin',
			'fake',
			'--session',
			'ahp-session:/one',
		]);
		const first = await readConfig(home);
		const firstInstallation = first.plugins.fake?.activeInstallation;
		assert.ok(firstInstallation);
		assert.equal(first.channels.personal?.installation, firstInstallation);

		await writePlugin(plugin, '2.0.0');
		await runCli(home, ['plugin', 'upgrade', 'fake']);
		const upgraded = await readConfig(home);
		const secondInstallation = upgraded.plugins.fake?.activeInstallation;
		assert.ok(secondInstallation);
		assert.notEqual(secondInstallation, firstInstallation);
		assert.equal(upgraded.channels.personal?.installation, firstInstallation);

		await runCli(home, ['channel', 'upgrade', 'personal']);
		const repinned = await readConfig(home);
		assert.equal(repinned.channels.personal?.installation, secondInstallation);

		await runCli(home, ['plugin', 'rollback', 'fake', firstInstallation]);
		const rolledBack = await readConfig(home);
		assert.equal(rolledBack.plugins.fake?.activeInstallation, firstInstallation);
		assert.equal(rolledBack.channels.personal?.installation, secondInstallation);
		assert.match(
			await runCli(home, ['plugin', 'versions', 'fake']),
			new RegExp(`${firstInstallation}|${secondInstallation}`),
		);
		assert.match(await runCli(home, ['plugin', 'prune', 'fake']), /No unreferenced/);

		await runCli(home, ['channel', 'delete', 'personal']);
		assert.match(await runCli(home, ['plugin', 'prune', 'fake']), new RegExp(secondInstallation));
		await assert.doesNotReject(access(join(home, 'plugins', 'test', 'fake', firstInstallation)));
		await assert.rejects(access(join(home, 'plugins', 'test', 'fake', secondInstallation)));
	});
});

interface TestConfig {
	readonly plugins: Readonly<Record<string, {
		readonly activeInstallation?: string;
	}>>;
	readonly channels: Readonly<Record<string, {
		readonly installation?: string;
	}>>;
}

async function readConfig(home: string): Promise<TestConfig> {
	const value: unknown = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
	if (!isRecord(value) || !isRecord(value['plugins']) || !isRecord(value['channels'])) {
		throw new Error('CLI wrote an invalid test configuration');
	}
	return {
		plugins: Object.fromEntries(Object.entries(value['plugins']).map(([name, plugin]) => [
			name,
			isRecord(plugin) && typeof plugin['activeInstallation'] === 'string'
				? { activeInstallation: plugin['activeInstallation'] }
				: {},
		])),
		channels: Object.fromEntries(Object.entries(value['channels']).map(([name, channel]) => [
			name,
			isRecord(channel) && typeof channel['installation'] === 'string'
				? { installation: channel['installation'] }
				: {},
		])),
	};
}

async function writePlugin(path: string, version: string): Promise<void> {
	await mkdir(join(path, '.claude-plugin'), { recursive: true });
	await writeFile(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({
		name: 'fake',
		version,
	}));
	await writeFile(join(path, '.mcp.json'), JSON.stringify({
		mcpServers: {
			fake: {
				command: process.execPath,
				args: ['--eval', 'setInterval(() => undefined, 1000)'],
			},
		},
	}));
}

function runCli(home: string, args: readonly string[]): Promise<string> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
			cwd: resolve(import.meta.dirname, '..'),
			env: { ...process.env, AHP_CHANNELS_HOME: home },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => stdout += chunk);
		child.stderr.on('data', chunk => stderr += chunk);
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolveRun(stdout);
			} else {
				reject(new Error(`CLI exited with ${code}: ${stderr}`));
			}
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
