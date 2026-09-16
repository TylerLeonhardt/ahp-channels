import { register } from 'node:module';

register(new URL('./daemon-import-failure-hook.mjs', import.meta.url));
