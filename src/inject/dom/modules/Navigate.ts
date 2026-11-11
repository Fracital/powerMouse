import {
	CLIENT_ID,
	FRAME_MOVED,
	NAVIGATE,
	NavigateInfo,
} from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';
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
		const global = this.client.global;

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
			fetch(`${global.location.origin}${this.client.directory}whoami`)
				.then((response) => response.json())
				.then(learned)
				.catch(() => {});
		// a document on about:srcdoc is a client of its own with no such URL:
		// the service worker says which, once a request of this document is
		// one the host's log reports (nothing is asked, and nothing sent, for
		// a document that loads nothing). One on about:blank is no client:
		// its loads are made by the page that controls it
		else if (global.location.href === 'about:srcdoc')
			this.client.onServiceWorkerMessage((data) => {
				if (typeof data === 'object' && data !== null)
					learned((data as Record<string, unknown>)[CLIENT_ID]);
			});

		const proxyModule = this.client.getModule(ProxyModule)!;
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

		// A document in a frame of the page: the host takes from it which
		// client it is (its requests are the page's frame's) and when its
		// history moved (a step of the frame's history, which a tab's Back
		// takes first), and nothing else, where the frame is being its page's
		// to say. So no observer over the document, no title or icon read and
		// no message per change, in every frame of every page
		if (this.client.nested) {
			tell = () => this.client.postToHost({ [CLIENT_ID]: client });
			watchHistory(() =>
				this.client.postToHost({ [FRAME_MOVED]: client ?? null }),
			);
			return;
		}

		// the frame's own history, all of it, whatever the page does to the
		// API (the page's view of it stops at its own origin)
		const history = this.client.getModule(HistoryModule)!;

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
					resolved = new URL(href, this.client.url.toString()).href;
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
				url: this.client.url.toString(),
				title: global.document.title,
				canGoBack: history.canStep(-1),
				canGoForward: history.canStep(1),
				icon: icon(),
				...(client ? { client } : {}),
			};
			const key = JSON.stringify(info);
			if (key === last) return;
			last = key;
			this.client.postToHost({ [NAVIGATE]: info });
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
