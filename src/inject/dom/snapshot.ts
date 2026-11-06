import { bindDescriptors } from '../snapshot';

export class DOMParser extends globalThis.DOMParser {}

Object.defineProperties(
	DOMParser.prototype,
	Object.getOwnPropertyDescriptors(globalThis.DOMParser),
);

export const navigator: Navigator = bindDescriptors(
	{},
	globalThis.navigator,
	Navigator.prototype,
);

export const postMessage = globalThis.postMessage;
