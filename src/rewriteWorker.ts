// A rewrite worker (dist/rewriteWorker.js): a dedicated Worker the
// controller starts so that the service worker's script rewrites run on
// threads of their own. The service worker rewrites one script at a time on
// its single thread, so a page of large scripts waits for each in turn;
// with a pool, they are rewritten side by side. Each port the controller
// hands over is a channel to the service worker, which sends a script with
// everything its output depends on and gets back what modifyJS makes of it,
// the same as it would have made itself. It also compiles the content
// blocker's engine from its lists when the service worker asks.
import { buildEngine } from './blocker/build';
import { parseConfig } from './config';
import { modifyJS, type RewrittenBy } from './rewriteJS';
import {
	REWRITE_READY,
	REWRITE_RPC,
	RewriteAnswer,
	RewriteBound,
	RewriteBytesRequest,
	RewriteRequest,
} from './rewriteMessages';
import { addRouteScopes } from './routeURL';
import StompURL from './StompURL';
import { REWRITE_MODULES, REWRITE_PORT } from './transport/messages';
import { RpcHelper } from './transport/rpc';
import { rewriteBytesInWasm } from './wasm/rewriteBytes';
import {
	adoptModules,
	heldModules,
	SERVING_MEMORY_LIMIT,
	setMemoryLimit,
} from './wasm/thread';

declare const self: DedicatedWorkerGlobalScope;

/** the script's URL as the service worker's rewrite would have it */
function scriptURL(request: RewriteRequest | RewriteBytesRequest): StompURL {
	addRouteScopes(request.scopes);
	const { codec } = parseConfig(request.config, request.codecKey);
	const url = new StompURL(new URL(request.url), codec, request.directory);
	if (typeof request.mark === 'string') url.mark = request.mark;
	return url;
}

function rewrite(request: RewriteRequest): string | RewriteAnswer {
	const url = scriptURL(request);
	const told: RewrittenBy = {};
	const output = modifyJS(
		request.script,
		url,
		request.config,
		request.type,
		request.preamble ?? '',
		request.source,
		told,
	);
	return told.by ? { output, by: told.by } : output;
}

/**
 * A script from its UTF-8 bytes: a Blob of the output's bytes (it goes to
 * the service worker as a handle), or what modifyJS makes of the text they
 * decode to where the module did not answer for them
 */
function rewriteBytes(
	request: RewriteBytesRequest,
): [Blob | string, Transferable[]] {
	const url = scriptURL(request);
	const bytes = new Uint8Array(request.bytes);
	const output = rewriteBytesInWasm(
		bytes,
		url,
		request.config,
		request.type,
		request.preamble,
	);
	if (output) return [output, []];
	return [
		modifyJS(
			new TextDecoder().decode(bytes),
			url,
			request.config,
			request.type,
			request.preamble ?? '',
		),
		[],
	];
}

function serve(port: MessagePort) {
	const rpc = new RpcHelper<RewriteBound, Record<string, never>>(
		{
			rewrite: async (request) => [rewrite(request), []],
			rewriteBytes: async (request) => rewriteBytes(request),
			// the blocker's engine, compiled here for the service worker
			// (src/blocker/build.ts); the module and the build's memory go
			// with the call
			buildEngine: async ({ module, lists }) => {
				const engine = buildEngine(await WebAssembly.compile(module), lists);
				return engine ? [engine.buffer, [engine.buffer]] : [null, []];
			},
		},
		REWRITE_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();
	port.postMessage({ [REWRITE_READY]: true });
}

// this thread rewrites a site's scripts: its instances keep what a large
// one needed for the next
setMemoryLimit(SERVING_MEMORY_LIMIT);

self.addEventListener('message', (event) => {
	if (event.data?.[REWRITE_PORT] && event.ports[0]) serve(event.ports[0]);
	else if (event.data?.[REWRITE_MODULES])
		// the controller hears which modules this thread holds now
		adoptModules(event.data[REWRITE_MODULES])
			.then(heldModules)
			.then((held) => self.postMessage({ [REWRITE_MODULES]: held }));
});
