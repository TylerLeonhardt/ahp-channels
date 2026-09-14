const META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChannelEvent {
	readonly content: string;
	readonly meta?: Readonly<Record<string, string>>;
}

export function formatChannelPrompt(source: string, event: ChannelEvent, instructions?: string): string {
	const attributes = [
		`source="${escapeAttribute(source)}"`,
		...Object.entries(event.meta ?? {})
			.filter(([key]) => META_KEY.test(key) && key !== 'source')
			.map(([key, value]) => `${key}="${escapeAttribute(value)}"`),
	].join(' ');
	const channel = `<channel ${attributes}>\n${escapeContent(event.content)}\n</channel>`;
	return instructions?.trim()
		? `<channel_instructions>\n${escapeContent(instructions.trim())}\n</channel_instructions>\n\n${channel}`
		: channel;
}

function escapeAttribute(value: string): string {
	return escapeContent(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function escapeContent(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}
