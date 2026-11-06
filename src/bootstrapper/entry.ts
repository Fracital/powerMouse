import SearchBuilder from './SearchBuilder';

Reflect.defineProperty(globalThis, 'SearchBuilder', {
	value: SearchBuilder,
	configurable: true,
	writable: true,
});
