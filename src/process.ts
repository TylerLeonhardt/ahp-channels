import { spawn } from 'node:child_process';

export interface RunProcessOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly quiet?: boolean;
}

export interface RunProcessResult {
	readonly stdout: string;
	readonly stderr: string;
}

export function runProcess(command: string, args: readonly string[], options: RunProcessOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: options.quiet ? 'ignore' : 'inherit',
			shell: false,
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with ${code ?? signal ?? 'an unknown status'}`));
		});
	});
}

export function runProcessOutput(
	command: string,
	args: readonly string[],
	options: Omit<RunProcessOptions, 'quiet'> = {},
): Promise<RunProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
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
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			const detail = stderr.trim();
			reject(new Error(
				`${command} exited with ${code ?? signal ?? 'an unknown status'}${detail ? `: ${detail}` : ''}`,
			));
		});
	});
}
