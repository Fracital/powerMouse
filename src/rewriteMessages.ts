// The service worker's calls to a rewrite worker (src/rewriteWorker.ts,
// src/server/rewritePool.ts). Apart from transport/messages.ts, which the
// controller and its declarations import, because this names the rewriter.
import type { Config } from './config';
import type { ScriptSource, ScriptType } from './rewriteJS';
import type { SplitPlan } from './splitRewrite';

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
	/** printed compact whatever it looks like: a part of a split script (splitRewrite) */
	compact?: boolean;
	/** where its functions' text is kept: a part of a split script */
	source?: ScriptSource;
	/** code to run first, after the directive prologue (an inline script's currentScript restore) */
	preamble?: string;
}

/** a large script to plan a split of (splitRewrite) */
export interface PlanRequest {
	script: string;
	/** how many groups */
	parts: number;
}

/** implemented by a rewrite worker (src/rewriteWorker.ts), called by the service worker */
export type RewriteBound = {
	rewrite: [RewriteRequest, string];
	plan: [PlanRequest, SplitPlan | null];
};
