import {
	NAVIGATION_HINT,
	type NavigationHintMessage,
} from '../../../transport/messages';
import { withQuery } from '../../../urlShape';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import { activationState } from '../activation';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import { destinationURL } from '../freshContext';
import { clickedLink } from '../links';
import { nativeElement } from './DOMHooks';
import { hookWrite } from './MutationObserver';

// a window's opener as the browser has it, taken when the bundle runs
const nativeOpener = Reflect.getOwnPropertyDescriptor(window, 'opener')!.get!;

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
		/**
		 * the navigation may open a window (a popup) this document makes:
		 * true for window.open, a link's or a form's target and whether a
		 * modifier key opens a new window
		 */
		opens?: true | [target: string | null, modifier: boolean],
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
		const routedClients = (): (DocumentClient | null)[] => {
			const candidates = [moduleClient.routedClient()];
			try {
				const openerClient = (opener as Record<string, unknown> | null)?.[
					moduleClient.names.client
				] as DocumentClient | undefined;
				candidates.push(openerClient?.routedClient() ?? null);
			} catch (error) {
				// an opener of another origin: not ours
			}
			return candidates as (DocumentClient | null)[];
		};
		const voucher = (): DocumentClient | null => {
			const own = moduleClient.url.url.origin;
			return (
				routedClients().find(
					(client) => client && client.url.url.origin === own,
				) ?? null
			);
		};
		const send = (this.hint = (
			url: string,
			allow?: string,
			csp?: NavigationHintMessage['csp'],
			opens?: true | [string | null, boolean],
		) => {
			const routed = voucher();
			// what the worker decides a top-level navigation's opener policy
			// by (../openerFacts.ts): only for a window this document opens,
			// or a navigation of a real top the proxy has
			let coop: NavigationHintMessage['coop'];
			try {
				const top = global.top as unknown as Record<string, unknown> | null;
				if (opens || (top && moduleClient.names.client in top))
					coop = deferred('openerFacts')(moduleClient, opens, nativeOpener);
			} catch (error) {
				// a document going away, or the host's top of another origin
			}
			if (!routed) {
				// a popup of another site than its opener's that no worker
				// controls (in Chrome 157 a popup that stays in its opener's
				// group has no controller): the opener's routed document
				// carries the opener policy facts alone, which are the
				// window's, not the initiator's
				const carrier = coop && routedClients().find(Boolean);
				carrier?.postToWorker({
					[NAVIGATION_HINT]: {
						directory: carrier.directory,
						url,
						coopOnly: true,
						coop,
					},
				});
				return;
			}
			// the document's own, as natively (./activation.ts), or for a
			// navigation another document makes of this window in the call
			// (navigateOther), that document's: the browser takes the
			// initiator's, and this window's own is none (a popup opened
			// without a URL has had no input)
			const told = moduleClient.initiatorActivation;
			const activated =
				told?.url === url
					? told.active
					: (activationState(moduleClient) & 1) !== 0;
			routed.postToWorker({
				[NAVIGATION_HINT]: {
					directory: routed.directory,
					url,
					activated,
					...(allow !== undefined ? { allow } : {}),
					nested: moduleClient.nestedRoute,
					own: routed === moduleClient,
					...(csp ? { csp } : {}),
					...(coop ? { coop } : {}),
				},
			});
		});
		// a frame's navigation is its parent's frame-src's to judge, whoever
		// started it; the src its parent set it judged itself
		const judgeFrame = (this.judgeFrame = (event, destination) => {
			const navigate = event as Event & { navigationType?: string };
			const parent = moduleClient.parentClient();
			if (!parent) return judgeAcross?.(event, destination) ?? null;
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
				required: parent.requiredCSP(moduleClient.nativeFrameElement()),
			});
			return false;
		});
		// the site pool: a frame whose parent is a document of another slot,
		// which it cannot reach (a deferred part, ../siteEvents.ts judgeAcross;
		// made only under a pool)
		const judgeAcross = this.client.sites
			? (event: Event, destination: string) =>
					this.client.scriptFacts.framed &&
					(global.parent as unknown) !== global
						? deferred('judgeAcross')(this.client, event, destination, send)
						: null
			: null;
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
			const link = clickedLink(global, event);
			if (!link) return;
			// the page's view: the real URL
			const url = link.href;
			const mouse = event as MouseEvent;
			if (/^https?:/.test(url))
				send(url, undefined, undefined, [
					link.getAttribute('target'),
					event.type === 'auxclick' ||
						mouse.ctrlKey ||
						mouse.metaKey ||
						mouse.shiftKey,
				]);
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
				const target = own('formtarget')
					? submitter!.getAttribute('formtarget')
					: form.getAttribute('target');
				const policies = moduleClient.hopPolicies('form-action');
				// where the page's code submitted it, which a violation of it
				// names, a redirect's too (a new window's navigation names
				// none, as natively)
				if (policies)
					try {
						deferred('noteFormSite')(moduleClient, url.href, target);
					} catch (error) {
						// the part cannot be had: the violation names no place
					}
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
				send(url.href, undefined, policies ? { policies } : undefined, [
					target,
					false,
				]);
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
