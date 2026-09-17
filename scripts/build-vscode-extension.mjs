import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'vscode-extension', 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
	build({
		entryPoints: [resolve(root, 'vscode-extension', 'src', 'extension.ts')],
		bundle: true,
		external: ['vscode'],
		banner: {
			js: 'const __ahpImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
		},
		define: {
			'import.meta.url': '__ahpImportMetaUrl',
		},
		format: 'cjs',
		outfile: resolve(outputDirectory, 'extension.cjs'),
		platform: 'node',
		sourcemap: true,
		target: 'node22',
	}),
	build({
		entryPoints: [resolve(root, 'src', 'daemonMain.ts')],
		bundle: true,
		format: 'esm',
		outfile: resolve(outputDirectory, 'daemonMain.js'),
		platform: 'node',
		sourcemap: true,
		target: 'node22',
	}),
]);
