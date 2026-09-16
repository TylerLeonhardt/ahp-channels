// Attachment-specific E2E fixture utilities. Interactive mode observes real UI
// uploads; automation uses the official HTTP/WS routes, not a browser UI driver.
import {
	ActionType,
	ToolCallConfirmationReason,
	ToolCallContributorKind,
	type ChatToolCallStartAction,
	type SessionState,
} from '@microsoft/agent-host-protocol';
import type { Subscription } from '@microsoft/agent-host-protocol/client';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';
import { raceAbort } from '../src/async.js';
import {
	ATTACHMENT_FIXTURE_VERSION,
	ATTACHMENT_OUTSIDE_FILE,
	ATTACHMENT_SCOPE_FILE,
	ATTACHMENT_SCOPE_NOTE,
	assertMaterializedAttachment,
	assertReturnedAttachment,
	assertSharedAttachmentRead,
	assertValidAttachmentPng,
	attachmentFixtureTools,
	attachmentInvocation,
	attachmentSample,
	attachmentScenarioFromMessage,
	type AttachmentKind,
	type AttachmentScenario,
} from '../test/fixtures/attachment-contract.js';

export async function createAttachmentFixture(home: string, installedPlugin: string): Promise<string> {
	const path = join(home, 'fakechat-attachment-fixture');
	await mkdir(join(path, '.claude-plugin'), { recursive: true });
	await writeFile(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({
		name: 'fakechat',
		version: ATTACHMENT_FIXTURE_VERSION,
	}));
	await writeFile(join(path, '.mcp.json'), JSON.stringify({
		mcpServers: {
			fakechat: {
				command: process.execPath,
				args: [
					'--import', import.meta.resolve('tsx'),
					join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'fixtures', 'fakechat-attachments.ts'),
					installedPlugin,
				],
			},
		},
	}));
	await writeFile(join(path, ATTACHMENT_SCOPE_FILE), ATTACHMENT_SCOPE_NOTE);
	await writeFile(join(home, ATTACHMENT_OUTSIDE_FILE), 'Fixture-only existing file outside the contributed plugin root.\n');
	return path;
}

export async function runAttachmentRoundTrips(options: {
	readonly home: string;
	readonly port: number;
	readonly socket: WebSocket;
	readonly subscription: Subscription;
	readonly state: SessionState;
	readonly clientId: string;
	readonly interactive: boolean;
	readonly fixtureHost: boolean;
}): Promise<void> {
	const client = options.state.activeClients.find(candidate => candidate.clientId === options.clientId);
	assert.ok(client, 'Attachment tools must belong to the running channel client');
	for (const expected of attachmentFixtureTools) {
		const actual: (typeof client.tools)[number] | undefined = client.tools.find(tool => tool.name === expected.name);
		assert.ok(actual, `${expected.name} must be discovered through MCP`);
		assert.deepEqual(actual.inputSchema, expected.inputSchema, 'Nested input schemas must survive tool contribution intact');
		assert.deepEqual(actual.outputSchema, expected.outputSchema, 'Output schemas must survive tool contribution intact');
	}
	assertValidAttachmentPng();
	console.log(`[attachments] ${options.interactive ? 'Browser UI uploads (observer only)' : 'Automated official HTTP upload / WebSocket fixture'}; ${options.fixtureHost ? 'scripted deterministic AHP host, not a real-model test' : 'live AHP provider'}`);
	const kinds: AttachmentKind[] = ['REFERENCE_TEXT', 'REFERENCE_PNG'];
	if (options.fixtureHost) {
		kinds.push('SHARED_TEXT');
		console.log('[attachments] Fixture host also verifies legitimate reverse plugin reads, denied writes/outside-root reads, and a separate shared-filesystem case.');
	}
	const inputs = join(options.home, 'attachment-inputs');
	await mkdir(inputs);
	for (const kind of kinds) {
		const sample = attachmentSample(kind);
		const path = join(inputs, sample.filename);
		await writeFile(path, sample.bytes);
		const bytes = await readFile(path);
		assert.deepEqual(bytes, sample.bytes);
		const marker = `FAKECHAT_ATTACHMENT_${kind}_${randomUUID()}`;
		const visualDescription = kind === 'REFERENCE_PNG' && !options.fixtureHost;
		const lifetime = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.interactive ? 300_000 : 120_000)]);
		try {
			const [observed, message] = await Promise.all([
				observeAttachmentTurn(options.subscription, marker, options.clientId, visualDescription, signal),
				waitForAttachmentDownload(options.socket, marker, visualDescription, signal),
				submitAttachment(options.port, marker, kind, path, bytes, options.interactive, visualDescription, signal),
			]);
			assert.equal(message.name, observed.scenario.name, 'Download must refer to the registered official upload');
			assert.equal(message.caption, observed.caption, 'The UI must display the actual outbound tool caption');
			const response = await fetch(`http://127.0.0.1:${options.port}${message.url}`, {
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			});
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('content-type')?.split(';')[0], kind === 'REFERENCE_PNG' ? 'image/png' : 'text/plain');
			const downloaded = Buffer.from(await response.arrayBuffer());
			assert.deepEqual(downloaded, bytes, 'The returned HTTP download must be byte-identical to the uploaded file, not an acknowledgement');
			console.log(`[attachments] ${kind}: exact AHP content, tool execution/approval/contributor, and ${bytes.length}-byte HTTP download verified; sha256=${createHash('sha256').update(downloaded).digest('hex')}`);
			if (visualDescription) {
				console.log(`[attachments] Live-provider visual response verified (answer was absent from prompt/tool text): ${message.caption.slice(marker.length + 1)}`);
			}
		} finally {
			lifetime.abort();
		}
	}
}

async function submitAttachment(
	port: number,
	marker: string,
	kind: AttachmentKind,
	path: string,
	bytes: Buffer,
	interactive: boolean,
	visualDescription: boolean,
	signal: AbortSignal,
): Promise<void> {
	const prompt = attachmentPrompt(kind, marker, visualDescription);
	if (interactive) {
		console.log(`FAKECHAT_BROWSER_URL=http://127.0.0.1:${port}/`);
		console.log(`FAKECHAT_BROWSER_UPLOAD=${path}`);
		console.log(`FAKECHAT_BROWSER_PROMPT=${prompt}`);
		return;
	}
	const sample = attachmentSample(kind);
	const form = new FormData();
	form.set('id', `attachment-http-fixture-${randomUUID()}`);
	form.set('text', prompt);
	form.set('file', new Blob([new Uint8Array(bytes)], { type: sample.mimeType }), sample.filename);
	const response = await fetch(`http://127.0.0.1:${port}/upload`, {
		method: 'POST',
		body: form,
		signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
	});
	assert.equal(response.status, 204, 'The official browser-facing upload route must accept the real file');
}

export function attachmentPrompt(kind: AttachmentKind, marker: string, visualDescription: boolean): string {
	if (kind === 'SHARED_TEXT') {
		return `${marker}. Separate shared-filesystem fixture: use a host file-read tool to read the uploaded file identified by official file_path metadata, then use the official reply tool with text exactly "${marker}" and files containing that same path.`;
	}
	const caption = visualDescription
		? `"${marker}" followed by a newline and a JSON object with keys "left" and "right", each naming the color you observe on that side of the image. Inspect the actual returned image; the answer is not in metadata`
		: `exactly "${marker}"`;
	return `${marker}. Reference-only attachment fixture: first call fixture_open_upload with the fixture_resource_id from metadata and consume its returned contents. Then call fixture_return_upload with the same resource_id and caption ${caption}. Do not read host files or use other reply tools.`;
}

// Expected visual content stays in this observer, never in the user prompt,
// fixture MCP instructions, tool descriptions, or resource text.
export function assertAttachmentCaption(caption: unknown, marker: string, visualDescription: boolean): asserts caption is string {
	assert.equal(typeof caption, 'string');
	if (!visualDescription) {
		assert.equal(caption, marker);
		return;
	}
	assert.ok(typeof caption === 'string' && caption.startsWith(`${marker}\n`), 'The live provider must return its visual answer after the marker');
	const description = JSON.parse(caption.slice(marker.length + 1));
	assert.deepEqual(Object.keys(description).sort(), ['left', 'right']);
	assert.equal(typeof description.left, 'string');
	assert.equal(typeof description.right, 'string');
	assert.deepEqual(
		{ left: description.left.trim().toLowerCase(), right: description.right.trim().toLowerCase() },
		{ left: 'red', right: 'green' },
		'The live provider must identify the actual PNG colors and their spatial order',
	);
}

interface ObservedTool {
	readonly start: ChatToolCallStartAction;
	state: 'started' | 'ready' | 'approved' | 'completed';
}

async function observeAttachmentTurn(
	subscription: Subscription,
	marker: string,
	clientId: string,
	visualDescription: boolean,
	signal: AbortSignal,
): Promise<{ readonly scenario: AttachmentScenario; readonly caption: string }> {
	let turnId: string | undefined;
	let scenario: AttachmentScenario | undefined;
	let returnedCaption: string | undefined;
	const tools = new Map<string, ObservedTool>();
	while (!signal.aborted) {
		const next = await raceAbort(subscription.next(), signal);
		assert.equal(next.done, false, 'AHP subscription closed before the attachment completed');
		const event = next.value;
		if (event.type !== 'action' || event.params.rejectionReason) {
			continue;
		}
		const action = event.params.action;
		if (action.type === ActionType.ChatTurnStarted && action.message.text.includes(marker)) {
			assert.equal(turnId, undefined, 'Each upload must create exactly one observed turn');
			assert.equal(event.params.origin?.clientId, clientId, 'Only the bridge may forward the official upload');
			turnId = action.turnId;
			scenario = attachmentScenarioFromMessage(action.message.text);
			assert.ok(scenario);
			assert.equal(scenario.marker, marker);
		}
		if (!scenario || !('turnId' in action) || action.turnId !== turnId) {
			continue;
		}
		if (action.type === ActionType.ChatToolCallStart) {
			// The live host may name its new session automatically. This is
			// bookkeeping, not attachment I/O; native file tools remain forbidden.
			if (!action.contributor && action.toolName === 'rename_chat') {
				continue;
			}
			const nativeRead = scenario.kind === 'SHARED_TEXT' && action.toolName === 'fixture_host_read_upload';
			if (!nativeRead) {
				assert.equal(action.contributor?.kind, ToolCallContributorKind.Client, `Unexpected attachment tool: ${JSON.stringify(action)}`);
				assert.equal(action.contributor.clientId, clientId, 'The running channel must contribute every attachment tool');
				assert.ok(action.toolName === attachmentInvocation(scenario, 'return').name
					|| (scenario.kind !== 'SHARED_TEXT' && action.toolName === attachmentInvocation(scenario, 'read').name),
				'Reference uploads must use only the discovered fixture tools, not filesystem shortcuts');
			}
			assert.ok(![...tools.values()].some(tool => tool.start.toolName === action.toolName), 'Attachment tools must execute exactly once');
			tools.set(action.toolCallId, { start: action, state: 'started' });
		}
		const tool = 'toolCallId' in action ? tools.get(action.toolCallId) : undefined;
		if (action.type === ActionType.ChatToolCallReady && tool) {
			assert.equal(tool.state, 'started');
			assert.equal(typeof action.toolInput, 'string', 'The observed invocation must expose its exact JSON arguments');
			const input = JSON.parse(action.toolInput as string);
			if (tool.start.contributor) {
				const phase = tool.start.toolName === 'fixture_open_upload' ? 'read' : 'return';
				const expectedInput = attachmentInvocation(scenario, phase).input;
				assert.equal(action.confirmed, undefined, 'Contributed tools should await automatic bridge approval');
				if (phase === 'return') {
					const captionKey = scenario.kind === 'SHARED_TEXT' ? 'text' : 'caption';
					const caption: unknown = input[captionKey];
					assertAttachmentCaption(caption, marker, visualDescription);
					assert.deepEqual(input, { ...expectedInput, [captionKey]: caption });
					returnedCaption = caption;
					assert.ok([...tools.values()].some(previous => previous.state === 'completed'), 'Uploaded content must reach AHP before returning the file');
				} else {
					assert.deepEqual(input, expectedInput);
				}
			} else {
				assert.deepEqual(input, { path: scenario.sharedPath });
				assert.equal(action.confirmed, ToolCallConfirmationReason.NotNeeded);
			}
			tool.state = 'ready';
		}
		if (action.type === ActionType.ChatToolCallConfirmed && tool) {
			assert.equal(tool.state, 'ready');
			assert.equal(action.approved, true);
			assert.equal(action.confirmed, ToolCallConfirmationReason.NotNeeded);
			assert.equal(action.selectedOptionId, undefined, 'Automatic approval must not alter session policy');
			assert.equal(event.params.origin?.clientId, clientId);
			tool.state = 'approved';
		}
		if (action.type === ActionType.ChatToolCallComplete && tool) {
			// Real providers can publish a presentation-normalized completion after
			// consuming the bridge result (for example, merging text blocks).
			// The original bridge completion and approval were already verified.
			if (tool.state === 'completed') {
				assert.equal(event.params.origin, undefined, 'A second bridge execution must not be mistaken for a provider update');
				assert.equal(action.result.success, true, JSON.stringify(action.result));
				continue;
			}
			if (tool.start.contributor) {
				assert.equal(tool.state, 'approved', 'Attachment tools must be automatically approved before completion');
				assert.equal(event.params.origin?.clientId, clientId, 'The bridge must publish the real MCP tool result');
				if (tool.start.toolName === 'fixture_open_upload') {
					assertMaterializedAttachment(action.result, scenario);
				} else {
					assertReturnedAttachment(action.result, scenario);
				}
			} else {
				assert.equal(tool.state, 'ready');
				assertSharedAttachmentRead(action.result);
			}
			tool.state = 'completed';
		}
		if (action.type === ActionType.ChatTurnComplete) {
			assert.equal(tools.size, 2, 'A file read and outbound attachment call must both be observed');
			assert.ok([...tools.values()].every(tool => tool.state === 'completed'));
			assert.ok(returnedCaption);
			return { scenario, caption: returnedCaption };
		}
		if (action.type === ActionType.ChatTurnCancelled || action.type === ActionType.ChatError) {
			throw new Error(`Attachment turn failed: ${JSON.stringify(action)}`);
		}
	}
	throw new Error(`Timed out observing attachment ${marker}`, { cause: signal.reason });
}

function waitForAttachmentDownload(
	socket: WebSocket,
	marker: string,
	visualDescription: boolean,
	signal: AbortSignal,
): Promise<{ readonly url: string; readonly name: string; readonly caption: string }> {
	return new Promise((resolve, reject) => {
		const onMessage = (raw: RawData) => {
			try {
				const value = JSON.parse(String(raw));
				if (value.type !== 'msg' || value.from !== 'assistant') {
					return;
				}
				assertAttachmentCaption(value.text, marker, visualDescription);
				assert.equal(typeof value.file?.name, 'string', 'Official fakechat must return an actual downloadable attachment');
				assert.match(value.file.url, /^\/files\/[A-Za-z0-9.-]+$/);
				finish();
				resolve({ url: value.file.url, name: value.file.name, caption: value.text });
			} catch (error) {
				finish(error);
			}
		};
		const onAbort = () => finish(signal.reason);
		const onClose = () => finish(new Error('Official fakechat disconnected before the attachment reply'));
		const onError = (error: Error) => finish(error);
		const finish = (error?: unknown) => {
			socket.off('message', onMessage);
			socket.off('close', onClose);
			socket.off('error', onError);
			signal.removeEventListener('abort', onAbort);
			if (error) {
				reject(error);
			}
		};
		socket.on('message', onMessage);
		socket.once('close', onClose);
		socket.once('error', onError);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
}
