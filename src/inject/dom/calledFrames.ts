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

import {
	CALL_HEADER,
	CALL_MESSAGE,
	CALL_PAGE,
	CALL_POLICY_HEADER,
	type CalledSession,
} from '../../transport/messages';
import { scopePrefix } from '../modules/Unroute';
import type DocumentClient from './Client';
import { addDocumentOpenListener } from './Client';
import { frameWindow } from './freshContext';

type Globals = typeof globalThis & Record<string, any>;

/** what Chrome's navigation asks for (its Accept header) */
const NAVIGATION_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

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
	/** the document the frame is to be called with next */
	want: { url: string; routed: string; how: How } | null;
	/** the port of the call in flight (a newer one drops it) */
	calling: MessagePort | null;
	/** the port to the document shown */
	port: MessagePort | null;
	/** the written document's load is the page's */
	writing: boolean;
	/** the route of the document shown, the referrer of its navigations */
	routed: string;
}

/** what a called frame's document tells (calledHooks.ts) */
type Told = {
	op: 'navigate' | 'push' | 'replace' | 'step';
	url?: string;
	routed?: string;
	state?: unknown;
	delta?: number;
	replace?: boolean;
	reload?: boolean;
	entries?: [string, string | File][] | null;
	enctype?: string;
	policy?: string;
};

export function calledFrames(
	client: DocumentClient,
	page: string,
	routed: string,
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
		return kid;
	};
	const id = () => crypto.randomUUID();

	const hrefOf = (win: Window | null) => {
		try {
			return win ? win.location.href : '';
		} catch (error) {
			return '';
		}
	};
	/** the frame to the call page again: a replace, no entry */
	const reach = (element: Element, kid: Kid): string | true => {
		kid.calling = null;
		const win = frameWindow(element);
		if (hrefOf(win) !== kidPage) return kidPage;
		win!.location.replace(kidPage);
		return true;
	};

	// a frame of this document on its call page takes no message of the
	// page's: its call is this document's hooks' alone (the page's poster,
	// modules/Context.ts)
	const pages = new URL(CALL_PAGE, kidPage).href;
	client.callPageWindow = (receiver) =>
		hrefOf(receiver as Window).startsWith(pages);

	client.callFrame = (element, url, to) => {
		if (element.nodeName !== 'IFRAME' && element.nodeName !== 'FRAME')
			return false;
		let absolute: string;
		try {
			absolute = new URL(to, page).href;
		} catch (error) {
			return false;
		}
		if (!absolute.startsWith(scope)) return false;
		let kid = kids.get(element);
		if (!kid) {
			kid = {
				entries: [],
				index: -1,
				documents: 0,
				want: null,
				calling: null,
				port: null,
				writing: false,
				routed: '',
			};
			kids.set(element, kid);
		}
		kid.want = {
			url,
			routed: absolute,
			how: { type: 'navigate', referrer: routed },
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
			return;
		}
		const win = frameWindow(element);
		if (hrefOf(win) !== kidPage || !kid.want) return;
		Reflect.apply(stop, event, []);
		void call(element, kid, win!);
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
		const answered = new Promise<Record<string, any>>((resolve) => {
			port.onmessage = ({ data }) => resolve(data ?? {});
		});
		Reflect.apply(windowPost, win, [{ [CALL_MESSAGE]: 1 }, origin, [port2]]);
		const { how } = want;
		send(port, {
			call: {
				routed: want.routed,
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
					referrer: how.referrer,
					cache: how.type === 'reload' ? 'no-cache' : 'default',
				},
			},
		});
		const answer = await answered;
		if (kid.calling !== port || answer.failed) {
			port.close();
			return;
		}
		kid.calling = null;
		let shown = want.url;
		const real = answer.answered?.url;
		if (typeof real === 'string' && real) {
			const after = new URL(real);
			if (!after.hash) after.hash = new URL(want.url).hash;
			shown = after.href;
		}
		const route =
			typeof answer.answered?.routed === 'string' && answer.answered.routed
				? answer.answered.routed
				: want.routed;
		if (how.type === 'navigate') {
			const made: KidEntry = {
				url: shown,
				key: id(),
				id: id(),
				document: ++kid.documents,
				state: null,
				referrer: how.referrer,
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
		port.onmessage = ({ data }) => void told(element, kid, port, data as Told);
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
		kid.want = { url, routed: to, how };
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
			case 'push':
			case 'replace': {
				const made: KidEntry = {
					url: String(what.url),
					key: what.op === 'replace' ? entry.key : id(),
					id: id(),
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
				let to = String(what.routed ?? '');
				try {
					to = new URL(to, page).href;
				} catch (error) {
					to = '';
				}
				if (!to.startsWith(scope)) break;
				const body = what.entries
					? await encoded(what.entries, what.enctype)
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
