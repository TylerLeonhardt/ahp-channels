import {
	AhpErrorCodes,
	ContentEncoding,
	ResourceType,
	type DirectoryEntry,
	type ResourceResolveResult,
} from '@microsoft/agent-host-protocol';
import { RpcError, type ResourceRequestHandlers } from '@microsoft/agent-host-protocol/client';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function createPluginResourceRequestHandlers(pluginRoot: string): Promise<ResourceRequestHandlers> {
	const canonicalRoot = await realpath(pluginRoot);
	return {
		async resourceRequest(params) {
			if (params.write) {
				throw readOnly(params.uri);
			}
			await resolveReadablePath(params.uri, canonicalRoot);
			return {};
		},
		async resourceResolve(params) {
			const resource = await resolveReadablePath(params.uri, canonicalRoot);
			const metadata = params.followSymlinks === false
				? await lstat(resource.requested)
				: await stat(resource.canonical);
			return {
				uri: params.followSymlinks === false
					? pathToFileURL(resource.requested).href
					: pathToFileURL(resource.canonical).href,
				type: resourceType(metadata),
				...(metadata.isDirectory() ? {} : { size: metadata.size }),
				mtime: metadata.mtime.toISOString(),
				ctime: metadata.birthtime.toISOString(),
			};
		},
		async resourceList(params) {
			const resource = await resolveReadablePath(params.uri, canonicalRoot);
			const metadata = await stat(resource.canonical);
			if (!metadata.isDirectory()) {
				throw notFound(params.uri);
			}
			const entries = await readdir(resource.canonical, { withFileTypes: true });
			return {
				entries: entries.map((entry): DirectoryEntry => ({
					name: entry.name,
					type: entry.isDirectory() ? 'directory' : 'file',
				})),
			};
		},
		async resourceRead(params) {
			const resource = await resolveReadablePath(params.uri, canonicalRoot);
			const data = await readFile(resource.canonical);
			const encoding = params.encoding === ContentEncoding.Utf8
				? ContentEncoding.Utf8
				: ContentEncoding.Base64;
			return {
				data: encoding === ContentEncoding.Utf8 ? data.toString('utf8') : data.toString('base64'),
				encoding,
			};
		},
	};
}

interface ReadablePath {
	readonly requested: string;
	readonly canonical: string;
}

async function resolveReadablePath(uri: string, canonicalRoot: string): Promise<ReadablePath> {
	let requested: string;
	try {
		requested = fileURLToPath(uri);
	} catch {
		throw unsupportedResource(uri);
	}
	let canonical: string;
	try {
		canonical = await realpath(requested);
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			throw notFound(uri);
		}
		if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
			throw permissionDenied(uri);
		}
		throw error;
	}
	if (!isWithin(canonicalRoot, canonical)) {
		throw permissionDenied(uri);
	}
	return { requested, canonical };
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function resourceType(metadata: Awaited<ReturnType<typeof stat>>): ResourceResolveResult['type'] {
	if (metadata.isSymbolicLink()) {
		return ResourceType.Symlink;
	}
	return metadata.isDirectory() ? ResourceType.Directory : ResourceType.File;
}

function notFound(uri: string): RpcError {
	return new RpcError(AhpErrorCodes.NotFound, `Resource does not exist: ${uri}`);
}

function permissionDenied(uri: string): RpcError {
	return new RpcError(AhpErrorCodes.PermissionDenied, `Resource is outside the contributed plugin: ${uri}`);
}

function readOnly(uri: string): RpcError {
	return new RpcError(AhpErrorCodes.PermissionDenied, `Contributed plugin resources are read-only: ${uri}`);
}

function unsupportedResource(uri: string): RpcError {
	return new RpcError(AhpErrorCodes.PermissionDenied, `Only file resources can be served: ${uri}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
