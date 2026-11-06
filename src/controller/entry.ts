import { StompController } from './index';

Reflect.defineProperty(globalThis, 'StompController', {
	value: StompController,
	configurable: true,
	writable: true,
});
