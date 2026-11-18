// window.open(), a deferred part of the document bundle (./deferredParts.ts),
// made at a document's first call: where the URL is routed (this window,
// the proxied parent or top, a window of another slot, a frame or popup of
// the tab by that name, a new tab the host opens), and the window it opened
// remembered for the tab. DOMHooks installs the wrapper as the bundle loads
// and makes the part before it calls anything of the browser's, in the call
// (it stays inside the user's activation): without it the call throws and
// nothing opens. document.open() with three arguments reaches it through
// the window's open. Its top level reads no global (constants and functions
// only).
import { routeHTML } from '../../rewriteHTML';
import StompURL from '../../StompURL';
import { mayOpenPopup, popupOpened } from './activation';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import { frameWindow } from './freshContext';
import ContextModule from './modules/Context';
import { siteWindows } from './siteWindows';

type Open = typeof globalThis.open;

/**
 * The body of `client`'s window.open wrapper, called as the wrapper is
 * (`NativeWeakRef`: WeakRef, taken before any page script ran)
 */
export function windowOpen(
	client: DocumentClient,
	NativeWeakRef: WeakRefConstructor,
) {
	const realm = client.global;
	// a window this document opened, for a link, form or open() of the
	// tab that names it later (DocumentClient namedWindow, tabPopups
	// of the proxied top's client; the last 64)
	const rememberOpened = (opened: unknown) => {
		if (typeof opened !== 'object' || opened === null) return;
		try {
			const top = (client.proxiedTop as Record<string, any>)[
				client.names.client
			] as DocumentClient | undefined;
			if (!top) return;
			const list = (top.tabPopups ??= []);
			if (list.length >= 64) list.shift();
			list.push(new NativeWeakRef(opened as typeof globalThis));
		} catch (error) {
			// the proxied top went away
		}
	};
	return (target: Open, that: unknown, args: any[]): unknown => {
		const name = args[1] === undefined ? '_blank' : String(args[1]);
		// about:blank (or no URL) is a document the page writes itself:
		// opened as is, injected by the IFrame module's hook
		let destination: URL | null = null;
		if (args[0] !== undefined && String(args[0]) !== '')
			destination = client.encodingParse(String(args[0]), client.baseHref);
		const routable =
			destination !== null && /^https?:$/.test(destination.protocol);
		// the proxied parent or top, named from a frame under the top:
		// the URL is routed as that window's document
		let aimed = client.targetWindow(name);
		// from a sandboxed document, the one it may navigate (else the
		// browser opens nothing and the page gets null)
		const keyword = name.toLowerCase();
		if (
			client.sandboxFlags !== null &&
			['_top', '_parent', '_unfencedtop'].includes(keyword)
		) {
			const window = keyword === '_parent' ? client.parent : client.proxiedTop;
			if (window !== realm) {
				if (!client.mayNavigate(window)) return null;
				const windowClient = (window as Record<string, any>)[
					client.names.client
				] as DocumentClient | undefined;
				if (windowClient) aimed = { window, client: windowClient };
			}
		}
		// the site pool: a window of another slot, asked to go there
		// itself; a javascript: URL runs in no window of another origin.
		// The caller gets that window's stand-in
		const across =
			aimed || !client.sites ? null : siteWindows().targetAcross(client, name);
		if (across) {
			if (routable)
				deferred('navigateAcross')(client, across, {
					kind: 'link',
					url: destination!.href,
				});
			return siteWindows().restrictAcross(
				client,
				client.getModule(ContextModule)!,
				across,
			);
		}
		// a frame of the tab by that name, which the browser would not
		// navigate for this frame (DocumentClient namedWindow): this
		// document's navigation of it, and the caller gets it
		if (!aimed && routable) {
			const named = client.namedWindow?.(name);
			if (named && client.navigateWindow?.(named, destination!.href, 'href'))
				return named;
		}
		// a javascript: URL runs in the opened window: rewritten, like a
		// javascript: link (routeHTML rewrites its body)
		if (destination !== null && destination.protocol === 'javascript:')
			args[0] = routeHTML(
				new StompURL(destination, client.url),
				client.url,
				client.config,
				false,
				aimed ? aimed.client.nestedRoute : client.nestedRoute,
			);
		// a new tab: the host's to open, when it said so (then the page
		// sees null, as with a popup blocker). Not for a sandboxed
		// document's popup that keeps its sandbox: the browser refuses it
		// without allow-popups, and opens it sandboxed like the page
		// (the IFrame module starts it with the opener's flags)
		const escapes =
			client.sandboxFlags === null ||
			(client.allows('allow-popups') &&
				client.allows('allow-popups-to-escape-sandbox'));
		if (
			client.config.openTab &&
			routable &&
			escapes &&
			!['_self', '_top', '_parent', '_unfencedtop'].includes(
				name.toLowerCase(),
			) &&
			// a frame of this page by that name: the browser navigates it,
			// and a popup the tab opened (DocumentClient namedWindow)
			!client.hasFrameNamed(name) &&
			!client.namedWindow?.(name, true)
		) {
			// Chrome's popup blocker: none without a transient activation,
			// one for each (../activation.ts)
			if (!mayOpenPopup(client)) return null;
			if (client.openInHost(destination!.toString())) {
				popupOpened(client);
				return null;
			}
		}

		if (routable)
			args[0] =
				// this window itself: a navigation like location.assign's; the
				// proxied parent or top: one of that window's own
				name.toLowerCase() === '_self'
					? client.navigationRoute(destination!)
					: aimed
						? aimed.client.navigationRoute(destination!)
						: routeHTML(
								new StompURL(destination!, client.url),
								client.url,
								client.config,
								false,
								client.nestedRoute,
							);

		// the proxied parent or top navigates from its own realm (see
		// DocumentClient targetWindow), and a javascript: URL's code runs
		// there; the caller gets that window
		if (aimed)
			return aimed.client.callIn(target, aimed.window, [
				args[0],
				'_self',
				...args.slice(2),
			]);

		// a frame of this document by that name still on its initial
		// about:blank fires no navigate event: one sent to another
		// origin gets a fresh context first, which the browser then
		// navigates by its name
		if (routable && destination) {
			const element = client.frameNamed(name);
			const view = element && frameWindow(element);
			let frameClient: DocumentClient | undefined;
			try {
				frameClient = view
					? ((view as unknown as Record<string, unknown>)[
							client.names.client
						] as DocumentClient | undefined)
					: undefined;
			} catch (error) {
				// another real origin's
			}
			frameClient?.freshTo?.(destination, null, true);
		}

		// a top-level page is its own top and parent: navigate the frame
		// (a sandboxed frame's too)
		if (
			args[1] !== undefined &&
			['_top', '_parent', '_unfencedtop'].includes(name.toLowerCase())
		)
			args[1] = '_self';

		const opened = Reflect.apply(target, that, args);
		rememberOpened(opened);
		return opened;
	};
}
