// The isolated world's bundle (build.js `extensionsWorld`): the page's
// runtime evaluates its text in a world's realm, where it leaves its
// factory under WORLD_FACTORY for the runtime to take (and delete) at once.
import { WORLD_FACTORY } from '../../types';
import { makeWorld } from './index';

Reflect.defineProperty(globalThis, WORLD_FACTORY, {
	value: makeWorld,
	configurable: true,
	writable: true,
});
