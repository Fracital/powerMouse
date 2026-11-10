// What build.js puts in place of `source-map` (escodegen) and css-tree's
// `source-map-js` generator: both are loaded only to print a source map,
// which the rewriters never ask for, and evaluating them cost every realm
// that loads the rewriter their code.
function unavailable(): never {
	throw new Error('Stomp: the rewriters print no source maps');
}

export class SourceNode {
	constructor() {
		unavailable();
	}
}

export class SourceMapGenerator {
	constructor() {
		unavailable();
	}
}
