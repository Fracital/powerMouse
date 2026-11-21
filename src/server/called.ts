// Just call stomp (src/controller/justCallStomp.ts): a frame of the host
// loads the call page (CALL_PAGE), one constant page under the scope that
// this worker serves and so controls, which names no site. The host hands
// it the route of the document it is to show by a message, and the page
// asks for that document with a fetch of the route that carries
// CALL_HEADER. The worker answers the fetch as it answers that frame's
// navigation to the route: the same request upstream (a document's
// Sec-Fetch-*, cookies and referrer), the same rewrite and the same shell.
// The page writes the answer into itself. The frame's one navigation is to
// the call page, its first (which makes no history entry), so nothing of
// the site ever reaches the session history, the frame's location or its
// navigation entries.
//
// Every handler past the fetch event reads the request's mode and
// destination and the event's resulting client to tell a navigation from a
// fetch, so the event and its request are handed on as views that read as
// that navigation's: a mode of `navigate`, the destination of a frame's
// document and the call page's own client as the client the navigation
// makes. Their methods are the real objects', bound. A redirect is answered
// as a navigation's (a 3xx to the next route), which the page's fetch
// follows through the worker with the header still on it.
//
// Only a call page may call, and once: a client whose document is the call
// page and has not been written yet. A call binds the client to the real
// origin of the route, as a vouched srcdoc document is bound
// (./srcdocVouches.ts), so its loads are that origin's.

import {
	CALL_HEADER,
	CALL_MESSAGE,
	CALL_PAGE,
	CALL_POLICY_HEADER,
	CALLED_KEY,
	CALLED_URL_HEADER,
	WORKER_BASE,
} from '../transport/messages';
import { bindCalled } from './srcdocVouches';

/** what a call's value may say of how the document was reached */
const CALL_TYPES = ['navigate', 'reload', 'back_forward'];
/** the referrer policies a call may name */
const POLICIES = [
	'no-referrer',
	'no-referrer-when-downgrade',
	'origin',
	'origin-when-cross-origin',
	'same-origin',
	'strict-origin',
	'strict-origin-when-cross-origin',
	'unsafe-url',
];
/** how long a client's call may go on redirecting */
const CHAIN_MS = 30_000;
/** how many clients that called are remembered as done */
const DONE_KEPT = 1024;
/** clients calling now, and since when: a redirect's next call is of the same client */
const calling = new Map<string, number>();
/** clients whose call was answered: their documents are written, and call no more */
const done = new Set<string>();

/**
 * The call page. Its script takes one message, from its parent's window and
 * origin only, with the port everything else goes over: the call (the
 * route, and the request's method, body and referrer), then, once the host
 * has shown the frame, the word to write. It writes the answer into itself
 * from its own realm, so the document keeps the call page's URL, its worker
 * and its realm; what the document's inject takes first (the port, the
 * tab's history) is left on the window under CALLED_KEY, and the page's URL
 * under WORKER_BASE. Nothing of it stays: its listener and variables go
 * with the write (document.open removes the window's listeners).
 */
const CALL_PAGE_HTML = `<!doctype html><meta charset="utf-8"><script>(() => {
	const key = ${JSON.stringify(CALL_MESSAGE)};
	const from = location.ancestorOrigins && location.ancestorOrigins[0];
	const listen = (event) => {
		const data = event.data && event.data[key];
		const port = event.ports && event.ports[0];
		if (event.source !== parent || parent === window || event.origin !== from || !data || !port) return;
		removeEventListener('message', listen);
		let response = null;
		port.onmessage = async ({ data: ask }) => {
			if (ask.call) {
				try {
					response = await fetch(ask.call.routed, ask.call.init);
					port.postMessage({ answered: { url: response.headers.get(${JSON.stringify(CALLED_URL_HEADER)}), routed: response.url, status: response.status } });
				} catch (error) {
					port.postMessage({ failed: String((error && error.message) || error) });
				}
				return;
			}
			if (!ask.write || !response) return;
			const type = response.headers.get('content-type') || '';
			const charset = (/;\\s*charset=["']?([^;"'\\s]+)/i.exec(type) || [])[1] || 'utf-8';
			let decoder;
			try {
				decoder = new TextDecoder(charset);
			} catch (error) {
				decoder = new TextDecoder();
			}
			let markup = decoder.decode(await response.arrayBuffer());
			// the policies the answer's headers set, which a written document
			// does not get from its headers: first in the shell, before any of
			// its scripts (a meta's policy applies from where it is)
			// and its referrer policy, before the page's own metas (a later one wins)
			const quote = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
			const policies = (response.headers.get('content-security-policy') || '').split(',').map((policy) => policy.trim()).filter(Boolean);
			const referrer = (response.headers.get('referrer-policy') || '').split(',').map((policy) => policy.trim()).filter(Boolean).pop();
			const metas = policies.map((policy) => '<meta http-equiv="Content-Security-Policy" content="' + quote(policy) + '">').join('') + (referrer ? '<meta name="referrer" content="' + quote(referrer) + '">' : '');
			if (metas) markup = markup.replace(/<head>(<meta charset="utf-8" \\/>)?/i, (head) => head + metas);
			port.onmessage = null;
			Object.defineProperty(window, ${JSON.stringify(CALLED_KEY)}, { value: { port, session: ask.write.session, policy: referrer || '' }, configurable: true });
			Object.defineProperty(window, ${JSON.stringify(WORKER_BASE)}, { value: ask.write.url, configurable: true });
			// the call's own fetch is none of the page's
			performance.clearResourceTimings();
			document.open();
			document.write(markup);
			document.close();
		};
	};
	addEventListener('message', listen);
})()</script>`;

/**
 * whether `url` is a call page's, under the worker's scope: the tab's
 * frame's, or a called document's frame's, numbered by its depth below it
 * (`?1`: no frame may load a URL two of its ancestors have)
 */
export function isCallPage(url: string): boolean {
	const page = `${self.location.origin}${scopePath()}${CALL_PAGE}`;
	return (
		url === page ||
		(url.startsWith(`${page}?`) && /^\d+$/.test(url.slice(page.length + 1)))
	);
}

const scopePath = () =>
	new URL((self as unknown as ServiceWorkerGlobalScope).registration.scope)
		.pathname;

/** the call page, for a navigation to it; whether it was answered */
export function callPage(event: FetchEvent, pathname: string): boolean {
	if (
		pathname !== `${scopePath()}${CALL_PAGE}` ||
		event.request.mode !== 'navigate' ||
		event.request.method !== 'GET'
	)
		return false;
	event.respondWith(
		new Response(CALL_PAGE_HTML, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
				// a host page that is cross-origin isolated embeds it
				'cross-origin-embedder-policy': 'require-corp',
				'cross-origin-resource-policy': 'cross-origin',
				// served from a site's own origin (a slot of the site pool), its
				// own process: Chrome keys a process by site unless the first
				// document of the origin asks for its origin (on the host's own
				// origin it changes nothing)
				'origin-agent-cluster': '?1',
			},
		}),
	);
	return true;
}

/** whether the request is a call (it carries the header and is no navigation) */
export function isCall(request: Request): boolean {
	return request.mode !== 'navigate' && request.headers.has(CALL_HEADER);
}

function view<T extends object>(target: T, own: Record<string, unknown>): T {
	return new Proxy(target, {
		get(object, key) {
			if (typeof key === 'string' && key in own) return own[key];
			const value = Reflect.get(object, key, object);
			return typeof value === 'function' ? value.bind(object) : value;
		},
	});
}

/** the request as its navigation's: the header is the worker's own, never sent on */
function calledRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	headers.delete(CALL_HEADER);
	const policy = headers.get(CALL_POLICY_HEADER);
	headers.delete(CALL_POLICY_HEADER);
	const own: Record<string, unknown> = {
		mode: 'navigate',
		destination: 'iframe',
		headers,
	};
	// (the fetch's own policy would strip the referrer the worker reads)
	if (policy && POLICIES.includes(policy)) own.referrerPolicy = policy;
	own.clone = () => calledRequest(request.clone());
	return view(request, own);
}

/**
 * The event of a call as its navigation's, or null when the client may not
 * call (it is answered 403). `realOrigin` reads the route's real origin.
 */
export async function calledEvent(
	event: FetchEvent,
	realOrigin: (url: string) => string | null,
): Promise<FetchEvent | null> {
	const { request, clientId } = event;
	const type = request.headers.get(CALL_HEADER) ?? '';
	if (!clientId || done.has(clientId) || !CALL_TYPES.includes(type))
		return null;
	const now = Date.now();
	for (const [id, at] of calling) if (now - at > CHAIN_MS) calling.delete(id);
	if (!calling.has(clientId)) {
		const client = await clients.get(clientId);
		if (
			client?.type !== 'window' ||
			(client as WindowClient).frameType !== 'nested' ||
			!isCallPage(client.url)
		)
			return null;
	}
	const origin = realOrigin(request.url);
	if (!origin || origin === 'null') return null;
	calling.set(clientId, now);
	bindCalled(clientId, origin);
	const navigation = calledRequest(request);
	let answered: Promise<Response> | null = null;
	return view(event, {
		request: navigation,
		resultingClientId: clientId,
		isReload: type === 'reload',
		respondWith: (answer: Promise<Response> | Response) => {
			answered = Promise.resolve(answer);
		},
		get answered() {
			return answered;
		},
	});
}

/**
 * The answer the handlers gave the call's event. A redirect goes as it is
 * (the page's fetch follows it, and calls again); the last answer names the
 * page's real URL, and ends the client's calls.
 */
export async function answerOf(
	event: FetchEvent,
	realURL: (url: string) => string | null,
): Promise<Response> {
	const answer = (event as FetchEvent & { answered?: Promise<Response> | null })
		.answered;
	if (!answer) return new Response(null, { status: 404 });
	const response = await answer;
	if (response.status >= 300 && response.status < 400) return response;
	calling.delete(event.clientId);
	if (done.size >= DONE_KEPT) done.delete(done.values().next().value!);
	done.add(event.clientId);
	const url = realURL(event.request.url);
	if (response.type !== 'default' || !url) return response;
	const headers = new Headers(response.headers);
	headers.set(CALLED_URL_HEADER, url);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
