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
// (CALL_PAGE): one page under the scope, the same for every site, which the
// worker serves and so controls. Once it is loaded this page sends it the
// route by a message, with a port; the page asks the worker for its document
// with a fetch of the route that carries CALL_HEADER, which the worker
// answers as that frame's navigation to the route (the same request
// upstream, rewrite and shell: src/server/called.ts), and writes the answer
// into itself. Its src and its location never show anything but the call
// page.
//
// The inject of a document written so (src/inject/dom/calledHooks.ts)
// cancels every navigation its page starts and hands it to the frame's
// CalledFrame here over the port, which gives the next document a fresh
// frame in the element's place (a clean realm, as a navigation's), and
// keeps the tab's session history: the entries, their states and scroll
// positions, with pushState and fragment entries of a document stepped
// within it (a popstate). The history is kept in this page's sessionStorage,
// so a reload of the host shows the tab where it was, and every change of it
// (an entry added, replaced or stepped to, a title) fires `entries` on the
// Frame, for the host's own record of the tab.

import { navigationAnswer } from '../navigationAnswer';
import {
	CALL_HEADER,
	CALL_MESSAGE,
	CALL_PAGE,
	CALL_POLICY_HEADER,
	type CalledSession,
} from '../transport/messages';
import { frameColorScheme } from './colorScheme';
import { stopWindow } from './history';
import type { Frame, StompController } from './index';

/** what Chrome's navigation asks for (its Accept header) */
const NAVIGATION_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
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
	/** the Navigation API's key and id of the entry */
	key: string;
	id: string;
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
};

/** what a called document tells its host (calledHooks.ts) */
type Told = {
	op: 'navigate' | 'push' | 'replace' | 'step';
	url?: string;
	state?: unknown;
	delta?: number;
	/** the scroll of the entry a push leaves */
	scroll?: [number, number];
	replace?: boolean;
	reload?: boolean;
	/** a submission's entries, and how its form encodes them */
	entries?: [string, string | File][] | null;
	enctype?: string;
	policy?: string;
};

const randomId = () => crypto.randomUUID();

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

/** the next message on `port` */
function next(port: MessagePort): Promise<Record<string, any>> {
	return new Promise((resolve) => {
		port.onmessage = ({ data }) => resolve(data ?? {});
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
	/** the load under way (#load): what stop() gives up, and the route it called, once it did */
	#pending: { cancel: () => void; routed: string | null } | null = null;
	/** the routes stop() told the worker to drop, until when (EARLY_STOP_MS) */
	#stopped = new Map<string, number>();
	readonly #key: string;
	constructor(
		public readonly frame: Frame,
		key: string,
	) {
		this.#key = KEPT_PREFIX + key;
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
	/** the entry shown again, as a reload does */
	async reload(): Promise<boolean> {
		const entry = this.entries[this.index];
		if (!entry) return false;
		await this.#load(entry.url, { type: 'reload' });
		return true;
	}
	canStep(delta: number): boolean {
		const to = this.index + delta;
		return to >= 0 && to < this.entries.length;
	}
	/** a step through the tab's history; false when there is no entry there */
	async step(delta: number): Promise<boolean> {
		if (!delta || !this.canStep(delta)) return false;
		this.#leave();
		this.index += delta;
		const to = this.entries[this.index];
		if (to.document === this.#document && this.#port) {
			this.#keep();
			this.#port.postMessage({
				pop: { index: this.index, state: to.state, scroll: to.scroll },
			});
			return true;
		}
		await this.#load(to.url, { type: 'back_forward' });
		return true;
	}
	/**
	 * Stop the tab as Chrome's Stop does (Frame.stop): a load not called
	 * yet is never called, and one whose answer has not come is given up
	 * (its frame goes, and the worker drops its request, so the origin's
	 * connection closes); the frame keeps the document it shows, which
	 * stops loading as on its own window.stop()
	 */
	async stop(): Promise<void> {
		this.#loads++;
		const pending = this.#pending;
		this.#pending = null;
		pending?.cancel();
		stopWindow(this.frame.element.contentWindow);
		if (!pending?.routed) return;
		// (its request may reach the worker after this)
		this.#stopped.set(pending.routed.split('#')[0], Date.now() + EARLY_STOP_MS);
		await this.controller.stopNavigation(pending.routed, true).catch(() => {});
	}
	/** the scroll of the entry being left */
	#leave() {
		const entry = this.entries[this.index];
		const win = this.frame.element.contentWindow;
		if (entry && win)
			try {
				entry.scroll = [win.scrollX, win.scrollY];
			} catch (error) {
				// a document out of reach
			}
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
			case 'push':
			case 'replace': {
				const next = this.#entry(String(told.url), told.state, this.#document);
				if (entry) {
					next.title = entry.title;
					next.referrer = entry.referrer;
				}
				if (told.op === 'push') {
					if (entry && Array.isArray(told.scroll))
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
				void this.step(Number(told.delta) || 0);
				break;
			case 'navigate': {
				if (told.reload) {
					void this.reload();
					break;
				}
				const body = told.entries
					? await encoded(told.entries, told.enctype)
					: null;
				void this.#load(String(told.url), {
					type: 'navigate',
					replace: told.replace,
					referrer: this.#routed,
					policy: told.policy,
					...(body && { method: 'POST', ...body }),
				});
				break;
			}
		}
	}
	/** what the document about to be written is told of the tab */
	#session(how: How): CalledSession {
		return {
			entries: this.entries.map(({ url, key, id, document }) => ({
				url,
				key,
				id,
				document,
			})),
			index: this.index,
			state: this.entries[this.index]?.state ?? null,
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
		// (the preference the document reads: its element's color-scheme,
		// which the fresh element has too, from the same rules)
		controller.reportViewport(
			old.clientWidth,
			old.clientHeight,
			frameColorScheme(old),
		);
		controller.expectNavigation(frame, url);
		const page = new URL(CALL_PAGE, controller.directory).href;
		const fresh = old.ownerDocument.createElement('iframe');
		for (const { name, value } of [...old.attributes])
			if (name !== 'src' && name !== 'srcdoc') fresh.setAttribute(name, value);
		const display = fresh.style.getPropertyValue('display');
		fresh.style.setProperty('display', 'none');
		// (set before it is in the document: the frame's first navigation,
		// which makes no history entry)
		fresh.src = page;
		old.after(fresh);
		const { port1: port, port2 } = new MessageChannel();
		// a reload and a step ask with the entry's own referrer, as natively
		const referrer =
			how.type === 'navigate'
				? (how.referrer ?? '')
				: (this.entries[this.index]?.referrer ?? '');
		let answered: Record<string, any>;
		let routed: string;
		try {
			await until(pageLoad(fresh));
			routed = await until(controller.route(url));
			await until(controller.measureGeometry());
			// a stop of the same route a moment ago is over for this call
			const key = routed.split('#')[0];
			const stopped = this.#stopped.get(key);
			if (stopped !== undefined) {
				this.#stopped.delete(key);
				if (Date.now() < stopped)
					await until(controller.navigationSent(routed).catch(() => {}));
			}
			pending.routed = routed;
			fresh.contentWindow!.postMessage(
				{ [CALL_MESSAGE]: 1 },
				new URL(page).origin,
				[port2],
			);
			const answer = next(port);
			port.postMessage({
				call: {
					routed,
					init: {
						method: how.method ?? 'GET',
						body: how.body ?? null,
						headers: {
							[CALL_HEADER]: how.type,
							accept: NAVIGATION_ACCEPT,
							'upgrade-insecure-requests': '1',
							...(how.contentType && { 'content-type': how.contentType }),
							...(how.policy && { [CALL_POLICY_HEADER]: how.policy }),
						},
						credentials: 'include',
						redirect: 'follow',
						referrer,
						cache: how.type === 'reload' ? 'no-cache' : 'default',
					},
				},
			});
			answered = await until(answer);
			if (answered.failed) throw new Error(answered.failed);
		} catch (error) {
			fresh.remove();
			port.close();
			if (this.#pending === pending) this.#pending = null;
			// stopped: the frame keeps its document
			if (error === STOPPED) return;
			throw error;
		}
		if (this.#pending === pending) this.#pending = null;
		if (load !== this.#loads) {
			fresh.remove();
			port.close();
			return;
		}
		// an answer Chrome commits no document for (a 204, a download): the
		// frame keeps its document and its entry, and the load is over
		const kind = navigationAnswer(
			Number(answered.answered?.status) || 200,
			answered.answered?.type ?? null,
			answered.answered?.disposition ?? null,
		);
		if (kind) {
			if (kind === 'download') {
				// (its frame, hidden, saves it, and stays until the browser has it)
				const saved = next(port);
				port.postMessage({
					save: downloadName(
						answered.answered?.disposition ?? null,
						answered.answered?.url || url,
					),
				});
				void Promise.race([
					saved,
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
			frame.dispatchEvent(new Event('stayed'));
			return;
		}
		// where the answer is from: the page's URL after its redirects, with
		// the fragment asked for when the last one named none
		let shown = url;
		const real = answered.answered?.url;
		if (typeof real === 'string' && real) {
			const after = new URL(real);
			if (!after.hash) after.hash = new URL(url).hash;
			shown = after.href;
			// the referrer of its navigations is the route it ended at
			if (shown !== url) routed = await controller.route(shown);
		}
		if (load !== this.#loads) {
			fresh.remove();
			port.close();
			return;
		}
		// the answer is in: the tab's entries change, and its document
		this.#leave();
		if (how.type === 'navigate') {
			const next = this.#entry(shown, null, ++this.#documents);
			next.referrer = referrer;
			if (how.replace && this.index >= 0) {
				next.key = this.entries[this.index].key;
				this.entries[this.index] = next;
			} else this.entries.splice(++this.index, Infinity, next);
		} else this.entries[this.index].url = shown;
		const entry = this.entries[this.index];
		this.#document = entry.document;
		this.#routed = routed;
		this.#port?.close();
		this.#port = port;
		this.#keep();
		const focused = old.ownerDocument.activeElement === old;
		old.remove();
		if (display) fresh.style.setProperty('display', display);
		else fresh.style.removeProperty('display');
		if (!fresh.getAttribute('style')) fresh.removeAttribute('style');
		frame.adopt(fresh);
		frame.dispatchEvent(new CustomEvent('element', { detail: fresh }));
		port.onmessage = ({ data }) => void this.#told(data as Told, port);
		port.postMessage({ write: { url: shown, session: this.#session(how) } });
		// the frame the user was in keeps the focus, as a navigation's does
		if (focused) fresh.focus();
		if (how.type === 'back_forward' && entry.scroll.some(Boolean)) {
			const [x, y] = entry.scroll;
			fresh.addEventListener(
				'load',
				() => fresh.contentWindow?.scrollTo(x, y),
				{ once: true },
			);
		}
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
 * documents are of the controller's own origin (no site pool).
 */
export async function justCallStomp(
	frame: Frame,
	url?: string | URL,
	options: JustCallStompOptions = {},
): Promise<CalledFrame> {
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
