const MAX_PREVIEW_CODE_POINTS = 3500;
const MAX_FIELD_CODE_POINTS = 1000;
const MAX_KEY_CODE_POINTS = 200;
const MAX_INPUT_CODE_UNITS = 65_536;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4096;
const MIN_TRUNCATION_BUDGET = 64;

// Unlike health summaries, approvals must not redact arbitrary assignments or discard lines:
// either can conceal a command, redirection, or URL. Only credential-shaped substrings match.
// Fixed-width formats also match concatenated credentials without consuming filename/URL suffixes.
const CREDENTIALS = /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-(?:(?:ant-api03|proj|svcacct)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48})|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u2028\u2029\u2800]/u;
const QUOTE_OR_ANGLE_LOOKALIKE = /[\p{Pi}\p{Pf}\u00B4\u02B9-\u02BF\u02C2\u02C3\u02C8\u02CA\u02CB\u02F1\u02F2\u02F4\u0374\u0384\u055A-\u055D\u05F3\u05F4\u07F4\u07F5\u1433\u1438\u1FBD\u1FBF\u1FEF\u1FFD\u1FFE\u2018-\u201F\u2032-\u2037\u226A\u226B\u227A\u227B\u2329\u232A\u275B-\u2760\u276C-\u2771\u27E8-\u27EB\u3008-\u300F\u301D-\u301F\uA78B\uA78C\uFE41-\uFE44]/u;

interface TextPreview {
	readonly head: string;
	readonly tail: string;
	readonly codePoints: number;
	readonly quotedCodePoints: number;
}

interface JsonEntry {
	readonly key?: TextPreview;
	readonly value: JsonPreview;
}

type JsonPreview = {
	readonly kind: 'text';
	readonly text: TextPreview;
} | {
	readonly kind: 'literal';
	readonly text: string;
} | {
	readonly kind: 'array' | 'object';
	readonly entries: readonly JsonEntry[];
	readonly codePoints: number;
};

interface RenderedEntry {
	readonly text: string;
	readonly key?: string;
}

/**
 * Display-only text, never an executable command. Controls (including line breaks),
 * invisible characters, and quotation/angle confusables become visible [U+XXXX] markers.
 * Other whitespace runs fold to one space; ASCII shell syntax is retained.
 * At most 3500 Unicode code points, including a middle-omission marker. Omission counts
 * refer to the sanitized, credential-redacted display, not the original source.
 */
export function sanitizePermissionText(text: string): string {
	return renderText(previewText(text), MAX_PREVIEW_CODE_POINTS, false);
}

/**
 * A display-only, JSON-shaped preview with structural quotes intact. Top-level entries
 * are limited to 1000 code points (keys to 200); the entire preview is limited to 3500.
 * Truncation retains both ends and is explicit. String omissions count decoded sanitized
 * text; structural elisions count omitted entries and their serialized sanitized JSON
 * code points. This is not an exhaustive secret detector.
 * Unparseable, oversized, ambiguous, or excessively complex JSON is visibly labeled and
 * shown as a bounded raw string instead. Parsing is capped at 65536 UTF-16 code units,
 * 32 nesting levels, and 4096 nodes; no input is evaluated.
 */
export function formatPermissionInput(input: string | undefined): string {
	if (input === undefined) {
		return '"[no arguments]"';
	}
	if (input.length > MAX_INPUT_CODE_UNITS) {
		return rawPreview(input, 'Input exceeds the 65536 UTF-16 code-unit parsing limit; structure not inspected.');
	}

	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		return rawPreview(input, 'Invalid JSON; showing raw input.');
	}

	const source = inspectJsonSource(input);
	if (!source.losslessNumbers) {
		return rawPreview(input, 'JSON numbers cannot be displayed losslessly; showing raw input.');
	}
	try {
		const budget = { nodes: 0, keys: 0 };
		const preview = previewJson(value, 0, budget);
		if (budget.keys !== source.keys) {
			return rawPreview(input, 'Duplicate JSON keys; showing raw input.');
		}
		return renderJson(preview, MAX_PREVIEW_CODE_POINTS, true);
	} catch {
		return rawPreview(input, 'JSON exceeds safe complexity limits or has ambiguous display keys; showing raw input.');
	}
}

function previewText(text: string): TextPreview {
	const head: string[] = [];
	const tail: string[] = [];
	let codePoints = 0;
	let quotedCodePoints = 2;
	let previousWasSpace = false;
	for (const character of text.replace(CREDENTIALS, '[redacted credential]')) {
		const compatibility = character.normalize('NFKC');
		const unsafe = INVISIBLE_OR_CONTROL.test(character)
			|| QUOTE_OR_ANGLE_LOOKALIKE.test(character)
			|| (character !== compatibility && /^["'`<>]+$/.test(compatibility));
		const visible = unsafe
			? `[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`
			: /\s/u.test(character) ? ' ' : character;
		if (visible === ' ' && previousWasSpace) {
			continue;
		}
		previousWasSpace = visible === ' ';
		for (const point of visible) {
			if (head.length < MAX_PREVIEW_CODE_POINTS) {
				head.push(point);
			}
			tail[codePoints % MAX_PREVIEW_CODE_POINTS] = point;
			codePoints++;
			quotedCodePoints += quotedWidth(point);
		}
	}
	const headText = head.join('');
	const tailOffset = codePoints % MAX_PREVIEW_CODE_POINTS;
	return {
		head: headText,
		tail: codePoints <= MAX_PREVIEW_CODE_POINTS
			? headText
			: [...tail.slice(tailOffset), ...tail.slice(0, tailOffset)].join(''),
		codePoints,
		quotedCodePoints,
	};
}

function renderText(text: TextPreview, budget: number, quoted: boolean): string {
	if ((quoted ? text.quotedCodePoints : text.codePoints) <= budget) {
		return quoted ? JSON.stringify(text.head) : text.head;
	}
	if (budget < MIN_TRUNCATION_BUDGET) {
		throw new RangeError('Not enough space for an unambiguous text preview.');
	}
	// Reserve the largest possible marker so its digits, quotes, and escaping all fit.
	const available = budget - omission(text.codePoints).length - (quoted ? 2 : 0);
	const head = takeEdge(text.head, Math.ceil(available / 2), quoted, false);
	const tail = takeEdge(text.tail, Math.floor(available / 2), quoted, true);
	const visible = head.text + omission(text.codePoints - head.count - tail.count) + tail.text;
	return quoted ? JSON.stringify(visible) : visible;
}

function takeEdge(text: string, budget: number, quoted: boolean, fromEnd: boolean): { text: string; count: number } {
	const points = Array.from(text);
	if (fromEnd) {
		points.reverse();
	}
	const kept: string[] = [];
	let width = 0;
	for (const point of points) {
		const nextWidth = quoted ? quotedWidth(point) : 1;
		if (width + nextWidth > budget) {
			break;
		}
		kept.push(point);
		width += nextWidth;
	}
	return { text: (fromEnd ? kept.reverse() : kept).join(''), count: kept.length };
}

function quotedWidth(point: string): number {
	return point === '"' || point === '\\' ? 2 : 1;
}

function omission(codePoints: number): string {
	return `[... ${codePoints} code points omitted ...]`;
}

function inspectJsonSource(input: string): { keys: number; losslessNumbers: boolean } {
	let keys = 0;
	let losslessNumbers = true;
	// JSON.parse has already validated the grammar. Tokenizing strings together with
	// numbers prevents inspecting quoted digits or escaped quotation marks as syntax.
	for (const match of input.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
		if (match[0].startsWith('"')) {
			let index = match.index + match[0].length;
			while (/[ \t\r\n]/.test(input[index] ?? '')) {
				index++;
			}
			if (input[index] === ':') {
				keys++;
			}
		} else if (match[0] !== '-0' && JSON.stringify(Number(match[0])) !== match[0]) {
			losslessNumbers = false;
		}
	}
	return { keys, losslessNumbers };
}

function previewJson(value: unknown, depth: number, budget: { nodes: number; keys: number }): JsonPreview {
	if (++budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
		throw new RangeError('JSON complexity limit exceeded.');
	}
	if (typeof value === 'string') {
		return { kind: 'text', text: previewText(value) };
	}
	if (value === null || typeof value !== 'object') {
		return { kind: 'literal', text: Object.is(value, -0) ? '-0' : JSON.stringify(value) };
	}
	const isArray = Array.isArray(value);
	const entries: JsonEntry[] = isArray
		? value.map(item => ({ value: previewJson(item, depth + 1, budget) }))
		: Object.entries(value).map(([key, item]) => {
			budget.keys++;
			return { key: previewText(key), value: previewJson(item, depth + 1, budget) };
		});
	return {
		kind: isArray ? 'array' : 'object',
		entries,
		codePoints: 2 + Math.max(0, entries.length - 1) * 2
			+ entries.reduce((sum, entry) => sum + entryWidth(entry), 0),
	};
}

function jsonWidth(value: JsonPreview): number {
	switch (value.kind) {
		case 'text': return value.text.quotedCodePoints;
		case 'literal': return value.text.length;
		default: return value.codePoints;
	}
}

function entryWidth(entry: JsonEntry): number {
	return (entry.key ? entry.key.quotedCodePoints + 2 : 0) + jsonWidth(entry.value);
}

function renderJson(value: JsonPreview, budget: number, topLevel = false): string {
	if (value.kind === 'text') {
		return renderText(value.text, budget, true);
	}
	if (value.kind === 'literal') {
		if (value.text.length > budget) {
			throw new RangeError('Not enough space for a JSON literal.');
		}
		return value.text;
	}
	const entryBudget = Math.min(topLevel ? MAX_FIELD_CODE_POINTS : budget - 2, budget - 2);
	const entries = value.entries.map(entry => renderEntry(entry, entryBudget));
	const complete = joinEntries(value.kind, entries);
	if (Array.from(complete).length <= budget) {
		return complete;
	}

	const hasMiddle = entries.length > 2;
	const markerBudget = hasMiddle ? omittedEntries(value, 0, entries.length).text.length + 4 : 2;
	const edgeBudget = Math.min(entryBudget, Math.floor((budget - 2 - markerBudget) / 2));
	entries[0] = renderEntry(value.entries[0], edgeBudget);
	entries[entries.length - 1] = renderEntry(value.entries[entries.length - 1], edgeBudget);
	let head = 1;
	let tail = 1;
	let result = selectedEntries(value, entries, head, tail);
	if (Array.from(result).length > budget) {
		throw new RangeError('Not enough space to retain both ends of JSON.');
	}
	while (head + tail < entries.length) {
		const sides = head <= tail ? ['head', 'tail'] as const : ['tail', 'head'] as const;
		let added = false;
		for (const side of sides) {
			const nextHead = head + (side === 'head' ? 1 : 0);
			const nextTail = tail + (side === 'tail' ? 1 : 0);
			const candidate = selectedEntries(value, entries, nextHead, nextTail);
			if (Array.from(candidate).length <= budget) {
				head = nextHead;
				tail = nextTail;
				result = candidate;
				added = true;
				break;
			}
		}
		if (!added) {
			break;
		}
	}
	return result;
}

function renderEntry(entry: JsonEntry, budget: number): RenderedEntry {
	if (!entry.key) {
		return { text: renderJson(entry.value, budget) };
	}
	const key = renderText(entry.key, Math.min(MAX_KEY_CODE_POINTS, Math.floor(budget / 3)), true);
	return {
		key,
		text: `${key}: ${renderJson(entry.value, budget - Array.from(key).length - 2)}`,
	};
}

function omittedEntries(value: Extract<JsonPreview, { kind: 'array' | 'object' }>, start: number, end: number): RenderedEntry {
	const count = end - start;
	const points = value.entries.slice(start, end).reduce((sum, entry) => sum + entryWidth(entry), 0)
		+ Math.max(0, count - 1) * 2;
	const marker = JSON.stringify(`[... ${count} ${value.kind === 'array' ? 'entries' : 'fields'}; ${points} code points omitted ...]`);
	return value.kind === 'array' ? { text: marker } : { key: marker, text: `${marker}: null` };
}

function selectedEntries(
	value: Extract<JsonPreview, { kind: 'array' | 'object' }>,
	entries: readonly RenderedEntry[],
	head: number,
	tail: number,
): string {
	const middle = head + tail < entries.length
		? [omittedEntries(value, head, entries.length - tail)]
		: [];
	return joinEntries(value.kind, [...entries.slice(0, head), ...middle, ...entries.slice(entries.length - tail)]);
}

function joinEntries(kind: 'array' | 'object', entries: readonly RenderedEntry[]): string {
	const keys = new Set<string>();
	for (const entry of entries) {
		if (entry.key !== undefined) {
			if (keys.has(entry.key)) {
				throw new RangeError('JSON keys collide after display sanitization.');
			}
			keys.add(entry.key);
		}
	}
	const content = entries.map(entry => entry.text).join(', ');
	return kind === 'array' ? `[${content}]` : `{${content}}`;
}

function rawPreview(input: string, warning: string): string {
	const prefix = `{"[preview warning]": ${JSON.stringify(`${warning} Review full input before approval.`)}, "input": `;
	return prefix + renderText(previewText(input), MAX_PREVIEW_CODE_POINTS - prefix.length - 1, true) + '}';
}
