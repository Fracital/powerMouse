// Where the document bundle has what reads a window as an array method or
// a list of arguments does (./windowArrays.ts): a deferred part
// (./dom/deferred.ts), evaluated with a document's first such call, set in
// dom/document.ts. A worker's scope has no windows, so its bundle sets
// none (modules/Reflection.ts applyWindowChildren returns there first).
import type { windowArrays } from './windowArrays';

export const windowArrayParts: {
	make?: () => typeof windowArrays;
} = {};
