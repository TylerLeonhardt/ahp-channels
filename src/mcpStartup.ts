import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ChannelOperationError, sanitizeErrorSummary } from './channelHealth.js';
import type { StdioMcpServerConfig } from './plugins.js';

export async function explainMcpStartupError(
	error: unknown,
	server: Pick<StdioMcpServerConfig, 'command' | 'cwd'>,
): Promise<unknown> {
	if (!(error instanceof Error)
		|| !('code' in error)
		|| (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
		|| !('syscall' in error)
		|| error.syscall !== `spawn ${server.command}`) {
		return error;
	}

	// Spawn can report ENOENT for either the executable or the working directory.
	const cwd = resolve(server.cwd ?? process.cwd());
	try {
		if (!(await stat(cwd)).isDirectory()) {
			throw new Error('The configured working directory is not a directory');
		}
	} catch (directoryError) {
		return new ChannelOperationError(
			'mcp-startup',
			`MCP working directory '${sanitizeErrorSummary(cwd)}' is unavailable.`,
			'Check the plugin MCP working-directory configuration, restore the directory, then restart the channel.',
			{ cause: new AggregateError([error, directoryError], 'MCP working directory could not be accessed') },
		);
	}
	if (error.code !== 'ENOENT') {
		return error;
	}
	const command = sanitizeErrorSummary(server.command);
	return new ChannelOperationError(
		'mcp-startup',
		`MCP executable '${command}' was not found or its interpreter is unavailable (ENOENT).`,
		`Install '${command}' and ensure the executable and any required interpreter are available in the daemon's PATH, or correct the plugin's MCP command. Restart the daemon from an environment with the updated PATH; reloading VS Code may also be needed.`,
		{ cause: error },
	);
}
