// What the service worker's build takes for tldts's public suffix trie
// (tldts/dist/es6/src/data/trie.js, build.js swTldts): the same exports,
// made from the part `tldts-trie` (src/server/swParts.ts), the module's
// values as JSON. Its array literals were a quarter of the worker's script.
// Evaluated when tldts is, at the first question the worker asks it
// (src/server/tldtsPart.ts).
import { swPart } from './swParts';

interface Trie {
	nodeFlags: number[];
	edgeStart: number[];
	edgeLength: number[];
	edgeChild: number[];
	labelText: string;
	rulesRoot: number;
	exceptionsRoot: number;
}

const trie = JSON.parse(swPart('tldts-trie')) as Trie;

export const nodeFlags = new Uint8Array(trie.nodeFlags);
export const edgeStart = new Uint16Array(trie.edgeStart);
export const edgeLength = new Uint8Array(trie.edgeLength);
export const edgeChild = new Uint16Array(trie.edgeChild);
export const labelText = trie.labelText;
export const rulesRoot = trie.rulesRoot;
export const exceptionsRoot = trie.exceptionsRoot;
