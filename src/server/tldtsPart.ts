// What the service worker's build takes for tldts where src/suffix.ts
// imports it (build.js swTldts): the same two functions, which evaluate
// tldts the first time they are called. A require is what esbuild makes a
// module of the bundle that runs only when first asked for: tldts's code
// stays in the script, its trie (src/server/tldtsTrie.ts) is parsed then,
// and a worker whose suffix module answers never builds either.
import type {
	getDomain as Domain,
	getPublicSuffix as PublicSuffix,
} from 'tldts';

declare function require(name: 'tldts'): {
	getDomain: typeof Domain;
	getPublicSuffix: typeof PublicSuffix;
};

let tldts: ReturnType<typeof require> | undefined;
const loaded = () => (tldts ??= require('tldts'));

export const getDomain: typeof Domain = (url, options) =>
	loaded().getDomain(url, options);

export const getPublicSuffix: typeof PublicSuffix = (url, options) =>
	loaded().getPublicSuffix(url, options);
