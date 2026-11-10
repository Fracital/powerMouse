import type { Config } from './config';
import type { ScriptSource } from './rewriteJS';
import type { ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';

/**
 * The rewriters that need a parser (meriyah and escodegen for scripts,
 * css-tree for stylesheets), for the light modules that route URLs and only
 * sometimes rewrite what they route: a data: script or stylesheet, a
 * javascript: URL. Every bundle that holds the rewriters themselves gets
 * them by importing them (rewriteJS.ts and rewriteCSS.ts provide themselves
 * when they load); the inject bundles provide stand-ins that reach the
 * rewriter library, which a frame loads only when it rewrites something or
 * shares with its top (src/inject/rewriter.ts).
 */
export interface Rewriters {
	modifyJS: (
		script: string,
		url: StompURL,
		config: Config,
		type?: ScriptType,
		preamble?: string,
		compact?: boolean,
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
