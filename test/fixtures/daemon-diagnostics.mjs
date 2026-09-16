process.on('message', message => {
	switch (message) {
		case 'warnings':
			for (let index = 0; index < 50; index++) {
				process.emitWarning(`${'w'.repeat(100 * 1024)} warning-${index}`);
			}
			process.nextTick(() => process.send?.({ type: 'fixture-warnings-done' }));
			break;
		case 'uncaughtException':
			setImmediate(() => {
				throw new Error('fixture uncaught exception');
			});
			break;
		case 'unhandledRejection':
			void Promise.reject(new Error('fixture unhandled rejection'));
			break;
	}
});
