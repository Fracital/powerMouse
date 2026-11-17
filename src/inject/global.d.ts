/* eslint-disable no-var */
declare var $P$s: import('./Client').default | undefined;
declare var $s$j: object | undefined;
declare var createClient:
	((config: import('../config').Config, codecKey: string) => void) | undefined;
// what the inject's syntax iterates (src/ownIterable.ts): build.js gives the
// bundles these names with their snapshot, and its own plugin writes the calls
declare var ownIterable: typeof import('../ownIterable').ownIterable;
declare var ownItems: typeof import('../ownIterable').ownItems;
declare var isArray: typeof import('../ownIterable').isArray;
