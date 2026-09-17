import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const expected = `export const VERSION = '${packageJson.version}';\n`;
const versionFile = resolve(root, 'src', 'version.ts');
const extensionPackageFile = resolve(root, 'vscode-extension', 'package.json');
const extensionPackage = JSON.parse(await readFile(extensionPackageFile, 'utf8'));

if (process.argv.includes('--check')) {
	const actual = (await readFile(versionFile, 'utf8')).replaceAll('\r\n', '\n');
	if (actual !== expected) {
		throw new Error(`src/version.ts does not match package.json (${packageJson.version})`);
	}
	if (extensionPackage.version !== packageJson.version) {
		throw new Error(`vscode-extension/package.json does not match package.json (${packageJson.version})`);
	}
} else {
	await writeFile(versionFile, expected, 'utf8');
	await writeFile(extensionPackageFile, `${JSON.stringify({
		...extensionPackage,
		version: packageJson.version,
	}, undefined, 2)}\n`, 'utf8');
}
