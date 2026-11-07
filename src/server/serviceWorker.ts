import { getDomain } from 'tldts';
import { Config, ConfigCodec } from '../config';
import {
	ABORT_REQUEST,
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	INIT_REMOTE_TRANSPORT,
	InitRemoteTransportMessage,
	postToPort,
	RequestInfo,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { RpcHelper } from '../transport/rpc';
import { BUILD } from '../version';
import createServer, { addressCodec, StompServer } from './createServer';
import { hostErrorPage } from './errorPage';
import { abortRequest } from './rewrites';

interface ControllerRef {
	/** the controller's address: its scope plus its id */
	directory: string;
	config: Config;
	port: MessagePort;
	rpc: RpcHelper<SWbound, Controllerbound>;
	server: Promise<StompServer>;
	ready?: StompServer;
	/** the client that registered it (the host page, or the controller frame); it goes with its tab */
	client?: string;
	/** registration order: the newest live controller of a scope takes over an address whose controller is gone */
	serial: number;
}

/** the fetch-metadata site of a request from `initiator` to `url` */
function siteOf(
	initiator: string,
	url: string,
): 'same-origin' | 'same-site' | 'cross-site' {
	try {
		const from = new URL(initiator);
		const to = new URL(url);
		// schemeful same-site: ws is http, wss is https
		for (const u of [from, to])
			if (u.protocol === 'ws:') u.protocol = 'http:';
			else if (u.protocol === 'wss:') u.protocol = 'https:';
		if (from.origin === to.origin) return 'same-origin';
		if (from.protocol !== to.protocol) return 'cross-site';
		const domain = getDomain(from.hostname);
		// an IP or localhost has no registrable domain: the host itself is the site
		return (domain !== null && domain === getDomain(to.hostname)) ||
			from.hostname === to.hostname
			? 'same-site'
			: 'cross-site';
	} catch (error) {
		return 'cross-site';
	}
}

/**
 * one controller per address (`/stomp/<id>/`): the controllers of a scope
 * (two host tabs on `/stomp/`) live side by side and share the scope's
 * stores (createServer); only the same id again replaces
 */
const controllers = new Map<string, ControllerRef>();
let serials = 0;

function registerController(
	{ directory, config: given }: ControllerInitMessage,
	port: MessagePort,
	transportPort?: MessagePort,
	client?: string,
) {
	const existing = controllers.get(directory);

	if (existing) {
		existing.rpc.abort('Controller replaced');
		existing.port.close();
	}

	// a controller bundle from before addresses sends no scope: its directory
	// is the scope
	const config: Config = { ...given, scope: given.scope || given.directory };

	// a controller whose transport lives in its worker sends a second port,
	// served from there; otherwise the transport shares the rpc port
	const transport = new RemoteTransport(transportPort ?? port);
	// the host's request log, only when it asked: one RPC per request. The
	// rpc is created below; requests only arrive once it exists
	function report(info: RequestInfo) {
		rpc.call('request', info);
	}
	const server = createServer(
		config,
		transport,
		config.requestLog ? report : undefined,
	);

	const rpc = new RpcHelper<SWbound, Controllerbound>(
		{
			route: async (url) => [(await server).route(url), []],
			rules: async (rules) => {
				(await server).setRules(rules);
			},
			clearCache: async () => {
				await (await server).clearCache();
			},
			cookies: async (command) => {
				const { cookies } = await server;
				switch (command.op) {
					case 'get':
						return [
							(
								await cookies.get(
									command.url,
									command.initiator
										? { site: siteOf(command.initiator, command.url) }
										: {},
								)
							).toString(),
							[],
						];
					case 'set':
						await cookies.set(command.setCookie, command.url);
						return [undefined, []];
					case 'list':
						return [await cookies.list(command.origin), []];
					case 'clear':
						await cookies.clear(command.origin);
						return [undefined, []];
				}
			},
		},
		CONTROLLER_RPC,
		(data, transfer) => postToPort(port, data, transfer),
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();

	const ref: ControllerRef = {
		directory,
		config,
		port,
		rpc,
		server,
		client,
		serial: ++serials,
	};
	server.then((ready) => (ref.ready = ready));
	controllers.set(directory, ref);
	// the controller's side of the port went away (its tab closed, or it
	// shook hands again over a new channel): forget it, unless the address
	// has already been taken over
	port.addEventListener('close', () => {
		if (controllers.get(directory) === ref) controllers.delete(directory);
	});

	server.then(
		() => rpc.call('ready', { build: BUILD }),
		(error) => console.error('Stomp: failed to create server', error),
	);
}

function controllerFor(pathname: string): ControllerRef | undefined {
	let match: ControllerRef | undefined;

	for (const ref of controllers.values())
		if (
			pathname.startsWith(ref.directory) &&
			(!match || ref.directory.length > match.directory.length)
		)
			match = ref;

	return match;
}

/**
 * Whether the tab that registered `ref` is still there. A port is not told
 * when its other side's document is gone (the `close` event above is
 * recent), so a document request asks the clients list before trusting a
 * controller; a controller that registered without a client is trusted.
 */
async function alive(ref: ControllerRef): Promise<boolean> {
	if (!ref.client) return true;
	return (await self.clients.get(ref.client)) !== undefined;
}

/** the segment an address adds to its scope, and the route under it */
const ADDRESS = /^([A-Za-z0-9_-]{1,32})\/(.+)$/;

/** the ready controllers of a scope, newest first */
function scopeControllers(scope: string): ControllerRef[] {
	return [...controllers.values()]
		.filter((ref) => ref.config.scope === scope && ref.ready)
		.sort((a, b) => b.serial - a.serial);
}

/** a routed URL whose address names no live controller, under a scope that has some */
interface Orphan {
	/** the gone controller's address */
	directory: string;
	/** the route under the address (`html/...`) */
	rest: string;
	/** the scope's live controllers that would route `rest`, newest first */
	candidates: ControllerRef[];
}

/**
 * A routed URL under a scope with live controllers, at an address that is
 * none of theirs: the address of a controller that is gone (a closed tab, a
 * history entry or a link from one). Null for anything else under the
 * scope, such as its assets or the host's own files, which no controller
 * would route.
 */
function orphanOf(pathname: string): Orphan | null {
	const scopes = [
		...new Set([...controllers.values()].map((ref) => ref.config.scope)),
	].sort((a, b) => b.length - a.length);
	for (const scope of scopes) {
		if (!pathname.startsWith(scope)) continue;
		const match = ADDRESS.exec(pathname.slice(scope.length));
		if (!match) continue;
		const [, id, rest] = match;
		const candidates = scopeControllers(scope).filter((ref) =>
			ref.ready!.router.willRoute(`${location.origin}${ref.directory}${rest}`),
		);
		if (candidates.length)
			return { directory: `${scope}${id}/`, rest, candidates };
	}
	return null;
}

/**
 * The newest live controller of the scope with the gone controller's codec
 * takes the request: a redirect to the same route at its address, so the
 * document and everything it loads run under a live address. Without one
 * (the codec is another, or this worker never served the address) the
 * host's error page answers with kind `controller`.
 */
async function answerOrphan(
	request: Request,
	{ directory, rest, candidates }: Orphan,
): Promise<Response> {
	const codec = await addressCodec(directory);
	const taker = codec && candidates.find((ref) => ref.config.codec === codec);
	if (taker) {
		const url = new URL(request.url);
		url.pathname = `${taker.directory}${rest}`;
		return Response.redirect(url.href, 307);
	}
	return orphanError(request, candidates[0].config, directory, codec);
}

/**
 * No live controller can take an address: 410 when this worker knows whose
 * it was (its codec is `codec`), 404 when it never served it. A document
 * gets the host's error page (`config.errorPage`) with kind `controller`.
 */
async function orphanError(
	request: Request,
	config: Config,
	directory: string,
	codec: ConfigCodec | undefined,
): Promise<Response> {
	const message = codec
		? `Stomp: the controller at ${directory} is gone and no live controller uses its codec (${codec})`
		: `Stomp: no controller is registered at ${directory}`;
	console.warn(message);
	const status = codec ? 410 : 404;
	if (!DOCUMENT_DESTINATIONS.has(request.destination))
		return new Response(null, { status });
	return (
		(await hostErrorPage(config, {
			url: request.url,
			status,
			error: message,
			kind: 'controller',
		})) ??
		new Response(
			`<!doctype html><title>${status}</title><h1>${status}</h1><p>${escapeHTML(message)}</p>`,
			{
				status,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			},
		)
	);
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;

	if (CONTROLLER_INIT in data) {
		registerController(
			data[CONTROLLER_INIT],
			event.ports[0],
			event.ports[1],
			event.source instanceof Client ? event.source.id : undefined,
		);
	} else if (ABORT_REQUEST in data) {
		abortRequest((data as Record<string, unknown>)[ABORT_REQUEST]);
	} else if (INIT_REMOTE_TRANSPORT in data) {
		const { directory } = data[
			INIT_REMOTE_TRANSPORT
		] as InitRemoteTransportMessage;
		const ref = controllers.get(directory);

		if (!ref) {
			console.error(`Stomp: no controller registered for ${directory}`);
			return;
		}

		const [port] = event.ports;
		ref.rpc.call('initRemoteTransport', port, [port]);
	}
});

/**
 * How long a routed request may take before the worker answers 504 instead.
 * A transport request that never settles (epoxy ignores abort) would
 * otherwise keep its fetch event, and with it this worker, alive for good,
 * and a waiting worker of a newer build could never activate. Documents and
 * media get longer; `config.fetchTimeout` overrides both (tests).
 */
const FETCH_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_LONG_MS = 120000;
const LONG_DESTINATIONS = new Set([
	'document',
	'iframe',
	'frame',
	'embed',
	'object',
	'video',
	'audio',
	'track',
]);
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

const escapeHTML = (text: string) =>
	text.replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
	);

async function timedOut(
	request: Request,
	ms: number,
	ref: ControllerRef,
): Promise<Response> {
	const message = `Stomp: no answer for ${request.url} within ${ms / 1000} seconds`;
	console.warn(message);
	if (DOCUMENT_DESTINATIONS.has(request.destination))
		return (
			(await hostErrorPage(ref.config, {
				url: ref.ready?.realURL(request.url) ?? request.url,
				status: 504,
				error: message,
				kind: 'timeout',
			})) ??
			new Response(
				`<!doctype html><title>504</title><h1>504</h1><p>${escapeHTML(message)}</p>`,
				{
					status: 504,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				},
			)
		);
	return new Response(null, { status: 504 });
}

/** the response, or a 504 when it takes longer than the destination allows */
function bounded(
	request: Request,
	response: Promise<Response>,
	ref: ControllerRef,
): Promise<Response> {
	const ms =
		ref.config.fetchTimeout ??
		(LONG_DESTINATIONS.has(request.destination)
			? FETCH_TIMEOUT_LONG_MS
			: FETCH_TIMEOUT_MS);
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<Response>((resolve) => {
		timer = setTimeout(() => resolve(timedOut(request, ms, ref)), ms);
	});
	return Promise.race([response.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * The request through its controller. A document for a controller whose tab
 * is gone (the port said nothing) is dropped from the table and answered
 * as an orphan, so an old tab's history entry lands on a live controller.
 */
async function serve(event: FetchEvent, ref: ControllerRef): Promise<Response> {
	const { request } = event;
	// a navigation has no client yet; the document it creates is the one the
	// host will hear from, so the report carries that id
	const clientId =
		request.mode === 'navigate'
			? event.resultingClientId || event.clientId
			: event.clientId;
	if (DOCUMENT_DESTINATIONS.has(request.destination) && !(await alive(ref))) {
		if (controllers.get(ref.directory) === ref)
			controllers.delete(ref.directory);
		const orphan = orphanOf(new URL(request.url).pathname);
		if (orphan) return answerOrphan(request, orphan);
		// nothing live under the scope at all: the gone controller's own error page
		return orphanError(request, ref.config, ref.directory, ref.config.codec);
	}
	const server = ref.ready ?? (await ref.server);
	return server.router.willRoute(request.url)
		? server.router.route(request, { clientId })
		: fetch(request);
}

self.addEventListener('fetch', (event: FetchEvent) => {
	const { pathname } = new URL(event.request.url);
	const ref = controllerFor(pathname);
	if (ref) {
		// the server is still opening its databases: decide once it's up
		if (ref.ready && !ref.ready.router.willRoute(event.request.url)) return;
		event.respondWith(bounded(event.request, serve(event, ref), ref));
		return;
	}
	const orphan = orphanOf(pathname);
	if (orphan) event.respondWith(answerOrphan(event.request, orphan));
});

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(self.clients.claim());
});

// This script only runs again when the worker was terminated and restarted.
// Nothing in `controllers` survived, so ask every client to re-register.
setTimeout(async () => {
	for (const client of await self.clients.matchAll({
		includeUncontrolled: true,
	}))
		client.postMessage({ [SW_REVIVE]: {} });
}, 100);
