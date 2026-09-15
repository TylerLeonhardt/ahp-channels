export async function readSecret(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
	if (!input.isTTY || typeof input.setRawMode !== 'function') {
		const chunks: Buffer[] = [];
		for await (const chunk of input) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const value = Buffer.concat(chunks).toString('utf8').trim();
		if (!value) {
			throw new Error('No secret was provided on stdin');
		}
		return value;
	}

	output.write(prompt);
	input.setEncoding('utf8');
	input.setRawMode(true);
	input.resume();
	return new Promise((resolve, reject) => {
		const decoder = new SecretInputDecoder();
		const finish = (error?: Error) => {
			input.off('data', onData);
			input.setRawMode(false);
			input.pause();
			output.write('\n');
			if (error) {
				reject(error);
			} else if (!decoder.value) {
				reject(new Error('Secret value must not be empty'));
			} else {
				resolve(decoder.value);
			}
		};
		const onData = (chunk: string | Buffer) => {
			const result = decoder.feed(String(chunk));
			if (result === 'cancel') {
				finish(new Error('Secret input cancelled'));
			} else if (result === 'submit') {
				finish();
			}
		};
		input.on('data', onData);
	});
}

type SecretInputResult = 'continue' | 'submit' | 'cancel';
type EscapeState = 'none' | 'escape' | 'csi' | 'ss3' | 'osc' | 'oscEscape';

export class SecretInputDecoder {
	private escapeState: EscapeState = 'none';
	private text = '';

	get value(): string {
		return this.text;
	}

	feed(chunk: string): SecretInputResult {
		for (const character of chunk) {
			if (this.consumeEscape(character)) {
				continue;
			}
			if (character === '\u001b') {
				this.escapeState = 'escape';
				continue;
			}
			if (character === '\u0003') {
				return 'cancel';
			}
			if (character === '\r' || character === '\n') {
				return 'submit';
			}
			if (character === '\b' || character === '\u007f') {
				this.text = this.text.slice(0, -1);
				continue;
			}
			if (character >= ' ') {
				this.text += character;
			}
		}
		return 'continue';
	}

	private consumeEscape(character: string): boolean {
		switch (this.escapeState) {
			case 'none':
				return false;
			case 'escape':
				if (character === '[') {
					this.escapeState = 'csi';
				} else if (character === 'O') {
					this.escapeState = 'ss3';
				} else if (character === ']') {
					this.escapeState = 'osc';
				} else {
					this.escapeState = 'none';
				}
				return true;
			case 'csi': {
				const code = character.charCodeAt(0);
				if (code >= 0x40 && code <= 0x7e) {
					this.escapeState = 'none';
				}
				return true;
			}
			case 'ss3':
				this.escapeState = 'none';
				return true;
			case 'osc':
				if (character === '\u0007') {
					this.escapeState = 'none';
				} else if (character === '\u001b') {
					this.escapeState = 'oscEscape';
				}
				return true;
			case 'oscEscape':
				this.escapeState = character === '\\' ? 'none' : 'osc';
				return true;
		}
	}
}
