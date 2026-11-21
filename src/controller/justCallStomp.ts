// Just call stomp: a proxied tab whose documents are written into frames of
// one constant page, never navigated to.
//
// A frame navigated to a route commits a real document of the proxy's
// origin for every page the user visits: the browser's joint session
// history (the host's history.length), the frame's location and its
// navigation and performance entries all change, and all of it can be read
// by the host's page, by anything that observes it and by the proxied page.
// Here each document of the tab gets a frame of its own, made fresh, whose
// one navigation is its first (no history entry) to the call page
// (the asset `callPage`, `<scope><callPage>`): one page under the scope,
// the same for every site, which the worker serves and so controls, only to
// a controller that opted in (ControllerInit.dialing). Before the frame
// loads, this page has the worker hold a token for the route
// (StompController.callToken); once it is loaded it sends the call page the
// token by a message, with a port, and the call over the port. The page
// asks the worker for its document with a fetch of the route that carries
// the token, which the worker answers as that frame's navigation to the
// route (the same request upstream, rewrite and shell:
// src/server/called.ts), and writes the answer into itself. Its src and its
// location never show anything but the call page.
//
// Everything between this page and a call page, or the document written
// into it, goes over the port: the page never reaches into the frame's
// window (its scroll, its document), so the call page may be of another
// origin than this page. Every message on the port is checked for its
// shape, and one of another shape is dropped.
//
// The inject of a document written so (src/inject/dom/calledHooks.ts)
// cancels every navigation its page starts and hands it to the frame's
// CalledFrame here over the port, which gives the next document a fresh
// frame in the element's place (a clean realm, as a navigation's), and
// keeps the tab's session history: the entries, their states, Navigation
// API states and scroll positions, with pushState and fragment entries of a
// document stepped within it. A step is a traversal as Chrome makes one:
// the document whose entry changes hears its `navigate` event first
// (src/inject/dom/calledNavigation.ts), which a page's own step within its
// document may cancel (the browser's Back, the user's, it cannot), then the
// document steps (`pop`) or the entry's document is loaded; the document
// left hears `pageswap` before it goes. A document is told only the entries
// of its own origin around its own, and how long the history is. The
// history is kept in this page's sessionStorage, so a reload of the host
// shows the tab where it was, and every change of it (an entry added,
// replaced or stepped to, a title) fires `entries` on the Frame, for the
// host's own record of the tab.
//
// Under the site pool (ControllerInit.sitePool, docs/site-pool.md; the
// content slots of docs/content-slots.md) every slot's worker serves the
// call page on its own origin, and a site's documents are written into call
// pages of its slot: another origin than the host's and than every other
// slot's, so another process, other storage and another worker, as the
// pool's navigations are. A call goes where the navigation would have begun
// (the origin of its referrer, the document it leaves), or with none to the
// site's slot (frame.go's choice), and its token is held by that origin's
// worker (StompController.callToken asks the slot's agent). A worker whose
// site is another slot's answers that it moved (src/server/called.ts), once
// it has handed that slot's worker what it knew of the navigation, and the
// call is made again from a fresh call page of that origin with a token of
// its own. A slot that does not give a token (its agent is gone), or whose
// call page does not say it is ready, is left out for the page, and the
// call is made from the host's own origin instead.

import { assetName } from '../config';
import { navigationAnswer } from '../navigationAnswer';
import { storeName } from '../profile';
import {
	CALL_MESSAGE,
	CALL_WAIT_MS,
	type CalledSession,
} from '../transport/messages';
import { frameColorScheme } from './colorScheme';
import { tellHardReload } from './history';
import type { Frame, StompController } from './index';

/** the sessionStorage name a tab's history is kept under */
const KEPT_PREFIX = 'just-call:';
/** how long a frame may take to show the call page */
const PAGE_WAIT_MS = 10_000;
/** how long the worker holds a stop for a call whose request did not come yet (EARLY_STOP_MS in src/server/rewrites.ts) */
const EARLY_STOP_MS = 2000;
/** how long a frame that saves a download is kept (hidden) once the browser has it */
const SAVE_KEPT_MS = 10_000;
/** how long it may take to read the download before that */
const SAVE_WAIT_MS = 60_000;
/** what a stopped load's waits reject with */
const STOPPED = Symbol('stopped');
/** how long a document has to fire a traversal's navigate event (a document that went never answers) */
const ASK_MS = 2_000;
/** how long the document a navigation leaves has for its pageswap */
const SWAP_MS = 500;

/** the name a download is saved under: its Content-Disposition's, else the last part of its URL's path */
function downloadName(disposition: string | null, url: string): string {
	const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(
		disposition ?? '',
	);
	if (star)
		try {
			return decodeURIComponent(star[2].trim());
		} catch (error) {
			// not percent-encoded as it says: the plain name, if any
		}
	const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(
		disposition ?? '',
	);
	const named = plain ? (plain[1] ?? plain[2]).trim() : '';
	if (named) return named.replace(/\\(.)/g, '$1');
	try {
		const last = new URL(url).pathname.split('/').pop();
		if (last) return decodeURIComponent(last);
	} catch (error) {
		// no name to be had from it
	}
	return 'download';
}

/** how many times one load may move to another origin (a redirect chain across the pool's slots) */
const MOVES = 8;
/**
 * how many times a GET the host's own worker refused is called again, with
 * a fresh token and a fresh call page: the token lives in a worker's
 * memory, and the worker that answers the call page can be another than
 * the one that took it (the browser stopped it in between, or a new one
 * took the scope over, as a Tor profile's worker does when a new session
 * registers it again)
 */
const REFUSED_RETRIES = 2;
/** how long before each of them, times its number */
const REFUSED_WAIT_MS = 300;

/** `url`'s path, query and fragment on `origin` (a route is one on every origin of the pool) */
const on = (origin: string, url: string) => {
	const { pathname, search, hash } = new URL(url);
	return `${origin}${pathname}${search}${hash}`;
};
/** `url`'s origin, '' when it has none */
const originOf = (url: string) => {
	try {
		return new URL(url, location.href).origin;
	} catch (error) {
		return '';
	}
};
/**
 * whether `pathname` is a route under `prefix` (the controller's address)
 * that a slot whose agent is gone sent back to this page's worker, marked
 * (`<scope>~home/<address>...`, HOMED_SEGMENT in src/server/serviceWorker.ts)
 */
const homed = (pathname: string, prefix: string) => {
	const scope = prefix.replace(/[^/]+\/$/, '');
	return (
		pathname.startsWith(`${scope}~home/`) &&
		`${scope}${pathname.slice(scope.length + '~home/'.length)}`.startsWith(
			prefix,
		)
	);
};

export interface CalledEntry {
	/** the page's real URL */
	url: string;
	title: string;
	/** the entry's state, a clone of what the page gave pushState */
	state: unknown;
	/** where the document was scrolled when the entry was left */
	scroll: [number, number];
	/** the entries of one document share a number: a step between them is the document's own */
	document: number;
	/** the Navigation API's key and id of the entry, and its state (navigate(), reload(), updateCurrentEntry()) */
	key: string;
	id: string;
	navState?: unknown;
	/** the route of the document it was reached from (its request's referrer), which a reload and a step name again */
	referrer: string;
}

export interface JustCallStompOptions {
	/** the name the tab's history is kept under in sessionStorage (default: the frame's place among the controller's frames) */
	key?: string;
}

type How = {
	type: CalledSession['type'];
	replace?: boolean;
	method?: string;
	body?: string | Blob | null;
	contentType?: string;
	referrer?: string;
	/** the navigation's referrer policy (its link's, else its document's) */
	policy?: string;
	/** the new entry's Navigation API state */
	navState?: unknown;
	/** a step's: the entry the tab showed before it (NavigationActivation's `from`) */
	left?: CalledEntry;
	/** a reload's: past the caches (Frame.reload's `bypassCache`) */
	hard?: boolean;
};

/** what a called document tells its host (calledHooks.ts) */
type Told = {
	op:
		| 'navigate'
		| 'push'
		| 'replace'
		| 'step'
		| 'scroll'
		| 'token'
		| 'update'
		| 'traversing'
		| 'swapped';
	url?: string;
	/** a token's: the route of the call a frame of the document is to make */
	routed?: string;
	/** a token's: the number the answer names */
	id?: number;
	state?: unknown;
	delta?: number;
	/** where the document is scrolled now (a push's: the entry it leaves) */
	scroll?: [number, number];
	replace?: boolean;
	reload?: boolean;
	/** a submission's entries, and how its form encodes them */
	entries?: [string, string | File][] | null;
	enctype?: string | null;
	policy?: string;
	/** a push's and a replace's: the entry's key and id, as the document made them (calledNavigation.ts) */
	key?: string;
	entryId?: string;
	/** the entry's Navigation API state (a push, a replace, an update, a navigation) */
	navState?: unknown;
	/** a traversing's and a swapped's: the request it answers, and whether the traversal goes on */
	req?: string;
	ok?: boolean;
};

/** the longest URL a message on a call's port names */
const MAX_URL = 32_768;
const OPS = [
	'navigate',
	'push',
	'replace',
	'step',
	'scroll',
	'token',
	'update',
	'traversing',
	'swapped',
];
const isText = (value: unknown, limit = MAX_URL): value is string =>
	typeof value === 'string' && value.length <= limit;
const isScroll = (value: unknown): value is [number, number] =>
	Array.isArray(value) &&
	value.length === 2 &&
	value.every((part) => Number.isFinite(part));

/**
 * `data` as what a called document may tell (calledHooks.ts), else null:
 * every field of its type, and a submission's entries as pairs of a name
 * and a string or File
 */
export function toldOf(data: unknown): Told | null {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const told = data as Record<string, unknown>;
	if (!OPS.includes(told.op as string)) return null;
	const optional = (key: string, check: (value: unknown) => boolean) =>
		told[key] === undefined || check(told[key]);
	const fine =
		optional('url', (value) => isText(value)) &&
		optional('routed', (value) => isText(value)) &&
		optional('id', Number.isSafeInteger) &&
		optional('delta', Number.isSafeInteger) &&
		optional('scroll', isScroll) &&
		optional('replace', (value) => typeof value === 'boolean') &&
		optional('reload', (value) => typeof value === 'boolean') &&
		optional('enctype', (value) => value === null || isText(value, 256)) &&
		optional('policy', (value) => isText(value, 256)) &&
		optional('key', (value) => isText(value, 64)) &&
		optional('entryId', (value) => isText(value, 64)) &&
		optional('req', (value) => isText(value, 64)) &&
		optional('ok', (value) => typeof value === 'boolean') &&
		optional(
			'entries',
			(value) =>
				value === null ||
				(Array.isArray(value) &&
					value.length <= 65_536 &&
					value.every(
						(pair) =>
							Array.isArray(pair) &&
							pair.length === 2 &&
							typeof pair[0] === 'string' &&
							(typeof pair[1] === 'string' || pair[1] instanceof File),
					)),
		);
	if (!fine) return null;
	if (
		(told.op === 'navigate' && !told.reload && told.url === undefined) ||
		((told.op === 'push' || told.op === 'replace') && told.url === undefined) ||
		(told.op === 'step' && told.delta === undefined) ||
		(told.op === 'scroll' && told.scroll === undefined) ||
		(told.op === 'token' &&
			(told.routed === undefined || told.id === undefined)) ||
		((told.op === 'traversing' || told.op === 'swapped') &&
			told.req === undefined)
	)
		return null;
	return told as Told;
}

/**
 * what a call page answers a call, else null (src/server/called.ts): the
 * document's answer, a failure, or the route on another origin of the site
 * pool that shows the document (CALL_MOVED_HEADER)
 */
export type CallAnswer =
	| {
			answered: {
				url: string;
				routed: string;
				status: number;
				/** its Content-Type and Content-Disposition (navigationAnswer) */
				type: string | null;
				disposition: string | null;
			};
	  }
	| { failed: string }
	| { moved: string };
export function callAnswerOf(data: unknown): CallAnswer | null {
	if (!data || typeof data !== 'object') return null;
	const { answered, failed, moved } = data as Record<string, any>;
	if (isText(failed, 1024)) return { failed };
	if (isText(moved))
		try {
			return { moved: new URL(moved).href };
		} catch (error) {
			return null;
		}
	if (
		answered &&
		typeof answered === 'object' &&
		isText(answered.url) &&
		isText(answered.routed) &&
		Number.isInteger(answered.status) &&
		(answered.type === null ||
			answered.type === undefined ||
			isText(answered.type, 1024)) &&
		(answered.disposition === null ||
			answered.disposition === undefined ||
			isText(answered.disposition, 4096))
	)
		try {
			new URL(answered.url);
			return {
				answered: {
					url: answered.url,
					routed: answered.routed,
					status: answered.status,
					type: answered.type ?? null,
					disposition: answered.disposition ?? null,
				},
			};
		} catch (error) {
			return null;
		}
	return null;
}

const randomId = () => crypto.randomUUID();
/** whether two pages' URLs are of one origin (an opaque one is of none) */
const sameOrigin = (a: string, b: string) => {
	const origin = originOf(a);
	return !!origin && origin !== 'null' && origin === originOf(b);
};

/** a submission's body as its form encodes it (the navigate event gives only the entries) */
async function encoded(
	entries: [string, string | File][],
	enctype = '',
): Promise<{ body: string | Blob; contentType: string }> {
	if (enctype === 'multipart/form-data') {
		const data = new FormData();
		for (const [name, value] of entries) data.append(name, value);
		const body = await new Response(data).blob();
		return { body, contentType: body.type };
	}
	const pairs = entries.map(([name, value]): [string, string] => [
		name,
		typeof value === 'string' ? value : value.name,
	]);
	if (enctype === 'text/plain')
		return {
			body: pairs.map(([name, value]) => `${name}=${value}\r\n`).join(''),
			contentType: 'text/plain',
		};
	return {
		body: new URLSearchParams(pairs).toString(),
		contentType: 'application/x-www-form-urlencoded',
	};
}

function pageLoad(element: HTMLIFrameElement): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('The call page did not load')),
			PAGE_WAIT_MS,
		);
		element.addEventListener(
			'load',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * A call over `port`, once the call page has its token and port: the page
 * says it is ready, then `call` goes and its answer comes back (within
 * CALL_WAIT_MS). Null when the page never says it is ready (PAGE_WAIT_MS):
 * it is no call page (a slot's port that answers with something else, a
 * slot whose worker went), or it took another caller's message; no call
 * went then, so it may be made elsewhere. Anything else the port hears is
 * dropped.
 */
function dial(port: MessagePort, call: object): Promise<CallAnswer | null> {
	return new Promise((resolve, reject) => {
		let ready = false;
		const fail = (why: string) => {
			clearTimeout(timer);
			port.onmessage = null;
			reject(new Error(why));
		};
		let timer = setTimeout(() => {
			port.onmessage = null;
			resolve(null);
		}, PAGE_WAIT_MS);
		port.onmessage = ({ data }) => {
			if (!ready) {
				if (data?.ready !== true || Object.keys(data).length !== 1) return;
				ready = true;
				clearTimeout(timer);
				timer = setTimeout(
					() => fail('The call page did not answer'),
					CALL_WAIT_MS,
				);
				port.postMessage({ call });
				return;
			}
			const answer = callAnswerOf(data);
			if (!answer) return;
			clearTimeout(timer);
			port.onmessage = null;
			resolve(answer);
		};
	});
}

/** settles once the call page on `port` says it saved the download (or never) */
function saved(port: MessagePort): Promise<void> {
	return new Promise((resolve) => {
		port.onmessage = ({ data }) => {
			if (data?.saved === true && Object.keys(data).length === 1) {
				port.onmessage = null;
				resolve();
			}
		};
	});
}

/**
 * A frame's tab of called frames (justCallStomp): its documents, its
 * session history and the steps through it. The Frame's go, back, forward
 * and reload are its own once a frame is called.
 */
export class CalledFrame {
	entries: CalledEntry[] = [];
	index = -1;
	/** the document the frame shows now, by its number */
	#document = 0;
	#documents = 0;
	/** the newest load: an older one that answers late is dropped */
	#loads = 0;
	/** the routed URL of the document shown, the referrer of its navigations */
	#routed = '';
	/** the port to the document shown */
	#port: MessagePort | null = null;
	/** where the document shown is scrolled, as it last told */
	#scroll: [number, number] = [0, 0];
	/** the load under way (#load): what stop() gives up, and the route it called, once it did */
	#pending: { cancel: () => void; routed: string | null } | null = null;
	/** the routes stop() told the worker to drop, until when (EARLY_STOP_MS) */
	#stopped = new Map<string, number>();
	/** the document's answers to a traversal's navigate event and to its pageswap, by request */
	#answers = new Map<string, (told: Told | null) => void>();
	/** the steps asked for, one at a time as the browser's */
	#queue: Promise<unknown> = Promise.resolve();
	readonly #key: string;
	constructor(
		public readonly frame: Frame,
		key: string,
	) {
		// this tab's, in the controller's profile (src/profile.ts)
		this.#key = storeName(KEPT_PREFIX + key);
		frame.addEventListener('navigate', (event) => {
			const entry = this.entries[this.index];
			const title = (event as CustomEvent<{ title?: string }>).detail?.title;
			if (entry && typeof title === 'string') {
				entry.title = title;
				this.#keep();
			}
		});
	}
	get controller(): StompController {
		return this.frame.controller;
	}
	/** the history kept for this tab, if any (a reload of the host) */
	restore(): boolean {
		try {
			const kept = JSON.parse(sessionStorage.getItem(this.#key) ?? 'null');
			if (!kept || !Array.isArray(kept.entries) || !kept.entries.length)
				return false;
			this.entries = kept.entries;
			this.index = Math.min(Math.max(0, kept.index), kept.entries.length - 1);
			this.#documents = Math.max(
				0,
				...this.entries.map((entry) => entry.document),
			);
			return true;
		} catch (error) {
			return false;
		}
	}
	#keep() {
		try {
			sessionStorage.setItem(
				this.#key,
				JSON.stringify({
					index: this.index,
					entries: this.entries.map((entry) => {
						let state: unknown = null;
						try {
							state = JSON.parse(JSON.stringify(entry.state) ?? 'null');
						} catch (error) {
							// a state JSON cannot carry: kept for this visit only
						}
						return { ...entry, state };
					}),
				}),
			);
		} catch (error) {
			// no sessionStorage (a private window's quota): kept in memory
		}
		// the host's own record of the tab follows (the demo's top URL)
		this.frame.dispatchEvent(
			new CustomEvent('entries', {
				detail: { index: this.index, entries: this.entries },
			}),
		);
	}
	/** the host's own navigation of the tab (a typed URL): a new entry */
	go(url: string): Promise<void> {
		return this.#load(new URL(url).href, { type: 'navigate' });
	}
	/**
	 * the entry shown again, as a reload does; `bypassCache` as Chrome's hard
	 * reload (Frame.reload's)
	 */
	async reload({ bypassCache = false } = {}): Promise<boolean> {
		const entry = this.entries[this.index];
		if (!entry) return false;
		await this.#load(entry.url, { type: 'reload', hard: bypassCache });
		return true;
	}
	canStep(delta: number): boolean {
		const to = this.index + delta;
		return to >= 0 && to < this.entries.length;
	}
	/**
	 * A step through the tab's history, of the browser's own Back or
	 * Forward (`user`, the default: no document can cancel it) or of a
	 * page's script; false when there is no entry there or the document
	 * cancelled it
	 */
	step(delta: number, { user = true } = {}): Promise<boolean> {
		if (!delta) return Promise.resolve(false);
		const run = () => this.#step(delta, user);
		const done = this.#queue.then(run, run);
		this.#queue = done.catch(() => false);
		return done;
	}
	async #step(delta: number, user: boolean): Promise<boolean> {
		if (!this.canStep(delta)) return false;
		const port = this.#port;
		const left = this.entries[this.index];
		const to = this.entries[this.index + delta];
		const same = to.document === this.#document && !!port;
		const req = randomId();
		// the document whose entry changes hears the traversal's navigate
		// event first, and may cancel a step within it that no user asked
		// for; a step to another origin's entry is never told to it, as
		// natively
		if (port && left && sameOrigin(left.url, to.url)) {
			const answer = await this.#ask(
				port,
				req,
				{
					traverse: {
						req,
						key: to.key,
						cancelable: same && !user,
						user,
					},
				},
				ASK_MS,
			);
			if (port !== this.#port || this.entries[this.index] !== left)
				return false;
			if (answer?.ok === false) {
				port.postMessage({ abort: { req, key: to.key } });
				return false;
			}
		}
		this.#leave();
		this.index += delta;
		if (same) {
			this.#keep();
			port!.postMessage({
				pop: {
					req,
					key: to.key,
					state: to.state,
					scroll: to.scroll,
					joint: { length: this.entries.length, index: this.index },
				},
			});
			return true;
		}
		await this.#load(to.url, { type: 'back_forward', left });
		return true;
	}
	/** ask the document shown over `port`, and wait for its answer (null after `wait`) */
	#ask(
		port: MessagePort,
		req: string,
		message: object,
		wait: number,
	): Promise<Told | null> {
		return new Promise((resolve) => {
			const done = (told: Told | null) => {
				clearTimeout(timer);
				this.#answers.delete(req);
				resolve(told);
			};
			const timer = setTimeout(() => done(null), wait);
			this.#answers.set(req, done);
			port.postMessage(message);
		});
	}
	/**
	 * Stop the tab as Chrome's Stop does (Frame.stop): a load not called
	 * yet is never called, and one whose answer has not come is given up
	 * (its frame goes, and the worker drops its request, so the origin's
	 * connection closes); the frame keeps the document it shows, which
	 * stops loading as on its own window.stop() (told over its port: the
	 * host never reaches into its window)
	 */
	async stop(): Promise<void> {
		this.#loads++;
		const pending = this.#pending;
		this.#pending = null;
		pending?.cancel();
		this.#port?.postMessage({ stop: true });
		if (!pending?.routed) return;
		// (its request may reach the worker after this)
		this.#stopped.set(pending.routed.split('#')[0], Date.now() + EARLY_STOP_MS);
		await this.controller.stopNavigation(pending.routed, true).catch(() => {});
	}
	/** an entry as a document is told it */
	#named(entry?: CalledEntry) {
		return entry ? { url: entry.url, key: entry.key, id: entry.id } : null;
	}
	/** the scroll of the entry being left: the document's, as it last told */
	#leave() {
		const entry = this.entries[this.index];
		if (entry) entry.scroll = [...this.#scroll];
	}
	#entry(url: string, state: unknown, document: number): CalledEntry {
		return {
			url,
			title: '',
			state,
			scroll: [0, 0],
			document,
			key: randomId(),
			id: randomId(),
			referrer: '',
		};
	}
	/** what the document shown told (calledHooks.ts) */
	async #told(told: Told, port: MessagePort) {
		// a document of a frame the tab has left
		if (port !== this.#port) return;
		const entry = this.entries[this.index];
		switch (told.op) {
			case 'scroll':
				this.#scroll = [Number(told.scroll![0]), Number(told.scroll![1])];
				break;
			case 'token': {
				// a frame of the document is to be called: a token for it, which
				// only this page can have the worker of the frame's origin hold
				// (a route of its own, on this page's origin or a slot's)
				let token: string | null = null;
				try {
					const routed = new URL(String(told.routed));
					const { controller } = this;
					if (
						(routed.origin === location.origin ||
							// (a file: page's, offline.html's: a file: URL's origin
							// reads "null", its location's "file://")
							(location.protocol === 'file:' && routed.protocol === 'file:') ||
							controller.siteOrigins.includes(routed.origin)) &&
						routed.pathname.startsWith(controller.directory.pathname) &&
						!routed.username &&
						!routed.password
					)
						token = await controller.callToken(routed.href);
				} catch (error) {
					// none: the frame's call is refused
				}
				if (port === this.#port)
					port.postMessage({ token: { id: told.id, value: token } });
				break;
			}
			case 'traversing':
			case 'swapped':
				this.#answers.get(told.req!)?.(told);
				break;
			case 'update':
				if (entry) {
					entry.navState = told.navState;
					this.#keep();
				}
				break;
			case 'push':
			case 'replace': {
				const next = this.#entry(String(told.url), told.state, this.#document);
				// (the key and id the document gave the entry, which its
				// Navigation API names it by)
				if (told.key) next.key = told.key;
				if (told.entryId) next.id = told.entryId;
				if (told.navState !== undefined) next.navState = told.navState;
				if (entry) {
					next.title = entry.title;
					next.referrer = entry.referrer;
				}
				if (told.op === 'push') {
					if (entry && told.scroll)
						entry.scroll = [Number(told.scroll[0]), Number(told.scroll[1])];
					else this.#leave();
					this.entries.splice(++this.index, Infinity, next);
				} else {
					next.key = entry?.key ?? next.key;
					this.entries[this.index] = next;
				}
				this.#keep();
				break;
			}
			case 'step':
				// (a page's own: history.back(), navigation.traverseTo())
				void this.step(Number(told.delta) || 0, { user: false });
				break;
			case 'navigate': {
				if (told.scroll) this.#scroll = told.scroll;
				if (told.reload) {
					if (entry && told.navState !== undefined)
						entry.navState = told.navState;
					void this.reload();
					break;
				}
				const body = told.entries
					? await encoded(told.entries, told.enctype ?? undefined)
					: null;
				void this.#load(String(told.url), {
					type: 'navigate',
					replace: told.replace,
					referrer: this.#routed,
					policy: told.policy,
					navState: told.navState,
					...(body && { method: 'POST', ...body }),
				});
				break;
			}
		}
	}
	/** what the document about to be written is told of the tab */
	#session(how: How): CalledSession {
		const shown = this.entries[this.index];
		const scroll = shown?.scroll;
		// the run of entries of the document's own origin around its own,
		// as its navigation.entries() lists them: never another origin's URL
		let first = this.index;
		let last = this.index;
		if (shown) {
			while (first > 0 && sameOrigin(this.entries[first - 1].url, shown.url))
				first--;
			while (
				last < this.entries.length - 1 &&
				sameOrigin(this.entries[last + 1].url, shown.url)
			)
				last++;
		}
		const named = (entry?: CalledEntry) =>
			entry && shown && sameOrigin(entry.url, shown.url)
				? {
						url: entry.url,
						key: entry.key,
						id: entry.id,
						document: entry.document,
					}
				: null;
		return {
			// a step's: the entry's scroll, which the document restores
			...(how.type === 'back_forward' &&
				scroll?.some(Boolean) && { scroll: [scroll[0], scroll[1]] }),
			entries: shown
				? this.entries
						.slice(first, last + 1)
						.map(({ url, key, id, document, navState }) => ({
							url,
							key,
							id,
							document,
							...(navState !== undefined && { navState }),
						}))
				: [],
			index: this.index - first,
			// (history.length, and where the document is in it)
			joint: { length: this.entries.length, index: this.index },
			// NavigationActivation's `from`: the entry left, of this origin
			from: named(how.left),
			state: shown?.state ?? null,
			type: how.type,
			replaced: !!how.replace,
			routed: this.#routed,
		};
	}
	/**
	 * Show `url` in a fresh frame of the call page, in the element's place.
	 * The old document stays until the worker's answer arrives, as a
	 * navigation's does; the entries change then.
	 */
	async #load(url: string, how: How): Promise<void> {
		const load = ++this.#loads;
		const { frame, controller } = this;
		const old = frame.element;
		// the tab loads from now (the host's go(), a page's own navigation)
		frame.dispatchEvent(new CustomEvent('dial', { detail: { url } }));
		let cancel!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			cancel = () => reject(STOPPED);
		});
		cancelled.catch(() => {});
		const pending = { cancel, routed: null as string | null };
		this.#pending = pending;
		const until = <T>(promise: Promise<T>) =>
			Promise.race([promise, cancelled]);
		/** the load is over: stopped, or a newer one took its place */
		const over = () => {
			if (this.#pending === pending) this.#pending = null;
		};
		// (the preference the document reads: its element's color-scheme,
		// which the fresh element has too, from the same rules)
		const colorScheme = frameColorScheme(old);
		controller.reportViewport(old.clientWidth, old.clientHeight, colorScheme);
		controller.expectNavigation(frame, url);
		// a reload and a step ask with the entry's own referrer, as natively
		const referrer =
			how.type === 'navigate'
				? (how.referrer ?? '')
				: (this.entries[this.index]?.referrer ?? '');
		// Start on the referrer's slot, whose worker knows the navigation, or
		// on the destination's slot for an address typed in the UI. With no
		// pool, or where the site's slot does not answer from here (a network
		// that lets the host's port through alone, a slot left out since),
		// the call page is this page's own origin's, as the pool's
		// navigations fall back (docs/content-slots.md).
		const slots = controller.siteOrigins;
		const origins = [location.origin, ...slots];
		const from = referrer ? originOf(referrer) : '';
		const prefix = controller.directory.pathname;
		const name = assetName(controller.config.assets, 'callPage');
		// (the referrer the call is made with: a route is one on every origin
		// of the pool, and the call page takes one of its own origin only;
		// none once the call moved, where the worker it moved from handed it
		// on)
		let sent = referrer;
		let at = location.origin;
		let routed!: string;
		/** no site is shown from `at` while this page lives: the site's slot now, or this page's origin */
		const leave = async (tries: number) => {
			controller.siteLeftOut(at);
			const other =
				tries < slots.length ? await until(controller.siteOrigin(url)) : null;
			at =
				other && other !== at && !controller.siteOriginLeftOut(other)
					? other
					: location.origin;
			routed = on(at, routed);
		};
		let fresh!: HTMLIFrameElement;
		let port!: MessagePort;
		let answer!: CallAnswer;
		let display!: string;
		try {
			if (controller.siteMode)
				at =
					slots.includes(from) && !controller.siteOriginLeftOut(from)
						? from
						: ((await until(controller.siteOrigin(url))) ?? location.origin);
			routed = on(at, await until(controller.route(url)));
			// a stop of the same route a moment ago is over for this call
			const key = routed.split('#')[0];
			const stopped = this.#stopped.get(key);
			if (stopped !== undefined) {
				this.#stopped.delete(key);
				if (Date.now() < stopped)
					await until(controller.navigationSent(routed).catch(() => {}));
			}
			let refusals = 0;
			for (let moves = 0, tries = 0; ; tries++) {
				// the route's token before the frame loads, held by the worker of
				// the origin the call is made from: the worker that answers the
				// call page knows this controller then (a worker the browser
				// stopped is woken and told it by these calls). A slot's comes
				// through its agent, and a slot whose agent gives none (it went)
				// is left out.
				let token: string | null = null;
				if (at !== location.origin) {
					await until(
						controller.siteViewport(
							at,
							old.clientWidth,
							old.clientHeight,
							colorScheme,
						),
					);
					if (!controller.siteOriginLeftOut(at))
						token = await until(controller.callToken(routed).catch(() => null));
					if (!token) {
						await leave(tries);
						continue;
					}
					frame.allowSlots();
				} else {
					token = await until(controller.callToken(routed));
					// a hard reload: the worker that answers the call gives it and
					// what its document loads Chrome's LOAD_BYPASS_CACHE (a slot's
					// worker is not told: there it is a reload)
					if (how.hard) await until(tellHardReload(routed));
				}
				const page = `${at}${prefix}${name}`;
				fresh = old.ownerDocument.createElement('iframe');
				for (const { name, value } of [...old.attributes])
					if (name !== 'src' && name !== 'srcdoc')
						fresh.setAttribute(name, value);
				display = fresh.style.getPropertyValue('display');
				fresh.style.setProperty('display', 'none');
				// (set before it is in the document: the frame's first navigation,
				// which makes no history entry)
				fresh.src = page;
				old.after(fresh);
				const channel = new MessageChannel();
				port = channel.port1;
				let heard: CallAnswer | null = null;
				let again = false;
				try {
					const loaded = await until(
						pageLoad(fresh).then(
							() => true,
							(error) => {
								if (at === location.origin) throw error;
								return false;
							},
						),
					);
					if (loaded) {
						await until(controller.measureGeometry());
						pending.routed = routed;
						// (a file: page's frames, offline.html's, are of an origin
						// that reads "null", which no target names)
						fresh.contentWindow!.postMessage(
							{ [CALL_MESSAGE]: token },
							location.protocol === 'file:' ? '*' : at,
							[channel.port2],
						);
						heard = await until(
							dial(port, {
								routed,
								type: how.type,
								method: how.method ?? 'GET',
								body: how.body ?? null,
								referrer: sent ? on(at, sent) : '',
								...(how.contentType && { contentType: how.contentType }),
								...(how.policy && { policy: how.policy }),
							}),
						);
					}
					if (!heard && at === location.origin)
						throw new Error('The call page did not take the call');
					if (heard && 'failed' in heard) {
						// (a GET, which no refused or failed call sent twice could
						// change: nothing else is called again)
						if (
							at === location.origin &&
							refusals < REFUSED_RETRIES &&
							(how.method ?? 'GET') === 'GET' &&
							!how.body
						)
							again = true;
						else throw new Error(heard.failed);
					}
				} catch (error) {
					fresh.remove();
					port.close();
					throw error;
				}
				if (again) {
					fresh.remove();
					port.close();
					pending.routed = null;
					if (load !== this.#loads) return;
					refusals++;
					await until(
						new Promise((resolve) =>
							setTimeout(resolve, REFUSED_WAIT_MS * refusals),
						),
					);
					continue;
				}
				if (!heard) {
					// a slot's call page that did not load or never said it was
					// ready (its port answers with something else, its worker
					// went): no call went, so it is made from elsewhere
					fresh.remove();
					port.close();
					pending.routed = null;
					if (load !== this.#loads) return;
					await leave(tries);
					continue;
				}
				answer = heard;
				if (!('moved' in answer)) break;
				// another origin shows the document: called again from there,
				// with what this origin's worker handed that one's (the referrer
				// among it), and a token of that origin's worker
				fresh.remove();
				port.close();
				pending.routed = null;
				if (load !== this.#loads) return;
				const to = new URL(answer.moved);
				if (!origins.includes(to.origin))
					throw new Error('The call moved to an origin of no slot');
				if (
					!(
						to.pathname.startsWith(prefix) ||
						(to.origin === location.origin && homed(to.pathname, prefix))
					) ||
					to.username ||
					to.password
				)
					throw new Error('The call moved outside its controller');
				if (++moves > MOVES || to.origin === at)
					throw new Error('The call moved too often');
				at = to.origin;
				routed = to.href;
				sent = '';
			}
		} catch (error) {
			over();
			// stopped: the frame keeps its document
			if (error === STOPPED) return;
			if (load === this.#loads) this.#port?.postMessage({ failed: true });
			throw error;
		}
		over();
		if (load !== this.#loads) {
			fresh.remove();
			port.close();
			return;
		}
		const got = 'answered' in answer ? answer.answered : null;
		// an answer Chrome commits no document for (a 204, a download): the
		// frame keeps its document and its entry, and the load is over
		const kind = got && navigationAnswer(got.status, got.type, got.disposition);
		if (got && kind) {
			if (kind === 'download') {
				// (its frame, hidden, saves it, and stays until the browser has it)
				const done = saved(port);
				port.postMessage({
					save: downloadName(got.disposition, got.url || url),
				});
				void Promise.race([
					done,
					new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS)),
				]).then(() =>
					setTimeout(() => {
						fresh.remove();
						port.close();
					}, SAVE_KEPT_MS),
				);
			} else {
				fresh.remove();
				port.close();
			}
			// (the document's navigation it handed here failed: navigateerror)
			this.#port?.postMessage({ failed: true });
			frame.dispatchEvent(new Event('stayed'));
			return;
		}
		// where the answer is from: the page's URL after its redirects, with
		// the fragment asked for when the last one named none
		let shown = url;
		if (got?.url) {
			const after = new URL(got.url);
			if (!after.hash) after.hash = new URL(url).hash;
			shown = after.href;
			// the referrer of its navigations is the route it ended at, on the
			// origin it is shown from
			if (shown !== url)
				routed = got.routed.startsWith(`${at}${prefix}`)
					? got.routed
					: on(at, await controller.route(shown));
		}
		if (load !== this.#loads) {
			fresh.remove();
			port.close();
			return;
		}
		// the answer is in: the tab's entries change, and its document (a
		// step left its entry before it moved)
		if (how.type !== 'back_forward') this.#leave();
		const left = how.left ?? this.entries[this.index];
		// a navigation's new entry (a replacement keeps the key of the entry
		// it replaces)
		const next =
			how.type === 'navigate'
				? this.#entry(shown, null, ++this.#documents)
				: null;
		if (next && how.replace && this.index >= 0)
			next.key = this.entries[this.index].key;
		// the document left hears pageswap first (its activation names the
		// entries only of a navigation within its origin), and the frame's
		// document is not swapped before it has, or a short while has gone
		const oldPort = this.#port;
		if (oldPort && left) {
			const req = randomId();
			const within = sameOrigin(left.url, shown);
			const type =
				how.type === 'back_forward'
					? 'traverse'
					: how.type === 'reload'
						? 'reload'
						: how.replace
							? 'replace'
							: 'push';
			await this.#ask(
				oldPort,
				req,
				{
					swap: {
						req,
						type,
						activation: within
							? {
									entry: this.#named(next ?? this.entries[this.index]),
									from: this.#named(left),
								}
							: null,
					},
				},
				SWAP_MS,
			);
			if (load !== this.#loads) {
				fresh.remove();
				port.close();
				return;
			}
		}
		if (next) {
			next.referrer = referrer;
			if (how.navState !== undefined) next.navState = how.navState;
			if (how.replace && this.index >= 0) this.entries[this.index] = next;
			else this.entries.splice(++this.index, Infinity, next);
		} else this.entries[this.index].url = shown;
		const entry = this.entries[this.index];
		this.#document = entry.document;
		this.#routed = routed;
		this.#port?.close();
		this.#port = port;
		this.#scroll = [0, 0];
		this.#keep();
		const focused = old.ownerDocument.activeElement === old;
		old.remove();
		if (display) fresh.style.setProperty('display', display);
		else fresh.style.removeProperty('display');
		if (!fresh.getAttribute('style')) fresh.removeAttribute('style');
		frame.adopt(fresh);
		frame.dispatchEvent(new CustomEvent('element', { detail: fresh }));
		port.onmessage = ({ data }) => {
			const told = toldOf(data);
			if (told) void this.#told(told, port);
		};
		port.postMessage({
			write: { url: shown, session: this.#session({ ...how, left }) },
		});
		// the frame the user was in keeps the focus, as a navigation's does
		if (focused) fresh.focus();
	}
}

/** the CalledFrame of each frame called */
const called = new WeakMap<Frame, CalledFrame>();

/**
 * Just call stomp: show `url` in the frame without navigating it to the
 * site. The document goes into a fresh frame of the call page, and so does
 * every document after it, in the frame element's place (the frame fires
 * `element` with the new one); its go, back, forward and reload work
 * through the history kept here, and the frame fires `entries` (detail
 * `{ index, entries }`) each time that history changes. Without a URL, a tab kept from before the
 * host's page was reloaded is shown again where it was. The frames'
 * documents are of the controller's own origin (no site pool). The
 * controller must have opted in (`init.dialing`).
 */
export async function justCallStomp(
	frame: Frame,
	url?: string | URL,
	options: JustCallStompOptions = {},
): Promise<CalledFrame> {
	if (frame.controller.config.dialing !== true)
		throw new Error(
			'Stomp: justCallStomp() needs a controller made with `dialing: true`',
		);
	// a dialed document's history and navigation are the Navigation API's
	// (calledNavigation.ts), which is not emulated where the browser lacks it
	if (!('navigation' in globalThis) || !('NavigateEvent' in globalThis))
		throw new DOMException(
			'Stomp: dialing needs the Navigation API, which this browser lacks',
			'NotSupportedError',
		);
	let tab = called.get(frame);
	if (!tab) {
		const key = options.key ?? String(frame.controller.frames.indexOf(frame));
		tab = new CalledFrame(frame, key);
		called.set(frame, tab);
		frame.called = tab;
		if (url === undefined && tab.restore()) {
			await tab.reload();
			return tab;
		}
	}
	if (url !== undefined) await tab.go(String(url));
	return tab;
}
