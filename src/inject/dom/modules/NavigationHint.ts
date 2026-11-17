import {
	NAVIGATION_HINT,
	type NavigationHintMessage,
} from '../../../transport/messages';
import { withQuery } from '../../../urlShape';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { destinationURL } from '../freshContext';
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
	/**
	 * This document is a frame's and a navigate event says it goes to
	 * `destination` (the page's URL): its parent's frame-src judges it. True
	 * when it refused it (the navigation is cancelled, kept from the page's
	 * listeners, and made again to a refusal URL), false when it goes on and
	 * the worker was told, null when the navigation is none of a frame's to
	 * judge. Set by apply.
	 */
	judgeFrame: (event: Event, destination: string) => boolean | null = () =>
		null;
	apply() {
		const moduleClient = this.client;
		const global = moduleClient.global as typeof globalThis & {
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
			const own = moduleClient.url.url.origin;
			const candidates = [moduleClient.routedClient()];
			try {
				const openerClient = (opener as Record<string, unknown> | null)?.[
					moduleClient.names.client
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
					nested: moduleClient.nestedRoute,
					own: routed === moduleClient,
					...(csp ? { csp } : {}),
				},
			});
		});
		// a frame's navigation is its parent's frame-src's to judge, whoever
		// started it; the src its parent set it judged itself
		const judgeFrame = (this.judgeFrame = (event, destination) => {
			const navigate = event as Event & { navigationType?: string };
			const parent = moduleClient.parentClient();
			// (the destination reads as the page's URL, a route's real one;
			// a refusal URL is one already)
			const real = parent && unrouteURL(moduleClient, destination);
			if (
				!parent ||
				!real ||
				!/^https?:/.test(real) ||
				/^[a-z]+:\/\/[^/]*\.refused\.invalid[:/]/.test(real) ||
				navigate.navigationType === 'traverse'
			)
				return null;
			const judged = this.judged === real.replace(/#.*$/s, '');
			this.judged = null;
			const refused = judged
				? null
				: parent.loadRefusal('frame-src', new URL(real), true);
			if (refused !== null && navigate.cancelable) {
				// (the page's listeners hear of the navigation once: when it
				// goes to the refusal URL, which reads as this destination)
				event.preventDefault();
				event.stopImmediatePropagation();
				// (a Location's methods are its own: the page cannot replace them)
				if (navigate.navigationType === 'replace')
					global.location.replace(refused);
				else global.location.assign(refused);
				return true;
			}
			send(destination, undefined, {
				policies: parent.hopPolicies('frame-src') ?? [],
				ancestors: moduleClient.ancestorOrigins(),
				parent: true,
			});
			return false;
		});
		navigation.addEventListener('navigate', (event) => {
			const navigate = event as Event & {
				destination?: { url: string; sameDocument: boolean };
			};
			if (!navigate.destination || navigate.destination.sameDocument) return;
			// as the browser has it, read as the page's URL (the page's own
			// getter reads a refusal URL as the URL it stands for, Readback)
			const routed = destinationURL(navigate.destination);
			const destination =
				routed === null
					? navigate.destination.url
					: (unrouteURL(moduleClient, routed) ?? routed);
			if (judgeFrame(event, destination) === null) send(destination);
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
				const policies = moduleClient.hopPolicies('form-action');
				if (
					policies &&
					moduleClient
						.pageRefusals('form-action', url)
						.some(({ policy }) => policy.disposition === 'enforce')
				) {
					const element: Element = own('formaction') ? submitter! : form;
					const name = element === form ? 'action' : 'formaction';
					const written = nativeElement.getAttribute.call(element, name);
					const refusal = moduleClient.refusalURL(
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
								moduleClient.reportRefusal('form-action', url);
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
		const proxyModule = moduleClient.getModule(ProxyModule)!;
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
