import type { Config } from './config';
import type { ScriptSource } from './rewriteJS';
import type { ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';

/**
 * The rewriters the light modules reach when they route a URL that itself
 * holds something to rewrite (a data: script or stylesheet, a javascript:
 * URL). rewriteJS.ts and rewriteCSS.ts provide the wasm-backed ones when they
 * load; the inject bundles provide the same through the light library
 * (src/rewriterLight.ts).
 */
export interface Rewriters {
	modifyJS: (
		script: string,
		url: StompURL,
		config: Config,
		type?: ScriptType,
		preamble?: string,
		source?: ScriptSource,
	) => string;
	modifyCSS: (script: string, url: StompURL, context?: string) => string;
	/** whether `code` parses as a script of one expression statement */
	singleExpression: (code: string) => boolean;
}

const provided: Partial<Rewriters> = {};

export function provideRewriters(rewriters: Partial<Rewriters>) {
	Object.assign(provided, rewriters);
}

export function rewriter<K extends keyof Rewriters>(name: K): Rewriters[K] {
	const found = provided[name];
	if (!found) throw new Error(`Stomp: this bundle has no ${name}`);
	return found;
}
