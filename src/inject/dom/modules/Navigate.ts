import { SITE_RUNS } from '../../../config';
import {
	ACTIVATED,
	CLIENT_ID,
	FRAME_ENTRY,
	FRAME_MOVED,
	HISTORY_RUN,
	NAVIGATE,
	NavigateInfo,
	NAVIGATION_TYPE,
	TAB_LOAD,
	type TabLoad,
} from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { activationState, markActivation, noteInput } from '../activation';
import { autofocusFlush } from '../autofocus';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { Pool } from '../pool';
import { siteWindows } from '../siteWindows';
import HistoryModule from './History';

/**
 * Tells the host application where the page is (URL, title, whether its
 * own history can step) whenever that changes: on load, pushState and
 * replaceState, popstate and hashchange, and title changes. The host keeps
 * its address bar and buttons current from these instead of polling. A
 * document in a frame of the page tells it which service
 * worker client it is.
 */
/** a turn's mutations may have changed what the host is told (title, icon, base) */
const SEEN_DECLARED = 1;
/** they added an autofocus candidate */
const SEEN_ELEMENT = 2;
const SEEN_ALL = SEEN_DECLARED | SEEN_ELEMENT;

export default class NavigateModule extends Module<DocumentClient> {
	apply() {
		const moduleClient = this.client;
		const global = moduleClient.global;

		// this document's service worker client id, from the service worker
		// itself (a page cannot read it); the host attributes requests with it
		let client: string | undefined;
		// what tells the host, set below
		let tell = () => {};
		const learned = (id: unknown) => {
			if (typeof id !== 'string' || id === client) return;
			client = id;
			tell();
		};
		// about: and blob: documents have no proxy-origin URL to ask. The
		// worker that served the document's navigation knows it already and
		// its shell said so (DocumentClient.servedClient); one of an earlier
		// worker's is asked, a request and a pass of the worker's router for
		// every document. A top-level document's first report carries the
		// served id: told at once, after apply and before the page's markup
		// is written, it went out with no title, and the report the page's
		// parse makes went out again with it (navigate-events). The answer to
		// `whoami` came after that parse. A frame of the page tells only the
		// id, heard after apply as an answer is
		const served = moduleClient.servedClient;
		if (served && !moduleClient.nested) client = served;
		else if (/^https?:$/.test(global.location.protocol))
			(served
				? Promise.resolve(served)
				: fetch(
						`${global.location.origin}${moduleClient.directory}whoami`,
					).then((response) => response.json())
			)
				.then(learned)
				.catch(() => {});
		// a document on about:srcdoc is a client of its own with no such URL:
		// the service worker says which, once a request of this document is
		// one the host's log reports (nothing is asked, and nothing sent, for
		// a document that loads nothing). One on about:blank is no client:
		// its loads are made by the page that controls it
		else if (global.location.href === 'about:srcdoc')
			moduleClient.onServiceWorkerMessage((data) => {
				if (typeof data === 'object' && data !== null)
					learned((data as Record<string, unknown>)[CLIENT_ID]);
			});

		const proxyModule = moduleClient.getModule(ProxyModule)!;
		/**
		 * `moved` once per turn after this document's history moved: it
		 * loaded, pushState or replaceState, popstate, hashchange (and
		 * whatever else calls the returned function)
		 */
		const watchHistory = (moved: () => void) => {
			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				global.setTimeout(() => {
					scheduled = false;
					moved();
				}, 0);
			};
			for (const name of ['pushState', 'replaceState'] as const)
				global.History.prototype[name] = proxyModule.wrapFunction(
					global.History.prototype[name],
					(target, that, args) => {
						const result = Reflect.apply(target, that, args);
						schedule();
						return result;
					},
				);
			// document.open() drops window listeners (and runs before the real
			// page is written), so they are registered again after each open
			const listen = () => {
				for (const event of [
					'load',
					'DOMContentLoaded',
					'popstate',
					'hashchange',
				])
					global.addEventListener(event, schedule);
			};
			listen();
			addDocumentOpenListener(global, listen);
			return schedule;
		};

		// The document's user activation, as the host's history needs it for
		// Chrome's history intervention: a document that navigates by script
		// with none is passed over by Back. The browser carries an activation
		// over to the next document of the same origin, and every proxied
		// document is of one origin, so one the document starts with may be
		// another site's: from then on only its own input counts (and a click
		// while it has a transient activation, as automation's clicks are).
		// The host is told at once, with a token that names the document, as
		// the click may navigate it away before the host reads anything. A
		// document in a frame of the page tells it too: an activation there
		// is the page's as well
		const isActive = Reflect.getOwnPropertyDescriptor(
			global.UserActivation?.prototype ?? {},
			'isActive',
		)?.get;
		const hasBeenActive = Reflect.getOwnPropertyDescriptor(
			global.UserActivation?.prototype ?? {},
			'hasBeenActive',
		)?.get;
		const userActivation = global.navigator.userActivation;
		const sticky = () =>
			!!hasBeenActive &&
			!!userActivation &&
			Reflect.apply(hasBeenActive, userActivation, []) === true;
		const start = sticky();
		let input = false;
		// the document's activation as natively (../activation.ts): every
		// input event in it tells the page's documents whose it is
		moduleClient.markActivation = markActivation;
		const activated = () =>
			(start ? input : sticky()) && (activationState(moduleClient) & 2) !== 0;
		// a transient activation of its own (WebAuthn's in a frame of another
		// origin): one the host's input or another site's frame gave every
		// proxied document of the one origin is not this document's
		const transient = () => input && (activationState(moduleClient) & 1) !== 0;
		const token = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
		moduleClient.historyActivation = {
			start,
			activated,
			transient,
			token,
			natives:
				isActive && hasBeenActive && userActivation
					? [isActive, hasBeenActive, userActivation]
					: undefined,
		};
		// a sticky activation it starts with is carried over from the
		// frame's last document: natively only from one of its origin (its
		// referrer, the document that navigated, as the worker decided it)
		if (start) {
			let carried = false;
			try {
				const referrer = moduleClient.referrerOf(global.document);
				carried =
					!moduleClient.sandboxedOpaque &&
					!!referrer &&
					new URL(referrer).origin === moduleClient.origin;
			} catch (error) {
				// no referrer to read
			}
			const now = Date.now();
			const active =
				!!isActive &&
				!!userActivation &&
				Reflect.apply(isActive, userActivation, []) === true;
			// a transient one is carried too where the browser keeps the
			// frame (a frame's navigation, natively the same), not to a top:
			// natively a new page, here a frame of the host's
			const top = moduleClient.proxiedTop === global;
			if (carried) markActivation(moduleClient, false, -Infinity);
			if (!carried || (active && top))
				markActivation(moduleClient, true, now, !active, false);
		}
		const onInput = (event: Event) => {
			if (
				event.type === 'click'
					? !isActive ||
						!userActivation ||
						Reflect.apply(isActive, userActivation, []) !== true
					: !event.isTrusted
			)
				return;
			// keys that activate nothing (the spec's activation-triggering
			// keydown leaves out Escape and the modifiers)
			if (
				event.type === 'keydown' &&
				/^(Escape|Shift|Control|Alt|Meta|AltGraph|CapsLock|Fn)$/.test(
					(event as KeyboardEvent).key,
				)
			)
				return;
			// an input event that activates: the page's documents are told
			// whose activation it is (a click is none)
			if (
				event.isTrusted &&
				(event.type === 'keydown' ||
					event.type === 'mousedown' ||
					event.type === 'touchend' ||
					(event.type === 'pointerdown' &&
						(event as PointerEvent).pointerType === 'mouse') ||
					(event.type === 'pointerup' &&
						(event as PointerEvent).pointerType !== 'mouse'))
			)
				noteInput(moduleClient);
			if (input) return;
			input = true;
			if (moduleClient.activation) moduleClient.activation.ownSticky = true;
			// a frame of the host's own page (same-origin mode) is told at once:
			// a message from a document that is navigating can wait behind the
			// next document's loading for longer than the host can
			try {
				const element = moduleClient.nativeFrameElement() as unknown as Record<
					string,
					unknown
				> | null;
				const note = element?.[ACTIVATED];
				if (typeof note === 'function') {
					Reflect.apply(note, element, [token]);
					return;
				}
			} catch (error) {
				// the host's: it reads the message instead
			}
			moduleClient.postToHost({ [ACTIVATED]: token });
		};

		// document.open() drops window listeners (and runs before the real
		// page is written), so they are registered again after each open
		const listenInput = () => {
			for (const event of [
				'keydown',
				'mousedown',
				'pointerdown',
				'pointerup',
				'touchend',
				'click',
			])
				global.addEventListener(event, onInput, true);
		};
		listenInput();
		addDocumentOpenListener(global, listenInput);

		// A document in a frame of the page: the host takes from it which
		// client it is (its requests are the page's frame's) and when its
		// history moved (a step of the frame's history, which a tab's Back
		// takes first), and nothing else, where the frame is being its page's
		// to say. So no observer over the document, no title or icon read and
		// no message per change, in every frame of every page
		if (moduleClient.nested) {
			tell = () => moduleClient.postToHost({ [CLIENT_ID]: client });
			// its entry, for the slot's frame to read when it cannot read the
			// document itself: one of another origin than the page's top
			// (history.ts noteEntry). A document that reaches the page's top
			// is of its origin, and the slot's frame reads it
			const entry =
				moduleClient.sites &&
				((
					(moduleClient.proxiedTop as Record<string, any>)[
						moduleClient.names.client
					] as DocumentClient | undefined
				)?.nested ??
					true)
					? siteWindows().currentEntry(global)
					: null;
			watchHistory(() =>
				moduleClient.postToHost({
					[FRAME_MOVED]: client ?? null,
					...(entry ? { [FRAME_ENTRY]: entry() } : {}),
				}),
			);
			return;
		}

		// the frame's own history, all of it, whatever the page does to the
		// API (the page's view of it stops at its own origin)
		const history = moduleClient.getModule(HistoryModule)!;
		const navigationType = moduleClient.sites
			? siteWindows().activationType(global)
			: null;
		// the site pool: the frame's entries in other slots' stretches, which
		// the browser lists this document none of, as the hub last told the
		// agent of its slot, for its first script (the hub's count of them
		// comes after it); a traversal waits for that count
		if (navigationType) {
			const type = navigationType();
			const run = history.ownRun?.() ?? null;
			const told = siteWindows().slotAgentShare(
				global,
				SITE_RUNS,
				moduleClient.names.client,
			);
			if (run && Array.isArray(told) && /^(push|replace|reload)$/.test(type))
				for (const entry of told as {
					frame: unknown;
					push: unknown;
					replace: unknown;
				}[]) {
					const length = type === 'push' ? entry.push : entry.replace;
					if (entry.frame === global && typeof length === 'number') {
						moduleClient.pool[Pool.HistoryAcross] =
							Math.max(0, length - run[1]) || 0;
						break;
					}
				}
		}

		// the icon as the page declared it: the attribute the page wrote
		// (getAttribute hands back the original), resolved against the real URL
		const icon = (): string | null => {
			const links = global.document.querySelectorAll('link[rel]');
			let touch: string | null = null;
			for (const link of links) {
				const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
				const href = link.getAttribute('href');
				if (!href) continue;
				let resolved: string;
				try {
					resolved = moduleClient.encodingParse(
						href,
						moduleClient.baseHref,
					).href;
				} catch (error) {
					continue;
				}
				if (rel.includes('icon')) return resolved;
				if (!touch && rel.includes('apple-touch-icon')) touch = resolved;
			}
			return touch;
		};

		// the document's load and how its entry was reached, for the host's
		// tabs (TAB_LOAD: Chrome's tab status and webNavigation), read with
		// the browser's own getters taken before any page script ran
		const readyState = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'readyState',
		)?.get;
		const ready = (): TabLoad['ready'] => {
			const state = readyState
				? Reflect.apply(readyState, global.document, [])
				: 'complete';
			return state === 'loading' || state === 'interactive'
				? state
				: 'complete';
		};
		let how = reachedBy(moduleClient);
		const navigation = (global as { navigation?: EventTarget }).navigation;
		const changeType = Reflect.getOwnPropertyDescriptor(
			(
				global as unknown as {
					NavigationCurrentEntryChangeEvent?: { prototype: object };
				}
			).NavigationCurrentEntryChangeEvent?.prototype ?? {},
			'navigationType',
		)?.get;
		// (not a called document's: its navigation and its events are the
		// inject's, whose currententrychange the browser's getter refuses as
		// an illegal invocation, thrown out of the page's navigate(); it says
		// how it moved with called.moved below)
		if (navigation && changeType && !moduleClient.called)
			Reflect.apply(global.EventTarget.prototype.addEventListener, navigation, [
				'currententrychange',
				(event: Event) => {
					let type: unknown;
					try {
						type = Reflect.apply(changeType, event, []);
					} catch (error) {
						// an event the page made of another kind
						return;
					}
					if (typeof type === 'string') how = type;
				},
			]);

		let last = '';
		let lastLoad = '';
		const post = () => {
			const info: NavigateInfo = {
				url: moduleClient.url.toString(),
				title: global.document.title,
				canGoBack: history.canStep(-1),
				canGoForward: history.canStep(1),
				icon: icon(),
				...(client ? { client } : {}),
			};
			// the site pool: where the document is in its slot's stretch of
			// the frame's history (a step within it changes no URL at times)
			const run = history.ownRun?.() ?? null;
			const load: TabLoad = {
				ready: ready(),
				how,
				...(client ? { client } : {}),
			};
			const loadKey = JSON.stringify(load);
			const key = JSON.stringify([info, run]);
			if (key === last) {
				// (no navigate event of the host's for a load)
				if (loadKey !== lastLoad) {
					lastLoad = loadKey;
					moduleClient.postToHost({ [TAB_LOAD]: load });
				}
				return;
			}
			last = key;
			lastLoad = loadKey;
			moduleClient.postToHost({
				[NAVIGATE]: info,
				[TAB_LOAD]: load,
				...(navigationType ? { [NAVIGATION_TYPE]: navigationType() } : {}),
				...(run ? { [HISTORY_RUN]: run } : {}),
			});
		};
		tell = post;

		// many mutations land at once (a whole page), one message per turn
		const schedule = watchHistory(post);
		// a called document's moves make no history call of the browser's
		const called = moduleClient.called;
		if (called)
			called.moved = (type) => {
				how = type;
				schedule();
			};

		// and the page's autofocus where the browser refuses it (../autofocus)
		const autofocus = autofocusFlush(moduleClient);
		// What a turn's mutations can have changed, by the browser's own
		// getters taken before the page ran: post() reads the title, the
		// icon links and the base URL, and autofocus looks at elements added.
		// krunk.io's HUD rewrites a dozen text nodes in every frame, and each
		// frame made a timer, a read of the title and the icon links, two
		// JSON strings (post) and a querySelectorAll of the whole document
		// (autofocus): 11 to 12 ms of every 8 s of play in Chrome 159.
		// A record that touches none of those leaves both alone; one this
		// cannot read counts as touching everything, as every record did
		// before
		const nodeProto = global.Node.prototype;
		const elementProto = global.Element.prototype;
		const getterOf = (proto: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(proto, name)?.get;
		const nodeType = getterOf(nodeProto, 'nodeType');
		const nodeName = getterOf(nodeProto, 'nodeName');
		const parentNode = getterOf(nodeProto, 'parentNode');
		const querySelector = elementProto.querySelector;
		const hasAttribute = elementProto.hasAttribute;
		const recordProto = global.MutationRecord.prototype;
		const recordType = getterOf(recordProto, 'type');
		const recordTarget = getterOf(recordProto, 'target');
		const recordAdded = getterOf(recordProto, 'addedNodes');
		const recordRemoved = getterOf(recordProto, 'removedNodes');
		const DECLARED = /^(title|link|base|head|html)$/i;
		/** an element the title, an icon or the base may be in or be */
		const declares = (node: unknown) =>
			DECLARED.test(Reflect.apply(nodeName!, node, [])) ||
			Reflect.apply(querySelector, node, ['title,link,base']) !== null;
		const candidate = (node: unknown) =>
			Reflect.apply(hasAttribute, node, ['autofocus']) ||
			Reflect.apply(querySelector, node, ['[autofocus]']) !== null;
		const mutationsSeen = (records: unknown[], focus: boolean): number => {
			if (
				!nodeType ||
				!nodeName ||
				!parentNode ||
				!recordType ||
				!recordTarget ||
				!recordAdded ||
				!recordRemoved
			)
				return SEEN_ALL;
			const lists: Function[] = [recordAdded, recordRemoved];
			try {
				let seen = 0;
				for (const record of records) {
					const type = Reflect.apply(recordType!, record, []);
					const target = Reflect.apply(recordTarget!, record, []);
					if (type === 'attributes') seen |= SEEN_DECLARED;
					else if (type === 'characterData') {
						const parent = Reflect.apply(parentNode, target, []);
						if (parent && DECLARED.test(Reflect.apply(nodeName, parent, [])))
							seen |= SEEN_DECLARED;
					} else {
						if (
							Reflect.apply(nodeType, target, []) !== 1 ||
							DECLARED.test(Reflect.apply(nodeName, target, []))
						)
							seen |= SEEN_DECLARED;
						for (const list of lists) {
							const nodes: ArrayLike<unknown> = Reflect.apply(list, record, []);
							for (let i = 0; i < nodes.length; i++) {
								const node = nodes[i];
								if (Reflect.apply(nodeType, node, []) !== 1) continue;
								if (!(seen & SEEN_DECLARED) && declares(node))
									seen |= SEEN_DECLARED;
								if (
									focus &&
									list === recordAdded &&
									!(seen & SEEN_ELEMENT) &&
									candidate(node)
								)
									seen |= SEEN_ELEMENT;
							}
						}
					}
					if (seen === SEEN_ALL) break;
				}
				return seen;
			} catch (error) {
				return SEEN_ALL;
			}
		};
		const observer = new global.MutationObserver((records: unknown[]) => {
			const seen = mutationsSeen(records, !!autofocus);
			if (seen & SEEN_DECLARED) schedule();
			if (seen & SEEN_ELEMENT) autofocus?.();
		});
		const observe = () =>
			observer.observe(global.document, {
				subtree: true,
				childList: true,
				characterData: true,
				// an icon the page swaps in place
				attributes: true,
				attributeFilter: ['href', 'rel'],
			});
		observe();
		addDocumentOpenListener(global, observe);
	}
}

/**
 * How a document was reached, as its navigation's activation says (push,
 * replace, reload, traverse), read before any page script ran; a called
 * document's from what its host said
 */
function reachedBy(client: DocumentClient): string | null {
	const session = client.called?.session;
	if (session)
		return session.type === 'back_forward'
			? 'traverse'
			: session.type === 'reload'
				? 'reload'
				: session.replaced
					? 'replace'
					: 'push';
	const global = client.global as typeof globalThis & {
		navigation?: object;
		NavigationActivation?: { prototype: object };
	};
	try {
		const navigation = global.navigation;
		const activationProto = global.NavigationActivation?.prototype;
		if (!navigation || !activationProto) return null;
		const activation = Reflect.getOwnPropertyDescriptor(
			Reflect.getPrototypeOf(navigation)!,
			'activation',
		)?.get;
		const type = Reflect.getOwnPropertyDescriptor(
			activationProto,
			'navigationType',
		)?.get;
		const current = activation && Reflect.apply(activation, navigation, []);
		return current && type ? String(Reflect.apply(type, current, [])) : null;
	} catch (error) {
		return null;
	}
}
