import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ChannelOperationError } from '../src/channelHealth.js';
import { explainMcpStartupError } from '../src/mcpStartup.js';

describe('MCP startup diagnostics', () => {
	for (const syscall of ['spawn', `spawn ${process.execPath}`]) {
		for (const code of ['ENOENT', 'ENOTDIR']) {
			it(`explains a non-directory cwd for ${code} with syscall '${syscall}'`, async context => {
				const home = await mkdtemp(join(tmpdir(), 'ahp-startup-error-'));
				context.after(() => rm(home, { recursive: true, force: true }));
				const cwd = join(home, 'not-a-directory');
				await writeFile(cwd, '');
				const original = Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
				const explained = await explainMcpStartupError(original, { command: process.execPath, cwd });

				assert.ok(explained instanceof ChannelOperationError);
				assert.equal(explained.stage, 'mcp-startup');
				assert.ok(explained.message.includes(cwd));
				assert.doesNotMatch(explained.guidance, /[Ii]nstall/);
				assert.ok(explained.cause instanceof AggregateError);
				assert.equal(explained.cause.errors[0], original);
			});
		}
	}

	it('preserves ENOTDIR when the working directory is valid', async () => {
		const original = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR', syscall: 'spawn' });
		assert.equal(
			await explainMcpStartupError(original, { command: process.execPath, cwd: tmpdir() }),
			original,
		);
	});

	it('does not reinterpret errors from other operations or commands', async () => {
		for (const syscall of ['open', 'spawn another-command']) {
			const original = Object.assign(new Error(`${syscall} ENOENT`), { code: 'ENOENT', syscall });
			assert.equal(
				await explainMcpStartupError(original, { command: process.execPath }),
				original,
			);
		}
	});
});
