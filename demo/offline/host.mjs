// The offline-html build's page side (scripts/build-offline.mjs): STomp with
// no service worker. dist/serviceWorker.js runs unchanged in a dedicated
// worker (./worker.mjs makes its scope there), the controller speaks to it
// as to the worker it registers, and the page hands it what the browser
// would: the controller's messages, and as fetch events the requests of the
// host page and of the proxied documents. A proxied document is written into
// a frame of its own (a call page, below), where no worker controls it: the
// inject's copies of its loads (src/inject/dom/uncontrolledCopies.ts) fetch
// them through the frame's fetch, which goes to the worker. Its links and
// forms are followed here.
//
// The files of dist/ and the transports are in the page, compressed
// (./boot.mjs decodes them): a URL under the proxy's directory, on this
// page's origin or on ORIGIN, is answered from them. The worker's location
// is this page's origin's (file:// on file:), so the routes the controller,
// the worker and the documents make are the same strings everywhere.

const KEY = '__pmOffline';
/** the origin the transports' modules are named on (an import map maps each to its copy): no site resolves it */
export const ORIGIN = 'https://powermouse.invalid';
/**
 * this page's origin as its documents read it (`file://` on file:, where
 * Chrome reads `file://` and Firefox the opaque `null`, which no URL is
 * made on)
 */
const OWN =
	location.protocol === 'file:' && location.origin === 'null'
		? 'file://'
		: location.origin;
/**
 * Firefox reads a file: URL's origin as "null" where Chrome reads
 * `file://`, so a route the inject made on a file: URL's origin (a called
 * document's base URL's) named no route here. A call page's realm reads
 * `file://` there, as in Chrome: a proxied page reads no file: URL, and the
 * getter is a Proxy of the native one, whose source reads as native.
 */
export function fileOrigins(win) {
	const descriptor = Object.getOwnPropertyDescriptor(
		win.URL.prototype,
		'origin',
	);
	const native = descriptor?.get;
	if (
		OWN !== 'file://' ||
		!native ||
		Reflect.apply(native, new win.URL('file:///'), []) !== 'null'
	)
		return;
	const protocol = Object.getOwnPropertyDescriptor(
		win.URL.prototype,
		'protocol',
	).get;
	Object.defineProperty(win.URL.prototype, 'origin', {
		...descriptor,
		get: new Proxy(native, {
			apply(target, self, args) {
				const own = Reflect.apply(target, self, args);
				return own === 'null' && Reflect.apply(protocol, self, []) === 'file:'
					? OWN
					: own;
			},
		}),
	});
}
const HOST_CLIENT = 'pm-host';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeWorker = globalThis.Worker;
const anchorHref = Object.getOwnPropertyDescriptor(
	HTMLAnchorElement.prototype,
	'href',
).get;
const areaHref = Object.getOwnPropertyDescriptor(
	HTMLAreaElement.prototype,
	'href',
).get;
const formAction = Object.getOwnPropertyDescriptor(
	HTMLFormElement.prototype,
	'action',
).get;
const baseOf = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI').get;
const addListener = EventTarget.prototype.addEventListener;
const getAttribute = Element.prototype.getAttribute;

let scope = '/stomp/';
/** the worker script's query: its profile's (src/controller/profiles.ts profileWorker) */
let scriptQuery = '';
/** the decoded files, by path (`/stomp/core.wasm`): { blob, url } */
const files = new Map();
let emulated = null;
/** settles once the files are decoded */
let filled = Promise.resolve();
/** what this page answers in place of the demo's server, by path: a function making the Response */
let answers = new Map();

/** the path (and query) of a URL this page answers itself, or null */
function localPath(input, base = location.href) {
	let url;
	try {
		url = new URL(
			typeof input === 'string' || input instanceof URL
				? String(input)
				: input.url,
			base,
		);
	} catch {
		return null;
	}
	const own =
		url.origin === ORIGIN ||
		(url.protocol === location.protocol && url.host === location.host);
	return own ? `${url.pathname}${url.search}${url.hash}` : null;
}
const fileOf = (path) => files.get(path.split(/[?#]/)[0]) ?? null;
const underScope = (path) => path.startsWith(scope);
/** the URL of a path of this page's origin, as the worker has it */
const toWorker = (path) => `${OWN}${path}`;

function fileResponse(file, Response = globalThis.Response) {
	return new Response(file.blob, {
		status: 200,
		headers: { 'content-type': file.blob.type || 'application/octet-stream' },
	});
}

/** a request's fields, as the worker takes them (worker.mjs requestOf) */
async function requestFields(request, extra) {
	const method = request.method;
	const body =
		method === 'GET' || method === 'HEAD' ? null : await request.arrayBuffer();
	const referrer = request.referrer;
	return {
		url: toWorker(localPath(request.url)),
		method,
		headers: [...request.headers],
		body,
		mode: request.mode,
		credentials: request.credentials,
		cache: request.cache,
		redirect: request.redirect,
		integrity: request.integrity,
		keepalive: request.keepalive,
		referrer:
			referrer && referrer !== 'about:client'
				? (() => {
						const path = localPath(referrer);
						return path === null ? referrer : toWorker(path);
					})()
				: '',
		referrerPolicy: request.referrerPolicy,
		destination: '',
		...extra,
	};
}

/** a Response of `realm` made of the worker's answer */
function responseOf(answer, realm = globalThis) {
	if (answer.error || answer.status === 0)
		throw new realm.TypeError('Failed to fetch');
	const response = new realm.Response(
		NULL_BODY.has(answer.status) ? null : answer.body,
		{
			status: answer.status,
			statusText: answer.statusText,
			headers: answer.headers.map(([name, value]) => [name, value]),
		},
	);
	Object.defineProperties(response, {
		url: { value: answer.url, configurable: true },
		redirected: { value: !!answer.redirected, configurable: true },
	});
	return response;
}

/**
 * Fetch `request` (of `realm`) through the worker for the client
 * `clientId`, following redirects as the browser follows a worker's
 */
async function workerFetch(request, clientId, realm = globalThis, load = null) {
	let fields = await requestFields(request, { clientId, ...load });
	for (let hop = 0; hop < 20; hop++) {
		const answer = await emulated.request(fields);
		if (
			fields.redirect !== 'follow' ||
			!REDIRECTS.has(answer.status) ||
			answer.error
		)
			return responseOf(answer, realm);
		const location = answer.headers.find(
			([name]) => name.toLowerCase() === 'location',
		)?.[1];
		if (!location) return responseOf(answer, realm);
		answer.body?.cancel().catch(() => {});
		const next = new URL(location, fields.url).href;
		const toGet =
			answer.status === 303 ||
			((answer.status === 301 || answer.status === 302) &&
				fields.method === 'POST');
		if (localPath(next) === null) return realm.fetch(next);
		fields = {
			...fields,
			url: next,
			...(toGet ? { method: 'GET', body: null } : {}),
		};
	}
	throw new realm.TypeError('Failed to fetch');
}

/**
 * What a written document's fetch of a route is, when the route is an
 * element's load (an image's, a stylesheet's, a script's) rather than one
 * of the page's own fetches (an `xhr` route): the inject copies the loads
 * of a document no worker controls (src/inject/dom/uncontrolledCopies.ts),
 * and the worker is handed the request the browser would have made for the
 * element, as a controlled document's load reaches it. (A controlled
 * document's copies say which load they are on a load channel, which only a
 * document the worker served can open: src/inject/dom/loadGrants.ts.)
 */
function loadOf(path, request) {
	if (request.method !== 'GET' || request.mode !== 'cors') return null;
	const kind = path.slice(scope.length).split('/')[1] ?? '';
	const [type, variant = ''] = kind.split(/[;~]/)[0].split(':');
	if (type === 'binary') return { mode: 'no-cors', destination: 'image' };
	if (type === 'css') return { mode: 'no-cors', destination: 'style' };
	if (type === 'js' && variant === 'generic')
		return { mode: 'no-cors', destination: 'script' };
	if (type === 'js' && variant === 'genericModule')
		return { destination: 'script' };
	return null;
}

/** this page's fetch: its own files, else the worker for its routes, else the network */
function hostFetch(input, init) {
	const path = localPath(input instanceof Request ? input.url : input);
	if (path === null) return nativeFetch(input, init);
	const answer = answers.get(path.split(/[?#]/)[0]);
	if (answer) return Promise.resolve(answer());
	return filled.then(() => {
		const file = fileOf(path);
		if (file) return fileResponse(file);
		if (underScope(path) && emulated)
			return workerFetch(new Request(input, init), HOST_CLIENT);
		return nativeFetch(input, init);
	});
}

/** a Worker of one of this page's files starts from its decoded copy */
const PageWorker = new Proxy(NativeWorker, {
	construct(target, [url, options], newTarget) {
		const path = localPath(url);
		const file = path && fileOf(path);
		return Reflect.construct(
			target,
			[file ? file.url : url, options],
			newTarget,
		);
	},
});

/** the service worker, emulated: a dedicated worker running dist/serviceWorker.js */
class EmulatedWorker extends EventTarget {
	state = 'activated';
	onstatechange = null;
	onerror = null;
	#worker;
	#asked = 0;
	#answers = new Map();
	/** the written documents, by client id: where the worker's messages to them go */
	clients = new Map();
	constructor(scriptURL, prelude, script) {
		super();
		this.scriptURL = scriptURL;
		const source = URL.createObjectURL(
			new Blob([prelude, '\n', script], { type: 'text/javascript' }),
		);
		this.#worker = new NativeWorker(source, {
			name: JSON.stringify({ origin: OWN, scope, query: scriptQuery }),
		});
		this.#worker.addEventListener('message', (event) =>
			this.#heard(event.data?.[KEY]),
		);
		this.#worker.addEventListener('error', (event) =>
			console.error('STomp worker:', event.message),
		);
		this.client({ id: HOST_CLIENT, url: location.href }, window);
	}
	/** what the controller posts to its worker */
	postMessage(data, transfer = [], source = HOST_CLIENT) {
		const list = Array.isArray(transfer) ? transfer : transfer?.transfer || [];
		this.#worker.postMessage(
			{ [KEY]: { kind: 'message', source, data } },
			list,
		);
	}
	/** a document the worker's clients list has (or, `gone`, no longer has) */
	client(info, window) {
		if (window) this.clients.set(info.id, window);
		if (info.gone) this.clients.delete(info.id);
		this.#worker.postMessage({ [KEY]: { kind: 'client', ...info } });
	}
	/** a request, as a fetch event: resolves with the worker's answer */
	request(fields) {
		const id = ++this.#asked;
		const transfer =
			fields.body instanceof ArrayBuffer ? [fields.body] : undefined;
		return new Promise((resolve) => {
			this.#answers.set(id, resolve);
			this.#worker.postMessage(
				{ [KEY]: { kind: 'fetch', id, ...fields } },
				transfer,
			);
		});
	}
	#heard(message) {
		if (!message) return;
		switch (message.kind) {
			case 'response': {
				const resolve = this.#answers.get(message.id);
				this.#answers.delete(message.id);
				resolve?.(message);
				break;
			}
			case 'asset': {
				const file = fileOf(message.path);
				this.#worker.postMessage({
					[KEY]: {
						kind: 'asset',
						id: message.id,
						blob: file?.blob ?? null,
						type: file?.blob.type ?? '',
					},
				});
				break;
			}
			case 'client': {
				// the worker's message to a written document reaches its container,
				// as a controlled document's would
				const window = this.clients.get(message.id);
				try {
					window?.navigator.serviceWorker.dispatchEvent(
						new window.MessageEvent('message', { data: message.data }),
					);
				} catch {
					// a document being torn down
				}
				break;
			}
		}
	}
}

/**
 * Install the page's side: its fetch and Worker answer for the decoded
 * files, the transports' modules are mapped to them (an import map), and
 * the emulated worker starts. `decoded` maps each file's path to its Blob.
 */
export function install({
	decoded,
	prelude,
	scope: given = '/stomp/',
	profile = '',
	answers: local = new Map(),
}) {
	scope = given;
	scriptQuery = profile ? `?${new URLSearchParams({ profile })}` : '';
	answers = local;
	// at once: the demo asks its server before the files are decoded
	globalThis.fetch = hostFetch;
	globalThis.Worker = PageWorker;
	filled = Promise.resolve(decoded).then((all) => {
		for (const [path, blob] of all)
			files.set(path, { blob, url: URL.createObjectURL(blob) });
	});
	return filled.then(() => {
		// a module's import of another resolves on ORIGIN (the transports find
		// their wasm and stomp-h3 next to themselves): each is mapped to its copy
		const imports = {};
		for (const [path, file] of files)
			if (/\.m?js$/.test(path) && !underScope(path))
				imports[`${ORIGIN}${path}`] = file.url;
		const map = document.createElement('script');
		map.type = 'importmap';
		map.textContent = JSON.stringify({ imports });
		document.head.append(map);
		const script = files.get(`${scope}serviceWorker.js`);
		if (!script) throw new Error('offline.html has no serviceWorker.js');
		const scriptURL = new URL(
			`${scope}serviceWorker.js${scriptQuery}`,
			location.href,
		).href;
		return script.blob.text().then((text) => {
			emulated = new EmulatedWorker(scriptURL, prelude, text);
			return emulated;
		});
	});
}

// ---- the Tor client ---------------------------------------------------------
//
// Tor mode's client (demo/public/tor-client/, ./tor-worker.mjs) runs in one
// dedicated worker of this page, started at the first transport that asks:
// arti's wasm, compiled here, goes in its first message, and each transport
// gets a port to it, as the served demo's get one to their SharedWorker.

let torWorker = null;

/** the options this page's Tor transport is given beside the demo's: a port to the worker, and the wasm for a client of the page's own */
export function torOptions() {
	const script = files.get('/tor-client/worker.js');
	const wasm = files.get('/tor-client/tor_js_bg.wasm');
	if (!script || !wasm) throw new Error('offline.html has no Tor client');
	if (!torWorker) {
		const worker = new NativeWorker(script.url, { name: 'tor' });
		worker.addEventListener('error', (event) =>
			console.error('offline.html: the Tor worker failed', event.message),
		);
		const compiled = WebAssembly.compileStreaming(fileResponse(wasm)).then(
			(module) => worker.postMessage({ type: 'wasm', module }),
		);
		torWorker = { worker, compiled };
	}
	const { port1, port2 } = new MessageChannel();
	torWorker.compiled.then(
		() => torWorker.worker.postMessage({ type: 'connect' }, [port2]),
		// (the transport's port never answers: it runs a client of its own)
		(error) => console.error("offline.html: arti's wasm", error),
	);
	return { sharedWorker: port1, wasm: wasm.url };
}

// ---- called frames ---------------------------------------------------------
//
// Each document of a tab gets a frame of its own, made fresh in the tab's
// container, that loads one fixed page (CALL_PAGE), the same for every site.
// The page takes a port from the host, which names the route over it; the
// page fetches the route with CALL_HEADER, its fetch is this page's (the
// worker answers it as the frame's navigation to the route: the same request
// upstream, rewrite and shell) and, once told, the page writes the answer
// into itself from its own realm, so the document's URL stays about:srcdoc.
// The message protocol and the header are the ones of just call stomp's call
// page (src/server/called.ts on the call-mode branch), which a service
// worker serves under its scope: here no worker can, so the page is a srcdoc.

/** the key of the host's one message to a call page, which carries the port the rest goes over */
const CALL_MESSAGE = '$stomp$call';
/** the header of a call page's fetch of its document: how it was reached (navigate, reload, back_forward) */
const CALL_HEADER = 'x-stomp-call';
/** what a written document's inject takes as its page's URL (src/transport/messages.ts WORKER_BASE) */
const WORKER_BASE = '$stomp$workerBase';
const CALL_TYPES = {
	push: 'navigate',
	replace: 'navigate',
	reload: 'reload',
	traverse: 'back_forward',
};

/**
 * The call page. Its script takes one message, from the host's window,
 * with the port everything else goes over: the call (the route, and the
 * request's method, body and headers), then, once the host has shown the
 * frame, the word to write. document.open() removes its listener; nothing
 * of it stays.
 */
const CALL_PAGE = `<!doctype html><meta charset="utf-8"><script>(() => {
	const key = ${JSON.stringify(CALL_MESSAGE)};
	const listen = (event) => {
		const port = event.ports && event.ports[0];
		if ((event.source !== parent && event.source !== parent.parent) || !event.data || !event.data[key] || !port) return;
		removeEventListener('message', listen);
		let response = null;
		port.onmessage = async ({ data: ask }) => {
			if (ask.call) {
				try {
					response = await fetch(ask.call.routed, ask.call.init);
					port.postMessage({ answered: { url: response.url, status: response.status } });
				} catch (error) {
					port.postMessage({ failed: String((error && error.message) || error) });
				}
				return;
			}
			if (!ask.write || !response) return;
			port.onmessage = null;
			const markup = await response.text();
			// the page's URL, which the document's inject reads first (its own is about:srcdoc)
			if (typeof ask.write.url === 'string') Object.defineProperty(window, ${JSON.stringify(WORKER_BASE)}, { value: ask.write.url, configurable: true });
			document.open();
			document.write(markup);
			document.close();
		};
	};
	addEventListener('message', listen);
})()</script>`;

/** the container each tab's call pages are made in */
// (each document's frame takes the color-scheme the tab's element gives this
// container, as the demo's own frames take theirs: a page reads the pages'
// mode, Settings > Page appearance, for prefers-color-scheme)
const CONTAINER = `<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}@media (prefers-color-scheme:light){iframe{color-scheme:light}}@media (prefers-color-scheme:dark){iframe{color-scheme:dark}}</style></head><body></body></html>`;

let documents = 0;
const nextClient = () => `pm-doc-${++documents}-${Date.now().toString(36)}`;

/**
 * The scripts a shell names by their URL under the scope, which nothing
 * serves on this page's origin, are given as their copies (a blob: URL
 * ending in '#', so a query after it stays in the fragment)
 */
function withCopies(markup) {
	return markup.replace(
		new RegExp(
			`(?:${OWN.replace(/[.]/g, '\\.')})?${scope}([\\w.-]+\\.js)(?:\\?[^"'\\s<>]*)?`,
			'g',
		),
		(whole, name) => {
			const file = files.get(`${scope}${name}`);
			return file ? `${file.url}#` : whole;
		},
	);
}

/** the markup a frame is given for the worker's answer to a navigation */
async function markupOf(answer) {
	if (answer.error || !answer.status)
		return `<!doctype html><title>Error</title><p>This page could not be loaded: ${String(answer.error || 'no answer').replace(/</g, '&lt;')}</p>`;
	const type =
		answer.headers.find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? '';
	const body = answer.body ? new Response(answer.body) : null;
	if (!body || /^\s*(text\/html|application\/xhtml\+xml)/i.test(type))
		return body ? withCopies(await body.text()) : '';
	// anything else (an image, a PDF, text) is shown by the browser itself,
	// from a copy
	const blob = await body.blob();
	const copy = URL.createObjectURL(
		new Blob([blob], { type: type || 'application/octet-stream' }),
	);
	return `<!doctype html><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="${copy}"></iframe>`;
}

/**
 * A route the inject made on the origin its frame's location reads, which
 * is "null" in a file: page's frames, as `null/stomp/...` (a page's fetch
 * and XMLHttpRequest: src/inject/dom/Client.ts #readDocumentURL takes the
 * location's origin, where proxyOrigin in src/inject/modules/Unroute.ts
 * takes the base URL's), as this page's own route
 */
function ownRoute(input) {
	if (typeof input === 'string' && input.startsWith(`null${scope}`))
		return `${OWN}${input.slice('null'.length)}`;
	return input;
}

/**
 * The route a document's navigation goes to, as this page has it, or null:
 * one of this page's routes, or one made on the origin a file: page's
 * frames read (ownRoute), which the browser resolved against the base URL
 */
function routeOf(url) {
	const path = localPath(url);
	if (path !== null && underScope(path)) return url;
	const at = url.indexOf(`/null${scope}`);
	return at === -1 ? null : `${OWN}${url.slice(at + '/null'.length)}`;
}

/**
 * The scripts a document writes, which run in place as they load (the
 * parser waits for each). The inject names such a script by a URL the
 * demo's server holds until the copy is posted to it (the sync relay's
 * held loads, src/inject/dom/uncontrolledCopies.ts syncCopyOf), and no
 * server or worker answers it here. So the written markup names it by its
 * token alone (a script with no src, which the parser passes), and each
 * gets its copy's URL when it is posted, in the order the document has
 * them (in order, as the parser would run them, though after the markup
 * that follows them).
 */
function heldScripts(win) {
	const path = `${scope}sync-relay/held/`;
	const ATTRIBUTE = 'data-pm-held';
	const prototype = win.HTMLScriptElement.prototype;
	const setSrc = Object.getOwnPropertyDescriptor(prototype, 'src').set;
	const setAsync = Object.getOwnPropertyDescriptor(prototype, 'async').set;
	const all = win.Document.prototype.querySelectorAll;
	const read = win.Element.prototype.getAttribute;
	const remove = win.Element.prototype.removeAttribute;
	const copies = new Map();
	const failed = () => {
		const url = URL.createObjectURL(new Blob());
		URL.revokeObjectURL(url);
		return url;
	};
	const release = () => {
		for (const script of Reflect.apply(all, win.document, [
			`script[${ATTRIBUTE}]`,
		])) {
			const token = Reflect.apply(read, script, [ATTRIBUTE]);
			if (!copies.has(token)) return;
			const url = copies.get(token);
			copies.delete(token);
			Reflect.apply(remove, script, [ATTRIBUTE]);
			Reflect.apply(setAsync, script, [false]);
			Reflect.apply(setSrc, script, [url || failed()]);
		}
	};
	const named = new RegExp(
		`(<script\\b[^>]*?)\\ssrc=(["']?)(?:${OWN.replace(/[.]/g, '\\.')})?${path}(\\w+)\\2`,
		'gi',
	);
	for (const name of ['write', 'writeln']) {
		const write = win.Document.prototype[name];
		win.Document.prototype[name] = {
			[name](...markup) {
				const result = Reflect.apply(
					write,
					this,
					markup.map((text) =>
						String(text).replace(
							named,
							(whole, head, quote, token) => `${head} ${ATTRIBUTE}="${token}"`,
						),
					),
				);
				release();
				return result;
			},
		}[name];
	}
	return {
		path,
		/** the copy of a held script, posted (an empty post: it did not load) */
		async copied(request, at) {
			const token = at.slice(path.length).split(/[?#]/)[0];
			const body = await request.arrayBuffer();
			const type = request.headers.get('content-type');
			copies.set(
				token,
				type ? URL.createObjectURL(new Blob([body], { type })) : null,
			);
			release();
			return new win.Response(null, { status: 204 });
		},
	};
}

/**
 * The fetch of a frame's window `win`, the document `client`: its routes go
 * to the worker (a load the inject copies as the load it is), the files of
 * dist/ are their copies, and anything else is the window's own. `called`
 * answers a call page's fetch of its document (null: not one).
 */
function frameFetch(win, client, called) {
	const held = heldScripts(win);
	const own = win.fetch;
	return (input, init) => {
		let request;
		try {
			request = new win.Request(ownRoute(input), init);
		} catch (error) {
			return win.Promise.reject(error);
		}
		const path = localPath(request.url);
		if (path === null || !underScope(path))
			return Reflect.apply(own, win, [input, init]);
		const call = called(request, init);
		if (call) return call;
		if (path.startsWith(held.path)) return held.copied(request, path);
		const file = fileOf(path);
		if (file) return Promise.resolve(fileResponse(file, win.Response));
		return workerFetch(request, client, win, loadOf(path, request));
	};
}

/**
 * A tab's frame whose documents are written into call pages (the demo's
 * Frame, for what the demo calls): `go`, `back`, `forward`, `reload`,
 * `url`, `title`, `canGoBack`, `canGoForward`, `lastNavigate`
 */
export class WrittenFrame extends EventTarget {
	lastNavigate = null;
	url = null;
	#entries = [];
	#at = -1;
	#inner = null;
	#container;
	#loading = 0;
	/** the calls under way, by the client they make: their referrer and where they ended */
	#calls = new Map();
	constructor(controller, element, callbacks = {}) {
		super();
		this.controller = controller;
		this.element = element;
		this.callbacks = callbacks;
		this.#container = new Promise((resolve) => {
			element.addEventListener('load', () => resolve(), { once: true });
			element.srcdoc = CONTAINER;
		}).then(() => {
			const window = element.contentWindow;
			// the tab's focus is its document's
			addListener.call(window, 'focus', () =>
				this.#inner?.contentWindow?.focus(),
			);
			return window;
		});
	}
	get title() {
		try {
			return this.#inner?.contentDocument?.title || this.lastNavigate?.title;
		} catch {
			return this.lastNavigate?.title ?? null;
		}
	}
	get canGoBack() {
		return this.#at > 0;
	}
	get canGoForward() {
		return this.#at < this.#entries.length - 1;
	}
	focus() {
		this.element.focus();
	}
	async go(url) {
		const routed = await this.controller.route(url);
		await this.#navigate({ url: routed, method: 'GET' }, 'push');
	}
	async back() {
		if (!this.canGoBack) return false;
		await this.#navigate(this.#entries[this.#at - 1], 'traverse', -1);
		return true;
	}
	async forward() {
		if (!this.canGoForward) return false;
		await this.#navigate(this.#entries[this.#at + 1], 'traverse', 1);
		return true;
	}
	async reload() {
		const entry = this.#entries[this.#at];
		if (!entry) return false;
		await this.#navigate(entry, 'reload');
		return true;
	}
	/**
	 * Show the document `entry` names in a fresh call page. The old document
	 * stays until the answer is in, as a navigation's does; the entries
	 * change then.
	 */
	async #navigate(entry, kind, delta = 0) {
		const container = await this.#container;
		const loading = ++this.#loading;
		const client = nextClient();
		const document = container.document;
		const inner = document.createElement('iframe');
		inner.setAttribute('allow', getAttribute.call(this.element, 'allow') || '');
		inner.style.display = 'none';
		inner.dataset.client = client;
		const blank = new Promise((resolve) =>
			inner.addEventListener('load', resolve, { once: true }),
		);
		inner.srcdoc = CALL_PAGE;
		document.body.append(inner);
		await blank;
		const win = inner.contentWindow;
		const here = this.#entries[this.#at];
		const call = {
			referrer:
				kind === 'push' && here && entry.referred
					? toWorker(localPath(here.url))
					: '',
			done: null,
		};
		this.#calls.set(client, call);
		this.#prime(win, client);
		emulated.client(
			{
				id: client,
				url: toWorker(localPath(entry.url)),
				type: 'window',
				frameType: 'nested',
			},
			win,
		);
		const { port1, port2 } = new MessageChannel();
		const answered = new Promise((resolve) => {
			port1.onmessage = ({ data }) => resolve(data);
		});
		win.postMessage({ [CALL_MESSAGE]: true }, '*', [port2]);
		port1.postMessage({
			call: {
				routed: entry.url,
				init: {
					method: entry.method,
					body: entry.body ? entry.body.slice(0) : null,
					headers: [...(entry.headers ?? []), [CALL_HEADER, CALL_TYPES[kind]]],
				},
			},
		});
		await answered;
		this.#calls.delete(client);
		if (loading !== this.#loading) {
			inner.remove();
			emulated.client({ id: client, gone: true });
			return;
		}
		const done = call.done ?? entry;
		if (kind === 'push' || (kind === 'replace' && this.#at < 0)) {
			this.#entries.length = this.#at + 1;
			this.#entries.push(done);
			this.#at++;
		} else if (kind === 'traverse') {
			this.#at += delta;
			this.#entries[this.#at] = done;
		} else this.#entries[this.#at] = done;
		// the answer is in: the old document goes, the new one shows and is
		// written
		const before = this.#inner;
		this.#inner = inner;
		if (before) {
			before.remove();
			emulated.client({ id: before.dataset.client, gone: true });
		}
		inner.style.removeProperty('display');
		if (!inner.getAttribute('style')) inner.removeAttribute('style');
		const written = new Promise((resolve) =>
			inner.addEventListener('load', resolve, { once: true }),
		);
		const shown =
			(await this.controller.unroute(done.url).catch(() => null)) || done.url;
		port1.postMessage({ write: { url: shown } });
		// the report the demo waits for comes at once (the page's own reports
		// go to a controller that knows no written frame)
		this.#reported(done.url);
		await written;
		if (this.#inner !== inner) return;
		this.#reported(done.url);
		// the demo's tab listens to its element's load
		this.element.dispatchEvent(new Event('load'));
	}
	/**
	 * A call page's fetch of its document: the frame's navigation to the
	 * route, asked of the worker, its redirects followed as the browser
	 * follows a navigation's. Answered with the markup to write.
	 */
	async #called(request, client, win) {
		const call = this.#calls.get(client);
		const type = request.headers.get(CALL_HEADER);
		const fields = await requestFields(request);
		let { url, method, body } = fields;
		let headers = fields.headers.filter(
			([name]) => name.toLowerCase() !== CALL_HEADER,
		);
		let answer;
		for (let hop = 0; hop < 20; hop++) {
			answer = await emulated.request({
				...fields,
				url,
				method,
				headers,
				body: body ? body.slice(0) : null,
				mode: 'navigate',
				destination: 'iframe',
				credentials: 'include',
				redirect: 'manual',
				referrer: call?.referrer ?? '',
				clientId: HOST_CLIENT,
				resultingClientId: client,
				isReload: type === 'reload',
			});
			const location = answer.headers?.find(
				([name]) => name.toLowerCase() === 'location',
			)?.[1];
			if (!REDIRECTS.has(answer.status) || !location) break;
			answer.body?.cancel().catch(() => {});
			const next = new URL(location, url).href;
			if (!next.startsWith(`${OWN}${scope}`)) {
				// a redirect off the proxy (none should be): shown as the error
				answer = { status: 0, error: `redirect to ${next}` };
				break;
			}
			if (
				answer.status === 303 ||
				((answer.status === 301 || answer.status === 302) && method === 'POST')
			) {
				method = 'GET';
				body = null;
				headers = headers.filter(
					([name]) => !/^content-(type|length)$/i.test(name),
				);
			}
			url = next;
		}
		if (call)
			call.done = {
				url,
				method,
				body,
				headers: headers.filter(([name]) => /^content-type$/i.test(name)),
			};
		return new win.Response(await markupOf(answer), {
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
	}
	async #reported(url) {
		let real = null;
		try {
			real = await this.controller.unroute(url);
		} catch {
			// not a route
		}
		this.url = real || url;
		const info = {
			url: this.url,
			title: this.title || '',
			canGoBack: this.canGoBack,
			canGoForward: this.canGoForward,
		};
		this.lastNavigate = info;
		this.callbacks.onNavigate?.(info, this);
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
	}
	/**
	 * A call page's window: its fetch goes to the worker, and its links and
	 * forms (the browser would send them to a URL nothing serves) are
	 * followed here. Its window's listeners go with every document.open(),
	 * so they are added again after one.
	 */
	#prime(win, client) {
		win.fetch = frameFetch(win, client, (request) =>
			request.headers.has(CALL_HEADER)
				? this.#called(request, client, win)
				: null,
		);
		// (one function each: adding one again while it is on adds nothing)
		const clicked = (event) => this.#clicked(win, event);
		const submitted = (event) => this.#submitted(win, event);
		const listen = () => {
			addListener.call(win, 'click', clicked);
			addListener.call(win, 'submit', submitted);
		};
		listen();
		// every other navigation the page starts (a location write, a
		// refresh, a form's submit()) goes to a route nothing serves here:
		// it is cancelled, and the host follows it
		const navigation = win.navigation;
		if (navigation)
			addListener.call(navigation, 'navigate', (event) =>
				this.#navigated(event),
			);
		// (document.open() keeps the Document and its observers)
		new win.MutationObserver(() => {
			if (!win.document.documentElement) return;
			listen();
		}).observe(win.document, { childList: true });
	}
	#clicked(win, event) {
		if (event.defaultPrevented || event.button !== 0) return;
		const link = event
			.composedPath()
			.find((node) => node.localName === 'a' || node.localName === 'area');
		if (!link || getAttribute.call(link, 'download') !== null) return;
		let href;
		try {
			href = (link.localName === 'a' ? anchorHref : areaHref).call(link);
		} catch {
			return;
		}
		const path = href && localPath(href);
		if (path === null || !path) return;
		event.preventDefault();
		const target = getAttribute.call(link, 'target') || '';
		const away =
			event.ctrlKey || event.metaKey || event.shiftKey || target === '_blank';
		this.#follow(win, href, path, away);
	}
	async #follow(win, href, path, away) {
		const url = new URL(href);
		// a fragment of this document: a same-document navigation of its own
		const here = this.#entries[this.#at];
		if (here && url.hash) {
			const now = new URL(here.url);
			if (`${now.pathname}${now.search}` === `${url.pathname}${url.search}`) {
				win.location.hash = url.hash;
				return;
			}
		}
		if (!underScope(path)) {
			if (url.hash) win.location.hash = url.hash;
			return;
		}
		if (away) {
			const real = await this.controller.unroute(href).catch(() => null);
			if (this.callbacks.onOpen) this.callbacks.onOpen(real || href, this);
			return;
		}
		this.#navigate(
			{ url: new URL(path, location.href).href, method: 'GET', referred: true },
			'push',
		);
	}
	/** a navigation of the document's own, to a route: followed here */
	#navigated(event) {
		if (!event.cancelable || event.hashChange || event.downloadRequest) return;
		const route = routeOf(event.destination.url);
		if (!route) return;
		event.preventDefault();
		if (event.navigationType === 'reload') {
			this.reload();
			return;
		}
		// (the frame has one entry of its own: the tab's are the host's)
		if (event.navigationType === 'traverse') return;
		const kind = event.navigationType === 'replace' ? 'replace' : 'push';
		const data = event.formData;
		if (!data) {
			this.#navigate({ url: route, method: 'GET', referred: true }, kind);
			return;
		}
		const form = event.sourceElement;
		const multipart =
			form?.localName === 'form' &&
			getAttribute.call(form, 'enctype')?.toLowerCase() ===
				'multipart/form-data';
		const encoded = multipart
			? new Response(data)
			: new Response(new URLSearchParams(data), {
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
				});
		encoded.arrayBuffer().then((body) =>
			this.#navigate(
				{
					url: route,
					method: 'POST',
					body,
					headers: [['content-type', encoded.headers.get('content-type')]],
					referred: true,
				},
				kind,
			),
		);
	}
	#submitted(win, event) {
		if (event.defaultPrevented) return;
		const form = event.target;
		const submitter = event.submitter ?? null;
		const given =
			submitter && getAttribute.call(submitter, 'formaction') !== null
				? getAttribute.call(submitter, 'formaction')
				: null;
		let action = given
			? new URL(given, baseOf.call(form)).href
			: formAction.call(form);
		// a form with no action is sent to its document's address
		if (!/^https?:|^file:/.test(action) && this.#entries[this.#at])
			action = this.#entries[this.#at].url;
		const path = localPath(action);
		if (path === null || !underScope(path)) return;
		event.preventDefault();
		const method = (
			(submitter && getAttribute.call(submitter, 'formmethod')) ||
			getAttribute.call(form, 'method') ||
			'get'
		).toLowerCase();
		if (method === 'dialog') return;
		const data = new win.FormData(form, submitter);
		const target = new URL(path, location.href);
		if (method === 'post') {
			const enctype = (
				(submitter && getAttribute.call(submitter, 'formenctype')) ||
				getAttribute.call(form, 'enctype') ||
				''
			).toLowerCase();
			const encoded =
				enctype === 'multipart/form-data'
					? new Response(data)
					: new Response(new URLSearchParams(data), {
							headers: {
								'content-type': 'application/x-www-form-urlencoded',
							},
						});
			encoded.arrayBuffer().then((body) =>
				this.#navigate(
					{
						url: target.href,
						method: 'POST',
						body,
						headers: [['content-type', encoded.headers.get('content-type')]],
						referred: true,
					},
					'push',
				),
			);
			return;
		}
		target.search = `?${new URLSearchParams(data)}`;
		this.#navigate({ url: target.href, method: 'GET', referred: true }, 'push');
	}
}

// ---- dialing ---------------------------------------------------------------
//
// Where this page's origin is one a URL can name (Chrome reads a file:
// page's as `file://`), the demo dials as it does online
// (src/controller/justCallStomp.ts): each document of a tab is written into
// a fresh frame of the call page the worker serves, and the document's
// inject keeps its session history, its Navigation API and its frames'
// calls (src/inject/dom/calledHooks.ts). Nothing serves the call page's URL
// here, so a frame sent to it (by the controller's src, a called document's
// src for a frame of its own, or that frame's location.replace for its next
// document) is given the page as its srcdoc, whose first script primes its
// window: its fetch goes to the worker, its document gets a port to the
// worker (OFFLINE_WORKER) in place of a controller (no worker controls it,
// so the inject copies its loads).
// Firefox, which reads this page's origin (and a file: URL's) as "null",
// dials too: the controller makes its routes and call pages on `file://`
// there (src/controller/justCallStomp.ts ownOrigin), a call page's realm
// reads a file: URL's origin as Chrome does (fileOrigins), and the call page
// takes the parent Firefox lists as `file://UNIVERSAL_FILE_URI_ORIGIN`
// (src/server/called.ts). A browser with no Navigation API keeps the
// written frames above.

/** global the inject takes its port to the worker from (src/transport/messages.ts OFFLINE_WORKER) */
const OFFLINE_WORKER = '$stomp$offlineWorker';
/** global the inject takes the srcdoc of its frames' call page from (src/transport/messages.ts OFFLINE_CALL_PAGE) */
const OFFLINE_CALL_PAGE = '$stomp$offlineCallPage';
/** the header of a call page's fetch that carries its token (src/transport/messages.ts CALL_TOKEN_HEADER) */
const CALL_TOKEN_HEADER = 'x-stomp-call-token';
/** whether the demo dials here */
export const dialing =
	'navigation' in globalThis && 'NavigateEvent' in globalThis;
/** the call page's path, once a controller dialed */
let callPath = null;
/** the call page as the worker serves it, its first script this page's prime */
let callMarkup = null;
let callAsked = null;
/** the call page each frame sent to one was given (its `?<depth>`) */
const callPages = new WeakMap();
/** the frames sent to the call page before they were in a document */
const unshown = new WeakSet();
let calls = 0;
/** the numbers of the srcdocs handed to a called document for its frames (callSrcdoc) */
const handed = new Set();
const setAttribute = Element.prototype.setAttribute;

/** the call page's markup, asked of the worker once */
function callPageReady() {
	callAsked ??= (async () => {
		const answer = await emulated.request({
			url: toWorker(callPath),
			method: 'GET',
			headers: [['accept', 'text/html']],
			body: null,
			mode: 'navigate',
			destination: 'iframe',
			credentials: 'include',
			cache: 'no-store',
			redirect: 'manual',
			referrer: '',
			clientId: HOST_CLIENT,
			resultingClientId: `pm-call-${Date.now().toString(36)}`,
		});
		if (answer.status !== 200 || !answer.body)
			throw new Error(
				`offline.html: the worker serves no call page (${answer.error || answer.status})`,
			);
		const markup = await new Response(answer.body).text();
		// (the first script of the page: before its own takes its fetch)
		// (up the windows by this realm's own getter: a called document's
		// parent reads as itself to its page, Framing)
		const key = JSON.stringify(KEY);
		const prime = `<script>(() => { try { const up = Object.getOwnPropertyDescriptor(window, 'parent').get; let at = window; let own; do { const next = up.call(at); if (next === at) break; at = next; own = Object.getOwnPropertyDescriptor(at, ${key}); } while (!own); own.value(window); } catch (error) { console.error('offline.html: a call page found no host', error); } })()</script>`;
		callMarkup = markup.replace('<script>', `${prime}<script>`);
	})();
	callAsked.catch(() => {
		callAsked = null;
	});
	return callAsked;
}

/** the call page `value` names (resolved against `base`), as the worker has it, or null */
function callPageOf(value, base) {
	if (!callPath) return null;
	let url;
	try {
		url = new URL(ownRoute(String(value)), base);
	} catch {
		return null;
	}
	const route = routeOf(url.href);
	if (!route) return null;
	const { pathname, search } = new URL(route);
	if (pathname !== callPath || !(search === '' || /^\?\d+$/.test(search)))
		return null;
	return toWorker(`${pathname}${search}`);
}

/** the srcdoc of the call page `page` (as the worker has it): a new one each time */
function callSrcdoc(page) {
	// (the page's own URL, which its frame does not read, with its depth)
	const markup = callMarkup.replace(
		`const here = ${JSON.stringify(toWorker(callPath))};`,
		() => `const here = ${JSON.stringify(page)};`,
	);
	return `${markup}<!--${++calls}-->`;
}

/** `element` to the call page `page`: the page as its srcdoc (a new one each time, which navigates it) */
function showCall(element, page, now = false) {
	if (!callMarkup) return false;
	callPages.set(element, page);
	// a frame not in a document yet gets it once it is in one (dialable):
	// the inject routes the attributes of a frame it sees inserted, and
	// would take the srcdoc for one of the page's
	if (!now && !element.isConnected) {
		unshown.add(element);
		return true;
	}
	unshown.delete(element);
	Reflect.apply(setAttribute, element, ['srcdoc', callSrcdoc(page)]);
	return true;
}

/**
 * A frame of `win` sent to the call page goes to it as a srcdoc: by its src
 * setter and, once `watch` is called, by the src attribute (the parser's
 * frame, the inject's own write of it); a frame that showed a document is
 * sent by a navigation of its window to it (primeCall)
 */
function dialable(win, own = false) {
	const prototype = win.HTMLIFrameElement.prototype;
	const src = Object.getOwnPropertyDescriptor(prototype, 'src');
	Object.defineProperty(prototype, 'src', {
		get: src.get,
		set(value) {
			const page = callPageOf(value, baseOf.call(this));
			if (!page || !showCall(this, page, own))
				Reflect.apply(src.set, this, [value]);
		},
		configurable: true,
		enumerable: src.enumerable,
	});
	const sent = (element, again) => {
		if (unshown.has(element)) {
			showCall(element, callPages.get(element));
			return;
		}
		if (!again && callPages.has(element)) return;
		const value = Reflect.apply(getAttribute, element, ['src']);
		if (value === null) return;
		const page = callPageOf(value, baseOf.call(element));
		if (!page) return;
		// (a frame its document gave the call page's srcdoc itself, the
		// parser's among them, is on its way to it already)
		const srcdoc = Reflect.apply(getAttribute, element, ['srcdoc']);
		const given = srcdoc && /<!--(\d+)-->$/.exec(srcdoc)?.[1];
		if (given && handed.has(given)) {
			callPages.set(element, page);
			return;
		}
		showCall(element, page);
	};
	const frames = (node) =>
		node.localName === 'iframe' || node.localName === 'frame'
			? [node]
			: typeof node.querySelectorAll === 'function'
				? [...node.querySelectorAll('iframe, frame')]
				: [];
	/**
	 * the frames the document has and gets. Only once it has loaded: an
	 * observer of the document from before its write left the scripts the
	 * page inserts unrewritten (Chrome 158)
	 */
	return function watch() {
		for (const element of frames(win.document)) sent(element, false);
		new win.MutationObserver((records) => {
			for (const record of records)
				if (record.type === 'attributes') sent(record.target, true);
				else
					for (const node of record.addedNodes)
						for (const element of frames(node)) sent(element, false);
		}).observe(win.document, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['src'],
		});
	};
}

/** a call page's fetch of its document: the worker's answer, the shell's scripts named by their copies */
async function calledFetch(request, init, client, win) {
	const referrer = init?.referrer
		? (() => {
				const path = localPath(ownRoute(init.referrer));
				return path === null ? init.referrer : toWorker(path);
			})()
		: '';
	const response = await workerFetch(request, client, win, { referrer });
	const type = response.headers.get('content-type') ?? '';
	if (!response.body || !/^\s*(text\/html|application\/xhtml\+xml)/i.test(type))
		return response;
	const markup = withCopies(await response.text());
	const headers = new win.Headers(response.headers);
	headers.set('content-type', `${type.split(';')[0].trim()}; charset=utf-8`);
	const copy = new win.Response(markup, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
	Object.defineProperties(copy, {
		url: { value: response.url, configurable: true },
		redirected: { value: response.redirected, configurable: true },
	});
	return copy;
}

// A worker the page starts in a called document (dialing): no worker
// controls it either, and on file: it can load nothing of the scope's. It
// starts from a prelude of this page's, which is told the copies of the
// scripts its bootstrap imports (the inject's bundle, the page's script as
// the worker rewrote it) and a port its routed fetches go over, then
// imports the bootstrap; the messages the page posts it meanwhile are
// posted once it says it is ready, so its own listeners hear them.

/** the key of the prelude's messages */
const WORKER_KEY = '__pmOfflineWorker';
const WORKER_PRELUDE = `(() => {
	const key = ${JSON.stringify(WORKER_KEY)};
	const nativeImport = self.importScripts;
	const nativeFetch = self.fetch;
	const listen = (event) => {
		const told = event.data && event.data[key];
		if (!told || typeof told !== 'object') return;
		event.stopImmediatePropagation();
		removeEventListener('message', listen);
		const { copies, routes } = told;
		// a worker of a route is at it, as natively, not at the prelude's
		// blob: URL: the inject decodes the page's URL from it
		// (src/inject/Client.ts takeNamedBase)
		if (told.location) self[${JSON.stringify(WORKER_BASE)}] = told.location;
		// (minted here: a worker of an opaque origin loads no blob: URL
		// another realm minted, not even its creator's)
		const own = (blob) =>
			typeof blob === 'string' ? blob : URL.createObjectURL(blob);
		for (const url of Object.keys(copies)) copies[url] = own(copies[url]);
		const script = own(told.script);
		const port = event.ports[0];
		const waiting = new Map();
		let asked = 0;
		port.onmessage = ({ data }) => {
			const wait = waiting.get(data.id);
			waiting.delete(data.id);
			if (!wait) return;
			if (data.error) wait.reject(new TypeError('Failed to fetch'));
			else
				wait.resolve(
					new Response(data.body, {
						status: data.status,
						statusText: data.statusText,
						headers: data.headers,
					}),
				);
		};
		self.importScripts = function importScripts(...urls) {
			return Reflect.apply(
				nativeImport,
				self,
				urls.map((url) => copies[String(url)] || url),
			);
		};
		self.fetch = function fetch(input, init) {
			let request;
			try {
				request = new Request(input, init);
			} catch (error) {
				return Promise.reject(error);
			}
			if (!request.url.startsWith(routes))
				return Reflect.apply(nativeFetch, self, [input, init]);
			const id = ++asked;
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? Promise.resolve(null)
					: request.arrayBuffer();
			return body.then(
				(body) =>
					new Promise((resolve, reject) => {
						waiting.set(id, { resolve, reject });
						port.postMessage({
							id,
							url: request.url,
							method: request.method,
							headers: [...request.headers],
							body,
							mode: request.mode,
							credentials: request.credentials,
							cache: request.cache,
							redirect: request.redirect,
							referrer: request.referrer,
							referrerPolicy: request.referrerPolicy,
						});
					}),
			);
		};
		Reflect.apply(nativeImport, self, [script]);
		postMessage({ [key]: 'ready' });
	};
	addEventListener('message', listen);
})();`;
const removeListener = EventTarget.prototype.removeEventListener;

/**
 * The bytes of the page's script behind a private blob: URL a route names
 * (src/server/rewrites.ts BLOB_ROUTE, its uuid), handed to the worker as a
 * realm of the page's origin hands them where the worker cannot read them
 * (blob~bytes): no inject hands them from a document no worker controls,
 * and the emulated worker reads no blob: URL a frame minted. The private
 * URL is of the bootstrap's minter, as `bootstrap` is; the realm that hands
 * them is a client at the route, whose page URL is the page's blob: URL.
 */
async function handBlob(route, bootstrap) {
	const uuid = /\/blob~(?:js|wjs|module|css)~([\da-f-]{36})\//.exec(route)?.[1];
	if (!uuid || !bootstrap.startsWith('blob:')) return;
	try {
		const blob = await (
			await nativeFetch(
				`${bootstrap.slice(0, bootstrap.lastIndexOf('/') + 1)}${uuid}`,
			)
		).blob();
		const client = nextClient();
		emulated.client({ id: client, url: route, type: 'worker' });
		await workerFetch(
			new Request(
				`${route.slice(0, route.indexOf('/blob~') + 1)}blob~bytes/${uuid}`,
				{
					method: 'POST',
					body: blob,
					headers: { 'content-type': blob.type },
				},
			),
			client,
		).catch(() => {});
		emulated.client({ id: client, gone: true });
	} catch {
		// (revoked: the import fails, as natively)
	}
}

/** the copy of the script at `url` (a route, or a blob: the inject made), with every route it names */
async function workerCopies(url, client, creator) {
	const routes = `${OWN}${scope}`;
	const copies = {};
	const fetchRoute = async (route, destination) => {
		const file = fileOf(localPath(route));
		if (file) return file.blob;
		const response = await workerFetch(new Request(route), client, globalThis, {
			mode: 'no-cors',
			destination,
		});
		return new Blob([await response.arrayBuffer()], {
			type: 'text/javascript',
		});
	};
	const own = url.startsWith(routes);
	const text = own
		? await // (the worker's script is its creator's request)
			(
				await workerFetch(new Request(url), creator, globalThis, {
					mode: 'same-origin',
					destination: 'worker',
				})
			).text()
		: await (await nativeFetch(url)).text();
	const named = new RegExp(
		`${routes.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^"'\`\\s\\\\)]+`,
		'g',
	);
	await Promise.all(
		// (a prefix the bootstrap names, or a load that fails, is left to
		// fail as the worker's own import)
		[...new Set(text.match(named) ?? [])].map(async (route) => {
			await handBlob(route, url);
			copies[route] = await fetchRoute(route, 'script').catch(() => route);
		}),
	);
	const script = new Blob([text], { type: 'text/javascript' });
	return { copies, script, routes, location: own ? url : null };
}

/** `win`'s Worker: a classic worker starts from the prelude (see above) */
function pageWorkers(win, page, creator) {
	const Native = win.Worker;
	if (typeof Native !== 'function') return;
	const post = Native.prototype.postMessage;
	const starting = new WeakMap();
	// (the frame's own, taken before the inject hooks it)
	const createObjectURL = win.URL.createObjectURL;
	const mint = (blob) => Reflect.apply(createObjectURL, win.URL, [blob]);
	let preludeURL = null;
	Object.defineProperty(Native.prototype, 'postMessage', {
		value: function postMessage(...args) {
			const queue = starting.get(this);
			if (!queue) return Reflect.apply(post, this, args);
			queue.push(args);
		},
		configurable: true,
		writable: true,
	});
	win.Worker = new Proxy(Native, {
		construct(target, [url, options], newTarget) {
			if (options?.type === 'module')
				return Reflect.construct(target, [url, options], newTarget);
			preludeURL ??= mint(
				new Blob([WORKER_PRELUDE], { type: 'text/javascript' }),
			);
			const worker = Reflect.construct(
				target,
				[preludeURL, options],
				newTarget,
			);
			const queue = [];
			starting.set(worker, queue);
			const ready = (event) => {
				if (event.data?.[WORKER_KEY] !== 'ready') return;
				event.stopImmediatePropagation();
				removeListener.call(worker, 'message', ready);
				starting.delete(worker);
				for (const args of queue) Reflect.apply(post, worker, args);
			};
			addListener.call(worker, 'message', ready);
			// (a route the inject made is of the scope's origin, maybe by
			// its path alone; the worker's client is at it, as natively)
			const script = new URL(String(url), `${OWN}${scope}`).href;
			const client = nextClient();
			emulated.client({
				id: client,
				url: script.startsWith('blob:') ? page : script,
				type: 'worker',
			});
			(async () => {
				const told = await workerCopies(script, client, creator);
				const channel = new MessageChannel();
				channel.port1.onmessage = async ({ data }) => {
					try {
						const response = await workerFetch(
							new Request(data.url, {
								method: data.method,
								headers: data.headers,
								body: data.body,
								credentials: data.credentials,
								cache: data.cache,
								redirect: data.redirect,
								...(['cors', 'no-cors', 'same-origin'].includes(data.mode) && {
									mode: data.mode,
								}),
							}),
							client,
							globalThis,
							{
								// (the worker's own address is the route, not the
								// prelude's blob: URL its Request read)
								referrer:
									data.referrer &&
									data.referrer !== 'about:client' &&
									!data.referrer.startsWith('blob:')
										? data.referrer
										: script.startsWith('blob:')
											? ''
											: script,
								referrerPolicy: data.referrerPolicy,
							},
						);
						const body = await response.arrayBuffer();
						channel.port1.postMessage(
							{
								id: data.id,
								status: response.status,
								statusText: response.statusText,
								headers: [...response.headers],
								body,
							},
							[body],
						);
					} catch {
						channel.port1.postMessage({ id: data.id, error: true });
					}
				};
				Reflect.apply(post, worker, [{ [WORKER_KEY]: told }, [channel.port2]]);
			})().catch((error) =>
				console.error(
					'offline.html: a worker could not start',
					String(url),
					error,
				),
			);
			return worker;
		},
	});
}

/** a call page's window, from its first script: see the section's head */
function primeCall(win) {
	fileOrigins(win);
	const element = win.frameElement;
	const page = callPages.get(element) ?? toWorker(callPath);
	// the documents of frames that went
	for (const [id, other] of emulated.clients)
		if (id !== HOST_CLIENT && other.closed) emulated.client({ id, gone: true });
	const client = nextClient();
	emulated.client(
		{ id: client, url: page, type: 'window', frameType: 'nested' },
		win,
	);
	const channel = new win.MessageChannel();
	channel.port1.onmessage = (event) =>
		emulated.postMessage(event.data, [...event.ports], client);
	Object.defineProperty(win, OFFLINE_WORKER, {
		value: channel.port2,
		configurable: true,
	});
	// the srcdoc of a frame its document sends to a call page, which it
	// gives the frame before the frame is in the document (the parser's
	// would be sent to the call page's URL, a file: one here)
	Object.defineProperty(win, OFFLINE_CALL_PAGE, {
		value: (value) => {
			const at = callMarkup && callPageOf(value, location.href);
			if (!at) return null;
			const srcdoc = callSrcdoc(at);
			handed.add(/<!--(\d+)-->$/.exec(srcdoc)[1]);
			return srcdoc;
		},
		configurable: true,
	});
	win.fetch = frameFetch(win, client, (request, init) =>
		request.headers.has(CALL_TOKEN_HEADER)
			? calledFetch(request, init, client, win)
			: null,
	);
	pageWorkers(win, page, client);
	const watch = dialable(win);
	// (the call page's own load, then the written document's)
	let loads = 0;
	const loaded = () => {
		if (++loads < 2) return;
		element.removeEventListener('load', loaded);
		watch();
	};
	if (element) addListener.call(element, 'load', loaded);
	const navigation = win.navigation;
	if (navigation)
		addListener.call(navigation, 'navigate', (event) => {
			const to = callPageOf(event.destination.url, location.href);
			if (!to || !event.cancelable) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const frame = win.frameElement;
			if (frame) showCall(frame, to);
		});
}

/**
 * The demo's createFrame. A dialing tab's frame is the controller's own
 * (`dial`), whose call pages this page gives their srcdoc; else a frame
 * whose documents this page writes.
 */
export function createFrame(controller, element, callbacks, dial = false) {
	if (!dial) return new WrittenFrame(controller, element, callbacks);
	if (!callPath) {
		const name =
			controller.config?.assets?.callPage ??
			controller.constructor.DEFAULT_ASSETS?.callPage;
		callPath = `${scope}${name}`;
		Object.defineProperty(window, KEY, { value: primeCall });
		dialable(window, true);
		// the call page is in hand before a frame is sent to it: the
		// controller asks a token for each call first
		const token = controller.callToken;
		controller.callToken = async function callToken(...args) {
			const given = await Reflect.apply(token, this, args);
			await callPageReady();
			return given;
		};
	}
	return controller.createFrame(element);
}
