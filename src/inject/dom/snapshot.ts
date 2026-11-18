import { bindDescriptors } from '../snapshot';

export class DOMParser extends globalThis.DOMParser {}

Object.defineProperties(
	DOMParser.prototype,
	Object.getOwnPropertyDescriptors(globalThis.DOMParser),
);

/**
 * What the bundles read of `navigator` (this file's, which esbuild gives
 * every file of them that names the global): each member bound to the
 * browser's own, taken before any of the page's script. Only these: a frame
 * bound every member of Navigator.prototype, and made each one's getter or
 * method, which a native frame makes only when its page reads it, about 7 KB
 * a frame (frame-cost). The lint names a member read of it that is not here
 * (eslint.config.mjs). (`Object` here: a bundle's `Reflect.<method>` is a
 * name src/inject/snapshot.ts gives the other files, build.js
 * REFLECT_METHODS, and not this one.)
 */
const NAVIGATOR_MEMBERS = ['userAgent', 'sendBeacon'];

const navigatorMembers = {};
for (const key of NAVIGATOR_MEMBERS)
	Object.defineProperty(
		navigatorMembers,
		key,
		Object.getOwnPropertyDescriptor(Navigator.prototype, key)!,
	);
export const navigator: Navigator = bindDescriptors(
	{},
	globalThis.navigator,
	navigatorMembers,
);

export const postMessage = globalThis.postMessage;
