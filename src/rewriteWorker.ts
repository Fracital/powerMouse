// A rewrite worker (dist/rewriteWorker.js): a dedicated Worker the
// controller starts so that the service worker's script rewrites run on
// threads of their own. The service worker rewrites one script at a time on
// its single thread, so a page of large scripts waits for each in turn;
// with a pool, they are rewritten side by side. Each port the controller
// hands over is a channel to the service worker, which sends a script with
// everything its output depends on and gets back what modifyJS makes of it,
// the same as it would have made itself.
import { parseConfig } from './config';
import { modifyJS, type RewrittenBy } from './rewriteJS';
import {
	REWRITE_READY,
	REWRITE_RPC,
	RewriteAnswer,
	RewriteBound,
	RewriteRequest,
} from './rewriteMessages';
import { addRouteScopes } from './routeURL';
import { planSplit } from './splitRewrite';
import StompURL from './StompURL';
import { REWRITE_MODULES, REWRITE_PORT } from './transport/messages';
import { RpcHelper } from './transport/rpc';
import { adoptModules, heldModules } from './wasm/thread';

declare const self: DedicatedWorkerGlobalScope;

function rewrite(request: RewriteRequest): string | RewriteAnswer {
	addRouteScopes(request.scopes);
	const { codec } = parseConfig(request.config, request.codecKey);
	const url = new StompURL(new URL(request.url), codec, request.directory);
	const told: RewrittenBy = {};
	const output = modifyJS(
		request.script,
		url,
		request.config,
		request.type,
		request.preamble ?? '',
		request.compact,
		request.source,
		told,
	);
	return told.by ? { output, by: told.by } : output;
}

function serve(port: MessagePort) {
	const rpc = new RpcHelper<RewriteBound, Record<string, never>>(
		{
			rewrite: async (request) => [rewrite(request), []],
			plan: async (request) => [planSplit(request.script, request.parts), []],
		},
		REWRITE_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();
	port.postMessage({ [REWRITE_READY]: true });
}

self.addEventListener('message', (event) => {
	if (event.data?.[REWRITE_PORT] && event.ports[0]) serve(event.ports[0]);
	else if (event.data?.[REWRITE_MODULES])
		// the controller hears which modules this thread holds now
		adoptModules(event.data[REWRITE_MODULES])
			.then(heldModules)
			.then((held) => self.postMessage({ [REWRITE_MODULES]: held }));
});
