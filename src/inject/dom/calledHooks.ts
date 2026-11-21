// Just call stomp (src/controller/justCallStomp.ts): the hooks of a
// document its call page wrote into itself, a deferred part
// (./deferredParts.ts) that only such a document evaluates, when its client
// applies (modules/Called.ts).
//
// Its host keeps the tab's session history. The browser's own history of the
// frame is one entry, the call page's, that never changes, so nothing the
// page does may navigate the frame: every navigation the page starts (a
// link, a form, a location write, a refresh, window.open into itself, a
// reload) is cancelled in its `navigate` event and told to the host over the
// call's port, and the host gives the next document a fresh frame. The
// session history as the page reads it (history, the Navigation API, its
// events, intercept() and the traversals of the host) is
// ./calledNavigation.ts. The performance navigation entry's name and type
// read the tab's history as the host told it.
//
// The host never reaches into this window: where the document is scrolled
// goes to it over the port as the document scrolls, and a step's entry's
// scroll comes with the step (a pop, or the session of the document written
// for it), restored here. A frame of this document gets its call's token
// from the host over the port too (calledFrames.ts).

import { CALL_WAIT_MS, type CalledSession } from '../../transport/messages';
import ProxyModule from '../modules/Proxy';
import { calledFrames } from './calledFrames';
import { calledNavigation } from './calledNavigation';
import type DocumentClient from './Client';
import { addDocumentOpenListener } from './Client';

type Globals = typeof globalThis & Record<string, any>;

const LEGACY_TYPES: Record<string, number> = {
	navigate: 0,
	reload: 1,
	back_forward: 2,
};

export function calledHooks(client: DocumentClient) {
	const called = client.called as {
		port: MessagePort;
		session: CalledSession;
		policy?: string;
		moved?: (how: string) => void;
		/** the call page's URL, where its frame reads about:srcdoc (config.srcdocCalls) */
		page?: string;
	};
	const { port, session } = called;
	const global = client.global as Globals;
	const navigation = global.navigation;
	if (!port || !session || !navigation || !global.NavigateEvent) return;
	const proxyModule = client.getModule(ProxyModule)!;
	// (the frame's one URL, the call page's)
	const page = global.location.href;
	const { setTimeout, Promise } = global;
	const post = global.MessagePort.prototype.postMessage;
	const tell = (message: object) => Reflect.apply(post, port, [message]);
	// a token for a frame of this document's call, which the host has its
	// worker hold (null: refused, or no answer within the call's wait)
	const asked = new Map<number, (token: string | null) => void>();
	let asks = 0;
	const askToken = (routed: string) =>
		new Promise<string | null>((resolve) => {
			const id = ++asks;
			const timer = setTimeout(() => {
				asked.delete(id);
				resolve(null);
			}, CALL_WAIT_MS);
			asked.set(id, (token) => {
				clearTimeout(timer);
				asked.delete(id);
				resolve(token);
			});
			tell({ op: 'token', id, routed });
		});
	// this document's own frames are called too
	// (the page its frames' call pages are numbered from: offline.html's
	// frame reads about:srcdoc, and its call page says which it is)
	calledFrames(
		client,
		client.srcdocCalls && typeof called.page === 'string' ? called.page : page,
		session.routed ?? '',
		askToken,
	);
	const isScroll = (value: unknown): value is [number, number] =>
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((part) => Number.isFinite(part));
	// the entry's own scroll, unless the page restores it itself
	const restore = (scroll: [number, number]) => {
		if (global.history.scrollRestoration !== 'manual')
			global.scrollTo(scroll[0], scroll[1]);
	};
	// the session history and the Navigation API (refused, with no hook of
	// this document's, where the browser has no Navigation API: the host
	// refuses to dial there, justCallStomp.ts)
	const history = calledNavigation(client, called, page, tell);
	if (!history) return;
	// what the host sends: the token a frame's call asked for and its Stop,
	// else its word on the session history (calledNavigation.ts), which
	// checks its own (the window's own stop, taken before any script of the
	// page runs: a [Global] interface's operations are the window's own
	// properties, which the page could replace)
	const ownStop = global.stop;
	port.onmessage = ({ data }) => {
		if (!data || typeof data !== 'object') return;
		// the host's Stop (CalledFrame.stop): this document stops loading, as
		// on its own window.stop(); a host of another origin cannot call it
		if (data.stop === true && Object.keys(data).length === 1) {
			Reflect.apply(ownStop, global, []);
			return;
		}
		const token = data.token;
		if (token && typeof token === 'object') {
			const value = token.value;
			if (value === null || (typeof value === 'string' && value.length <= 64))
				asked.get(token.id)?.(value);
			return;
		}
		history.heard(data);
	};
	// where the document is scrolled, for the entry it is when the host
	// leaves it (the window's first listener, capturing: a page's own does
	// not stop it), and a step to an entry of another document: its scroll
	// once it has loaded, as a browser restores a traversal's. Again after
	// each open (loadHTML's, which writes the real page, among them), which
	// erases the window's listeners
	const addListener = global.EventTarget.prototype.addEventListener;
	const reported = () =>
		tell({ op: 'scroll', scroll: [global.scrollX, global.scrollY] });
	// (at each load: the shell's, before loadHTML writes the real page,
	// restores nothing yet)
	const restoring =
		session.type === 'back_forward' && isScroll(session.scroll)
			? session.scroll
			: null;
	const restored = () => {
		if (restoring) setTimeout(() => restore(restoring));
	};
	const listen = () => {
		Reflect.apply(addListener, global, [
			'scroll',
			reported,
			{ capture: true, passive: true },
		]);
		// (this part may arrive once the document has loaded)
		if (restoring && global.document.readyState === 'complete') restored();
		else if (restoring)
			Reflect.apply(addListener, global, [
				'load',
				restored,
				{ capture: true, once: true },
			]);
	};
	listen();
	addDocumentOpenListener(global, listen);
	const accessor = (
		from: object,
		name: string,
		answer: (that: any) => unknown,
		mine: (that: any) => boolean,
	) => {
		const descriptor = Reflect.getOwnPropertyDescriptor(from, name);
		if (!descriptor?.get) return;
		Reflect.defineProperty(from, name, {
			...descriptor,
			get: proxyModule.wrapFunction(descriptor.get, (target, that) =>
				mine(that) ? answer(that) : Reflect.apply(target, that, []),
			),
		});
	};
	// the performance navigation entry: of the page's URL, reached as it was
	const Timing = global.PerformanceNavigationTiming?.prototype;
	if (Timing) {
		// (the entry's own name is the call page's)
		const loaded = session.entries[session.index].url;
		client.calledName = (name) => (name === page ? loaded : undefined);
		accessor(
			Timing,
			'type',
			() => session.type,
			(that) => Reflect.getPrototypeOf(that) === Timing,
		);
	}
	const Legacy = global.PerformanceNavigation?.prototype;
	if (Legacy)
		accessor(
			Legacy,
			'type',
			() => LEGACY_TYPES[session.type],
			(that) => Reflect.getPrototypeOf(that) === Legacy,
		);
}
