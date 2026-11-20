// The service worker's calls to a rewrite worker (src/rewriteWorker.ts,
// src/server/rewritePool.ts). Apart from transport/messages.ts, which the
// controller and its declarations import, because this names the rewriter.
import type { EngineList } from './blocker/build';
import type { Config } from './config';
import type { RewrittenBy, ScriptSource, ScriptType } from './rewriteJS';

/** rpc id on a rewrite worker's port */
export const REWRITE_RPC = 'stomp-rewrite';
/**
 * What a rewrite worker posts on a port once it serves it. A Worker whose
 * script failed to load closes nothing the service worker would see, so a
 * port is only used once its worker said this
 */
export const REWRITE_READY = '$stomp$rewriteReady';

/** a script to rewrite as the service worker would (modifyJS), with what its output depends on */
export interface RewriteRequest {
	script: string;
	/** the script's real URL */
	url: string;
	/** the controller's address (StompURL.directory) */
	directory: string;
	codecKey: string;
	config: Config;
	type: ScriptType;
	/** the service worker's route scopes (routeURL), origin included */
	scopes: string[];
	/** the cache mark of the document the script is for (src/memoryMark.ts), when the worker names one */
	mark?: string;
	/** where its functions' text is kept (a javascript: URL) */
	source?: ScriptSource;
	/** code to run first, after the directive prologue (an inline script's currentScript restore) */
	preamble?: string;
	/**
	 * a document's inline script, for the table that goes with its markup
	 * (src/prewrite.ts): the worker writes a classic one's preamble itself
	 * and answers with the rewrite packed (packRewrite) for this access
	 * helper, so the service worker holds no copy of the script's text in
	 * the rewrite
	 */
	pack?: string;
}

/** a script's output with the backend that made it (always the wasm module); the output alone when nothing rewrote it */
export interface RewriteAnswer extends Required<Pick<RewrittenBy, 'by'>> {
	output: string;
	/** the map of an output asked for apart (src/wasm/rewriter.ts takeApart) */
	map?: string;
	/** asked for packed (RewriteRequest.pack): `output` is the PackedRewrite's rest, and this its other two */
	packed?: [at: number, holder: 0 | string];
}

/** a script that came as UTF-8: its bytes, handed over, in place of its text (src/wasm/rewriteBytes.ts) */
export interface RewriteBytesRequest extends Omit<
	RewriteRequest,
	'script' | 'source'
> {
	bytes: ArrayBuffer;
}

/** a content blocker engine to compile (src/blocker/build.ts): the blocker module's bytes and the lists */
export interface EngineBuild {
	module: ArrayBuffer;
	lists: EngineList[];
}

/** implemented by a rewrite worker (src/rewriteWorker.ts), called by the service worker */
export type RewriteBound = {
	rewrite: [RewriteRequest, string | RewriteAnswer];
	/** a Blob of the output's UTF-8 bytes, or its text where it was made of the text the bytes decode to */
	rewriteBytes: [RewriteBytesRequest, Blob | string];
	/** the serialized engine, null when the module refused the lists */
	buildEngine: [EngineBuild, ArrayBuffer | null];
};
