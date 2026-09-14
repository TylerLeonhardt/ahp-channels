import { spawn } from 'node:child_process';

export interface RunProcessOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly quiet?: boolean;
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
