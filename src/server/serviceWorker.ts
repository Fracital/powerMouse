import { getDomain } from 'tldts';
import { Config } from '../config';
import {
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
import createServer, { StompServer } from './createServer';

interface ControllerRef {
	directory: string;
	config: Config;
	port: MessagePort;
	rpc: RpcHelper<SWbound, Controllerbound>;
	server: Promise<StompServer>;
	ready?: StompServer;
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

/** one controller per directory (scope) */
const controllers = new Map<string, ControllerRef>();

function registerController(
	{ directory, config }: ControllerInitMessage,
	port: MessagePort,
) {
	const existing = controllers.get(directory);

	if (existing) {
		existing.rpc.abort('Controller replaced');
		existing.port.close();
	}

	const transport = new RemoteTransport(port);
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

	const ref: ControllerRef = { directory, config, port, rpc, server };
	server.then((ready) => (ref.ready = ready));
	controllers.set(directory, ref);

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

self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;

	if (CONTROLLER_INIT in data) {
		registerController(data[CONTROLLER_INIT], event.ports[0]);
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

function timedOut(request: Request, ms: number): Response {
	const message = `Stomp: no answer for ${request.url} within ${ms / 1000} seconds`;
	console.warn(message);
	if (DOCUMENT_DESTINATIONS.has(request.destination))
		return new Response(
			`<!doctype html><title>504</title><h1>504</h1><p>${escapeHTML(message)}</p>`,
			{
				status: 504,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			},
		);
	return new Response(null, { status: 504 });
}

/** the response, or a 504 when it takes longer than the destination allows */
function bounded(
	request: Request,
	response: Promise<Response>,
	config: Config,
): Promise<Response> {
	const ms =
		config.fetchTimeout ??
		(LONG_DESTINATIONS.has(request.destination)
			? FETCH_TIMEOUT_LONG_MS
			: FETCH_TIMEOUT_MS);
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<Response>((resolve) => {
		timer = setTimeout(() => resolve(timedOut(request, ms)), ms);
	});
	return Promise.race([response.finally(() => clearTimeout(timer)), timeout]);
}

self.addEventListener('fetch', (event: FetchEvent) => {
	const { pathname } = new URL(event.request.url);
	const ref = controllerFor(pathname);
	if (!ref) return;
	// a navigation has no client yet; the document it creates is the one the
	// host will hear from, so the report carries that id
	const clientId =
		event.request.mode === 'navigate'
			? event.resultingClientId || event.clientId
			: event.clientId;

	if (ref.ready) {
		if (ref.ready.router.willRoute(event.request.url))
			event.respondWith(
				bounded(
					event.request,
					ref.ready.router.route(event.request, { clientId }),
					ref.config,
				),
			);
	} else {
		// the server is still opening its databases; decide once it's up
		event.respondWith(
			bounded(
				event.request,
				ref.server.then(({ router }) =>
					router.willRoute(event.request.url)
						? router.route(event.request, { clientId })
						: fetch(event.request),
				),
				ref.config,
			),
		);
	}
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
