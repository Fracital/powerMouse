import {
	NAVIGATION_HINT,
	type NavigationHintMessage,
} from '../../../transport/messages';
import { withQuery } from '../../../urlShape';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { nativeElement } from './DOMHooks';
import { hookWrite } from './MutationObserver';

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
 *
 * It also says which of the page's policies judge the navigation's later
 * hops (src/csp.ts): a form's form-action, a frame's parent's frame-src,
 * and a frame's real ancestors (its document's frame-ancestors), which
 * the worker applies (src/server/contentPolicies.ts). What they refuse of
 * the navigation itself is refused here, before it starts: a submission
 * goes to a refusal URL (DocumentClient.refusalURL) the browser's copy of
 * the form-action refuses, a frame's own navigation to one its parent's
 * frame-src refuses, and the browser refuses and reports it as natively.
 */
export default class NavigationHintModule extends Module<DocumentClient> {
	/** tell the worker this document is about to navigate to `url` (the real URL), a frame with its allow attribute and its policies: set by apply */
	hint: (
		url: string,
		allow?: string,
		csp?: NavigationHintMessage['csp'],
	) => void = () => {};
	/** the real URL a frame's src was set to by its parent, which judged it (set by the parent on this document's module) */
	judged: string | null = null;
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
		const send = (this.hint = (
			url: string,
			allow?: string,
			csp?: NavigationHintMessage['csp'],
		) => {
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
					...(csp ? { csp } : {}),
				},
			});
		});
		navigation.addEventListener('navigate', (event) => {
			const navigate = event as Event & {
				destination?: { url: string; sameDocument: boolean };
				navigationType?: string;
			};
			if (!navigate.destination || navigate.destination.sameDocument) return;
			const destination = navigate.destination.url;
			// a frame's navigation is its parent's frame-src's to judge,
			// whoever started it; the src its parent set it judged itself
			const parent = this.client.parentClient();
			// (the destination reads as the page's URL, a route's real one;
			// a refusal URL is one already)
			const real = parent && unrouteURL(this.client, destination);
			if (
				parent &&
				real &&
				/^https?:/.test(real) &&
				!/^[a-z]+:\/\/[^/]*\.refused\.invalid[:/]/.test(real) &&
				navigate.navigationType !== 'traverse'
			) {
				const judged = this.judged === real.replace(/#.*$/s, '');
				this.judged = null;
				const refused = judged
					? null
					: parent.loadRefusal('frame-src', new URL(real), true);
				if (refused !== null && navigate.cancelable) {
					event.preventDefault();
					// (a Location's methods are its own: the page cannot replace them)
					if (navigate.navigationType === 'replace')
						global.location.replace(refused);
					else global.location.assign(refused);
					return;
				}
				send(destination, undefined, {
					policies: parent.hopPolicies('frame-src') ?? [],
					ancestors: this.client.ancestorOrigins(),
					parent: true,
				});
				return;
			}
			send(destination);
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
			submitted(
				form,
				(event as SubmitEvent).submitter as
					HTMLButtonElement | HTMLInputElement | null,
				event,
			);
		};
		/**
		 * A form's submission is about to be made: the worker is told where
		 * it goes, and the page's form-action judges it (src/csp.ts). One it
		 * refuses goes to a refusal URL (its element's action, put back in a
		 * moment): the browser refuses it there and reports it as natively,
		 * nothing is sent and no window opens. The action is put back in the
		 * next task (a submit event's submission reads it once the event is
		 * done), or by the returned function (at the end of submit()). `event`:
		 * the submit event, which the page may still cancel
		 */
		const submitted = (
			form: HTMLFormElement,
			submitter: HTMLButtonElement | HTMLInputElement | null,
			event?: Event,
		): (() => void) | null => {
			const own = (name: string) => !!submitter?.hasAttribute(name);
			const action = own('formaction') ? submitter!.formAction : form.action;
			const method = (
				(own('formmethod') ? submitter!.formMethod : form.method) || 'get'
			).toLowerCase();
			if (method === 'dialog') return null;
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
				if (!/^https?:$/.test(url.protocol)) return null;
				const policies = this.client.hopPolicies('form-action');
				if (
					policies &&
					this.client
						.pageRefusals('form-action', url)
						.some(({ policy }) => policy.disposition === 'enforce')
				) {
					const element: Element = own('formaction') ? submitter! : form;
					const name = element === form ? 'action' : 'formaction';
					const written = nativeElement.getAttribute.call(element, name);
					const refusal = this.client.refusalURL(
						'https',
						url.href,
						url.href.replace(/#.*$/s, ''),
					);
					const write = (value: string | null) =>
						hookWrite(
							element,
							() => [name],
							() =>
								value === null
									? nativeElement.removeAttribute.call(element, name)
									: nativeElement.setAttribute.call(element, name, value),
						);
					write(refusal);
					const restore = () => {
						if (nativeElement.getAttribute.call(element, name) === refusal)
							write(written);
					};
					Reflect.apply(setTimeout, global, [restore, 0]);
					return restore;
				}
				// (a report-only one's refusal is reported a task later, as the
				// browser would, unless the page cancelled the submission)
				if (policies)
					Reflect.apply(setTimeout, global, [
						() => {
							if (!event?.defaultPrevented)
								this.client.reportRefusal('form-action', url);
						},
						0,
					]);
				send(url.href, undefined, policies ? { policies } : undefined);
			} catch (error) {
				// an action that is no URL submits nowhere
			}
			return null;
		};
		// submit() fires no submit event
		const proxyModule = this.client.getModule(ProxyModule)!;
		const nativeSubmit = global.HTMLFormElement.prototype.submit;
		global.HTMLFormElement.prototype.submit = proxyModule.wrapFunction(
			nativeSubmit,
			(target, that, args) => {
				let restore: (() => void) | null = null;
				try {
					if (that instanceof global.HTMLFormElement)
						restore = submitted(that, null);
				} catch (error) {
					// no form: the call throws on its own
				}
				try {
					return Reflect.apply(target, that, args);
				} finally {
					restore?.();
				}
			},
		);
		const listen = () => {
			global.addEventListener('click', onClick, true);
			global.addEventListener('submit', onSubmit, true);
		};
		listen();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, listen);
	}
}
