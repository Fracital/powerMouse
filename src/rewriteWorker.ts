// A rewrite worker (dist/rewriteWorker.js): a dedicated Worker the
// controller starts so that the service worker's script rewrites run on
// threads of their own. The service worker rewrites one script at a time on
// its single thread, so a page of large scripts waits for each in turn;
// with a pool, they are rewritten side by side. Each port the controller
// hands over is a channel to the service worker, which sends a script with
// everything its output depends on and gets back what modifyJS makes of it,
// the same as it would have made itself.
import { parseConfig } from './config';
import { modifyJS } from './rewriteJS';
import {
	REWRITE_READY,
	REWRITE_RPC,
	RewriteBound,
	RewriteRequest,
} from './rewriteMessages';
import { addRouteScopes } from './routeURL';
import { planSplit } from './splitRewrite';
import StompURL from './StompURL';
import { REWRITE_PORT } from './transport/messages';
import { RpcHelper } from './transport/rpc';

declare const self: DedicatedWorkerGlobalScope;

function rewrite(request: RewriteRequest): string {
	addRouteScopes(request.scopes);
	const { codec } = parseConfig(request.config, request.codecKey);
	const url = new StompURL(new URL(request.url), codec, request.directory);
	return modifyJS(
		request.script,
		url,
		request.config,
		request.type,
		'',
		request.compact,
	);
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
});
