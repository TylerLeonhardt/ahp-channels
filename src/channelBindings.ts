import { isDeepStrictEqual } from 'node:util';
import {
	FileChannelHandoffStore,
	failedHandoff,
	type ChannelHandoffRecord,
} from './channelHandoff.js';
import {
	ConfigStore,
	isValidChannelInstanceName,
	rebindChannelInstance,
	type AppConfig,
	type ChannelInstanceConfig,
} from './config.js';
import { withFileLock } from './lockedFile.js';
import type { ChannelBindingTarget } from './sessionCatalog.js';

export interface RecoveredChannelBinding {
	readonly definition: ChannelInstanceConfig;
	readonly handoff?: ChannelHandoffRecord;
}

export class ChannelBindingError extends Error {
	constructor(
		readonly code: 'INVALID_CHANNEL' | 'NOT_FOUND' | 'STALE_BINDING' | 'HANDOFF_PENDING',
		message: string,
	) {
		super(message);
	}
}

export class ChannelBindingService {
	constructor(
		private readonly configStore: ConfigStore,
		private readonly handoffStore: FileChannelHandoffStore,
	) { }

	async recover(name: string): Promise<RecoveredChannelBinding> {
		return withFileLock(this.configStore.configPath, async () => {
			const config = await this.configStore.read();
			const definition = requireDefinition(config, name);
			const handoff = await this.handoffStore.read(name);
			if (!handoff || (handoff.state !== 'pending' && handoff.recovery !== 'source')) {
				return { definition, ...(handoff ? { handoff } : {}) };
			}
			const ownsBinding = sameBinding(definition, handoff.source)
				|| sameBinding(definition, handoff.target);
			const restored = ownsBinding
				? rebindChannelInstance(definition, {
					host: handoff.source.host ?? null,
					session: handoff.source.session,
					...(handoff.source.chat ? { chat: handoff.source.chat } : {}),
				})
				: definition;
			const failed = failedHandoff(handoff, ownsBinding
				? handoff.state === 'pending'
					? 'Daemon restarted before the handoff was applied; the committed source binding was restored'
					: handoff.error ?? 'Handoff rollback restored the committed source binding'
				: 'A later binding superseded this interrupted handoff; the later binding was preserved');
			if (!isDeepStrictEqual(restored, definition)) {
				await this.configStore.write(withBinding(config, name, restored));
			}
			await this.handoffStore.write(name, failed);
			return { definition: restored, handoff: failed };
		});
	}

	async replace(
		name: string,
		previous: ChannelInstanceConfig,
		next: ChannelInstanceConfig,
		handoffId?: string,
	): Promise<void> {
		await withFileLock(this.configStore.configPath, async () => {
			const config = await this.configStore.read();
			if (!isDeepStrictEqual(requireDefinition(config, name), previous)) {
				throw new ChannelBindingError('STALE_BINDING', `Channel '${name}' changed while the binding operation was in progress`);
			}
			const record = await this.handoffStore.read(name);
			if (handoffId && (record?.requestId !== handoffId || record.state === 'cancelled')) {
				throw new ChannelBindingError('STALE_BINDING', `Handoff '${handoffId}' no longer owns channel '${name}'`);
			}
			if (!handoffId && (record?.state === 'pending' || record?.recovery === 'source')) {
				throw new ChannelBindingError('HANDOFF_PENDING', `Recover or cancel handoff '${record.requestId}' before replacing channel '${name}'`);
			}
			await this.configStore.write(withBinding(config, name, next));
		});
	}
}

function requireDefinition(config: AppConfig, name: string): ChannelInstanceConfig {
	if (!isValidChannelInstanceName(name)) {
		throw new ChannelBindingError('INVALID_CHANNEL', `Invalid channel name '${name}'`);
	}
	const definition = config.channels[name];
	if (!definition) {
		throw new ChannelBindingError('NOT_FOUND', `Channel '${name}' does not exist`);
	}
	return definition;
}

function sameBinding(definition: ChannelBindingTarget, target: ChannelBindingTarget): boolean {
	return definition.host === target.host
		&& definition.session === target.session
		&& definition.chat === target.chat;
}

function withBinding(config: AppConfig, name: string, definition: ChannelInstanceConfig): AppConfig {
	return { ...config, channels: { ...config.channels, [name]: definition } };
}
