// Just call stomp (src/controller/justCallStomp.ts): the frames of a called
// document are called as the tab's frame is. Part of the calledHooks
// deferred part (./calledHooks.ts), which only a called document evaluates.
//
// A frame the page sends to a document (its src, set by a script or by the
// markup) gets the call page's URL for its src instead of the document's
// route (modules/DOMAttributes.ts calls `callFrame`), and this document is
// its host: once the call page is loaded, it is sent the route by a
// message, with a port, and asks the worker for the document as its
// navigation would have, and writes the answer into itself. The page reads
// the src it set (the element's attributes keep the page's own values) and
// the frame's location as the document's URL; the frame's real src and
// location are the call page's (numbered by depth, `?1` below the tab's). The call page's own load is none of the
// page's: it is stopped before any listener of the page sees it.
//
// The frame's next documents go into it the same way: its document tells
// this one of each navigation it starts (as the tab's frame tells its
// host), and the frame is sent to the call page again with
// location.replace, which makes no history entry, then called. Its history
// is kept here, and its steps are its own: a frame's history is not joined
// to the tab's.
//
// Each call takes a token, which only the controller can have the worker
// hold: this document asks its host for one over its own port (askToken,
// calledHooks.ts), and a frame's document asks this one, which asks its
// host in turn. Between this document and a frame's call page or document
// there are messages alone: nothing here reads the frame's window, so a
// frame on another origin is called the same way. (Where the frame is of
// this origin, its URL is checked as well before the call goes.)
//
// Under the site pool a frame of another site is written in its slot, as
// the tab's frame is (justCallStomp.ts): the call goes where the frame's
// navigation begins (its referrer's origin: this document's for a src the
// page set), with a token for that origin's worker, and when the worker
// there says the document moved to another slot, the frame is sent to that
// slot's call page (location.replace, which a window of another origin
// takes) and called again from there, with a token for that slot's worker.
// A frame is never moved to the host's own origin: one whose slot is left
// out stays unwritten (fail closed below the top).

import { proxyOrigins } from '../../routeURL';
import {
	CALL_MESSAGE,
	CALL_WAIT_MS,
	type CalledSession,
} from '../../transport/messages';
import { scopePrefix } from '../modules/Unroute';
import type DocumentClient from './Client';
import { addDocumentOpenListener } from './Client';
import { frameWindow } from './freshContext';
import { nativeElement } from './modules/DOMHooks';

type Globals = typeof globalThis & Record<string, any>;

/** how long a frame's call page may take to say it has the call's port */
const READY_WAIT_MS = 10_000;
/** the longest URL a message on a call's port names */
const MAX_URL = 32_768;
/** how many times one call may move to another slot */
const MOVES = 8;
/** the longest a frame's call holds this document's load (the worker's bound is longer: src/server/called.ts HOLD_MS) */
const HOLD_MS = READY_WAIT_MS + CALL_WAIT_MS;
/** how often a held frame is looked at: one taken out of the document holds nothing, as natively */
const HOLD_CHECK_MS = 250;

type How = {
	type: CalledSession['type'];
	replace?: boolean;
	method?: string;
	body?: string | Blob | null;
	contentType?: string;
	referrer: string;
	policy?: string;
};

type KidEntry = CalledSession['entries'][number] & {
	state: unknown;
	referrer: string;
	routed: string;
};

interface Kid {
	entries: KidEntry[];
	index: number;
	documents: number;
	/** the document the frame is to be called with next, and its call's token on the way */
	want: {
		url: string;
		routed: string;
		how: How;
		token: Promise<string | null>;
		/** the referrer the navigation began with, when it moved to another slot (the entry's) */
		first?: string;
		moves?: number;
	} | null;
	/** the frame was sent to its call page before: the next is a replace of it */
	shown: boolean;
	/** the port of the call in flight (a newer one drops it) */
	calling: MessagePort | null;
	/** the port to the document shown */
	port: MessagePort | null;
	/** the written document's load is the page's */
	writing: boolean;
	/** the route of the document shown, the referrer of its navigations */
	routed: string;
	/** the call page the frame is called from next: this document's frames', or another slot's (a site of the pool) */
	page: string;
	/** the image that holds this document's load while the frame is called (`hold`) */
	hold: Element | null;
	holdTimer: ReturnType<typeof setInterval> | undefined;
	/** the frame element of this document it is shown in (none yet for the parser's copy of one) */
	frame: Element | null;
}

/** what a called frame's document tells (calledHooks.ts) */
type Told = {
	op: 'navigate' | 'push' | 'replace' | 'step' | 'scroll' | 'token';
	url?: string;
	routed?: string;
	id?: number;
	state?: unknown;
	delta?: number;
	replace?: boolean;
	reload?: boolean;
	entries?: [string, string | File][] | null;
	enctype?: string | null;
	policy?: string;
	/** a push's or replacement's: the key and id the document's Navigation API gave the entry */
	key?: string;
	entryId?: string;
};

const isText = (value: unknown, limit = MAX_URL): value is string =>
	typeof value === 'string' && value.length <= limit;

/** `data` as what a frame's document may tell, else null (the host's check, src/controller/justCallStomp.ts toldOf) */
function toldOf(data: unknown, File: typeof globalThis.File): Told | null {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const told = data as Record<string, unknown>;
	const optional = (key: string, check: (value: unknown) => boolean) =>
		told[key] === undefined || check(told[key]);
	const text = (limit?: number) => (value: unknown) => isText(value, limit);
	const ops: Record<string, string[]> = {
		navigate: [],
		push: ['url'],
		replace: ['url'],
		step: ['delta'],
		scroll: [],
		token: ['routed', 'id'],
	};
	const needs = ops[told.op as string];
	if (
		!needs ||
		needs.some((key) => told[key] === undefined) ||
		(told.op === 'navigate' && !told.reload && told.url === undefined) ||
		!optional('url', text()) ||
		!optional('routed', text()) ||
		!optional('id', Number.isSafeInteger) ||
		!optional('delta', Number.isSafeInteger) ||
		!optional('replace', (value) => typeof value === 'boolean') ||
		!optional('reload', (value) => typeof value === 'boolean') ||
		!optional('enctype', (value) => value === null || isText(value, 256)) ||
		!optional('policy', text(256)) ||
		!optional('key', text(64)) ||
		!optional('entryId', text(64)) ||
		!optional(
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
		)
	)
		return null;
	return told as Told;
}

/** what a frame's call page answers its call, else null (src/server/called.ts): the document's answer, a failure, or the route on another slot that shows it */
function answerOf(
	data: unknown,
):
	| { url: string; routed: string }
	| { failed: string }
	| { moved: string }
	| null {
	if (!data || typeof data !== 'object') return null;
	const { answered, failed, moved } = data as Record<string, any>;
	if (isText(failed, 1024)) return { failed };
	if (isText(moved)) return { moved };
	if (
		answered &&
		typeof answered === 'object' &&
		isText(answered.url) &&
		isText(answered.routed) &&
		Number.isInteger(answered.status)
	)
		return { url: answered.url, routed: answered.routed };
	return null;
}

export function calledFrames(
	client: DocumentClient,
	page: string,
	routed: string,
	askToken: (routed: string) => Promise<string | null>,
) {
	const global = client.global as Globals;
	const {
		MessageChannel,
		FormData,
		Response,
		URLSearchParams,
		URL,
		Reflect,
		crypto,
		File,
		setTimeout,
		clearTimeout,
	} = global;
	const portPost = global.MessagePort.prototype.postMessage;
	const send = (port: MessagePort, message: object) =>
		Reflect.apply(portPost, port, [message]);
	const windowPost = client.nativePostMessage ?? global.postMessage;
	const stop = global.Event.prototype.stopImmediatePropagation;
	const targetOf = Reflect.getOwnPropertyDescriptor(
		global.Event.prototype,
		'target',
	)!.get!;
	const origin = new URL(page).origin;
	// the call page of this document's frames: the same page, numbered by
	// its depth below the tab's frame. A frame may not load the URL of more
	// than one of its ancestors (Chrome's recursion check, fragments aside),
	// and every called document's URL is a call page's
	const kidPage = (() => {
		const url = new URL(page);
		url.hash = '';
		url.search = `?${(Number(url.search.slice(1)) || 0) + 1}`;
		return url.href;
	})();
	const scope = scopePrefix(client);
	// the site pool: every origin of the pool has the same routes (the
	// scope's path on each), and a frame's call page is on one of them. A
	// slot's descendants may be on another slot, never on the hub's origin
	const scopePath = new URL(scope).pathname;
	const sites = client.config.sites;
	const origins = [
		origin,
		...(sites ? (sites.origins ?? []) : proxyOrigins(client.config)),
	];
	/** `url` as a route of the pool's origin it names, else '' */
	const routeOn = (url: string) => {
		if (!url) return '';
		try {
			const to = new URL(url, page);
			return origins.includes(to.origin) &&
				to.pathname.startsWith(scopePath) &&
				!to.username &&
				!to.password
				? to.href
				: '';
		} catch (error) {
			return '';
		}
	};
	/** the call page of the frames on `at`, an origin of the pool */
	const pageOn = (at: string) => {
		const url = new URL(kidPage);
		return `${at}${url.pathname}${url.search}`;
	};
	/** the call page a navigation with `referrer` is called from: its document's origin */
	const pageFor = (referrer: string) => {
		try {
			const at = new URL(referrer).origin;
			if (origins.includes(at)) return pageOn(at);
		} catch (error) {
			// no referrer: this document's
		}
		return kidPage;
	};
	/** `routed` on the origin of the call page `on` */
	const rebased = (routed: string, on: string) => {
		const { pathname, search, hash } = new URL(routed);
		return `${new URL(on).origin}${pathname}${search}${hash}`;
	};
	/** the windows of frames sent to another origin's call page, not written yet */
	const waiting = new WeakSet<object>();
	const kids = new WeakMap<Element, Kid>();
	/**
	 * the frames sent out of the document, by the page's URL: the parser's
	 * frame is a copy of the one the hooks saw (its attributes, the call
	 * page's src among them, and not its record here)
	 */
	const unplaced = new Map<string, Kid>();
	const placed = (element: Element): Kid | undefined => {
		let url: string;
		try {
			url = String(Reflect.get(element, 'src'));
		} catch (error) {
			return undefined;
		}
		const kid = unplaced.get(url);
		if (!kid) return undefined;
		unplaced.delete(url);
		kids.set(element, kid);
		kid.frame = element;
		return kid;
	};
	const id = () => crypto.randomUUID();

	// A frame's document is part of this document's load, as natively. The
	// call page's own load is over before the frame's document is even
	// asked for, so the browser fires this document's load with the frame
	// still on its call page: a page that reads its frame at its load (its
	// document, its navigation) found another origin's stand-in, or nothing
	// written yet. So while a frame of it is called before this document
	// has loaded, an image the worker holds (src/server/called.ts callHold)
	// keeps the load waiting, as a frame's document does, until the frame's
	// document has loaded or its call ended. An image no document has, so
	// the page sees no element (and no entry: its URL is no page's, which
	// the timing hooks leave out); not under a policy of the page's, which
	// could refuse it, and report that
	const readyState = Reflect.getOwnPropertyDescriptor(
		global.Document.prototype,
		'readyState',
	)!.get!;
	const createElement = global.Document.prototype.createElement;
	const { setInterval, clearInterval } = global;
	const connected = Reflect.getOwnPropertyDescriptor(
		global.Node.prototype,
		'isConnected',
	)!.get!;
	const holdURL = () => {
		const url = new URL(page);
		url.hash = '';
		url.search = `?hold=${id()}`;
		return url.href;
	};
	const release = (kid: Kid) => {
		const image = kid.hold;
		if (!image) return;
		kid.hold = null;
		clearInterval(kid.holdTimer);
		Reflect.apply(nativeElement.removeAttribute, image, ['src']);
	};
	const querySelectorAll = global.Document.prototype.querySelectorAll;
	/** the element `kid` is shown in: the parser's, for a copy the hooks saw */
	const frameOf = (kid: Kid): Element | null => {
		if (kid.frame) return kid.frame;
		for (const element of Reflect.apply(querySelectorAll, global.document, [
			'iframe, frame',
		]) as Element[])
			if ((kids.get(element) ?? placed(element)) === kid)
				return (kid.frame = element);
		return null;
	};
	/** whether `element` runs no script: its call page never answers, and a hold would only wait out its bound */
	const scriptless = (element: Element) => {
		const sandbox = Reflect.apply(nativeElement.getAttribute, element, [
			'sandbox',
		]) as string | null;
		return sandbox !== null && !/(^|\s)allow-scripts(\s|$)/i.test(sandbox);
	};
	const hold = (kid: Kid, element: Element) => {
		if (kid.hold) return;
		try {
			const state = Reflect.apply(readyState, global.document, []);
			if (
				state === 'complete' ||
				client.browserPolicies().length ||
				// (a frame the hooks saw out of the document: the parser's copy,
				// while the parser runs, which it puts in the document next)
				(!Reflect.apply(connected, element, []) && state !== 'loading') ||
				scriptless(element)
			)
				return;
			const image = Reflect.apply(createElement, global.document, [
				'img',
			]) as Element;
			Reflect.apply(nativeElement.setAttribute, image, ['src', holdURL()]);
			kid.hold = image;
			let checks = 0;
			kid.holdTimer = setInterval(() => {
				const frame = frameOf(kid);
				if (
					++checks * HOLD_CHECK_MS > HOLD_MS ||
					(frame
						? !Reflect.apply(connected, frame, []) || scriptless(frame)
						: Reflect.apply(readyState, global.document, []) !== 'loading')
				)
					release(kid);
			}, HOLD_CHECK_MS);
		} catch (error) {
			// no hold: the load is the browser's
		}
	};

	const hrefOf = (win: Window | null) => {
		try {
			return win ? win.location.href : '';
		} catch (error) {
			return '';
		}
	};
	/**
	 * the frame to the call page: its src the first time, then a replace,
	 * no entry (Location.replace is the one member of another origin's
	 * location a parent may call)
	 */
	const reach = (element: Element, kid: Kid): string | true => {
		kid.calling = null;
		hold(kid, element);
		const win = frameWindow(element);
		if (!win || !kid.shown) {
			kid.shown = true;
			return kid.page;
		}
		win.location.replace(kid.page);
		// (a call page of another origin, which this realm cannot read, takes
		// no message of the page's until its document is written)
		if (new URL(kid.page).origin !== origin) waiting.add(win);
		return true;
	};

	// a frame of this document on its call page takes no message of the
	// page's: its call is this document's hooks' alone (the page's poster,
	// modules/Context.ts)
	const pages = (() => {
		const url = new URL(kidPage);
		url.search = '';
		return url.href;
	})();
	client.callPageWindow = (receiver) =>
		(typeof receiver === 'object' &&
			receiver !== null &&
			waiting.has(receiver)) ||
		hrefOf(receiver as Window).startsWith(pages);

	// a frame sent to its call page whose window shows no document of the
	// page's: its initial about:blank, which the browser keeps for a call
	// page of this origin (so nothing may be injected into it), or the call
	// page itself (modules/IFrame.ts)
	client.callPending = (element, context) => {
		const kid = kids.get(element) ?? placed(element);
		if (!kid?.shown) return false;
		try {
			return !(client.names.client in context);
		} catch (error) {
			// another origin's
			return true;
		}
	};

	client.callFrame = (element, url, to) => {
		if (element.nodeName !== 'IFRAME' && element.nodeName !== 'FRAME')
			return false;
		let absolute: string;
		try {
			absolute = new URL(to, page).href;
		} catch (error) {
			return false;
		}
		if (!absolute.startsWith(scope)) {
			// (sent elsewhere: no call of it is to come, and its next call page
			// is its src again)
			const kid = kids.get(element);
			if (kid) {
				kid.want = null;
				kid.calling = null;
				kid.shown = false;
				release(kid);
			}
			return false;
		}
		let kid = kids.get(element);
		if (!kid) {
			kid = {
				entries: [],
				index: -1,
				documents: 0,
				want: null,
				shown: false,
				calling: null,
				port: null,
				writing: false,
				routed: '',
				page: kidPage,
				hold: null,
				holdTimer: undefined,
				frame: element.isConnected ? element : null,
			};
			kids.set(element, kid);
		}
		// (called from this document's origin, whose worker knows the page)
		kid.page = kidPage;
		kid.want = {
			url,
			routed: absolute,
			how: { type: 'navigate', referrer: routed },
			token: askToken(absolute),
		};
		if (!element.isConnected) unplaced.set(url, kid);
		return reach(element, kid);
	};

	// the call page's load: the call, which the page does not see (on the
	// document, capturing: a load never reaches the window; again after each
	// open, which erases the document's listeners)
	const loaded = (event: Event) => {
		const element = Reflect.apply(targetOf, event, []) as Element;
		let kid = kids.get(element);
		if (!kid) kid = placed(element);
		if (!kid) return;
		if (kid.writing) {
			kid.writing = false;
			release(kid);
			return;
		}
		const win = frameWindow(element);
		// (a frame of this origin on another page is no call page; one of
		// another origin cannot be read, and its call page says it is one)
		const href = hrefOf(win);
		if (!win || !kid.want || (href !== '' && href !== kid.page)) {
			release(kid);
			return;
		}
		Reflect.apply(stop, event, []);
		// (the frame of the markup, which the hooks saw as a copy, is held
		// from its call page's load on: its load event comes before this
		// document's own is decided)
		hold(kid, element);
		void call(element, kid, win);
	};
	const listen = () =>
		Reflect.apply(
			global.EventTarget.prototype.addEventListener,
			global.document,
			['load', loaded, true],
		);
	listen();
	addDocumentOpenListener(global, listen);

	const call = async (element: Element, kid: Kid, win: Window) => {
		const want = kid.want!;
		kid.want = null;
		const { port1: port, port2 } = new MessageChannel();
		kid.calling = port;
		const token = await want.token;
		if (kid.calling !== port || !token) {
			if (kid.calling === port) release(kid);
			port.close();
			return;
		}
		const { how } = want;
		// the call page says it has the port, then the call goes, then its
		// answer comes; anything else it says is dropped
		const answered = new Promise<ReturnType<typeof answerOf>>((resolve) => {
			let ready = false;
			let timer = setTimeout(() => resolve(null), READY_WAIT_MS);
			port.onmessage = ({ data }) => {
				if (!ready) {
					if (data?.ready !== true) return;
					ready = true;
					clearTimeout(timer);
					timer = setTimeout(() => resolve(null), CALL_WAIT_MS);
					send(port, {
						call: {
							routed: want.routed,
							type: how.type,
							method: how.method ?? 'GET',
							body: how.body ?? null,
							referrer: how.referrer,
							...(how.contentType && { contentType: how.contentType }),
							...(how.policy && { policy: how.policy }),
						},
					});
					return;
				}
				const answer = answerOf(data);
				if (!answer) return;
				clearTimeout(timer);
				resolve(answer);
			};
		});
		Reflect.apply(windowPost, win, [
			{ [CALL_MESSAGE]: token },
			new URL(kid.page).origin,
			[port2],
		]);
		const answer = await answered;
		port.onmessage = null;
		if (kid.calling !== port || !answer || 'failed' in answer) {
			if (kid.calling === port) release(kid);
			port.close();
			return;
		}
		kid.calling = null;
		// another slot shows the document: the frame goes to that slot's
		// call page and is called from there, with what this one's worker
		// handed that one's (the referrer among it) and a token for that
		// slot's worker
		if ('moved' in answer) {
			port.close();
			const moved = routeOn(answer.moved);
			const moves = (want.moves ?? 0) + 1;
			if (!moved || moves > MOVES) return release(kid);
			const at = new URL(moved).origin;
			if (at === new URL(kid.page).origin) return release(kid);
			kid.page = pageOn(at);
			kid.want = {
				...want,
				routed: moved,
				token: askToken(moved),
				first: want.first ?? how.referrer,
				moves,
				how: { ...how, referrer: '' },
			};
			reach(element, kid);
			return;
		}
		waiting.delete(win);
		let shown = want.url;
		try {
			const after = new URL(answer.url);
			if (!after.hash) after.hash = new URL(want.url).hash;
			shown = after.href;
		} catch (error) {
			// no URL: the one asked for
		}
		const route = routeOn(answer.routed) || want.routed;
		if (how.type === 'navigate') {
			const made: KidEntry = {
				url: shown,
				key: id(),
				id: id(),
				document: ++kid.documents,
				state: null,
				referrer: want.first ?? how.referrer,
				routed: route,
			};
			if (how.replace && kid.index >= 0) {
				made.key = kid.entries[kid.index].key;
				kid.entries[kid.index] = made;
			} else kid.entries.splice(++kid.index, Infinity, made);
		} else {
			kid.entries[kid.index].url = shown;
			kid.entries[kid.index].routed = route;
		}
		const entry = kid.entries[kid.index];
		kid.routed = route;
		kid.port?.close();
		kid.port = port;
		port.onmessage = ({ data }) => {
			const what = toldOf(data, File);
			if (what) void told(element, kid, port, what);
		};
		kid.writing = true;
		send(port, {
			write: {
				url: shown,
				session: {
					entries: kid.entries.map(({ url, key, id, document }) => ({
						url,
						key,
						id,
						document,
					})),
					index: kid.index,
					state: entry.state,
					type: how.type,
					replaced: !!how.replace,
					routed: route,
				} satisfies CalledSession,
			},
		});
	};

	const load = (
		element: Element,
		kid: Kid,
		url: string,
		to: string,
		how: How,
	) => {
		kid.page = pageFor(how.referrer);
		const routed = rebased(to, kid.page);
		kid.want = { url, routed, how, token: askToken(routed) };
		reach(element, kid);
	};

	const told = async (
		element: Element,
		kid: Kid,
		port: MessagePort,
		what: Told,
	) => {
		if (port !== kid.port) return;
		const entry = kid.entries[kid.index];
		switch (what.op) {
			// (a frame's scroll is its own: its steps are within its document)
			case 'scroll':
				break;
			// a token for a frame of the frame's document: asked of this
			// document's host, for a route of the scope only
			case 'token': {
				let to = '';
				try {
					to = new URL(String(what.routed)).href;
				} catch (error) {
					// none
				}
				// (a route of any origin of the pool: the frame's frame may be on
				// another slot)
				const value = routeOn(to) === to && to ? await askToken(to) : null;
				if (port === kid.port) send(port, { token: { id: what.id, value } });
				break;
			}
			case 'push':
			case 'replace': {
				const made: KidEntry = {
					url: String(what.url),
					// (the document's own names for it, which it steps by)
					key: what.op === 'replace' ? entry.key : (what.key ?? id()),
					id: what.entryId ?? id(),
					document: entry.document,
					state: what.state,
					referrer: entry.referrer,
					routed: entry.routed,
				};
				if (what.op === 'push') kid.entries.splice(++kid.index, Infinity, made);
				else kid.entries[kid.index] = made;
				break;
			}
			case 'step': {
				const delta = Number(what.delta) || 0;
				const to = kid.index + delta;
				if (!delta || to < 0 || to >= kid.entries.length) break;
				kid.index = to;
				const next = kid.entries[to];
				if (next.document === entry.document)
					send(port, { pop: { index: to, state: next.state } });
				else
					load(element, kid, next.url, next.routed, {
						type: 'back_forward',
						referrer: next.referrer,
					});
				break;
			}
			case 'navigate': {
				if (what.reload) {
					load(element, kid, entry.url, entry.routed, {
						type: 'reload',
						referrer: entry.referrer,
					});
					break;
				}
				// (a route of the frame's own origin, which may be another slot)
				const to = routeOn(String(what.routed ?? ''));
				if (!to) break;
				const body = what.entries
					? await encoded(what.entries, what.enctype ?? undefined)
					: null;
				load(element, kid, String(what.url), to, {
					type: 'navigate',
					replace: what.replace,
					referrer: kid.routed,
					policy: what.policy,
					...(body && { method: 'POST', ...body }),
				});
				break;
			}
		}
	};

	/** a submission's body as its form encodes it */
	const encoded = async (
		entries: [string, string | File][],
		enctype = '',
	): Promise<{ body: string | Blob; contentType: string }> => {
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
	};
}
