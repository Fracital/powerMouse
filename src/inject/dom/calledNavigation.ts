// Just call stomp (src/controller/justCallStomp.ts): a called document's
// session history and Navigation API, part of the calledHooks deferred part
// (./calledHooks.ts), which only a called document evaluates.
//
// The frame's own history is one entry, the call page's, which never
// changes: the host keeps the tab's session history (a frame's host, the
// document above it, keeps the frame's: calledFrames.ts), and this document
// keeps the entries of its origin around its own and the length of the
// whole, as the host told it and as the document changed them since.
// Every navigation the page starts is the browser's no further than its
// `navigate` event, which is cancelled and never reaches the page: the page
// hears one of its own, made here with the values Chrome gives
// (NavigateEvent, NavigationDestination, NavigationHistoryEntry,
// NavigationTransition, NavigationActivation, PageSwapEvent and
// NavigationCurrentEntryChangeEvent expose the state kept here). These
// events are synthetic: `isTrusted` is false, as the browser sets it, and
// nothing reads them as a user's gesture. `intercept()` makes the
// navigation this document's: its URL and state are committed to the entry,
// the host told of it, and its handlers run as Chrome runs them. A
// navigation nothing intercepted is a fragment of this document (applied by
// the browser itself to the frame's one entry, replaced, so `:target` and
// the scroll are its own) or another document's, which the host loads in a
// fresh frame. A traversal is the host's: the tab's host asks the document
// to fire its `navigate` event first (`traverse`), and steps (`pop`) only
// when it was not cancelled. What cannot be had as natively refuses as the
// browser does (a navigation that cannot be intercepted throws its
// SecurityError, a key of no entry here rejects), never resolves as done.
// Everything crosses the call's port as messages: the host never reads this
// window, which may be of another origin (a content slot).

import type { CalledSession } from '../../transport/messages';
import ProxyModule from '../modules/Proxy';
import { unrouteURL } from '../modules/Unroute';
import { withStack } from '../nativeErrors';
import type DocumentClient from './Client';
import { addDocumentOpenListener } from './Client';
import { destinationURL } from './freshContext';
import { sourcePolicy } from './sourcePolicy';

type Entry = CalledSession['entries'][number];
type Globals = typeof globalThis & Record<string, any>;
type Kind = 'push' | 'replace' | 'reload' | 'traverse';

/** what a called document tells its host (or the document above it) */
export type CalledTold = {
	op:
		| 'navigate'
		| 'push'
		| 'replace'
		| 'update'
		| 'step'
		| 'traversing'
		| 'swapped';
	[key: string]: unknown;
};

/** a navigation API method's promises (navigate(), reload(), traverseTo(), back(), forward()) */
interface Tracker {
	committed: Promise<unknown>;
	finished: Promise<unknown>;
	resolveCommitted: (value: unknown) => void;
	rejectCommitted: (reason: unknown) => void;
	resolveFinished: (value: unknown) => void;
	rejectFinished: (reason: unknown) => void;
	info: unknown;
	/** the state navigate() or reload() gave, when it gave one */
	navState?: { value: unknown };
	/** a traversal's entry */
	key?: string;
	/** navigate()'s `history` */
	history?: string;
	entry: object | null;
	done: boolean;
	/** its navigate event fired */
	fired?: boolean;
}

/** what a navigate event of this file reads */
interface EventFacts {
	type: Kind;
	destination: object;
	canIntercept: boolean;
	userInitiated: boolean;
	hashChange: boolean;
	controller: AbortController;
	formData: FormData | null;
	downloadRequest: string | null;
	info: unknown;
	sourceElement: Element | null;
	cancelable: boolean;
	dispatching: boolean;
	interception: 'none' | 'intercepted' | 'committed' | 'scrolled' | 'finished';
	handlers: Function[];
	precommit: Function[];
	focusReset: string | null;
	scroll: string | null;
	tracker: Tracker | null;
	event: Event;
	/** the URL the navigation goes to (a precommit handler's redirect changes it) */
	url: string;
}

interface DestinationFacts {
	url: string;
	key: string;
	id: string;
	index: number;
	sameDocument: boolean;
	state: unknown;
}

interface TransitionFacts {
	type: Kind;
	from: object;
	finished: Promise<unknown>;
	committed: Promise<unknown>;
	resolveFinished: (value: unknown) => void;
	rejectFinished: (reason: unknown) => void;
	resolveCommitted: (value: unknown) => void;
	rejectCommitted: (reason: unknown) => void;
}

export interface CalledNavigation {
	/** a message of the host's for this document's history */
	heard(data: Record<string, any>): void;
}

export function calledNavigation(
	client: DocumentClient,
	called: {
		port: MessagePort;
		session: CalledSession;
		policy?: string;
		moved?: (how: string) => void;
	},
	page: string,
	tell: (message: CalledTold) => void,
): CalledNavigation | undefined {
	const { session } = called;
	const global = client.global as Globals;
	const navigation = global.navigation;
	if (!navigation || !global.NavigateEvent) return undefined;
	const proxyModule = client.getModule(ProxyModule)!;
	const {
		DOMException,
		structuredClone,
		Promise,
		AbortController,
		EventTarget,
		Event,
		URL,
		Reflect,
		Object,
		crypto,
	} = global;
	const getter = (from: object, name: string) =>
		Reflect.getOwnPropertyDescriptor(from, name)?.get;
	const eventProto = Event.prototype;
	const natives = {
		prevented: getter(eventProto, 'defaultPrevented')!,
		cancelable: getter(eventProto, 'cancelable')!,
		preventDefault: eventProto.preventDefault,
		stopImmediate: eventProto.stopImmediatePropagation,
		dispatch: EventTarget.prototype.dispatchEvent,
		listen: EventTarget.prototype.addEventListener,
		unlisten: EventTarget.prototype.removeEventListener,
		then: Promise.prototype.then,
		abort: AbortController.prototype.abort,
		signal: getter(AbortController.prototype, 'signal')!,
		setPrototypeOf: Reflect.setPrototypeOf,
		scrollTo: global.scrollTo,
		getElementById: global.Document.prototype.getElementById,
		activeElement: getter(global.Document.prototype, 'activeElement')!,
		focus: global.HTMLElement.prototype.focus,
		blur: global.HTMLElement.prototype.blur,
		scrollRestoration: getter(global.History.prototype, 'scrollRestoration')!,
		randomUUID: crypto.randomUUID,
		reload: global.location.reload,
		destinationState: global.NavigationDestination.prototype.getState,
		eventInfo: getter(global.NavigateEvent.prototype, 'info')!,
	};
	const prevented = (event: Event) =>
		Reflect.apply(natives.prevented, event, []) as boolean;
	const uuid = () => Reflect.apply(natives.randomUUID, crypto, []) as string;
	const then = (
		promise: Promise<unknown>,
		ok: (value: unknown) => unknown,
		fail: (reason: unknown) => unknown,
	) => Reflect.apply(natives.then, promise, [ok, fail]) as Promise<unknown>;
	const handled = (promise: Promise<unknown>) => {
		then(
			promise,
			() => {},
			() => {},
		);
		return promise;
	};
	const microtask = (callback: () => void) =>
		then(Promise.resolve(), callback, () => {});
	const task = (callback: () => void) => {
		const channel = new global.MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			callback();
		};
		channel.port2.postMessage(null);
	};
	const domError = (message: string, name: string) =>
		withStack(new DOMException(message, name));

	// ---- the history as this document has it ------------------------------

	const entries: Entry[] = session.entries.slice();
	let index = session.index;
	/** the classic history state of the current entry (history.state) */
	let state: unknown = session.state;
	const joint = session.joint
		? { ...session.joint }
		: { length: entries.length, index };
	const ownDocument = entries[index].document;
	const current = () => entries[index];
	const originOf = (url: string) => {
		try {
			return new URL(url).origin;
		} catch (error) {
			return 'null';
		}
	};
	/** the run of this document's origin around the current entry, which the browser lists */
	const run = () => {
		const at = originOf(current().url);
		let start = index;
		let end = index;
		while (start > 0 && originOf(entries[start - 1].url) === at) start--;
		while (end < entries.length - 1 && originOf(entries[end + 1].url) === at)
			end++;
		return { start, end };
	};
	const unfragmented = (href: string) => href.replace(/#.*$/s, '');
	const fragmentOf = (href: string) => {
		const at = href.indexOf('#');
		return at < 0 ? null : href.slice(at + 1);
	};

	const fire = (target: EventTarget, event: Event): boolean =>
		Reflect.apply(natives.dispatch, target, [event]);
	/** an event of one of the realm's classes the page cannot make with these values */
	const made = (type: string, proto: object, cancelable = false) => {
		const event = new Event(type, { cancelable });
		Reflect.apply(natives.setPrototypeOf, Reflect, [event, proto]);
		return event;
	};

	// ---- the realm's objects, answered from what is kept here ------------

	const accessor = (
		from: object | undefined,
		name: string,
		answer: (that: any) => unknown,
		mine: (that: any) => boolean,
		set?: (that: any, value: unknown) => void,
	) => {
		if (!from) return;
		const descriptor = Reflect.getOwnPropertyDescriptor(from, name);
		if (!descriptor?.get) return;
		Reflect.defineProperty(from, name, {
			...descriptor,
			get: proxyModule.wrapFunction(descriptor.get, (target, that) =>
				mine(that) ? answer(that) : Reflect.apply(target, that, []),
			),
			...(set &&
				descriptor.set && {
					set: proxyModule.wrapFunction(descriptor.set, (target, that, args) =>
						mine(that) ? set(that, args[0]) : Reflect.apply(target, that, args),
					),
				}),
		});
	};
	const method = (
		from: object | undefined,
		name: string,
		answer: (that: any, args: unknown[]) => unknown,
		mine: (that: any) => boolean,
	) => {
		if (!from) return;
		const descriptor = Reflect.getOwnPropertyDescriptor(from, name);
		if (typeof descriptor?.value !== 'function') return;
		Reflect.defineProperty(from, name, {
			...descriptor,
			value: proxyModule.wrapFunction(descriptor.value, (target, that, args) =>
				mine(that) ? answer(that, args) : Reflect.apply(target, that, args),
			),
		});
	};

	// NavigationHistoryEntry: an EventTarget of the realm's own (dispose)
	const EntryProto = global.NavigationHistoryEntry.prototype;
	const entryObjects = new Map<string, object>();
	const entryFacts = new WeakMap<object, Entry>();
	const entryHandlers = new WeakMap<object, unknown>();
	const entryObject = (data: Entry): object => {
		let made = entryObjects.get(data.id);
		if (!made) {
			made = new EventTarget();
			Reflect.apply(natives.setPrototypeOf, Reflect, [made, EntryProto]);
			entryObjects.set(data.id, made);
		}
		// (the same entry, its data changed in place: a reload's state)
		entryFacts.set(made, data);
		return made;
	};
	const isEntry = (that: unknown) =>
		!!that && typeof that === 'object' && entryFacts.has(that);
	const factsOf = (that: object) => entryFacts.get(that)!;
	/** the entry's place in the run the browser lists, -1 once it is gone */
	const listedIndex = (data: Entry) => {
		const at = entries.indexOf(data);
		if (at < 0) return -1;
		const { start, end } = run();
		return at < start || at > end ? -1 : at - start;
	};
	accessor(EntryProto, 'url', (that) => factsOf(that).url, isEntry);
	accessor(EntryProto, 'key', (that) => factsOf(that).key, isEntry);
	accessor(EntryProto, 'id', (that) => factsOf(that).id, isEntry);
	accessor(EntryProto, 'index', (that) => listedIndex(factsOf(that)), isEntry);
	accessor(
		EntryProto,
		'sameDocument',
		(that) => factsOf(that).document === ownDocument,
		isEntry,
	);
	const clone = (value: unknown) =>
		value === undefined ? undefined : structuredClone(value);
	method(
		EntryProto,
		'getState',
		(that) => clone(factsOf(that).navState),
		isEntry,
	);
	accessor(
		EntryProto,
		'ondispose',
		(that) => entryHandlers.get(that) ?? null,
		isEntry,
		(that, value) => {
			const handler =
				typeof value === 'function' || (typeof value === 'object' && value)
					? value
					: null;
			const had = entryHandlers.has(that);
			if (handler === null) entryHandlers.delete(that);
			else entryHandlers.set(that, handler);
			if (!had && handler !== null)
				Reflect.apply(natives.listen, that, [
					'dispose',
					function (this: unknown, event: Event) {
						const now = entryHandlers.get(that);
						if (typeof now !== 'function') return;
						const result = Reflect.apply(now, this, [event]);
						if (result === false)
							Reflect.apply(natives.preventDefault, event, []);
					},
				]);
		},
	);

	// NavigationDestination
	const DestinationProto = global.NavigationDestination.prototype;
	const destinationFacts = new WeakMap<object, DestinationFacts>();
	const isDestination = (that: unknown) =>
		!!that && typeof that === 'object' && destinationFacts.has(that);
	const destinationOf = (facts: DestinationFacts) => {
		const made = Object.create(DestinationProto) as object;
		destinationFacts.set(made, facts);
		return made;
	};
	for (const name of ['url', 'key', 'id', 'index', 'sameDocument'] as const)
		accessor(
			DestinationProto,
			name,
			(that) => destinationFacts.get(that)![name],
			isDestination,
		);
	method(
		DestinationProto,
		'getState',
		(that) => clone(destinationFacts.get(that)!.state),
		isDestination,
	);

	// NavigateEvent
	const NavigateProto = global.NavigateEvent.prototype;
	const eventFacts = new WeakMap<object, EventFacts>();
	const isNavigate = (that: unknown) =>
		!!that && typeof that === 'object' && eventFacts.has(that);
	const navigateFacts = (that: object) => eventFacts.get(that)!;
	for (const [name, read] of [
		['navigationType', (f: EventFacts) => f.type],
		['destination', (f: EventFacts) => f.destination],
		['canIntercept', (f: EventFacts) => f.canIntercept],
		['userInitiated', (f: EventFacts) => f.userInitiated],
		['hashChange', (f: EventFacts) => f.hashChange],
		[
			'signal',
			(f: EventFacts) => Reflect.apply(natives.signal, f.controller, []),
		],
		['formData', (f: EventFacts) => f.formData],
		['downloadRequest', (f: EventFacts) => f.downloadRequest],
		['info', (f: EventFacts) => f.info],
		['hasUAVisualTransition', () => false],
		['sourceElement', (f: EventFacts) => f.sourceElement],
	] as const)
		accessor(
			NavigateProto,
			name,
			(that) => (read as (f: EventFacts) => unknown)(navigateFacts(that)),
			isNavigate,
		);

	// NavigationTransition
	const TransitionProto = global.NavigationTransition?.prototype;
	const transitionFacts = new WeakMap<object, TransitionFacts>();
	const isTransition = (that: unknown) =>
		!!that && typeof that === 'object' && transitionFacts.has(that);
	for (const [name, read] of [
		['navigationType', (f: TransitionFacts) => f.type],
		['from', (f: TransitionFacts) => f.from],
		['finished', (f: TransitionFacts) => f.finished],
		['committed', (f: TransitionFacts) => f.committed],
	] as const)
		accessor(
			TransitionProto,
			name,
			(that) =>
				(read as (f: TransitionFacts) => unknown)(transitionFacts.get(that)!),
			isTransition,
		);
	let transition: object | null = null;

	// NavigationCurrentEntryChangeEvent
	const ChangeProto = global.NavigationCurrentEntryChangeEvent?.prototype;
	const changeFacts = new WeakMap<
		object,
		{ type: Kind | null; from: object }
	>();
	const isChange = (that: unknown) =>
		!!that && typeof that === 'object' && changeFacts.has(that);
	accessor(
		ChangeProto,
		'navigationType',
		(that) => changeFacts.get(that)!.type,
		isChange,
	);
	accessor(
		ChangeProto,
		'from',
		(that) => changeFacts.get(that)!.from,
		isChange,
	);

	// ---- the API method trackers -----------------------------------------

	const tracker = (info: unknown): Tracker => {
		let resolveCommitted!: (value: unknown) => void;
		let rejectCommitted!: (reason: unknown) => void;
		let resolveFinished!: (value: unknown) => void;
		let rejectFinished!: (reason: unknown) => void;
		const committed = new Promise((resolve, reject) => {
			resolveCommitted = resolve;
			rejectCommitted = reject;
		});
		const finished = new Promise((resolve, reject) => {
			resolveFinished = resolve;
			rejectFinished = reject;
		});
		// (one rejection is reported, not two)
		handled(finished);
		return {
			committed,
			finished,
			resolveCommitted,
			rejectCommitted,
			resolveFinished,
			rejectFinished,
			info,
			entry: null,
			done: false,
		};
	};
	const result = (made: Tracker) => ({
		committed: made.committed,
		finished: made.finished,
	});
	/** the tracker's committed-to entry (notify about the committed-to entry) */
	const trackerCommitted = (made: Tracker | null, entry: object) => {
		if (!made || made.entry) return;
		made.entry = entry;
		made.resolveCommitted(entry);
	};
	const trackerFinished = (made: Tracker | null) => {
		if (!made || made.done) return;
		made.done = true;
		made.resolveFinished(made.entry);
		dropTracker(made);
	};
	const trackerFailed = (made: Tracker | null, error: unknown) => {
		if (!made || made.done) return;
		made.done = true;
		if (!made.entry) made.rejectCommitted(error);
		made.rejectFinished(error);
		dropTracker(made);
	};
	/** the trackers of traversals asked for and not yet committed, by entry key */
	const upcomingTraversals = new Map<string, Tracker>();
	const dropTracker = (made: Tracker) => {
		if (made.key !== undefined && upcomingTraversals.get(made.key) === made)
			upcomingTraversals.delete(made.key);
	};
	/** a refusal both of whose promises reject at once */
	const refused = (message: string, name = 'InvalidStateError') => {
		const error = domError(message, name);
		const committed = Promise.reject(error);
		const finished = Promise.reject(error);
		handled(finished);
		return { committed, finished };
	};

	// ---- the ongoing navigation --------------------------------------------

	/** the navigate event whose navigation is going on (intercepted, or another document's) */
	let ongoing: EventFacts | null = null;
	let focusChanged = false;
	const abortError = () => domError('Navigation was aborted', 'AbortError');
	const fireError = (error: unknown) => {
		const isError = error instanceof global.Error;
		fire(
			navigation,
			new global.ErrorEvent('navigateerror', {
				error,
				message: isError ? String((error as Error).message) : '',
			}),
		);
	};
	/** abort the ongoing navigation with `error` (an AbortError by default) */
	const abortOngoing = (error: unknown = abortError()) => {
		const facts = ongoing;
		if (!facts) return;
		ongoing = null;
		focusChanged = false;
		if (facts.dispatching)
			Reflect.apply(natives.preventDefault, facts.event, []);
		facts.interception = 'finished';
		Reflect.apply(natives.abort, facts.controller, [error]);
		fireError(error);
		trackerFailed(facts.tracker, error);
		const made = transition;
		if (made) {
			transition = null;
			const own = transitionFacts.get(made)!;
			own.rejectCommitted(error);
			own.rejectFinished(error);
		}
	};

	// ---- commits -------------------------------------------------------------

	const disposeAll = (gone: Entry[]) => {
		for (const data of gone) {
			const made = entryObjects.get(data.id);
			if (!made) continue;
			entryObjects.delete(data.id);
			fire(made as EventTarget, new Event('dispose'));
		}
	};
	const currentChanged = (type: Kind | null, from: object) => {
		const event = made('currententrychange', ChangeProto ?? eventProto);
		changeFacts.set(event, { type, from });
		fire(navigation, event);
	};
	/**
	 * The URL and history update steps of a same-document navigation of
	 * `kind` to `url` (an intercepted one, a fragment, pushState or
	 * replaceState): the entries change, the host hears of it and the page
	 * reads its new URL; then the tracker is told and currententrychange
	 * fires, then the dispose of every entry it removed
	 */
	const commitSame = (
		kind: 'push' | 'replace' | 'reload',
		url: string,
		classic: unknown,
		navState: { value: unknown } | undefined,
		made: Tracker | null,
	) => {
		const from = entryObject(current());
		const gone: Entry[] = [];
		if (kind === 'push') {
			gone.push(...entries.splice(index + 1, Infinity));
			entries.push({
				url,
				key: uuid(),
				id: uuid(),
				document: ownDocument,
				...(navState && { navState: navState.value }),
			});
			index++;
			joint.index++;
			joint.length = joint.index + 1;
			state = classic;
			client.rename(url);
			called.moved?.('push');
			tell({
				op: 'push',
				url,
				state: classic,
				navState: navState?.value,
				scroll: [global.scrollX, global.scrollY],
				key: current().key,
				entryId: current().id,
			});
		} else if (kind === 'replace') {
			const old = current();
			gone.push(old);
			entries[index] = {
				url,
				key: old.key,
				id: uuid(),
				document: ownDocument,
				// (replaceState's has none, as Chrome's)
				...(navState && { navState: navState.value }),
			};
			state = classic;
			client.rename(url);
			called.moved?.('replace');
			tell({
				op: 'replace',
				url,
				state: classic,
				navState: current().navState,
				key: current().key,
				entryId: current().id,
			});
		} else if (navState) {
			current().navState = navState.value;
			tell({ op: 'update', navState: navState.value });
		}
		trackerCommitted(made, entryObject(current()));
		currentChanged(kind, from);
		disposeAll(gone);
	};

	// ---- the fragment ----------------------------------------------------------

	/**
	 * The scroll to the fragment of `url` (its element, by id, else by name;
	 * the top for none or `top`), unless `keep` (a traversal restores its
	 * own). The frame's own URL never takes the fragment: it would show the
	 * page's fragment to the browser (its webNavigation, the frame's real
	 * location), so `:target` does not match in a dialed document.
	 */
	const applyFragment = (url: string, keep: boolean) => {
		if (keep) return;
		let name = fragmentOf(url) ?? '';
		try {
			name = decodeURIComponent(name);
		} catch (error) {
			// as written
		}
		const document = global.document;
		const target = name
			? ((Reflect.apply(natives.getElementById, document, [
					name,
				]) as Element | null) ?? document.getElementsByName(name)[0])
			: null;
		if (target) target.scrollIntoView();
		else if (name === '' || name.toLowerCase() === 'top')
			Reflect.apply(natives.scrollTo, global, [0, 0]);
	};
	/** scroll to the fragment of the document's URL, or to its top without one */
	const scrollToFragment = () => {
		const url = client.locationHref;
		if (fragmentOf(url) === null) {
			Reflect.apply(natives.scrollTo, global, [0, 0]);
			return;
		}
		applyFragment(url, false);
	};
	const restoreScroll = (scroll: unknown) => {
		if (!Array.isArray(scroll)) return;
		Reflect.apply(natives.scrollTo, global, [
			Number(scroll[0]) || 0,
			Number(scroll[1]) || 0,
		]);
	};
	const manualRestoration = () =>
		Reflect.apply(natives.scrollRestoration, global.history, []) === 'manual';
	/** the scroll of the entry a traversal arrived at, kept for its commit */
	const arrivedScroll = new WeakMap<EventFacts, unknown>();

	// ---- the navigate event ------------------------------------------------

	const pageURL = () => client.url.url;
	/** whether the document's URL can become `url` (a same-document navigation) */
	const rewritable = (url: string) => {
		let to: URL;
		try {
			to = new URL(url);
		} catch (error) {
			return false;
		}
		const from = new URL(client.locationHref);
		if (
			to.protocol !== from.protocol ||
			to.username !== from.username ||
			to.password !== from.password ||
			to.host !== from.host
		)
			return false;
		if (to.protocol === 'http:' || to.protocol === 'https:') return true;
		if (to.protocol === 'file:') return to.pathname === from.pathname;
		return to.pathname === from.pathname && to.search === from.search;
	};
	const listenFocus = () =>
		Reflect.apply(natives.listen, global.document, [
			'focusin',
			() => {
				if (ongoing) focusChanged = true;
			},
			true,
		]);
	listenFocus();
	addDocumentOpenListener(global, listenFocus);

	/**
	 * The navigate event of a navigation to `destination`; the facts of the
	 * event as it was left (cancelled, intercepted, neither)
	 */
	const navigate = (init: {
		type: Kind;
		destination: DestinationFacts;
		userInitiated: boolean;
		formData?: FormData | null;
		downloadRequest?: string | null;
		info?: unknown;
		sourceElement?: Element | null;
		cancelable?: boolean;
		/** (pushState and replaceState: never a fragment navigation) */
		hashChange?: boolean;
		tracker: Tracker | null;
	}): EventFacts => {
		const { type, destination } = init;
		const canIntercept =
			rewritable(destination.url) &&
			(type !== 'traverse' || destination.sameDocument);
		const cancelable = init.cancelable ?? type !== 'traverse';
		const url = destination.url;
		const here = client.locationHref;
		const hashChange =
			init.hashChange ??
			(!init.formData &&
				type !== 'reload' &&
				unfragmented(url) === unfragmented(here) &&
				fragmentOf(url) !== fragmentOf(here) &&
				// (a traversal to the entry without one changes the fragment too)
				(fragmentOf(url) !== null || type === 'traverse'));
		const event = made('navigate', NavigateProto, cancelable);
		const facts: EventFacts = {
			type,
			destination: destinationOf(destination),
			canIntercept,
			userInitiated: init.userInitiated,
			hashChange,
			controller: new AbortController(),
			formData:
				type === 'push' || type === 'replace' ? (init.formData ?? null) : null,
			downloadRequest: init.downloadRequest ?? null,
			info: init.info,
			sourceElement: init.sourceElement ?? null,
			cancelable,
			dispatching: true,
			interception: 'none',
			handlers: [],
			precommit: [],
			focusReset: null,
			scroll: null,
			tracker: init.tracker,
			event,
			url,
		};
		eventFacts.set(event, facts);
		// a new navigation ends the one going on
		abortOngoing();
		ongoing = facts;
		focusChanged = false;
		let kept: boolean;
		try {
			kept = fire(navigation, event);
		} finally {
			facts.dispatching = false;
		}
		if (!kept) {
			if (ongoing === facts) abortOngoing();
			else trackerFailed(facts.tracker, abortError());
			return facts;
		}
		if (facts.interception !== 'none') {
			const from = entryObject(current());
			let resolveFinished!: (value: unknown) => void;
			let rejectFinished!: (reason: unknown) => void;
			let resolveCommitted!: (value: unknown) => void;
			let rejectCommitted!: (reason: unknown) => void;
			const finished = new Promise((resolve, reject) => {
				resolveFinished = resolve;
				rejectFinished = reject;
			});
			const committed = new Promise((resolve, reject) => {
				resolveCommitted = resolve;
				rejectCommitted = reject;
			});
			handled(finished);
			handled(committed);
			const made = Object.create(TransitionProto ?? Object.prototype) as object;
			transitionFacts.set(made, {
				type,
				from,
				finished,
				committed,
				resolveFinished,
				rejectFinished,
				resolveCommitted,
				rejectCommitted,
			});
			transition = made;
		}
		return facts;
	};

	/** the handlers' promises, all fulfilled or the first rejection */
	const waitAll = (
		promises: Promise<unknown>[],
		ok: () => void,
		fail: (reason: unknown) => void,
	) => {
		let left = promises.length;
		let over = false;
		if (!left) {
			microtask(ok);
			return;
		}
		for (const promise of promises)
			then(
				promise,
				() => {
					if (!over && --left === 0) {
						over = true;
						ok();
					}
				},
				(reason) => {
					if (over) return;
					over = true;
					fail(reason);
				},
			);
	};
	const call = (handler: Function, args: unknown[]): Promise<unknown> => {
		try {
			return Promise.resolve(Reflect.apply(handler, undefined, args));
		} catch (error) {
			return Promise.reject(error);
		}
	};
	/** reset the focus after a navigation (unless the page moved it, or asked for none) */
	const resetFocus = (facts: EventFacts) => {
		if (facts.focusReset === 'manual' || focusChanged) return;
		const document = global.document;
		const autofocus = document.querySelector(
			'[autofocus]',
		) as HTMLElement | null;
		if (autofocus) {
			Reflect.apply(natives.focus, autofocus, []);
			return;
		}
		const active = Reflect.apply(
			natives.activeElement,
			document,
			[],
		) as HTMLElement | null;
		if (
			active &&
			active !== document.body &&
			active !== document.documentElement
		)
			Reflect.apply(natives.blur, active, []);
	};
	/** process the scroll behaviour of an intercepted navigation */
	const processScroll = (facts: EventFacts) => {
		if (facts.type === 'traverse') {
			if (!manualRestoration()) restoreScroll(arrivedScroll.get(facts));
		} else if (facts.type === 'push' || facts.type === 'replace')
			scrollToFragment();
	};
	/**
	 * The handlers of an intercepted navigation, the commit done: its end.
	 * An intercepted traversal's popstate (`after`) is Chrome's: once the
	 * handlers settled, right after navigatesuccess or navigateerror and in
	 * the same task, so a page awaiting `finished` has heard it.
	 */
	const runHandlers = (facts: EventFacts, after?: () => void) => {
		facts.interception = 'committed';
		const made = transition;
		if (made) transitionFacts.get(made)?.resolveCommitted(undefined);
		const promises = facts.handlers.map((handler) => call(handler, []));
		if (!promises.length) promises.push(Promise.resolve());
		waitAll(
			promises,
			() => {
				if (ongoing !== facts) return;
				ongoing = null;
				if (facts.focusReset !== 'manual') resetFocus(facts);
				if (facts.interception !== 'scrolled' && facts.scroll !== 'manual')
					processScroll(facts);
				facts.interception = 'finished';
				fire(navigation, new Event('navigatesuccess'));
				trackerFinished(facts.tracker);
				if (made && transition === made) {
					transition = null;
					transitionFacts.get(made)!.resolveFinished(undefined);
				}
				after?.();
			},
			(reason) => {
				if (ongoing !== facts) return;
				ongoing = null;
				if (facts.focusReset !== 'manual') resetFocus(facts);
				facts.interception = 'finished';
				fireError(reason);
				trackerFailed(facts.tracker, reason);
				if (made && transition === made) {
					transition = null;
					transitionFacts.get(made)!.rejectFinished(reason);
				}
				after?.();
			},
		);
	};
	/** a same-document navigation nothing intercepted (a fragment) ends a microtask later */
	const finishSoon = (facts: EventFacts) =>
		microtask(() => {
			if (ongoing !== facts) return;
			ongoing = null;
			facts.interception = 'finished';
			fire(navigation, new Event('navigatesuccess'));
			trackerFinished(facts.tracker);
		});
	/**
	 * An intercepted push, replace or reload: committed (after the precommit
	 * handlers, when there are any), then its handlers
	 */
	const intercepted = (
		facts: EventFacts,
		classic: unknown,
		navState: { value: unknown } | undefined,
		fragment = false,
	) => {
		const commit = () => {
			if (ongoing !== facts) return;
			const kind = facts.type as 'push' | 'replace' | 'reload';
			const before = client.locationHref;
			commitSame(
				kind,
				facts.url,
				kind === 'reload' ? state : classic,
				navState,
				facts.tracker,
			);
			// An intercepted navigation to a fragment is still one (not a
			// pushState): Chrome fires its popstate at the commit and its
			// hashchange once the handlers settled
			if (!fragment) return runHandlers(facts);
			fire(global, new global.PopStateEvent('popstate', { state: null }));
			const after = () => {
				if (fragmentOf(before) === fragmentOf(facts.url)) return;
				task(() =>
					fire(
						global,
						new global.HashChangeEvent('hashchange', {
							oldURL: before,
							newURL: facts.url,
						}),
					),
				);
			};
			runHandlers(facts, after);
		};
		if (!facts.precommit.length) return commit();
		const Controller = global.NavigationPrecommitController;
		const controller = Controller
			? (Object.create(Controller.prototype) as object)
			: {};
		precommitControllers.set(controller, { facts, navState });
		const promises = facts.precommit.map((handler) =>
			call(handler, [controller]),
		);
		waitAll(promises, commit, (reason) => {
			if (ongoing === facts) abortOngoing(reason);
		});
	};
	const precommitControllers = new WeakMap<
		object,
		{ facts: EventFacts; navState: { value: unknown } | undefined }
	>();
	const PrecommitProto = global.NavigationPrecommitController?.prototype;
	method(
		PrecommitProto,
		'redirect',
		(that, args) => {
			const own = precommitControllers.get(that)!;
			const facts = own.facts;
			if (facts.interception !== 'intercepted' || ongoing !== facts)
				throw domError(
					"Failed to execute 'redirect' on 'NavigationPrecommitController': redirect() may only be called before the navigation commits.",
					'InvalidStateError',
				);
			if (facts.type !== 'push' && facts.type !== 'replace')
				throw domError(
					"Failed to execute 'redirect' on 'NavigationPrecommitController': redirect() may only be called on a push or replace navigation.",
					'InvalidStateError',
				);
			const url = new URL(String(args[0]), client.baseHref).href;
			if (!rewritable(url))
				throw domError(
					`Failed to execute 'redirect' on 'NavigationPrecommitController': Cannot redirect to '${url}' in a document with origin '${pageURL().origin}' and URL '${client.locationHref}'.`,
					'SecurityError',
				);
			facts.url = url;
			const options = args[1] as Record<string, unknown> | undefined;
			if (options && 'state' in options)
				own.navState = { value: structuredClone(options.state) };
		},
		(that) => precommitControllers.has(that),
	);

	method(
		NavigateProto,
		'intercept',
		(that, args) => {
			const facts = navigateFacts(that);
			const name = "Failed to execute 'intercept' on 'NavigateEvent':";
			if (!facts.dispatching)
				throw domError(
					`${name} intercept() may only be called while the navigate event is being dispatched.`,
					'InvalidStateError',
				);
			if (!facts.canIntercept)
				// (Chrome's words, "by in" included)
				throw domError(
					`${name} A navigation with URL '${facts.url}' cannot be intercepted by in a window with origin '${pageURL().origin}' and URL '${client.locationHref}'.`,
					'SecurityError',
				);
			if (prevented(facts.event))
				throw domError(
					`${name} intercept() may not be called on a canceled event.`,
					'InvalidStateError',
				);
			const options = (args[0] ?? {}) as Record<string, unknown>;
			if (typeof options !== 'object')
				throw withStack(
					new global.TypeError(
						`${name} The provided value is not of type 'NavigationInterceptOptions'.`,
					),
				);
			const read = (key: string) => (options as any)[key];
			const focusReset = read('focusReset');
			const handler = read('handler');
			const precommit = read('precommitHandler');
			const scroll = read('scroll');
			const enumOf = (value: unknown, allowed: string[], type: string) => {
				if (value === undefined) return null;
				const text = `${value}`;
				if (!allowed.includes(text))
					throw withStack(
						new global.TypeError(
							`${name} Failed to read the '${type === 'NavigationFocusReset' ? 'focusReset' : 'scroll'}' property from 'NavigationInterceptOptions': The provided value '${text}' is not a valid enum value of type ${type}.`,
						),
					);
				return text;
			};
			const reset = enumOf(
				focusReset,
				['after-transition', 'manual'],
				'NavigationFocusReset',
			);
			if (handler !== undefined && typeof handler !== 'function')
				throw withStack(
					new global.TypeError(
						`${name} Failed to read the 'handler' property from 'NavigationInterceptOptions': The provided value is not a function.`,
					),
				);
			if (precommit !== undefined && typeof precommit !== 'function')
				throw withStack(
					new global.TypeError(
						`${name} Failed to read the 'precommitHandler' property from 'NavigationInterceptOptions': The provided value is not a function.`,
					),
				);
			const scrolls = enumOf(
				scroll,
				['after-transition', 'manual'],
				'NavigationScrollBehavior',
			);
			if (precommit !== undefined && !facts.cancelable)
				throw domError(
					`${name} Cannot use precommitHandler in a non-cancelable navigation.`,
					'InvalidStateError',
				);
			if (handler !== undefined) facts.handlers.push(handler);
			if (precommit !== undefined) facts.precommit.push(precommit);
			if (reset !== null) facts.focusReset = reset;
			if (scrolls !== null) facts.scroll = scrolls;
			facts.interception = 'intercepted';
		},
		isNavigate,
	);
	method(
		NavigateProto,
		'scroll',
		(that) => {
			const facts = navigateFacts(that);
			const name = "Failed to execute 'scroll' on 'NavigateEvent':";
			if (facts.interception === 'scrolled')
				throw domError(`${name} scroll() already called.`, 'InvalidStateError');
			if (facts.interception !== 'committed')
				throw domError(
					`${name} scroll() must be called after commit.`,
					'InvalidStateError',
				);
			facts.interception = 'scrolled';
			processScroll(facts);
		},
		isNavigate,
	);

	// ---- the page's navigations, met at the browser's navigate event --------

	const destinationOfNative = getter(NavigateProto, 'destination')!;
	const [typeOf, hashOf, formOf, sourceOf, userOf, downloadOf] = [
		'navigationType',
		'hashChange',
		'formData',
		'sourceElement',
		'userInitiated',
		'downloadRequest',
	].map((name) => getter(NavigateProto, name)!);
	const sameOf = getter(DestinationProto, 'sameDocument')!;
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
	/** a navigation API call's own (its info, state, history and promises), for the event it fires */
	let calling: {
		tracker: Tracker;
		history?: string;
		reload?: boolean;
	} | null = null;
	/**
	 * A navigation of the page that nothing cancelled or intercepted: a
	 * fragment of this document, else another document, the host's
	 */
	const proceed = (
		facts: EventFacts,
		how: {
			routed: string;
			fragment: boolean;
			navState?: { value: unknown };
			later: boolean;
		},
	) => {
		if (facts.type === 'reload') {
			if (how.navState) current().navState = how.navState.value;
			tell({
				op: 'navigate',
				reload: true,
				navState: current().navState,
				scroll: [global.scrollX, global.scrollY],
			});
			return;
		}
		if (how.fragment) {
			const from = client.locationHref;
			commitSame(
				facts.type === 'replace' ? 'replace' : 'push',
				facts.url,
				facts.type === 'replace' ? state : null,
				how.navState,
				facts.tracker,
			);
			applyFragment(facts.url, false);
			const pop = () =>
				fire(
					global,
					new global.PopStateEvent('popstate', { state: state ?? null }),
				);
			if (how.later) microtask(pop);
			else pop();
			finishSoon(facts);
			if (fragmentOf(from) !== fragmentOf(facts.url))
				task(() =>
					fire(
						global,
						new global.HashChangeEvent('hashchange', {
							oldURL: from,
							newURL: facts.url,
						}),
					),
				);
			return;
		}
		// another document: the host loads it (the promises settle no more,
		// as natively, unless it never arrives)
		const data = facts.formData;
		const source = facts.sourceElement as
			(HTMLButtonElement & HTMLFormElement) | null;
		tell({
			op: 'navigate',
			url: facts.url,
			routed: how.routed,
			replace: facts.type === 'replace',
			entries: data ? [...Reflect.apply(formEntries, data, [])] : null,
			enctype:
				source && (source.formEnctype || (source.form ?? source).enctype),
			policy: sourcePolicy(source) || documentPolicy(),
			navState: how.navState?.value,
			scroll: [global.scrollX, global.scrollY],
		});
	};
	Reflect.apply(natives.listen, navigation, [
		'navigate',
		(event: Event) => {
			// (one of this file's own, for the page's listeners)
			if (!event.isTrusted) return;
			// no event of the browser's reaches the page: its own is made here
			Reflect.apply(natives.stopImmediate, event, []);
			const of = (get: Function) => Reflect.apply(get, event, []);
			const type = of(typeOf) as Kind;
			if (type === 'traverse') return;
			const native = of(destinationOfNative) as object;
			const routed = destinationURL(native) ?? '';
			// the host sending the frame to the call page again, for the
			// document after this one (calledFrames.ts)
			// (a reload's destination is the call page too: the host's)
			if (type === 'replace' && unfragmented(routed) === unfragmented(page))
				return;
			// the proxy's own pushState or replaceState (the page's are
			// handled in their hooks): the frame's one entry stays as it is
			if (Reflect.apply(sameOf, native, []) && !of(hashOf)) return;
			if (!of(natives.cancelable)) return;
			const download = of(downloadOf) as string | null;
			const api = calling;
			calling = null;
			if (api) {
				api.tracker.fired = true;
				api.tracker.info = of(natives.eventInfo);
				let given: unknown;
				try {
					given = Reflect.apply(natives.destinationState, native, []);
				} catch (error) {
					given = undefined;
				}
				if (given !== undefined) api.tracker.navState = { value: given };
			}
			let url =
				type === 'reload'
					? client.locationHref
					: (unrouteURL(client, routed) ?? routed);
			try {
				url = new URL(url).href;
			} catch (error) {
				// as given
			}
			const formData = of(formOf) as FormData | null;
			let kind: Kind = api?.reload ? 'reload' : type;
			// Firefox replaces the entry on any form submission of a document
			// written with document.open(), which every called document is;
			// a loaded document's submission natively pushes one
			const source = of(sourceOf) as Element | null;
			if (
				kind === 'replace' &&
				!api &&
				source !== null &&
				/^(FORM|BUTTON|INPUT)$/.test(source.nodeName) &&
				global.document.readyState === 'complete'
			)
				kind = 'push';
			// a navigation to the document's own URL replaces its entry, as
			// natively (unless navigate() asked for a push)
			if (
				kind === 'push' &&
				!formData &&
				api?.history !== 'push' &&
				url === client.locationHref
			)
				kind = 'replace';
			const fragment =
				kind !== 'reload' &&
				!formData &&
				download === null &&
				fragmentOf(url) !== null &&
				unfragmented(url) === unfragmented(client.locationHref);
			const user = !!of(userOf);
			const facts = navigate({
				type: kind,
				destination: {
					url,
					key: '',
					id: '',
					index: -1,
					sameDocument: fragment,
					state: api?.tracker.navState?.value,
				},
				userInitiated: user,
				formData,
				downloadRequest: download,
				info: api?.tracker.info,
				sourceElement: of(sourceOf) as Element | null,
				tracker: api?.tracker ?? null,
			});
			// a download goes on as the browser's own, unless it was cancelled
			if (download !== null) {
				if (prevented(facts.event) || facts.interception !== 'none')
					Reflect.apply(natives.preventDefault, event, []);
				if (ongoing === facts) {
					ongoing = null;
					// (it never commits: the page stays)
				}
				return;
			}
			Reflect.apply(natives.preventDefault, event, []);
			if (prevented(facts.event) || ongoing !== facts) return;
			const navState = api?.tracker.navState;
			if (facts.interception !== 'none') {
				intercepted(facts, null, navState, fragment);
				return;
			}
			proceed(facts, { routed, fragment, navState, later: user });
		},
	]);
	// the browser's own after-events of the frame's one entry: never the page's
	for (const type of ['navigatesuccess', 'navigateerror', 'currententrychange'])
		Reflect.apply(natives.listen, navigation, [
			type,
			(event: Event) => {
				if (event.isTrusted) Reflect.apply(natives.stopImmediate, event, []);
			},
		]);

	// ---- the History interface ---------------------------------------------

	const prototype = global.History.prototype;
	const ours = (that: unknown) => that === global.history;
	const lengthGetter = getter(prototype, 'length')!;
	const historyEntry = (name: 'pushState' | 'replaceState') =>
		proxyModule.wrapFunction(prototype[name], (target, that, args) => {
			if (!ours(that)) return Reflect.apply(target, that, args);
			// (throws for a document that is not fully active, as natively)
			Reflect.apply(lengthGetter, that, []);
			const value = structuredClone(args[0]);
			let url = client.locationHref;
			if (args[2] !== undefined && args[2] !== null && args[2] !== '') {
				const own = pageURL();
				const text = `${args[2]}`;
				let to: URL | null;
				try {
					to = new URL(text, client.baseHref);
				} catch (error) {
					to = null;
				}
				if (
					!to ||
					to.protocol !== own.protocol ||
					to.origin !== own.origin ||
					to.username !== own.username ||
					to.password !== own.password
				)
					throw domError(
						`Failed to execute '${name}' on 'History': A history state object with URL '${to ? to.href : text}' cannot be created in a document with origin '${own.origin}' and URL '${own.href}'.`,
						'SecurityError',
					);
				url = to.href;
			}
			const kind = name === 'pushState' ? 'push' : 'replace';
			const facts = navigate({
				type: kind,
				destination: {
					url,
					key: '',
					id: '',
					index: -1,
					sameDocument: true,
					state: undefined,
				},
				userInitiated: false,
				hashChange: false,
				tracker: null,
			});
			if (prevented(facts.event) || ongoing !== facts) return;
			if (facts.interception !== 'none') {
				intercepted(facts, value, undefined);
				return;
			}
			ongoing = null;
			// (the new entry has no Navigation API state, as Chrome's: its
			// getState() is undefined after replaceState too)
			commitSame(kind, url, value, undefined, null);
		});
	prototype.pushState = historyEntry('pushState');
	prototype.replaceState = historyEntry('replaceState');
	const step = (delta: number) => {
		if (joint.index + delta >= 0 && joint.index + delta < joint.length)
			tell({ op: 'step', delta });
	};
	const reload = () => {
		calling = null;
		Reflect.apply(natives.reload, global.location, []);
	};
	prototype.back = proxyModule.wrapFunction(prototype.back, (target, that) => {
		if (!ours(that)) return Reflect.apply(target, that, []);
		Reflect.apply(lengthGetter, that, []);
		step(-1);
	});
	prototype.forward = proxyModule.wrapFunction(
		prototype.forward,
		(target, that) => {
			if (!ours(that)) return Reflect.apply(target, that, []);
			Reflect.apply(lengthGetter, that, []);
			step(1);
		},
	);
	prototype.go = proxyModule.wrapFunction(
		prototype.go,
		(target, that, args) => {
			if (!ours(that)) return Reflect.apply(target, that, args);
			Reflect.apply(lengthGetter, that, []);
			const delta = Math.trunc(Number(args[0])) || 0;
			if (delta) step(delta);
			else reload();
		},
	);
	accessor(prototype, 'length', () => joint.length, ours);
	accessor(prototype, 'state', () => state, ours);

	// ---- the Navigation interface ---------------------------------------------

	const Navigation = global.Navigation.prototype;
	const isNavigation = (that: unknown) => that === navigation;
	const listed = () => {
		const { start, end } = run();
		return entries.slice(start, end + 1).map(entryObject);
	};
	method(Navigation, 'entries', () => listed(), isNavigation);
	accessor(
		Navigation,
		'currentEntry',
		() => entryObject(current()),
		isNavigation,
	);
	accessor(Navigation, 'canGoBack', () => index > run().start, isNavigation);
	accessor(Navigation, 'canGoForward', () => index < run().end, isNavigation);
	accessor(Navigation, 'transition', () => transition, isNavigation);
	const optionsOf = (value: unknown): Record<string, unknown> => {
		if (value === undefined || value === null) return {};
		if (typeof value !== 'object' && typeof value !== 'function')
			throw withStack(
				new global.TypeError('The provided value is not of type options.'),
			);
		return value as Record<string, unknown>;
	};
	// (the History module's: navigate() routes its URL)
	const nativeNavigation = {
		navigate: Navigation.navigate,
		reload: Navigation.reload,
	};
	for (const name of ['navigate', 'reload'] as const)
		method(
			Navigation,
			name,
			(that, args) => {
				const options = args[name === 'navigate' ? 1 : 0];
				let history: string | undefined;
				if (name === 'navigate' && options && typeof options === 'object') {
					const value = (options as Record<string, unknown>).history;
					if (value !== undefined) history = `${value}`;
				}
				const made = tracker(undefined);
				made.history = history;
				// the browser's own checks (the URL, the state's serialization)
				// and its navigate event, met above, which hands this tracker,
				// the info and the state to the page's own
				calling = { tracker: made, reload: name === 'reload', history };
				let native: { committed: Promise<unknown>; finished: Promise<unknown> };
				try {
					native = Reflect.apply(nativeNavigation[name], that, args);
				} finally {
					calling = null;
				}
				handled(native.committed);
				handled(native.finished);
				// no event fired: the browser's refusal is the page's
				if (!made.fired) return native;
				return result(made);
			},
			isNavigation,
		);
	const traverseTo = (key: string, info: unknown) => {
		const { start, end } = run();
		const target = entries.findIndex(
			(data, at) => at >= start && at <= end && data.key === key,
		);
		if (target < 0) return refused('Invalid key');
		if (target === index) {
			const entry = entryObject(current());
			return {
				committed: Promise.resolve(entry),
				finished: Promise.resolve(entry),
			};
		}
		const kept = upcomingTraversals.get(key);
		if (kept) return result(kept);
		const made = tracker(info);
		made.key = key;
		upcomingTraversals.set(key, made);
		// (a step of the host's: its run of this origin is this document's
		// list, so the step is as long in the tab's history; the host fires
		// its navigate event with `traverse` before its `pop`)
		tell({ op: 'step', delta: target - index });
		return result(made);
	};
	method(
		Navigation,
		'traverseTo',
		(that, args) => {
			if (!args.length)
				throw withStack(
					new global.TypeError(
						"Failed to execute 'traverseTo' on 'Navigation': 1 argument required, but only 0 present.",
					),
				);
			const key = `${args[0]}`;
			return traverseTo(key, optionsOf(args[1]).info);
		},
		isNavigation,
	);
	for (const [name, delta, message] of [
		['back', -1, 'Cannot go back'],
		['forward', 1, 'Cannot go forward'],
	] as const)
		method(
			Navigation,
			name,
			(that, args) => {
				const info = optionsOf(args[0]).info;
				const { start, end } = run();
				const target = index + delta;
				if (target < start || target > end) return refused(message);
				return traverseTo(entries[target].key, info);
			},
			isNavigation,
		);
	method(
		Navigation,
		'updateCurrentEntry',
		(that, args) => {
			const options = args[0] as Record<string, unknown> | undefined;
			if (!options || typeof options !== 'object' || !('state' in options))
				throw withStack(
					new global.TypeError(
						"Failed to execute 'updateCurrentEntry' on 'Navigation': Failed to read the 'state' property from 'NavigationUpdateCurrentEntryOptions': Required member is undefined.",
					),
				);
			const value = structuredClone(options.state);
			current().navState = value;
			tell({ op: 'update', navState: value });
			const entry = entryObject(current());
			currentChanged(null, entry);
		},
		isNavigation,
	);

	// how this document was reached (navigation.activation), and what
	// pageswap shows of the navigation that leaves it
	const Activation = global.NavigationActivation?.prototype;
	const activationFacts = new WeakMap<
		object,
		{ entry: object; from: object | null; type: string }
	>();
	const isActivation = (that: unknown) =>
		!!that && typeof that === 'object' && activationFacts.has(that);
	/** an entry the host names: this document's own when it lists it, else one of no index */
	const namedEntry = (named: unknown): object | null => {
		if (!named || typeof named !== 'object') return null;
		const { url, key, id } = named as Record<string, unknown>;
		const listed = entries.find((data) => data.key === key && data.id === id);
		return entryObject(
			listed ?? {
				url: String(url),
				key: String(key),
				id: String(id),
				document: -1,
			},
		);
	};
	const activationOf = (facts: {
		entry: object;
		from: object | null;
		type: string;
	}) => {
		const made = Object.create(Activation ?? Object.prototype) as object;
		activationFacts.set(made, facts);
		return made;
	};
	if (Activation) {
		const activation = activationOf({
			entry: entryObject(current()),
			from: namedEntry(session.from),
			type:
				session.type === 'back_forward'
					? 'traverse'
					: session.type === 'reload'
						? 'reload'
						: session.replaced
							? 'replace'
							: 'push',
		});
		accessor(Navigation, 'activation', () => activation, isNavigation);
		for (const name of ['entry', 'from', 'navigationType'] as const)
			accessor(
				Activation,
				name,
				(that) => {
					const facts = activationFacts.get(that)!;
					return name === 'navigationType' ? facts.type : facts[name];
				},
				isActivation,
			);
	}
	const PageSwap = global.PageSwapEvent?.prototype;
	const swapFacts = new WeakMap<object, object | null>();
	accessor(
		PageSwap,
		'activation',
		(that) => swapFacts.get(that) ?? null,
		(that) => !!that && typeof that === 'object' && swapFacts.has(that),
	);
	accessor(
		PageSwap,
		'viewTransition',
		() => null,
		(that) => !!that && typeof that === 'object' && swapFacts.has(that),
	);
	// the browser's own pageswap is of the call page's navigations (a
	// nested frame sent to it again), never the page's
	const listenSwap = () =>
		Reflect.apply(natives.listen, global, [
			'pageswap',
			(event: Event) => {
				if (event.isTrusted) Reflect.apply(natives.stopImmediate, event, []);
			},
			true,
		]);
	listenSwap();
	addDocumentOpenListener(global, listenSwap);
	/** the host's navigation away from this document: its pageswap */
	const swapped = (swap: Record<string, any>) => {
		if (PageSwap) {
			const event = made('pageswap', PageSwap);
			const given = swap.activation as Record<string, unknown> | null;
			swapFacts.set(
				event,
				given && Activation
					? activationOf({
							entry: namedEntry(given.entry)!,
							from: namedEntry(given.from),
							type: String(swap.type),
						})
					: null,
			);
			fire(global, event);
		}
		tell({ op: 'swapped', req: swap.req });
	};

	// ---- the host's word --------------------------------------------------------

	/**
	 * The entry a traversal goes to, as its host names it: by key (the
	 * tab's host, which lists only this origin's run of entries here), else
	 * by its place (a frame's host, calledFrames.ts, which keeps the same
	 * list as this document)
	 */
	const traversalTarget = (to: Record<string, any>) => {
		if (typeof to.key === 'string')
			return entries.findIndex((data) => data.key === to.key);
		return Number.isInteger(to.index) && entries[to.index] ? to.index : -1;
	};
	/** a traversal's navigate event, before its host commits it (a step it cannot cancel when `cancelable` is false) */
	const traversing = (to: Record<string, any>) => {
		const at = traversalTarget(to);
		if (at < 0) return null;
		const target = entries[at];
		const same = target.document === ownDocument;
		const made = upcomingTraversals.get(target.key) ?? null;
		const facts = navigate({
			type: 'traverse',
			destination: {
				url: target.url,
				key: target.key,
				id: target.id,
				index: listedIndex(target),
				sameDocument: same,
				state: target.navState,
			},
			userInitiated: to.user === true,
			cancelable: same && to.cancelable === true,
			info: made?.info,
			tracker: made,
		});
		const ok = !prevented(facts.event);
		// another document's: this one is about to go
		if (ok && !same && ongoing === facts) ongoing = null;
		return { facts, ok, same };
	};
	/** a step of the host's to entry `at` of this document, its navigate event fired (`facts`) */
	const commit = (
		to: Record<string, any>,
		at: number,
		facts: EventFacts | undefined,
	) => {
		const from = entryObject(current());
		const before = client.locationHref;
		index = at;
		state = to.state ?? null;
		client.rename(current().url);
		called.moved?.('traverse');
		if (isJoint(to.joint)) {
			joint.length = to.joint.length;
			joint.index = to.joint.index;
		} else joint.index = index;
		const made =
			facts?.tracker ?? upcomingTraversals.get(current().key) ?? null;
		const popstate = () =>
			fire(
				global,
				new global.PopStateEvent('popstate', { state: state ?? null }),
			);
		if (facts && facts.interception !== 'none' && ongoing === facts) {
			applyFragment(current().url, true);
			arrivedScroll.set(facts, to.scroll);
			trackerCommitted(made, entryObject(current()));
			currentChanged('traverse', from);
			// (Chrome fires an intercepted traversal's popstate once its
			// handlers settled, and no hashchange, measured:
			// test/suites/nav-router.mjs)
			runHandlers(facts, popstate);
			return;
		}
		trackerCommitted(made, entryObject(current()));
		currentChanged('traverse', from);
		applyFragment(current().url, true);
		if (!manualRestoration()) restoreScroll(to.scroll);
		const after = () => {
			popstate();
			if (fragmentOf(before) !== fragmentOf(current().url))
				task(() =>
					fire(
						global,
						new global.HashChangeEvent('hashchange', {
							oldURL: before,
							newURL: current().url,
						}),
					),
				);
		};
		if (facts && ongoing === facts)
			microtask(() => {
				if (ongoing === facts) {
					ongoing = null;
					facts.interception = 'finished';
					fire(navigation, new Event('navigatesuccess'));
					trackerFinished(made);
				}
				after();
			});
		else {
			trackerFinished(made);
			microtask(after);
		}
	};
	const isJoint = (
		value: unknown,
	): value is { length: number; index: number } =>
		!!value &&
		typeof value === 'object' &&
		Number.isSafeInteger((value as any).length) &&
		Number.isSafeInteger((value as any).index);
	/** the traversals whose navigate event fired, by the host's request */
	const asked = new Map<string, EventFacts>();
	/**
	 * What the host says (the tab's, justCallStomp.ts, or a frame's,
	 * calledFrames.ts): a traversal's navigate event to fire (`traverse`), a
	 * step to an entry of this document (`pop`), a traversal or the
	 * navigation that was to leave this document given up (`abort`,
	 * `failed`), the navigation that leaves it (`swap`)
	 */
	const heard = (data: Record<string, any>) => {
		const req = (value: unknown) =>
			typeof value === 'string' && value.length <= 64 ? value : null;
		if (data.swap && typeof data.swap === 'object') return swapped(data.swap);
		if (data.traverse && typeof data.traverse === 'object') {
			const to = data.traverse;
			const id = req(to.req);
			if (!id) return;
			const asking = traversing(to);
			if (asking?.ok && asking.same) asked.set(id, asking.facts);
			tell({ op: 'traversing', req: id, ok: asking ? asking.ok : true });
			return;
		}
		if (data.pop && typeof data.pop === 'object') {
			const to = data.pop;
			const at = traversalTarget(to);
			if (at < 0) return;
			const id = req(to.req);
			let facts = id ? asked.get(id) : undefined;
			if (id) asked.delete(id);
			// a step no navigate event was fired for (a frame's host steps at
			// once): it fires now, and cannot be cancelled
			if (!id) facts = traversing({ ...to, cancelable: false })?.facts;
			commit(to, at, facts);
			return;
		}
		if (data.abort && typeof data.abort === 'object') {
			const to = data.abort;
			const id = req(to.req);
			const facts = id ? asked.get(id) : undefined;
			if (id) asked.delete(id);
			if (facts && ongoing === facts) abortOngoing();
			const made =
				typeof to.key === 'string' ? upcomingTraversals.get(to.key) : null;
			if (made) trackerFailed(made, abortError());
			return;
		}
		// the other document this one was to give way to never came (a 204,
		// a download, a network error, the host's Stop): the navigation is
		// aborted
		if (data.failed === true && ongoing) abortOngoing();
	};

	return { heard };
}
