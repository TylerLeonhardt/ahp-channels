import { createHash, randomUUID } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isValidChannelInstanceName, type PluginInstallationConfig } from './config.js';
import { withFileLock } from './lockedFile.js';

const INSTALLATION_METADATA = '.ahp-channels-installation.json';
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface PluginInstallationProvenance {
	readonly marketplace: string;
	readonly plugin: string;
	readonly source: string;
	readonly version?: string;
	readonly marketplaceRevision?: string;
}

export interface InstalledPluginSnapshot {
	readonly id: string;
	readonly path: string;
	readonly config: PluginInstallationConfig;
	readonly created: boolean;
}

interface FileEntry {
	readonly kind: 'file';
	readonly path: string;
	readonly content: Buffer;
	readonly mode: number;
}

interface DirectoryEntry {
	readonly kind: 'directory';
	readonly path: string;
	readonly mode: number;
}

interface SymlinkEntry {
	readonly kind: 'symlink';
	readonly path: string;
	readonly target: string;
}

type SnapshotEntry = FileEntry | DirectoryEntry | SymlinkEntry;

export async function installPluginSnapshot(
	home: string,
	sourceRoot: string,
	provenance: PluginInstallationProvenance,
	includedPaths?: readonly string[],
): Promise<InstalledPluginSnapshot> {
	assertSafeName(provenance.marketplace, 'marketplace');
	assertSafeName(provenance.plugin, 'plugin');
	const canonicalSource = await realpath(sourceRoot);
	const entries = await collectEntries(canonicalSource, includedPaths);
	const id = digestEntries(entries);
	const installationPath = getPluginInstallationPath(home, provenance.marketplace, provenance.plugin, id);
	return withFileLock(installationPath, async () => {
		if (await isDirectory(installationPath)) {
			return readInstalledSnapshot(installationPath, id, provenance.marketplace, provenance.plugin);
		}

		const parent = dirname(installationPath);
		const temporary = join(parent, `.${id}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await writeSnapshot(temporary, entries);
			await writeFile(join(temporary, INSTALLATION_METADATA), `${JSON.stringify({
				schemaVersion: 2,
				id,
				...provenance,
				entries: entries.map(entry => ({
					kind: entry.kind,
					path: normalizePath(entry.path),
				})),
			}, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
			await rename(temporary, installationPath);
			return {
				id,
				path: installationPath,
				config: installationConfig(provenance),
				created: true,
			};
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
}

export async function resolvePluginInstallation(
	home: string,
	marketplace: string,
	plugin: string,
	id: string,
): Promise<InstalledPluginSnapshot> {
	return readInstalledSnapshot(
		getPluginInstallationPath(home, marketplace, plugin, id),
		id,
		marketplace,
		plugin,
	);
}

export function getPluginInstallationPath(
	home: string,
	marketplace: string,
	plugin: string,
	id: string,
): string {
	assertSafeName(marketplace, 'marketplace');
	assertSafeName(plugin, 'plugin');
	if (!/^[a-f0-9]{64}$/.test(id)) {
		throw new Error(`Invalid plugin installation ID '${id}'`);
	}
	const root = resolve(home, 'plugins');
	const path = resolve(root, marketplace, plugin, id);
	if (!isWithin(root, path)) {
		throw new Error(`Plugin installation path escapes ${root}`);
	}
	return path;
}

export async function removePluginInstallation(
	home: string,
	marketplace: string,
	plugin: string,
	id: string,
): Promise<void> {
	await rm(getPluginInstallationPath(home, marketplace, plugin, id), {
		recursive: true,
		force: true,
	});
}

async function collectEntries(root: string, includedPaths?: readonly string[]): Promise<SnapshotEntry[]> {
	const entries: SnapshotEntry[] = [];
	const inclusion = includedPaths ? createInclusion(includedPaths) : undefined;
	await collectDirectory(root, '', root, entries, inclusion);
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectDirectory(
	directory: string,
	relativeDirectory: string,
	root: string,
	entries: SnapshotEntry[],
	inclusion: PathInclusion | undefined,
): Promise<void> {
	const children = await readdir(directory, { withFileTypes: true });
	children.sort((left, right) => left.name.localeCompare(right.name));
	for (const child of children) {
		if (EXCLUDED_DIRECTORIES.has(child.name)
			|| (relativeDirectory === '' && child.name === INSTALLATION_METADATA)) {
			continue;
		}
		const sourcePath = join(directory, child.name);
		const relativePath = relativeDirectory ? join(relativeDirectory, child.name) : child.name;
		const normalizedPath = normalizePath(relativePath);
		const metadata = await lstat(sourcePath);
		if (metadata.isDirectory()) {
			if (inclusion && !inclusion.directories.has(normalizedPath)) {
				continue;
			}
			entries.push({
				kind: 'directory',
				path: relativePath,
				mode: metadata.mode & 0o777,
			});
			await collectDirectory(sourcePath, relativePath, root, entries, inclusion);
			continue;
		}
		if (metadata.isFile()) {
			if (inclusion && !inclusion.files.has(normalizedPath)) {
				continue;
			}
			entries.push({
				kind: 'file',
				path: relativePath,
				content: await readFile(sourcePath),
				mode: metadata.mode & 0o777,
			});
			continue;
		}
		if (metadata.isSymbolicLink()) {
			if (inclusion && !inclusion.files.has(normalizedPath)) {
				continue;
			}
			const target = await readlink(sourcePath);
			if (isAbsolute(target)) {
				throw new Error(`Plugin symlink must be relative: ${sourcePath}`);
			}
			const canonicalTarget = await realpath(sourcePath);
			if (!isWithin(root, canonicalTarget)) {
				throw new Error(`Plugin symlink escapes its source directory: ${sourcePath}`);
			}
			const relativeTarget = normalizePath(relative(root, canonicalTarget));
			if (inclusion
				&& !inclusion.files.has(relativeTarget)
				&& !inclusion.directories.has(relativeTarget)) {
				throw new Error(`Plugin symlink targets an excluded file: ${sourcePath}`);
			}
			entries.push({ kind: 'symlink', path: relativePath, target });
			continue;
		}
		throw new Error(`Unsupported plugin file type: ${sourcePath}`);
	}
}

interface PathInclusion {
	readonly files: ReadonlySet<string>;
	readonly directories: ReadonlySet<string>;
}

function createInclusion(paths: readonly string[]): PathInclusion {
	const files = new Set<string>();
	const directories = new Set<string>();
	for (const path of paths) {
		const normalized = normalizePath(path);
		if (!normalized || normalized === '..' || normalized.startsWith('../') || isAbsolute(path)) {
			throw new Error(`Invalid included plugin path '${path}'`);
		}
		files.add(normalized);
		const segments = normalized.split('/');
		segments.pop();
		let directory = '';
		for (const segment of segments) {
			directory = directory ? `${directory}/${segment}` : segment;
			directories.add(directory);
		}
	}
	return { files, directories };
}

function digestEntries(entries: readonly SnapshotEntry[]): string {
	const digest = createHash('sha256');
	for (const entry of entries) {
		digest.update(entry.kind);
		digest.update('\0');
		digest.update(normalizePath(entry.path));
		digest.update('\0');
		if (entry.kind === 'file') {
			digest.update(String(entry.mode));
			digest.update('\0');
			digest.update(entry.content);
		} else if (entry.kind === 'directory') {
			digest.update(String(entry.mode));
		} else {
			digest.update(entry.target);
		}
		digest.update('\0');
	}
	return digest.digest('hex');
}

async function writeSnapshot(root: string, entries: readonly SnapshotEntry[]): Promise<void> {
	await mkdir(root, { recursive: true });
	for (const entry of entries) {
		const destination = join(root, entry.path);
		if (entry.kind === 'directory') {
			await mkdir(destination, { recursive: true, mode: entry.mode });
			await chmod(destination, entry.mode);
			continue;
		}
		await mkdir(dirname(destination), { recursive: true });
		if (entry.kind === 'file') {
			await writeFile(destination, entry.content, { mode: entry.mode });
			await chmod(destination, entry.mode);
		} else {
			await symlink(entry.target, destination);
		}
	}
}

function installationConfig(provenance: PluginInstallationProvenance): PluginInstallationConfig {
	return {
		source: provenance.source,
		...(provenance.version ? { version: provenance.version } : {}),
		...(provenance.marketplaceRevision
			? { marketplaceRevision: provenance.marketplaceRevision }
			: {}),
	};
}

async function readInstalledSnapshot(
	path: string,
	id: string,
	marketplace: string,
	plugin: string,
): Promise<InstalledPluginSnapshot> {
	const metadataPath = join(path, INSTALLATION_METADATA);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(metadataPath, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to read plugin installation metadata ${metadataPath}`, { cause: error });
	}
	if (!isRecord(value)
		|| value['schemaVersion'] !== 2
		|| value['id'] !== id
		|| value['marketplace'] !== marketplace
		|| value['plugin'] !== plugin
		|| typeof value['source'] !== 'string'
		|| (value['version'] !== undefined && typeof value['version'] !== 'string')
		|| (value['marketplaceRevision'] !== undefined && typeof value['marketplaceRevision'] !== 'string')
		|| !Array.isArray(value['entries'])) {
		throw new Error(`Invalid plugin installation metadata ${metadataPath}`);
	}
	const entries = await Promise.all(value['entries'].map(entry => readInstalledEntry(path, entry)));
	const actualId = digestEntries(entries.sort((left, right) => left.path.localeCompare(right.path)));
	if (actualId !== id) {
		throw new Error(`Plugin installation content does not match digest '${id}': ${path}`);
	}
	return {
		id,
		path,
		config: {
			source: value['source'],
			...(value['version'] ? { version: value['version'] } : {}),
			...(value['marketplaceRevision']
				? { marketplaceRevision: value['marketplaceRevision'] }
				: {}),
		},
		created: false,
	};
}

async function readInstalledEntry(root: string, value: unknown): Promise<SnapshotEntry> {
	if (!isRecord(value)
		|| (value['kind'] !== 'file' && value['kind'] !== 'directory' && value['kind'] !== 'symlink')
		|| typeof value['path'] !== 'string') {
		throw new Error(`Invalid plugin installation entry in ${root}`);
	}
	const relativePath = value['path'];
	if (!relativePath
		|| relativePath === '..'
		|| relativePath.startsWith('../')
		|| isAbsolute(relativePath)) {
		throw new Error(`Invalid plugin installation path '${relativePath}'`);
	}
	const path = resolve(root, ...relativePath.split('/'));
	if (!isWithin(root, path)) {
		throw new Error(`Plugin installation path escapes its root: ${relativePath}`);
	}
	const metadata = await lstat(path);
	if (value['kind'] === 'directory') {
		if (!metadata.isDirectory()) {
			throw new Error(`Expected plugin installation directory: ${path}`);
		}
		return {
			kind: 'directory',
			path: relativePath,
			mode: metadata.mode & 0o777,
		};
	}
	if (value['kind'] === 'file') {
		if (!metadata.isFile()) {
			throw new Error(`Expected plugin installation file: ${path}`);
		}
		return {
			kind: 'file',
			path: relativePath,
			content: await readFile(path),
			mode: metadata.mode & 0o777,
		};
	}
	if (!metadata.isSymbolicLink()) {
		throw new Error(`Expected plugin installation symlink: ${path}`);
	}
	return {
		kind: 'symlink',
		path: relativePath,
		target: await readlink(path),
	};
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizePath(path: string): string {
	return path.split(sep).join('/');
}

function assertSafeName(value: string, label: string): void {
	if (!isValidChannelInstanceName(value)) {
		throw new Error(`Invalid ${label} name '${value}'`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
