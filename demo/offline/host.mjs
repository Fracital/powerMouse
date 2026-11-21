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
			name: JSON.stringify({ origin: OWN, scope }),
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
	answers: local = new Map(),
}) {
	scope = given;
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
		const scriptURL = new URL(`${scope}serviceWorker.js`, location.href).href;
		return script.blob.text().then((text) => {
			emulated = new EmulatedWorker(scriptURL, prelude, text);
			return emulated;
		});
	});
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
		const held = heldScripts(win);
		const own = win.fetch;
		const frameFetch = (input, init) => {
			let request;
			try {
				request = new win.Request(ownRoute(input), init);
			} catch (error) {
				return win.Promise.reject(error);
			}
			const path = localPath(request.url);
			if (path === null || !underScope(path))
				return Reflect.apply(own, win, [input, init]);
			if (request.headers.has(CALL_HEADER))
				return this.#called(request, client, win);
			if (path.startsWith(held.path)) return held.copied(request, path);
			const file = fileOf(path);
			if (file) return Promise.resolve(fileResponse(file, win.Response));
			return workerFetch(request, client, win, loadOf(path, request));
		};
		win.fetch = frameFetch;
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

/** the demo's createFrame, for a frame whose documents the page writes */
export function createFrame(controller, element, callbacks) {
	return new WrittenFrame(controller, element, callbacks);
}
