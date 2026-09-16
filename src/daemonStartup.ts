export type DaemonStartupMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'busy' }
	| { readonly type: 'error'; readonly message: string };

export function parseDaemonStartupMessage(value: unknown): DaemonStartupMessage {
	if (typeof value === 'object' && value !== null && 'type' in value) {
		if (value.type === 'ready' || value.type === 'busy') {
			return { type: value.type };
		}
		if (value.type === 'error' && 'message' in value && typeof value.message === 'string') {
			return { type: 'error', message: value.message };
		}
	}
	throw new Error('Invalid daemon startup message');
}
