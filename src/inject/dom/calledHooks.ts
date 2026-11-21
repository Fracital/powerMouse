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
// call's port, and the host gives the next document a fresh frame. A
// fragment navigation, pushState and replaceState change only the tab's
// entries and the URL the page reads (the shell's name for the document;
// the frame's own URL has no fragment). back, forward and go are the host's
// steps, which come back over the port as a popstate when the entry is of
// this document. history.length and history.state, the Navigation API's
// entries, current entry and activation, and the performance navigation
// entry's name and type read the tab's history as the host told it and as
// this document changed it since.
//
// The host never reaches into this window: where the document is scrolled
// goes to it over the port as the document scrolls, and a step's entry's
// scroll comes with the step (a pop, or the session of the document written
// for it), restored here. A frame of this document gets its call's token
// from the host over the port too (calledFrames.ts).

import { CALL_WAIT_MS, type CalledSession } from '../../transport/messages';
import ProxyModule from '../modules/Proxy';
import { unrouteURL } from '../modules/Unroute';
import { withStack } from '../nativeErrors';
import { calledFrames } from './calledFrames';
import type DocumentClient from './Client';
import { addDocumentOpenListener } from './Client';
import { destinationURL } from './freshContext';
import { sourcePolicy } from './sourcePolicy';

type Entry = CalledSession['entries'][number];
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
	};
	const { port, session } = called;
	const global = client.global as Globals;
	const navigation = global.navigation;
	if (!port || !session || !navigation || !global.NavigateEvent) return;
	const proxyModule = client.getModule(ProxyModule)!;
	// (the frame's one URL, the call page's)
	const page = global.location.href;
	const { DOMException, structuredClone, setTimeout, Promise } = global;
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
	calledFrames(client, page, session.routed ?? '', askToken);
	const getter = (from: object, name: string) =>
		Reflect.getOwnPropertyDescriptor(from, name)!.get!;
	const dispatch = global.EventTarget.prototype.dispatchEvent;
	const fire = (event: Event) => Reflect.apply(dispatch, global, [event]);
	const eventProto = global.Event.prototype;
	const natives = {
		prevented: getter(eventProto, 'defaultPrevented'),
		cancelable: getter(eventProto, 'cancelable'),
		preventDefault: eventProto.preventDefault,
	};

	// the tab's history as this document has it
	const entries: Entry[] = session.entries.slice();
	let index = session.index;
	let state: unknown = session.state;
	const own = () => entries[index].document;
	const entry = (url: string): Entry => ({
		url,
		key: global.crypto.randomUUID(),
		id: global.crypto.randomUUID(),
		document: own(),
	});
	const popped = (from: string, to: string, value: unknown) => {
		fire(new global.PopStateEvent('popstate', { state: value }));
		const hash = (url: string) => new URL(url).hash;
		if (hash(from) !== hash(to))
			setTimeout(() =>
				fire(
					new global.HashChangeEvent('hashchange', {
						oldURL: from,
						newURL: to,
					}),
				),
			);
	};
	const isScroll = (value: unknown): value is [number, number] =>
		Array.isArray(value) &&
		value.length === 2 &&
		value.every((part) => Number.isFinite(part));
	// the entry's own scroll, unless the page restores it itself
	const restore = (scroll: [number, number]) => {
		if (global.history.scrollRestoration !== 'manual')
			global.scrollTo(scroll[0], scroll[1]);
	};
	// what the host sends: a step of its to an entry of this document, the
	// token a frame's call asked for and its Stop; anything else is dropped
	// (the window's own stop, taken before any script of the page runs: a
	// [Global] interface's operations are the window's own properties, which
	// the page could replace)
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
		const pop = data.pop;
		if (
			!pop ||
			typeof pop !== 'object' ||
			!Number.isInteger(pop.index) ||
			!entries[pop.index]
		)
			return;
		const from = client.locationHref;
		index = pop.index;
		state = pop.state;
		client.rename(entries[index].url);
		if (isScroll(pop.scroll)) restore(pop.scroll);
		popped(from, entries[index].url, state);
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
	const change = (push: boolean, url: string, value: unknown) => {
		const made = entry(url);
		if (push) entries.splice(++index, Infinity, made);
		else entries[index] = { ...made, key: entries[index].key };
		state = value;
		client.rename(url);
		// (with the scroll of the entry left, before a fragment's scrolls it)
		tell({
			op: push ? 'push' : 'replace',
			url,
			state: value,
			scroll: [global.scrollX, global.scrollY],
		});
	};

	const prototype = global.History.prototype;
	const ours = (that: unknown) => that === global.history;
	const historyEntry = (name: 'pushState' | 'replaceState') =>
		proxyModule.wrapFunction(prototype[name], (target, that, args) => {
			if (!ours(that)) return Reflect.apply(target, that, args);
			const value = structuredClone(args[0]);
			let url = client.locationHref;
			if (args[2] !== undefined && args[2] !== null && args[2] !== '') {
				const page = client.url.url;
				const text = `${args[2]}`;
				let to: URL | null;
				try {
					to = new URL(text, client.baseHref);
				} catch (error) {
					to = null;
				}
				if (
					!to ||
					to.protocol !== page.protocol ||
					to.origin !== page.origin ||
					to.username !== page.username ||
					to.password !== page.password
				)
					throw withStack(
						new DOMException(
							`Failed to execute '${name}' on 'History': A history state object with URL '${to ? to.href : text}' cannot be created in a document with origin '${page.origin}' and URL '${page.href}'.`,
							'SecurityError',
						),
					);
				url = to.href;
			}
			change(name === 'pushState', url, value);
		});
	prototype.pushState = historyEntry('pushState');
	prototype.replaceState = historyEntry('replaceState');
	const step = (delta: number) => {
		if (index + delta >= 0 && index + delta < entries.length)
			tell({ op: 'step', delta });
	};
	const reload = () => tell({ op: 'navigate', reload: true });
	prototype.back = proxyModule.wrapFunction(prototype.back, (target, that) =>
		ours(that) ? step(-1) : Reflect.apply(target, that, []),
	);
	prototype.forward = proxyModule.wrapFunction(
		prototype.forward,
		(target, that) => (ours(that) ? step(1) : Reflect.apply(target, that, [])),
	);
	prototype.go = proxyModule.wrapFunction(
		prototype.go,
		(target, that, args) => {
			if (!ours(that)) return Reflect.apply(target, that, args);
			const delta = Math.trunc(Number(args[0])) || 0;
			if (delta) step(delta);
			else reload();
		},
	);
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
	accessor(prototype, 'length', () => entries.length, ours);
	accessor(prototype, 'state', () => state, ours);

	// the Navigation API: the entries of this origin around this one, as the
	// browser lists a document's, made of the tab's
	const Entry = global.NavigationHistoryEntry;
	const fakes = new Map<string, object>();
	const facts = new WeakMap<object, Entry>();
	const fake = (data: Entry) => {
		let made = fakes.get(data.key + data.id);
		if (!made) {
			made = Object.create(Entry.prototype) as object;
			fakes.set(data.key + data.id, made);
			facts.set(made, data);
		}
		return made;
	};
	const origin = (url: string) => new URL(url).origin;
	const run = () => {
		const at = origin(entries[index].url);
		let start = index;
		let end = index;
		while (start > 0 && origin(entries[start - 1].url) === at) start--;
		while (end < entries.length - 1 && origin(entries[end + 1].url) === at)
			end++;
		return { start, end };
	};
	const isFake = (that: object) => facts.has(that);
	for (const [name, answer] of [
		['url', (data: Entry) => data.url],
		['key', (data: Entry) => data.key],
		['id', (data: Entry) => data.id],
		[
			'index',
			(data: Entry) => {
				const at = entries.indexOf(data);
				return at < 0 ? -1 : at - run().start;
			},
		],
		['sameDocument', (data: Entry) => data.document === own()],
	] as const)
		accessor(
			Entry.prototype,
			name,
			(that) => (answer as (data: Entry) => unknown)(facts.get(that)!),
			isFake,
		);
	Entry.prototype.getState = proxyModule.wrapFunction(
		Entry.prototype.getState,
		(target, that, args) =>
			isFake(that)
				? facts.get(that) === entries[index]
					? structuredClone(state)
					: undefined
				: Reflect.apply(target, that, args),
	);
	const Navigation = global.Navigation.prototype;
	const nav = (that: unknown) => that === navigation;
	const listed = () => {
		const { start, end } = run();
		return entries.slice(start, end + 1).map(fake);
	};
	Navigation.entries = proxyModule.wrapFunction(
		Navigation.entries,
		(target, that, args) =>
			nav(that) ? listed() : Reflect.apply(target, that, args),
	);
	accessor(Navigation, 'currentEntry', () => fake(entries[index]), nav);
	accessor(Navigation, 'canGoBack', () => index > 0, nav);
	accessor(Navigation, 'canGoForward', () => index < entries.length - 1, nav);
	const result = () => {
		const done = Promise.resolve(fake(entries[index]));
		return { committed: done, finished: done };
	};
	for (const [name, delta] of [
		['back', -1],
		['forward', 1],
	] as const)
		Navigation[name] = proxyModule.wrapFunction(
			Navigation[name],
			(target, that, args) => {
				if (!nav(that)) return Reflect.apply(target, that, args);
				step(delta);
				return result();
			},
		);
	// a navigate() or reload() the listener below hands to the host is a
	// load of another document: its promises never settle, as natively
	// (the browser's reject, the event being cancelled); one to a fragment
	// is this document's, done at once
	let fragment = false;
	for (const name of ['navigate', 'reload'] as const)
		Navigation[name] = proxyModule.wrapFunction(
			Navigation[name],
			(target, that, args) => {
				if (!nav(that)) return Reflect.apply(target, that, args);
				fragment = false;
				const native = Reflect.apply(target, that, args) as {
					committed: Promise<unknown>;
					finished: Promise<unknown>;
				};
				native.committed.catch(() => {});
				native.finished.catch(() => {});
				if (fragment) return result();
				const never = new Promise(() => {});
				return { committed: never, finished: never };
			},
		);
	Navigation.traverseTo = proxyModule.wrapFunction(
		Navigation.traverseTo,
		(target, that, args) => {
			if (!nav(that)) return Reflect.apply(target, that, args);
			const to = entries.findIndex((data) => data.key === `${args[0]}`);
			if (to >= 0) step(to - index);
			return result();
		},
	);
	// how this document was reached
	const Activation = global.NavigationActivation?.prototype;
	if (Activation) {
		const activation = Object.create(Activation) as object;
		const first = entries[index];
		const before = entries[index - 1];
		const type =
			session.type === 'back_forward'
				? 'traverse'
				: session.type === 'reload'
					? 'reload'
					: session.replaced
						? 'replace'
						: 'push';
		accessor(Navigation, 'activation', () => activation, nav);
		const mine = (that: object) => that === activation;
		accessor(Activation, 'entry', () => fake(first), mine);
		accessor(
			Activation,
			'from',
			() =>
				before && origin(before.url) === origin(first.url)
					? fake(before)
					: null,
			mine,
		);
		accessor(Activation, 'navigationType', () => type, mine);
	}
	// the performance navigation entry: of the page's URL, reached as it was
	const Timing = global.PerformanceNavigationTiming?.prototype;
	if (Timing) {
		// (the entry's own name is the call page's)
		const loaded = entries[index].url;
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

	// last of the proxy's own listeners: a link route's visit (Visited) has
	// been made a plain navigation by now
	const eventOf = global.NavigateEvent.prototype;
	const [downloadOf, typeOf, destinationOf, hashOf, formOf, sourceOf] = [
		'downloadRequest',
		'navigationType',
		'destination',
		'hashChange',
		'formData',
		'sourceElement',
	].map((name) => getter(eventOf, name));
	const sameOf = getter(global.NavigationDestination.prototype, 'sameDocument');
	const formEntries = global.FormData.prototype.entries;
	// the document's referrer policy: its last meta's that names one (the
	// shell's markup is gone by now), else its header's, else the default
	const documentPolicy = () => {
		const metas = global.document.querySelectorAll('meta[name="referrer" i]');
		for (let at = metas.length - 1; at >= 0; at--) {
			const policy = (metas[at].getAttribute('content') ?? '')
				.trim()
				.toLowerCase();
			if (policy) return policy;
		}
		return called.policy ?? '';
	};
	Reflect.apply(global.EventTarget.prototype.addEventListener, navigation, [
		'navigate',
		(event: Event) => {
			const of = (get: Function) => Reflect.apply(get, event, []);
			if (
				of(natives.prevented) ||
				!of(natives.cancelable) ||
				of(downloadOf) !== null
			)
				return;
			const type = of(typeOf) as string;
			if (type === 'traverse') return;
			const destination = of(destinationOf) as object;
			const routed = destinationURL(destination) ?? '';
			// the host sending the frame to the call page again, for the
			// document after this one (calledFrames.ts)
			// (a reload's destination is the call page too: the host's)
			if (type === 'replace' && routed.replace(/#.*$/s, '') === page) return;
			const url = unrouteURL(client, routed) ?? routed;
			Reflect.apply(natives.preventDefault, event, []);
			// a fragment of this document: the browser's own (to the call
			// page's URL), or the proxy's, which goes to the fragment's route
			// (modules/Location.ts), another URL than the frame's to the browser
			const unfragmented = (href: string) => href.replace(/#.*$/s, '');
			if (
				of(hashOf) ||
				(type !== 'reload' &&
					!of(formOf) &&
					url.includes('#') &&
					unfragmented(url) === unfragmented(client.locationHref))
			) {
				// a fragment of this document: an entry of the tab's, the
				// scroll to it, the popstate and the hashchange
				fragment = true;
				const from = client.locationHref;
				change(type !== 'replace', url, null);
				const id = decodeURIComponent(new URL(url).hash.slice(1));
				const document = global.document;
				const target =
					document.getElementById(id) ?? document.getElementsByName(id)[0];
				if (target) target.scrollIntoView();
				else if (id === '' || id.toLowerCase() === 'top') global.scrollTo(0, 0);
				popped(from, url, null);
				return;
			}
			// the proxy's own pushState or replaceState (the page's are the
			// tab's, above): the frame's one entry stays as it is
			if (Reflect.apply(sameOf, destination, [])) return;
			if (type === 'reload') {
				reload();
				return;
			}
			// a submission's entries (a FormData is not cloned), encoded as
			// its submitter says, else its form
			const data = of(formOf) as FormData | null;
			const source = of(sourceOf) as
				(HTMLButtonElement & HTMLFormElement) | null;
			tell({
				op: 'navigate',
				url,
				routed,
				scroll: [global.scrollX, global.scrollY],
				replace: type === 'replace',
				entries: data ? [...Reflect.apply(formEntries, data, [])] : null,
				enctype:
					source && (source.formEnctype || (source.form ?? source).enctype),
				policy: sourcePolicy(source) || documentPolicy(),
			});
		},
	]);
}
