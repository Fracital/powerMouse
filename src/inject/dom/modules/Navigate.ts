import {
	ACTIVATED,
	CLIENT_ID,
	FRAME_ENTRY,
	FRAME_MOVED,
	HISTORY_RUN,
	NAVIGATE,
	NavigateInfo,
	NAVIGATION_TYPE,
} from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { activationState, markActivation, noteInput } from '../activation';
import DocumentClient, { addDocumentOpenListener } from '../Client';
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
		// about: and blob: documents have no proxy-origin URL to ask
		if (/^https?:$/.test(global.location.protocol))
			fetch(`${global.location.origin}${moduleClient.directory}whoami`)
				.then((response) => response.json())
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
						moduleClient.baseURL.toString(),
					).href;
				} catch (error) {
					continue;
				}
				if (rel.includes('icon')) return resolved;
				if (!touch && rel.includes('apple-touch-icon')) touch = resolved;
			}
			return touch;
		};

		let last = '';
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
			const key = JSON.stringify([info, run]);
			if (key === last) return;
			last = key;
			moduleClient.postToHost({
				[NAVIGATE]: info,
				...(navigationType ? { [NAVIGATION_TYPE]: navigationType() } : {}),
				...(run ? { [HISTORY_RUN]: run } : {}),
			});
		};
		tell = post;

		// many mutations land at once (a whole page), one message per turn
		const schedule = watchHistory(post);

		const observer = new global.MutationObserver(schedule);
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
