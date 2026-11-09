import { NAVIGATION_HINT } from '../../../transport/messages';
import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';

/**
 * Tells the service worker, before a document's navigation leaves it, who
 * started it (NAVIGATION_HINT): the worker sees a navigation's referrer
 * only, and a document that sends none (about:blank, a no-referrer policy)
 * would look like the user's own from the host. Also whether the page had
 * user activation, for Sec-Fetch-User. Sent through the nearest routed
 * document of this one's origin, which the worker can verify; for a popup
 * opened without a URL that is the opener's. From the Navigation API's
 * navigate event, or, in an initial about:blank document (which fires
 * none), from link activation and from the location hooks (`hint`), which
 * also run when another window navigates this one.
 */
export default class NavigationHintModule extends Module<DocumentClient> {
	/** tell the worker this document is about to navigate to `url` (the real URL): set by apply */
	hint: (url: string) => void = () => {};
	apply() {
		const global = this.client.global as typeof globalThis & {
			navigation?: EventTarget;
		};
		const navigation = global.navigation;
		if (!navigation) return;
		// as they are now, before the page could replace them
		const opener = (() => {
			try {
				return global.opener as typeof globalThis | null;
			} catch (error) {
				return null;
			}
		})();
		const isActive = Object.getOwnPropertyDescriptor(
			global.UserActivation?.prototype ?? {},
			'isActive',
		)?.get;
		const activation = global.navigator.userActivation;
		const voucher = (): DocumentClient | null => {
			const own = this.client.url.url.origin;
			const candidates = [this.client.routedClient()];
			try {
				const openerClient = (opener as Record<string, unknown> | null)?.[
					this.client.names.client
				] as DocumentClient | undefined;
				candidates.push(openerClient?.routedClient() ?? null);
			} catch (error) {
				// an opener of another origin: not ours
			}
			return (
				(candidates.find(
					(client) => client && client.url.url.origin === own,
				) as DocumentClient | undefined) ?? null
			);
		};
		const send = (this.hint = (url: string) => {
			const routed = voucher();
			if (!routed) return;
			let activated = false;
			try {
				activated = !!(activation && isActive?.call(activation));
			} catch (error) {
				// no user activation API
			}
			routed.postToWorker({
				[NAVIGATION_HINT]: { directory: routed.directory, url, activated },
			});
		});
		navigation.addEventListener('navigate', (event) => {
			const navigate = event as Event & {
				destination?: { url: string; sameDocument: boolean };
			};
			if (!navigate.destination || navigate.destination.sameDocument) return;
			send(navigate.destination.url);
		});
		// an initial about:blank document (a popup opened without a URL, a new
		// frame) fires no navigate events: its links say where they go when
		// activated instead
		const entry = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(navigation),
			'currentEntry',
		)?.get;
		const onClick = (event: Event) => {
			try {
				if (entry?.call(navigation)) return;
			} catch (error) {
				return;
			}
			const link = event
				.composedPath()
				.find(
					(node): node is HTMLAnchorElement | HTMLAreaElement =>
						node instanceof global.Element &&
						(node.nodeName === 'A' || node.nodeName === 'AREA') &&
						node.hasAttribute('href'),
				);
			if (!link) return;
			// the page's view: the real URL
			const url = link.href;
			if (/^https?:/.test(url)) send(url);
		};
		const listen = () => global.addEventListener('click', onClick, true);
		listen();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, listen);
	}
}
