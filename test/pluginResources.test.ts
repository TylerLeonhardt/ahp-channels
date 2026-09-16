import {
	AhpErrorCodes,
	ContentEncoding,
	ResourceType,
} from '@microsoft/agent-host-protocol';
import { RpcError } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createPluginResourceRequestHandlers } from '../src/pluginResources.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('plugin resource requests', () => {
	it('serves plugin files and directories read-only', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-resources-'));
		temporaryDirectories.push(root);
		await mkdir(join(root, 'skills', 'configure'), { recursive: true });
		await mkdir(join(root, '..metadata'));
		await writeFile(join(root, 'skills', 'configure', 'SKILL.md'), 'configure');
		await writeFile(join(root, '..metadata', 'manifest.json'), '{}');
		const handlers = await createPluginResourceRequestHandlers(root);
		assert.ok(handlers.resourceRequest);
		assert.ok(handlers.resourceResolve);
		assert.ok(handlers.resourceList);
		assert.ok(handlers.resourceRead);
		const rootUri = pathToFileURL(root).href;
		const skillUri = pathToFileURL(join(root, 'skills', 'configure', 'SKILL.md')).href;

		const permission = await handlers.resourceRequest({
			channel: 'ahp-root://',
			uri: rootUri,
			read: true,
		});
		const resolved = await handlers.resourceResolve({
			channel: 'ahp-root://',
			uri: skillUri,
		});
		const listed = await handlers.resourceList({
			channel: 'ahp-root://',
			uri: pathToFileURL(join(root, 'skills')).href,
		});
		const read = await handlers.resourceRead({
			channel: 'ahp-root://',
			uri: skillUri,
			encoding: ContentEncoding.Utf8,
		});
		const dottedDirectoryRead = await handlers.resourceRead({
			channel: 'ahp-root://',
			uri: pathToFileURL(join(root, '..metadata', 'manifest.json')).href,
			encoding: ContentEncoding.Utf8,
		});

		assert.deepEqual({
			permission,
			resolvedType: resolved.type,
			resolvedSize: resolved.size,
			entries: listed.entries,
			read,
			dottedDirectoryRead,
		}, {
			permission: {},
			resolvedType: ResourceType.File,
			resolvedSize: 'configure'.length,
			entries: [{ name: 'configure', type: 'directory' }],
			read: {
				data: 'configure',
				encoding: ContentEncoding.Utf8,
			},
			dottedDirectoryRead: {
				data: '{}',
				encoding: ContentEncoding.Utf8,
			},
		});
	});

	it('rejects writes and paths outside the plugin root', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-resources-'));
		temporaryDirectories.push(parent);
		const root = join(parent, 'plugin');
		const outside = join(parent, 'outside.txt');
		await mkdir(root);
		await writeFile(outside, 'outside');
		const handlers = await createPluginResourceRequestHandlers(root);
		const resourceRequest = handlers.resourceRequest;
		const resourceRead = handlers.resourceRead;
		assert.ok(resourceRequest);
		assert.ok(resourceRead);

		await assert.rejects(
			() => Promise.resolve(resourceRequest({
				channel: 'ahp-root://',
				uri: pathToFileURL(root).href,
				write: true,
			})),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
		await assert.rejects(
			() => Promise.resolve(resourceRead({
				channel: 'ahp-root://',
				uri: pathToFileURL(outside).href,
			})),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
		await assert.rejects(
			() => Promise.resolve(resourceRead({
				channel: 'ahp-root://',
				uri: pathToFileURL(join(root, 'missing')).href,
			})),
			isRpcError(AhpErrorCodes.NotFound),
		);
		await assert.rejects(
			() => Promise.resolve(resourceRead({
				channel: 'ahp-root://',
				uri: 'https://example.com/plugin.json',
			})),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
	});

	it('rejects symlinks that escape the plugin root', { skip: process.platform === 'win32' }, async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-resources-'));
		temporaryDirectories.push(parent);
		const root = join(parent, 'plugin');
		const outside = join(parent, 'outside.txt');
		const link = join(root, 'outside.txt');
		await mkdir(root);
		await writeFile(outside, 'outside');
		await symlink(outside, link);
		const handlers = await createPluginResourceRequestHandlers(root);
		const resourceRead = handlers.resourceRead;
		assert.ok(resourceRead);

		await assert.rejects(
			() => Promise.resolve(resourceRead({
				channel: 'ahp-root://',
				uri: pathToFileURL(link).href,
			})),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
	});

	it('rejects directory links that escape the plugin root, including Windows junctions', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'ahp-channels-plugin-resources-'));
		temporaryDirectories.push(parent);
		const root = join(parent, 'plugin');
		const outside = join(parent, 'outside');
		await mkdir(root);
		await mkdir(outside);
		await writeFile(join(outside, 'attachment.txt'), 'not contributed');
		await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		const handlers = await createPluginResourceRequestHandlers(root);
		assert.ok(handlers.resourceRead);
		assert.ok(handlers.resourceRequest);
		const uri = pathToFileURL(join(root, 'linked', 'attachment.txt')).href;
		await assert.rejects(
			() => Promise.resolve(handlers.resourceRead?.({ channel: 'ahp-root://', uri })),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
		await assert.rejects(
			() => Promise.resolve(handlers.resourceRequest?.({ channel: 'ahp-root://', uri, read: true })),
			isRpcError(AhpErrorCodes.PermissionDenied),
		);
	});
});

function isRpcError(code: number): (error: unknown) => boolean {
	return error => error instanceof RpcError && error.code === code;
}
