import * as Omnibox from './index';

Reflect.defineProperty(globalThis, 'Omnibox', {
	value: { ...Omnibox },
	configurable: true,
	writable: true,
});
