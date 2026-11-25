// Just call stomp (src/controller/justCallStomp.ts): a frame of the host
// loads the call page (the asset `callPage`, src/config.ts Assets), one
// constant page under the scope that this worker serves and so controls,
// which names no site. The host hands it a token and a port by a message,
// then the call over the port: the route of the document it is to show,
// and how it was reached. The page asks for that document with a fetch of
// the route that carries CALL_HEADER and the token. The worker answers the
// fetch as it answers that frame's navigation to the route: the same
// request upstream (a document's Sec-Fetch-*, cookies and referrer), the
// same rewrite and the same shell. The page writes the answer into itself.
// The frame's one navigation is to the call page, its first (which makes no
// history entry), so nothing of the site ever reaches the session history,
// the frame's location or its navigation entries.
//
// The surface exists only for a controller that opted in
// (ControllerInit.dialing, Config.dialing): the call page is served at the
// names those controllers give it, and a call is answered only for a route
// of theirs. For every other controller the page's URL is a URL like any
// other under the scope (the host's server answers it), and a request that
// carries CALL_HEADER is a request like any other.
//
// Every handler past the fetch event reads the request's mode and
// destination and the event's resulting client to tell a navigation from a
// fetch, so the event and its request are handed on as views that read as
// that navigation's: a mode of `navigate`, the destination of a frame's
// document and the call page's own client as the client the navigation
// makes. Their methods are the real objects', bound. A redirect is answered
// as a navigation's (a 3xx to the next route), which the page's fetch
// follows through the worker with the headers still on it.
//
// Only a call page may call, once, and with a token: a client whose
// document is a call page and has not been written yet, presenting a token
// its controller gave this worker for that route (allowCallToken) over the
// controller's own channel, which no page reaches. The token is spent on
// the call; its redirects within the scope are the same call. A call binds
// the client to the real origin of the route, as a vouched srcdoc document
// is bound (./srcdocVouches.ts), so its loads are that origin's.
//
// Under the site pool (content slots, docs/content-slots.md) every slot's
// worker serves the call page on its own origin, for its agent's controller
// (which opted in as the hub's did), so a site's documents are written in
// its slot's process. A token is held by the worker of the origin the call
// is made from: the hub mints it and hands it to that slot's worker through
// the slot's agent. A call whose document another origin shows (leaveSlot's
// 307 to another slot, or to the hub's origin) is answered with
// CALL_MOVED_HEADER instead, which ends the call; the host calls again from
// a call page of that origin, with a token for that origin's worker.
//
// What the token does not close: on the host's own origin (the same-origin
// fallback, no slot of its own) a script of that origin that got past the
// inject can reach the call page's window, read what is written into it,
// and replace its globals before the host's message arrives. Only a call
// page on an origin of its own is out of such a script's reach.

import { assetName, type Config } from '../config';
import { proxyOrigins } from '../routeURL';
import {
	CALL_HEADER,
	CALL_HERE,
	CALL_MESSAGE,
	CALL_MOVED_HEADER,
	CALL_POLICY_HEADER,
	CALL_TOKEN_DIGITS,
	CALL_TOKEN_HEADER,
	CALL_WAIT_MS,
	CALLED_KEY,
	CALLED_RESOURCE_HEADER,
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
/** what Chrome's navigation asks for (its Accept header) */
const NAVIGATION_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const TOKEN_SHAPE = new RegExp(`^[0-9a-f]{${CALL_TOKEN_DIGITS}}$`);
/** how many tokens, and how many calls in progress, are kept at most */
const MAX_PENDING = 1024;
/** how many clients that called are remembered as done */
const DONE_KEPT = 1024;
/** the redirects a call follows (the page's fetch does, within the scope) */
const REDIRECTS = [301, 302, 303, 307, 308];
/** the longest URL a call names */
const MAX_URL = 32_768;

/** a controller of this worker, as far as dialing goes */
export interface Dialer {
	directory: string;
	config: Config;
}
/** the controllers that opted in (Config.dialing), from the worker */
let dialers: () => Dialer[] = () => [];
export function useDialers(list: () => Dialer[]) {
	dialers = list;
}
const dialing = () => dialers().filter((ref) => ref.config.dialing === true);

type Permit = { href: string; directory: string; expires: number };
type Chain = Permit & { token: string; type: string; awaiting: boolean };
/** tokens a controller gave and no call has spent yet */
const tokens = new Map<string, Permit>();
/** clients calling now: a redirect's next call is of the same client and token */
const calling = new Map<string, Chain>();
/** clients whose call was answered: their documents are written, and call no more */
const done = new Set<string>();

function sweep<T extends { expires: number }>(map: Map<string, T>) {
	const now = Date.now();
	for (const [id, permit] of map) if (permit.expires <= now) map.delete(id);
}

const withoutHash = (url: string) => {
	const parsed = new URL(url);
	parsed.hash = '';
	return parsed.href;
};

/**
 * `token` may make one call of `route`, a route of the controller at
 * `directory` (the controller's rpc, `callToken`). False for a token of the
 * wrong shape, one already given, or too many waiting.
 */
export function allowCallToken(
	token: unknown,
	route: string,
	directory: string,
): boolean {
	if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false;
	sweep(tokens);
	if (tokens.has(token) || tokens.size >= MAX_PENDING) return false;
	tokens.set(token, {
		href: withoutHash(route),
		directory,
		expires: Date.now() + CALL_WAIT_MS,
	});
	return true;
}

/**
 * The call page. Its script takes a message from its parent's window only,
 * from an origin of the controllers that opted in (the browser stamps
 * event.origin; where the browser lists the frame's ancestors' origins,
 * Chrome's `location.ancestorOrigins`, the parent's must be that one too;
 * Firefox lists none, and the parent's window and stamped origin decide
 * there), naming a token of the right shape and carrying exactly one port.
 * Up to eight such messages are taken, so a page of the same origin that
 * posts first does not shut out the host: only the one whose token the
 * worker holds is answered, and the others are closed then. Over the port:
 * the page says it is ready, the host sends the call (the route and how it
 * was reached; the page builds the fetch itself, so a caller names no
 * header and no mode), then, once the host has shown the frame, the word
 * to write (or, for an answer Chrome would download, the word to save it
 * under a name, as a download). Anything else on the port, or of
 * another shape, is dropped. It writes the answer into itself from its own
 * realm, so the document keeps the call page's URL, its worker and its
 * realm; what the document's inject takes first (the port, the tab's
 * history) is left on the window under CALLED_KEY, and the page's URL
 * under WORKER_BASE. Nothing of it stays: its listener and variables go
 * with the write (document.open removes the window's listeners).
 */
// (`at`: the page's own URL where its location is not, a srcdoc frame's;
// such a page is under no controller: callPageResponse)
const callPageHTML = (
	origins: string[],
	at: string | null = null,
) => `<!doctype html><meta charset="utf-8"><script>(() => {
	const key = ${JSON.stringify(CALL_MESSAGE)};
	const origins = ${JSON.stringify(origins)};
	const types = ${JSON.stringify(CALL_TYPES)};
	const policies = ${JSON.stringify(POLICIES)};
	const shape = /^[0-9a-f]{${CALL_TOKEN_DIGITS}}$/;
	const most = ${MAX_URL};
	const ancestors = location.ancestorOrigins;
	const listed = ancestors && ancestors.length ? ancestors[0] : null;
	// (Firefox lists a file: parent as this, and stamps its messages "null")
	const above = listed === 'file://UNIVERSAL_FILE_URI_ORIGIN' ? 'null' : listed;
	const here = ${at === null ? 'location.href' : JSON.stringify(at)};
	const own = new URL(here).origin;
	const scope = new URL('.', here).pathname;
	const fetching = fetch.bind(window);
	const later = setTimeout.bind(window);
	const rootOf = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get;
	const closing = Document.prototype.close;
	const pending = new Set();
	let settled = false;
	const text = (value, limit) => typeof value === 'string' && value.length <= limit;
	const ours = (value) => {
		try {
			const url = new URL(value, here);
			return url.origin === own && url.pathname.startsWith(scope) ? url : null;
		} catch (error) {
			return null;
		}
	};
	// the call as the page makes it: the host names the route and how
	const request = (call, token, signal) => {
		if (!call || typeof call !== 'object' || !text(call.routed, most)) return null;
		const routed = ours(call.routed);
		const post = call.method === 'POST';
		if (!routed || !types.includes(call.type) || (call.method !== 'GET' && !post)) return null;
		const body = post ? call.body : null;
		if (body !== null && !text(body, Infinity) && !(body instanceof Blob)) return null;
		if (call.contentType !== undefined && !text(call.contentType, 256)) return null;
		if (call.policy !== undefined && !policies.includes(call.policy)) return null;
		if (call.referrer !== '' && !(text(call.referrer, most) && ours(call.referrer))) return null;
		const headers = new Headers({
			${JSON.stringify(CALL_HEADER)}: call.type,
			${JSON.stringify(CALL_TOKEN_HEADER)}: token,
			accept: ${JSON.stringify(NAVIGATION_ACCEPT)},
			'upgrade-insecure-requests': '1',
		});
		if (call.contentType) headers.set('content-type', call.contentType);
		if (call.policy) headers.set(${JSON.stringify(CALL_POLICY_HEADER)}, call.policy);
		return [routed.href, {
			method: call.method,
			body,
			headers,
			credentials: 'include',
			mode: 'same-origin',
			redirect: 'follow',
			referrer: call.referrer,
			cache: call.type === 'reload' ? 'no-cache' : 'default',
			signal,
		}];
	};
	const sessionShape = (session) =>
		!!session && typeof session === 'object' && Array.isArray(session.entries) &&
		session.entries.length > 0 && session.entries.length <= 4096 &&
		session.entries.every((entry) => entry && text(entry.url, most) && text(entry.key, 64) && text(entry.id, 64) && Number.isInteger(entry.document)) &&
		Number.isInteger(session.index) && session.index >= 0 && session.index < session.entries.length &&
		types.includes(session.type) && (session.routed === undefined || text(session.routed, most)) &&
		(session.scroll === undefined || (Array.isArray(session.scroll) && session.scroll.length === 2 && session.scroll.every(Number.isFinite)));
	const listen = (event) => {
		const data = event.data;
		const ports = event.ports;
		if (settled || !event.isTrusted || parent === window || event.source !== parent ||
			!origins.includes(event.origin) || (above !== null && event.origin !== above) ||
			!data || typeof data !== 'object' || Object.keys(data).length !== 1 ||
			typeof data[key] !== 'string' || !shape.test(data[key]) ||
			!ports || ports.length !== 1 || pending.size >= 8) return;
		const token = data[key];
		const port = ports[0];
		const abort = new AbortController();
		const release = () => {
			clearTimeout(timer);
			pending.delete(close);
			removeEventListener('pagehide', close);
			port.onmessageerror = port.onmessage = null;
		};
		const close = () => {
			release();
			abort.abort();
			// (the host hears no port close: it is told)
			port.postMessage({ gone: true });
			port.close();
		};
		const fail = () => {
			port.postMessage({ failed: 'The call was refused or did not load' });
			close();
		};
		const timer = setTimeout(close, ${CALL_WAIT_MS});
		pending.add(close);
		addEventListener('pagehide', close, { once: true });
		port.onmessageerror = close;
		let asked = false;
		let response = null;
		port.onmessage = async ({ data: ask }) => {
			if (!ask || typeof ask !== 'object' || Object.keys(ask).length !== 1) return;
			// (the host asks, while its call is out, whether this page is here)
			if (Number.isInteger(ask.ping)) return port.postMessage({ pong: ask.ping });
			if (ask.call && !asked && !settled) {
				asked = true;
				const made = ${at === null ? 'navigator.serviceWorker && navigator.serviceWorker.controller' : 'true'} ? request(ask.call, token, abort.signal) : null;
				if (!made) return fail();
				let answer;
				try {
					answer = await fetching(...made);
				} catch (error) {
					if (!abort.signal.aborted) fail();
					return;
				}
				if (abort.signal.aborted) return;
				if (settled) return close();
				// another origin shows the document (a slot of the site pool):
				// the host calls again from there, and this page is done
				const moved = answer.headers.get(${JSON.stringify(CALL_MOVED_HEADER)});
				const url = answer.headers.get(${JSON.stringify(CALLED_URL_HEADER)});
				if (moved ? !text(moved, most) : !url) return fail();
				settled = true;
				removeEventListener('message', listen);
				for (const other of pending) if (other !== close) other();
				if (moved) {
					release();
					port.postMessage({ moved });
					return;
				}
				response = answer;
				port.postMessage({ answered: { url, routed: answer.url, status: answer.status, type: answer.headers.get('content-type'), disposition: answer.headers.get('content-disposition') } });
				return;
			}
			// an answer Chrome downloads: saved under the name the host gives
			if (ask.save !== undefined) {
				if (!response || !text(ask.save, 1024)) return;
				const body = response;
				response = null;
				let blob;
				try {
					blob = await body.blob();
				} catch (error) {
					if (!abort.signal.aborted) fail();
					return;
				}
				release();
				const link = document.createElement('a');
				link.href = URL.createObjectURL(blob);
				link.download = ask.save;
				link.click();
				port.postMessage({ saved: true });
				return;
			}
			const write = ask.write;
			if (!write || !response || typeof write !== 'object' || !text(write.url, most) || !sessionShape(write.session)) return;
			try {
				new URL(write.url);
			} catch (error) {
				return;
			}
			const body = response;
			response = null;
			const type = body.headers.get('content-type') || '';
			const charset = (/;\\s*charset=["']?([^;"'\\s]+)/i.exec(type) || [])[1] || 'utf-8';
			let decoder;
			try {
				decoder = new TextDecoder(charset);
			} catch (error) {
				decoder = new TextDecoder();
			}
			let markup;
			let jsonText, prettyText;
			const mime = type.split(';')[0].trim().toLowerCase();
			const media = /^(?:image|audio|video)\\//.test(mime);
			const pdf = mime === 'application/pdf';
			const html = mime === 'text/html' || mime === 'application/xhtml+xml' ||
				mime === 'text/xml' || mime === 'application/xml' || mime.endsWith('+xml');
			// Only HTML (or the worker's XML shell) is markup. A text file
			// may contain arbitrary HTML and must not run it on this origin.
			const quote = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			const head = '<!doctype html><html><head><meta charset="utf-8" /><meta name="color-scheme" content="light dark">';
			try {
				if (media || pdf) {
					// A media element can seek through the worker's binary route.
					// A POST must not be repeated as a GET, and Chrome sends an
					// embed's request past its worker, so show those answers from
					// the bytes the call already received. The document owns the
					// Blob URL and the browser releases it when the frame goes.
					const route = body.headers.get(${JSON.stringify(CALLED_RESOURCE_HEADER)});
					const routed = route && ours(route);
					let src;
					if (media && routed && ${at === null}) {
						src = routed.href;
						void body.body?.cancel().catch(() => {});
					} else {
						src = URL.createObjectURL(new Blob([await body.arrayBuffer()], { type: mime }));
					}
					const url = quote(src);
					if (mime.startsWith('image/')) {
						markup = head + '<style>html,body{height:100%;margin:0;background:#0e0e0e}body{display:grid;place-items:center}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img src="' + url + '"></body></html>';
					} else if (pdf) {
						markup = head + '<style>html,body{width:100%;height:100%;margin:0}body{display:flex;flex-direction:column}header{padding:8px;font:menu}embed{width:100%;flex:1}</style></head><body><header><a download="document.pdf" href="' + url + '">Download PDF</a></header><embed type="application/pdf" src="' + url + '"></body></html>';
					} else {
						const tag = mime.startsWith('video/') ? 'video' : 'audio';
						markup = head + '<style>html,body{height:100%;margin:0;background:#0e0e0e}body{display:grid;place-items:center}video,audio{max-width:100%;max-height:100%}</style></head><body><' + tag + ' controls autoplay src="' + url + '"></' + tag + '></body></html>';
					}
				} else {
					const decoded = decoder.decode(await body.arrayBuffer());
					if (mime === 'application/json' || mime.endsWith('+json')) {
						try {
							prettyText = JSON.stringify(JSON.parse(decoded), null, 2);
							jsonText = decoded;
						} catch (error) {
							// Invalid JSON is still displayed as text.
						}
					}
					markup = html ? decoded : head + '</head><body>' +
						(jsonText === undefined ? '' : '<label><input type="checkbox" id="pretty-json"> Pretty print</label>') +
						'<pre style="white-space:pre-wrap;word-wrap:break-word">\\n' + quote(decoded) + '</pre></body></html>';
				}
			} catch (error) {
				if (!abort.signal.aborted) fail();
				return;
			}
			if (abort.signal.aborted) return;
			// the policies the answer's headers set, which a written document
			// does not get from its headers: first in the shell, before any of
			// its scripts (a meta's policy applies from where it is)
			// and its referrer policy, before the page's own metas (a later one wins)
			const policies = (body.headers.get('content-security-policy') || '').split(',').map((policy) => policy.trim()).filter(Boolean);
			const referrer = (body.headers.get('referrer-policy') || '').split(',').map((policy) => policy.trim()).filter(Boolean).pop();
			const metas = policies.map((policy) => '<meta http-equiv="Content-Security-Policy" content="' + quote(policy) + '">').join('') + (referrer ? '<meta name="referrer" content="' + quote(referrer) + '">' : '');
			if (metas) markup = markup.replace(/<head>(<meta charset="utf-8" \\/>)?/i, (head) => head + metas);
			release();
			Object.defineProperty(window, ${JSON.stringify(CALLED_KEY)}, { value: { port, session: write.session, policy: referrer || ''${at === null ? '' : ', page: here'} }, configurable: true });
			Object.defineProperty(window, ${JSON.stringify(WORKER_BASE)}, { value: write.url, configurable: true });
			// the call's own fetch is none of the page's
			performance.clearResourceTimings();
			document.open();
			document.write(markup);
			if (jsonText !== undefined) {
				const checkbox = document.getElementById('pretty-json');
				const pre = document.querySelector('pre');
				checkbox?.addEventListener('change', () => {
					pre.textContent = checkbox.checked ? prettyText : jsonText;
				});
			}
			// closed a task later, unless the shell's client wrote the page
			// by then: its bundle can run inside the write (a script already
			// at hand), and then it writes the page only from a microtask
			// after this one, when a close here would have ended the shell's
			// parse and fired the frame's load event first (the host read
			// the tab as loaded while the page still came)
			const root = rootOf.call(document);
			later(() => {
				if (rootOf.call(document) === root) closing.call(document);
			});
		};
		// (the host knows at once that this is a call page, and that it heard)
		port.postMessage({ ready: true });
	};
	addEventListener('message', listen);
	// a frame below the tab's tells its host it is here: one the parser put
	// in a shadow root of the markup loads where the host hears no load (a
	// composed event, which leaves the root; its frame element is null where
	// the host is of another origin, which only a moved call is, its frame
	// known by then)
	if (${at === null} && /^\\?\\d+$/.test(location.search)) {
		let frame = null;
		try {
			frame = frameElement;
		} catch (error) {}
		if (frame) frame.dispatchEvent(new CustomEvent(${JSON.stringify(CALL_HERE)}, { bubbles: true, composed: true, detail: frame }));
	}
})()</script>`;

/** whether this worker runs in a dedicated worker of its page (offline.html, demo/offline/worker.mjs), not as a service worker */
export const emulatedWorker = () =>
	'WorkerGlobalScope' in globalThis &&
	!('ServiceWorkerGlobalScope' in globalThis);

/** the call page's path of each controller that opted in, with the origins that may call it */
function callPages(): Map<string, Set<string>> {
	const pages = new Map<string, Set<string>>();
	for (const { config } of dialing()) {
		const path = `${config.scope ?? config.directory}${assetName(config.assets, 'callPage')}`;
		const origins = pages.get(path) ?? new Set([self.location.origin]);
		for (const candidate of [
			...proxyOrigins(config),
			...(config.frameAncestors ?? []),
		])
			try {
				const url = new URL(candidate);
				if (url.protocol === 'http:' || url.protocol === 'https:')
					origins.add(url.origin);
			} catch (error) {
				// not an origin ('self', a scheme, a wildcard): it lets no parent call
			}
		pages.set(path, origins);
	}
	return pages;
}

/** whether `pathname` is a call page's of a controller that opted in */
export function isCallPagePath(pathname: string): boolean {
	return callPages().has(pathname);
}

/**
 * whether `url` is a call page's: the tab's frame's, or a called document's
 * frame's, numbered by its depth below it (`?1`: no frame may load a URL
 * two of its ancestors have)
 */
export function isCallPage(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		return false;
	}
	return (
		parsed.origin === self.location.origin &&
		isCallPagePath(parsed.pathname) &&
		(parsed.search === '' || /^\?\d+$/.test(parsed.search))
	);
}

/** the answer to a navigation to the call page at `pathname`, null when there is none */
export function callPageResponse(pathname: string): Response | null {
	const origins = callPages().get(pathname);
	if (!origins) return null;
	// offline.html (demo/offline/), whose worker runs in a dedicated worker
	// of its page: its host gives a frame the page as its srcdoc, whose
	// location is about:srcdoc, under no controller; and on file: the
	// frame's origin, and its parent's in a message, reads "null"
	const emulated = emulatedWorker();
	const file = self.location.protocol === 'file:';
	return new Response(
		callPageHTML(
			file ? [...origins, 'null'] : [...origins],
			emulated ? `${self.location.origin}${pathname}` : null,
		),
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				// a host page that is cross-origin isolated embeds it
				'cross-origin-embedder-policy': 'require-corp',
				'cross-origin-resource-policy': 'cross-origin',
				// served from a site's own origin (a slot of the site pool), its
				// own process: Chrome keys a process by site unless the first
				// document of the origin asks for its origin (on the host's own
				// origin it changes nothing)
				'origin-agent-cluster': '?1',
				// (no referrer policy of its own: the call's fetch carries the
				// route of the document the navigation leaves as its referrer,
				// which the worker reads, and the written document keeps the
				// policy container of the page, which its own policy changes)
			},
		},
	);
}

/** the longest a called document's load is held for a frame of it (callHold) */
const HOLD_MS = CALL_WAIT_MS + 15_000;
/** a hold's query: `?hold=` and the document's name for it */
const HOLD_SHAPE = /^\?hold=[0-9a-f-]{1,64}$/;

/**
 * An image a called document loads while a frame of it is called before
 * the document has loaded (src/inject/dom/calledFrames.ts hold), which keeps
 * its load waiting as the frame's document natively would: answered when the
 * document lets go of it (the request is aborted), or empty after HOLD_MS.
 * Whether it was one.
 */
function callHold(event: FetchEvent, pathname: string): boolean {
	const { request } = event;
	if (
		request.method !== 'GET' ||
		request.destination !== 'image' ||
		!HOLD_SHAPE.test(new URL(request.url).search) ||
		!isCallPagePath(pathname)
	)
		return false;
	event.respondWith(
		new Promise<Response>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve(
					new Response(null, {
						status: 204,
						headers: { 'cache-control': 'no-store' },
					}),
				);
			};
			const timer = setTimeout(done, HOLD_MS);
			request.signal?.addEventListener('abort', done, { once: true });
		}),
	);
	return true;
}

/** the call page, for a navigation to it (or a called document's hold); whether it was answered */
export function callPage(event: FetchEvent, pathname: string): boolean {
	if (event.request.mode !== 'navigate') return callHold(event, pathname);
	if (event.request.method !== 'GET') return false;
	const response = callPageResponse(pathname);
	if (!response) return false;
	event.respondWith(response);
	return true;
}

/**
 * Whether the client is a call page that called (or is calling): its
 * document is the one written into it, under the call page's embedder
 * policy (callPageResponse), whatever the host's isolation
 */
export function calledClient(clientId: string | undefined): boolean {
	return !!clientId && (done.has(clientId) || calling.has(clientId));
}

/** Whether this client is still receiving its call's navigation answer. */
export function callingClient(clientId: string | undefined): boolean {
	return !!clientId && calling.has(clientId);
}

/** whether the request is a call (it carries the header and is no navigation) */
export function isCall(request: Request): boolean {
	return request.mode !== 'navigate' && request.headers.has(CALL_HEADER);
}

/** whether a call of `url` is one this worker answers: a route of a controller that opted in */
export function callable(
	url: string,
	controllerFor: (pathname: string) => Dialer | undefined,
): boolean {
	return controllerFor(new URL(url).pathname)?.config.dialing === true;
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

/** the request as its navigation's: the headers are the worker's own, never sent on */
function calledRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	headers.delete(CALL_HEADER);
	headers.delete(CALL_TOKEN_HEADER);
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
 * call (it is answered 403). `realOrigin` reads the route's real origin and
 * `directoryOf` names the controller whose route a URL is.
 */
export async function calledEvent(
	event: FetchEvent,
	realOrigin: (url: string) => string | null,
	directoryOf: (url: string) => string | undefined,
): Promise<FetchEvent | null> {
	const { request, clientId } = event;
	const type = request.headers.get(CALL_HEADER) ?? '';
	const token = request.headers.get(CALL_TOKEN_HEADER) ?? '';
	if (
		!clientId ||
		!TOKEN_SHAPE.test(token) ||
		done.has(clientId) ||
		!CALL_TYPES.includes(type)
	)
		return null;
	const origin = realOrigin(request.url);
	if (!origin || origin === 'null') return null;
	const href = withoutHash(request.url);
	sweep(calling);
	const chain = calling.get(clientId);
	if (chain) {
		// the next call of a redirect: the same token, to where it went
		if (
			chain.awaiting ||
			chain.href !== href ||
			chain.token !== token ||
			chain.type !== type
		)
			return null;
		chain.awaiting = true;
	} else {
		const permit = tokens.get(token);
		if (
			!permit ||
			permit.href !== href ||
			permit.expires <= Date.now() ||
			permit.directory !== directoryOf(href) ||
			calling.size >= MAX_PENDING
		)
			return null;
		const client = await clients.get(clientId);
		if (
			client?.type !== 'window' ||
			(client as WindowClient).frameType !== 'nested' ||
			!isCallPage(client.url) ||
			// (taken while the client was looked up)
			tokens.get(token) !== permit ||
			calling.has(clientId) ||
			done.has(clientId)
		)
			return null;
		tokens.delete(token);
		calling.set(clientId, { ...permit, token, type, awaiting: true });
	}
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
 * The answer the handlers gave the call's event. A redirect within the
 * scope goes as it is (the page's fetch follows it, and calls again with
 * the same token); one to a route on another origin of the site pool (a
 * slot's, or the hub's: `isPoolOrigin`) ends the call and is told as moved
 * there (CALL_MOVED_HEADER: the page's fetch would follow it to an origin
 * whose worker does not control the call page); one anywhere else ends the
 * call, as does the last answer, which names the page's real URL.
 */
export async function answerOf(
	event: FetchEvent,
	realURL: (url: string) => string | null,
	isPoolOrigin: (origin: string) => boolean = () => false,
	resourceRoute: (routed: string, real: string) => string | null = () => null,
): Promise<Response> {
	const answer = (event as FetchEvent & { answered?: Promise<Response> | null })
		.answered;
	const chain = calling.get(event.clientId);
	const finish = () => {
		calling.delete(event.clientId);
		if (done.size >= DONE_KEPT) done.delete(done.values().next().value!);
		done.add(event.clientId);
	};
	let response: Response;
	try {
		if (!answer) throw new Error('No answer');
		response = await answer;
	} catch (error) {
		finish();
		return new Response(null, { status: 502 });
	}
	if (
		!chain ||
		chain !== calling.get(event.clientId) ||
		chain.expires <= Date.now()
	) {
		finish();
		void response.body?.cancel();
		return new Response(null, { status: 403 });
	}
	const redirect =
		REDIRECTS.includes(response.status) && response.headers.get('location');
	if (redirect) {
		try {
			const next = new URL(redirect, event.request.url);
			next.hash = '';
			if (next.origin === self.location.origin && realURL(next.href)) {
				chain.href = next.href;
				chain.awaiting = false;
				return response;
			}
			if (next.origin !== self.location.origin && isPoolOrigin(next.origin)) {
				finish();
				void response.body?.cancel();
				return new Response(null, {
					status: 204,
					headers: {
						[CALL_MOVED_HEADER]: next.href,
						'cache-control': 'no-store',
					},
				});
			}
		} catch (error) {
			// no URL: the call ends here
		}
		finish();
		void response.body?.cancel();
		return new Response(null, { status: 403 });
	}
	finish();
	const url = realURL(event.request.url);
	if (response.type !== 'default' || !url) return response;
	const headers = new Headers(response.headers);
	headers.set(CALLED_URL_HEADER, url);
	// Never take this header from a site. Only GETs can be loaded again
	// as a media element, and its URL must be a route of this controller.
	headers.delete(CALLED_RESOURCE_HEADER);
	if (
		event.request.method === 'GET' &&
		/^(?:image|audio|video)\//i.test(headers.get('content-type') ?? '')
	) {
		const routed = resourceRoute(event.request.url, url);
		if (routed) headers.set(CALLED_RESOURCE_HEADER, routed);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
