import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatPermissionInput, sanitizePermissionText } from '../src/permissionPreview.js';

const githubToken = `ghp_${'a'.repeat(36)}`;
const providerKey = `sk-proj-${'b'.repeat(60)}`;

function points(text: string): number {
	return Array.from(text).length;
}

function assertTextElision(source: string, preview: string): void {
	const match = /\[\.\.\. (\d+) code points omitted \.\.\.\]/.exec(preview);
	assert.ok(match, 'must visibly indicate truncation');
	const head = preview.slice(0, match.index);
	const tail = preview.slice(match.index + match[0].length);
	assert.ok(head.length > 0 && tail.length > 0, 'must retain both ends');
	assert.ok(source.startsWith(head));
	assert.ok(source.endsWith(tail));
	assert.equal(Number(match[1]), points(source) - points(head) - points(tail));
	assert.doesNotMatch(preview, /[\p{Cs}]/u, 'must not split surrogate pairs');
}

function parsePreview(input: string | undefined): unknown {
	const preview = formatPermissionInput(input);
	assert.ok(points(preview) <= 3500, 'total preview must respect the production limit');
	assert.doesNotMatch(preview, /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u);
	return JSON.parse(preview);
}

describe('sanitizePermissionText', () => {
	it('preserves shell operators, quoting, Windows/POSIX paths, and complete URLs', () => {
		const command = 'printf \'%s\\n\' "$HOME" | tee -- /var/log/out.txt && curl -fsS '
			+ '"https://example.test/a%2Fb?key=download&token=file-name#part" > "C:\\Users\\Me\\out.txt"; echo done';
		assert.equal(sanitizePermissionText(command), command);
	});

	it('folds visible whitespace runs without changing ordinary Unicode', () => {
		assert.equal(sanitizePermissionText('one  \u00A0 two\u2003\u2009three'), 'one two three');
		const text = 'echo café 雪 😀 🚀 C:\\文件\\😀.txt';
		assert.equal(sanitizePermissionText(text), text);
	});

	it('visibly neutralizes controls, bidi, invisible characters, and lone surrogates', () => {
		const characters = [
			'\u0000', '\u0008', '\t', '\n', '\r', '\u001B', '\u007F', '\u0085',
			'\u2028', '\u2029', '\u202E', '\u202C', '\u2066', '\u2069', '\u200B',
			'\uFEFF', '\u2060', '\u00AD', '\u034F', '\uFE0F', '\u{E0001}', '\u{E0100}',
			'\u2800', '\u3164', '\uD800', '\uDFFF', '\uFFFE', '\u{10FFFF}',
		];
		for (const character of characters) {
			const marker = `[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;
			assert.equal(sanitizePermissionText(`before${character}after`), `before${marker}after`);
		}
		assert.equal(sanitizePermissionText('echo safe\nrm -- /target'), 'echo safe[U+000A]rm -- /target');
	});

	it('annotates quotation/angle confusables rather than turning them into shell syntax', () => {
		for (const character of '‘’‚‛“”„‟‹›«»＂＇＜＞｀′″‵❛❜❝❞〈〉《》「」『』〈〉﹤﹥´ʹ΄՚՝׳״ߴߵᐳᐸ᾽᾿`´῾≺≻Ꞌꞌ') {
			assert.equal(
				sanitizePermissionText(character),
				`[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`,
			);
		}
		assert.equal(sanitizePermissionText('\'"<>`|&;$()'), '\'"<>`|&;$()');
	});

	it('uses the real 3500-code-point threshold, not UTF-16 string length', () => {
		const exactly = '😀'.repeat(3500);
		assert.equal(sanitizePermissionText(exactly), exactly);
		const over = `HEAD|${'😀'.repeat(3491)}|TAIL`;
		assert.equal(points(over), 3501);
		const preview = sanitizePermissionText(over);
		assert.ok(points(preview) <= 3500);
		assert.ok(preview.startsWith('HEAD|') && preview.endsWith('|TAIL'));
		assertTextElision(over, preview);
	});

	it('counts omitted supplementary characters correctly for enormous text', () => {
		const source = `BEGIN ${'🚀'.repeat(200_000)} && echo END`;
		const preview = sanitizePermissionText(source);
		assert.ok(points(preview) <= 3500);
		assertTextElision(source, preview);
		assert.ok(preview.endsWith('&& echo END'));
	});

	it('bounds expansion of malicious controls and counts the sanitized display', () => {
		const source = `start${'\u0000'.repeat(20_000)}end`;
		const preview = sanitizePermissionText(source);
		assert.ok(points(preview) <= 3500);
		assertTextElision(`start${'[U+0000]'.repeat(20_000)}end`, preview);
		assert.doesNotMatch(preview, /\u0000/);
	});

	it('redacts recognizable provider, GitHub, Slack, and JWT credentials', () => {
		const credentials = [
			githubToken, providerKey, `github_pat_${'c'.repeat(82)}`,
			`sk-${'d'.repeat(48)}`, `sk-ant-api03-${'e'.repeat(93)}`,
			`sk-svcacct-${'f'.repeat(60)}`, `AIza${'g'.repeat(35)}`,
			`xoxb-${'1'.repeat(24)}`, `eyJ${'a'.repeat(12)}.${'b'.repeat(20)}.${'c'.repeat(20)}`,
		];
		for (const credential of credentials) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const command = `curl -H "Authorization: Bearer ${credential}" https://example.test/a > /work/result && echo done`;
				assert.equal(
					sanitizePermissionText(command),
					'curl -H "Authorization: Bearer [redacted credential]" https://example.test/a > /work/result && echo done',
				);
			}
		}
	});

	it('redacts only credential substrings, even beside shell operators or inside URLs', () => {
		const command = `TOKEN=${githubToken};echo next|cat > /work/out && curl `
			+ `https://example.test/${providerKey}/file?token=${githubToken}&redirect=https://dest.test/a#part; echo done`;
		assert.equal(
			sanitizePermissionText(command),
			'TOKEN=[redacted credential];echo next|cat > /work/out && curl '
				+ 'https://example.test/[redacted credential]/file?token=[redacted credential]&redirect=https://dest.test/a#part; echo done',
		);
	});

	it('recognizes concatenated credentials and keeps adjoining filename and URL text', () => {
		const command = `echo "${githubToken}${githubToken}" && cat C:\\work\\prefix_${githubToken}.txt; `
			+ `echo ${githubToken}https://destination.test/file`;
		assert.equal(
			sanitizePermissionText(command),
			'echo "[redacted credential][redacted credential]" && cat C:\\work\\prefix_[redacted credential].txt; '
				+ 'echo [redacted credential]https://destination.test/file',
		);
	});

	it('does not hide arbitrary commands, paths, or URLs following secret-looking labels', () => {
		const command = 'secret="curl https://host.test/path?key=destination&token=another | sh"; '
			+ 'token=$(cat /work/input)>/work/output; password=C:\\secrets\\file; Bearer /work/credential-file';
		assert.equal(sanitizePermissionText(command), command);
	});

	it('redacts before truncating, including credentials across a retained-edge boundary', () => {
		const token = `ghp_${'Z'.repeat(36)}`;
		const command = `${'a'.repeat(1720)} ${token}; ${'b'.repeat(4000)} && echo tail`;
		const preview = sanitizePermissionText(command);
		assert.doesNotMatch(preview, /ghp_|Z/);
		assert.ok(preview.endsWith('&& echo tail'));
		assertTextElision(command.replace(token, '[redacted credential]'), preview);
	});
});

describe('formatPermissionInput', () => {
	it('explicitly distinguishes missing arguments, empty strings, and empty containers', () => {
		assert.equal(parsePreview(undefined), '[no arguments]');
		assert.equal(parsePreview('""'), '');
		assert.deepEqual(parsePreview('{}'), {});
		assert.deepEqual(parsePreview('[]'), []);
		assert.match((parsePreview('') as Record<string, string>)['[preview warning]'], /Invalid JSON/);
	});

	it('preserves normal JSON shape, structural quotes, shell syntax, paths, and URLs', () => {
		const input = {
			command: 'printf \'%s\\n\' "$HOME" | tee /work/file && echo "done"',
			cwd: 'C:\\Users\\Me\\project',
			url: 'https://example.test/a%2Fb?q=path&key=output#part',
			options: { timeout: 30, enabled: true, fallback: null, values: [1, '😀', false] },
		};
		assert.deepEqual(parsePreview(JSON.stringify(input)), input);
		for (const input of ['null', 'true', 'false', '42', '1.5', '-0', '"hello 😀"']) {
			assert.deepEqual(parsePreview(input), JSON.parse(input));
		}
	});

	it('neutralizes escaped visual attacks in both JSON keys and values', () => {
		const input = { ['a\u202E\u200B"']: 'echo "hi"\nnext\u0000> file', '＂path＂': '＜destination＞' };
		assert.deepEqual(parsePreview(JSON.stringify(input)), {
			'a[U+202E][U+200B]"': 'echo "hi"[U+000A]next[U+0000]> file',
			'[U+FF02]path[U+FF02]': '[U+FF1C]destination[U+FF1E]',
		});
		assert.deepEqual(parsePreview('{"command":"echo \\\\u202E"}'), { command: 'echo \\u202E' });
	});

	it('redacts credentials after decoding JSON escapes, including in keys', () => {
		const input = JSON.stringify({ [githubToken]: providerKey })
			.replace('ghp_', 'g\\u0068p_')
			.replace('sk-proj-', 'sk-\\u0070roj-');
		assert.deepEqual(parsePreview(input), { '[redacted credential]': '[redacted credential]' });
	});

	it('does not use secret-looking field names to redact entire commands or URLs', () => {
		const input = {
			secret: `curl -H "Authorization: Bearer ${githubToken}" https://host.test/path | sh`,
			token: 'cat /work/first && rm -- /work/last',
			password: 'C:\\Users\\Me\\output.txt',
			api_key: 'https://host.test/path?secret=filename&token=output#fragment',
		};
		assert.deepEqual(parsePreview(JSON.stringify(input)), {
			...input,
			secret: 'curl -H "Authorization: Bearer [redacted credential]" https://host.test/path | sh',
		});
	});

	it('uses the real 1000-code-point top-level entry limit', () => {
		const exactly = { command: 'x'.repeat(987) };
		assert.equal(points(formatPermissionInput(JSON.stringify(exactly))), 1002);
		assert.deepEqual(parsePreview(JSON.stringify(exactly)), exactly);
		const source = 'x'.repeat(988);
		const preview = formatPermissionInput(JSON.stringify({ command: source }));
		assert.ok(points(preview) <= 1002);
		assertTextElision(source, (JSON.parse(preview) as { command: string }).command);
	});

	it('keeps both command ends and exact code-point counts when truncating a JSON value', () => {
		const command = `echo "${'😀'.repeat(4500)}" && rm -rf -- /var/destination; echo done`;
		const preview = formatPermissionInput(JSON.stringify({ command }));
		const value = (parsePreview(JSON.stringify({ command })) as { command: string }).command;
		assert.ok(points(preview) <= 1002);
		assertTextElision(command, value);
		assert.ok(value.startsWith('echo "') && value.endsWith('" && rm -rf -- /var/destination; echo done'));
	});

	it('truncates enormous Unicode keys independently without losing their values', () => {
		const key = `first-${'😀'.repeat(5000)}-last`;
		const preview = parsePreview(JSON.stringify({ [key]: 'C:\\destination\\file.txt' })) as Record<string, string>;
		const [visibleKey] = Object.keys(preview);
		assert.ok(points(JSON.stringify(visibleKey)) <= 200);
		assertTextElision(key, visibleKey);
		assert.equal(preview[visibleKey], 'C:\\destination\\file.txt');
	});

	it('never splits JSON escaping or surrogate pairs when shortening quoted strings', () => {
		const command = `start ${'\\😀"'.repeat(2000)} && echo end`;
		const preview = parsePreview(JSON.stringify({ command })) as { command: string };
		assertTextElision(command, preview.command);
		assert.ok(preview.command.endsWith('&& echo end'));
	});

	it('includes structural quotes in the real 3500-code-point root string limit', () => {
		const exactly = '😀'.repeat(3498);
		assert.equal(points(formatPermissionInput(JSON.stringify(exactly))), 3500);
		assert.equal(parsePreview(JSON.stringify(exactly)), exactly);
		const over = `${exactly}😀`;
		assertTextElision(over, parsePreview(JSON.stringify(over)) as string);
	});

	it('bounds wide arrays while retaining first/last entries and counting structural omissions', () => {
		const input = Array.from({ length: 1200 }, (_, index) => `item ${index} 😀`);
		const preview = parsePreview(JSON.stringify(input)) as string[];
		assert.equal(preview[0], input[0]);
		assert.equal(preview.at(-1), input.at(-1));
		const markerIndex = preview.findIndex(value => value.startsWith('[... '));
		assert.ok(markerIndex > 0);
		const match = /^\[\.\.\. (\d+) entries; (\d+) code points omitted \.\.\.\]$/.exec(preview[markerIndex]);
		assert.ok(match);
		const tailCount = preview.length - markerIndex - 1;
		const omitted = input.slice(markerIndex, input.length - tailCount);
		assert.equal(Number(match[1]), omitted.length);
		assert.equal(Number(match[2]), points(omitted.map(value => JSON.stringify(value)).join(', ')));
	});

	it('bounds wide objects and explicitly counts omitted fields', () => {
		const entries = Array.from({ length: 400 }, (_, index) => [`field${index}`, `echo ${index} && next`] as const);
		const preview = parsePreview(JSON.stringify(Object.fromEntries(entries))) as Record<string, unknown>;
		assert.equal(preview.field0, entries[0][1]);
		assert.equal(preview.field399, entries[399][1]);
		const keys = Object.keys(preview);
		const markerIndex = keys.findIndex(key => key.startsWith('[... '));
		assert.ok(markerIndex > 0);
		const match = /^\[\.\.\. (\d+) fields; (\d+) code points omitted \.\.\.\]$/.exec(keys[markerIndex]);
		assert.ok(match);
		assert.equal(preview[keys[markerIndex]], null);
		const tailCount = keys.length - markerIndex - 1;
		const omitted = entries.slice(markerIndex, entries.length - tailCount);
		assert.equal(Number(match[1]), omitted.length);
		assert.equal(Number(match[2]), points(omitted.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')));
	});

	it('retains nested array/object shape and the final nested command', () => {
		const steps = Array.from({ length: 100 }, (_, index) => ({
			command: `echo step${index} && next`,
			path: `/work/${index}.txt`,
		}));
		const preview = parsePreview(JSON.stringify({ steps, cwd: '/work', last: 'echo final' })) as {
			steps: unknown[]; cwd: string; last: string;
		};
		assert.deepEqual(preview.steps[0], steps[0]);
		assert.deepEqual(preview.steps.at(-1), steps.at(-1));
		assert.ok(preview.steps.some(value => typeof value === 'string' && value.includes('entries;')));
		assert.equal(preview.cwd, '/work');
		assert.equal(preview.last, 'echo final');
	});

	it('visibly falls back for malformed input while preserving commands and masking credentials', () => {
		const input = `curl -H "Authorization: Bearer ${githubToken}" https://host.test/path\nnext > C:\\work\\out; echo done`;
		const preview = parsePreview(input) as Record<string, string>;
		assert.match(preview['[preview warning]'], /Invalid JSON.*Review full input before approval/);
		assert.equal(
			preview.input,
			'curl -H "Authorization: Bearer [redacted credential]" https://host.test/path[U+000A]next > C:\\work\\out; echo done',
		);
	});

	it('uses the real parsing-size limit and bounds huge valid and malformed inputs', () => {
		assert.deepEqual(parsePreview(`${' '.repeat(65_534)}{}`), {});
		const over = parsePreview(`${' '.repeat(65_535)}{}`) as Record<string, string>;
		assert.match(over['[preview warning]'], /65536.*structure not inspected/);
		const valid = JSON.stringify({ command: `echo ${'😀'.repeat(40_000)} && echo final > /work/destination` });
		const malformed = `{"command":"${'x'.repeat(80_000)} && echo final > /work/destination`;
		for (const input of [valid, malformed]) {
			const preview = parsePreview(input) as Record<string, string>;
			assert.match(preview['[preview warning]'], /65536/);
			assertTextElision(input, preview.input);
			assert.ok(preview.input.includes('&& echo final > /work/destination'));
		}
	});

	it('enforces production depth and node limits without overflowing the call stack', () => {
		const atDepthLimit = `${'['.repeat(32)}"echo final"${']'.repeat(32)}`;
		assert.deepEqual(parsePreview(atDepthLimit), JSON.parse(atDepthLimit));
		const deep = `${'['.repeat(10_000)}"echo final"${']'.repeat(10_000)}`;
		const wide = JSON.stringify(Array(4096).fill('echo next'));
		const object = JSON.stringify(Object.fromEntries(Array.from({ length: 4500 }, (_, index) => [`k${index}`, 0])));
		for (const input of [deep, wide, object]) {
			const preview = parsePreview(input) as Record<string, string>;
			assert.match(preview['[preview warning]'], /complexity limits/);
			assertTextElision(input, preview.input);
		}
		const allowed = parsePreview(JSON.stringify(Array(4095).fill(0)));
		assert.ok(Array.isArray(allowed), '4095 children and the root fit the 4096-node limit');
	});

	it('does not silently discard duplicate keys or keys that become indistinguishable', () => {
		const sources = [
			'{"command":"echo first","command":"echo last"}',
			'{"a":"echo first","\\u0061":"echo last"}',
			'{"a  b":"echo first","a b":"echo last"}',
			JSON.stringify({ [githubToken]: 'echo first', [`ghp_${'c'.repeat(36)}`]: 'echo last' }),
		];
		for (const input of sources) {
			const preview = parsePreview(input) as Record<string, string>;
			assert.match(preview['[preview warning]'], /Duplicate JSON keys|ambiguous display keys/);
			assert.ok(preview.input.includes('echo first') && preview.input.includes('echo last'));
			assert.ok(!preview.input.includes(githubToken));
		}
	});

	it('shows raw numbers instead of silently rounding them, dropping notation, or displaying null', () => {
		for (const number of ['9007199254740993', '1e400', '1.0000000000000001', '1e3']) {
			const input = `{"amount":${number},"command":"echo final"}`;
			const preview = parsePreview(input) as Record<string, string>;
			assert.match(preview['[preview warning]'], /numbers cannot be displayed losslessly/);
			assert.equal(preview.input, input);
		}
	});

	it('preserves prototype-named own properties without mutating any prototype', () => {
		const input = '{"__proto__":{"polluted":true},"constructor":"echo last","toString":"file"}';
		const preview = parsePreview(input) as Record<string, unknown>;
		assert.deepEqual(preview, JSON.parse(input));
		assert.ok(Object.hasOwn(preview, '__proto__'));
		assert.equal(Object.getPrototypeOf(preview), Object.prototype);
		assert.ok(!Object.hasOwn(Object.prototype, 'polluted'));
	});

	it('keeps adversarial combinations bounded, visually safe, and valid JSON', () => {
		const fragments = ['😀', '"', '\\', '\u202E', '\u0000', '‘', '＜', '  ', 'x', githubToken, '| next > /work/out'];
		let seed = 0xABCD;
		function next(): number {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed;
		}
		function value(depth: number): unknown {
			const kind = next() % 4;
			if (depth === 0 || kind === 0) {
				return fragments[next() % fragments.length].repeat(next() % 500);
			}
			if (kind === 1) {
				return next();
			}
			const children = Array.from({ length: next() % 8 }, () => value(depth - 1));
			return kind === 2
				? children
				: Object.fromEntries(children.map((child, index) => [
					`${index}-${fragments[next() % fragments.length].repeat(next() % 150)}`,
					child,
				]));
		}
		for (let index = 0; index < 100; index++) {
			const input = JSON.stringify(value(4));
			assert.doesNotThrow(() => parsePreview(input), `case ${index}`);
			assert.ok(!formatPermissionInput(input).includes(githubToken), `credential in case ${index}`);
		}
	});
});
