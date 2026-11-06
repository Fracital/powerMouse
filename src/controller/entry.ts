import { RemoteController, StompController } from './index';

Reflect.defineProperty(globalThis, 'StompController', {
	value: StompController,
	configurable: true,
	writable: true,
});

Reflect.defineProperty(globalThis, 'StompRemoteController', {
	value: RemoteController,
	configurable: true,
	writable: true,
});
