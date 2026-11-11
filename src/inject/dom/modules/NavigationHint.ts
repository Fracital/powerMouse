import { NAVIGATION_HINT } from '../../../transport/messages';
import { withQuery } from '../../../urlShape';
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
 * navigate event, link activation and form submission (which may navigate
 * another browsing context, and in an initial about:blank document, which
 * fires no navigate events), the location hooks (`hint`, which also run
 * when another window navigates this one), and a frame's src the page sets.
 */
export default class NavigationHintModule extends Module<DocumentClient> {
	/** tell the worker this document is about to navigate to `url` (the real URL), a frame with its allow attribute: set by apply */
	hint: (url: string, allow?: string) => void = () => {};
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
		const send = (this.hint = (url: string, allow?: string) => {
			const routed = voucher();
			if (!routed) return;
			let activated = false;
			try {
				activated = !!(activation && isActive?.call(activation));
			} catch (error) {
				// no user activation API
			}
			routed.postToWorker({
				[NAVIGATION_HINT]: {
					directory: routed.directory,
					url,
					activated,
					...(allow !== undefined ? { allow } : {}),
					nested: this.client.nestedRoute,
					own: routed === this.client,
				},
			});
		});
		navigation.addEventListener('navigate', (event) => {
			const navigate = event as Event & {
				destination?: { url: string; sameDocument: boolean };
			};
			if (!navigate.destination || navigate.destination.sameDocument) return;
			send(navigate.destination.url);
		});
		// a link says where it goes when activated: the navigation may be
		// another browsing context's (a target), and an initial about:blank
		// document (a popup opened without a URL, a new frame) fires no
		// navigate events at all
		const onClick = (event: Event) => {
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
		// a form's submission, wherever it goes (a named popup or frame
		// navigates for this document, under this document's activation): its
		// destination as the browser builds it, the query the form's data for
		// a GET
		const onSubmit = (event: Event) => {
			const form = event.target;
			if (!(form instanceof global.HTMLFormElement)) return;
			const submitter = (event as SubmitEvent).submitter as
				HTMLButtonElement | HTMLInputElement | null;
			const own = (name: string) => !!submitter?.hasAttribute(name);
			const action = own('formaction') ? submitter!.formAction : form.action;
			const method = (
				(own('formmethod') ? submitter!.formMethod : form.method) || 'get'
			).toLowerCase();
			if (method === 'dialog') return;
			try {
				let url = new URL(action);
				// a form without fields submits to `action?` (src/urlShape.ts)
				if (method === 'get')
					url = withQuery(
						url,
						`?${new URLSearchParams(
							new global.FormData(
								form,
								submitter ?? undefined,
							) as unknown as Record<string, string>,
						).toString()}`,
					);
				if (/^https?:$/.test(url.protocol)) send(url.href);
			} catch (error) {
				// an action that is no URL submits nowhere
			}
		};
		const listen = () => {
			global.addEventListener('click', onClick, true);
			global.addEventListener('submit', onSubmit, true);
		};
		listen();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, listen);
	}
}
