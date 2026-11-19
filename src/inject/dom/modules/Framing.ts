import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../../routeURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { routedPrefix } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { hostGeometry } from '../hostGeometry';
import { nativeTopOf, siteWindows } from '../siteWindows';
import ContextModule, { reachableClients } from './Context';

/**
 * Makes a proxied document believe it is a top-level page even though the
 * host application shows it in an iframe. The Context module already spoofs
 * `top` and `parent`; this covers the other tells:
 *
 * - `frameElement` is null
 * - `window.name` is empty in the host's frame (the host names it so its
 *   controller can find it; a page must never see that, but it may still use
 *   the name slot as storage, so writes go to a shadow value); a frame or
 *   popup the page made keeps the name it gave it
 * - outer size and screen position are a window's whose viewport is the
 *   frame's: the browser's window less the host's UI around the frame
 * - `document.referrer` never reveals the host; a document the service
 *   worker served shows the referrer it computed under the referring
 *   document's policy for the real origins, and anything else (srcdoc,
 *   blob: documents) decodes a routed referrer to the real page URL
 * - `message` events from windows outside the proxied world never reach the
 *   page (the host must not be able to talk to it, and it must not learn
 *   the host exists)
 */
export default class FramingModule extends Module<DocumentClient> {
	apply() {
		const moduleClient = this.client;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const global = moduleClient.global;
		// (only a top-level document of a slot has the hub's page above it)
		if (moduleClient.sites && !moduleClient.nested)
			siteWindows().keepTopFocus(global, moduleClient.sites.hub);

		// the host's frame is never seen; a frame nested in a proxied page of the
		// same real origin gets its element, as a browser gives it (another
		// origin's parent gives null, as a browser does too)
		const nativeFrameElement =
			Reflect.getOwnPropertyDescriptor(global, 'frameElement')?.get ||
			function () {
				return null;
			};
		Reflect.defineProperty(global, 'frameElement', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(nativeFrameElement, () => {
				if (!moduleClient.nested) return null;
				try {
					const parentClient = (moduleClient.parent as Record<string, any>)[
						moduleClient.names.client
					] as DocumentClient;
					// an opaque origin (a sandbox without allow-same-origin) is
					// another origin to every other document, its parent included
					if (
						moduleClient.sandboxedOpaque ||
						parentClient.sandboxedOpaque ||
						!reachableClients(moduleClient, parentClient)
					)
						return null;
					return Reflect.apply(nativeFrameElement, global, []);
				} catch (error) {
					return null;
				}
			}),
		});

		// window.viewport.segments (the Viewport Segments API) is a frozen
		// array of one rectangle, the viewport, in a top-level page on an
		// ordinary screen, and null in every frame. A page the host frames
		// read null; it reads the one rectangle of a window its size. A
		// frame nested in a proxied page still reads null, as natively, and
		// so does a removed frame's window (closed, its parent itself, and
		// no DOMRect of its own to make one with).
		const viewport = (global as { viewport?: object }).viewport;
		const viewportPrototype = (global as Record<string, any>).Viewport
			?.prototype as object | undefined;
		const segments =
			viewportPrototype &&
			Reflect.getOwnPropertyDescriptor(viewportPrototype, 'segments');
		if (viewportPrototype && segments?.get)
			Reflect.defineProperty(viewportPrototype, 'segments', {
				...segments,
				get: proxyModule.wrapFunction(segments.get, (target, that, args) => {
					const native = Reflect.apply(target, that, args);
					if (
						native !== null ||
						that !== viewport ||
						moduleClient.nested ||
						global.closed ||
						typeof global.DOMRect !== 'function'
					)
						return native;
					return global.Object.freeze(
						global.Array.of(
							new global.DOMRect(0, 0, global.innerWidth, global.innerHeight),
						),
					);
				}),
			});

		// getInstalledRelatedApps() rejects in any frame ("only supported in
		// top-level browsing contexts"), which a page the host frames threw
		// where natively it runs (whatpwacando.today): a top-level page with
		// none of its related apps installed gets an empty list. A frame
		// nested in a proxied page still gets the browser's rejection
		const relatedApps = global.Navigator?.prototype as
			{ getInstalledRelatedApps?: () => Promise<unknown[]> } | undefined;
		if (typeof relatedApps?.getInstalledRelatedApps === 'function')
			relatedApps.getInstalledRelatedApps = proxyModule.wrapFunction(
				relatedApps.getInstalledRelatedApps,
				(target, that, args) => {
					if (moduleClient.nested || !(that instanceof global.Navigator))
						return Reflect.apply(target, that, args);
					return global.Promise.resolve(new global.Array());
				},
			);

		// opener: a page opened by another STomp page keeps it (restricted
		// across origins by the Context module); anything else, the host
		// included, is no opener a top-level page would have
		const openerDescriptor = Reflect.getOwnPropertyDescriptor(global, 'opener');
		if (openerDescriptor?.get)
			Reflect.defineProperty(global, 'opener', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(openerDescriptor.get, (target, that) => {
					const opener = Reflect.apply(target, that, []);
					try {
						if (opener && moduleClient.names.client in opener)
							return moduleClient
								.getModule(ContextModule)!
								.newRestricted(opener);
					} catch (error) {
						// cross-origin: the host, or (the site pool) another site's
						// window, restricted as without a pool (ContextModule)
						const sites = this.client.sites;
						if (sites && !siteWindows().isHub(global, opener, sites.hub))
							return siteWindows().restrictAcross(
								this.client,
								this.client.getModule(ContextModule)!,
								opener,
							);
					}
					return null;
				}),
				set: openerDescriptor.set,
			});

		// window.name: in the host's frame a shadow value, starting empty (the
		// name there is the host's). A frame the page made, or a popup, keeps
		// its own: the page named it, and finds it by that name
		// (`parent.frames[name]`, a link's target), as natively
		const hostFramed = (() => {
			try {
				return !moduleClient.nested && (global.parent as unknown) !== global;
			} catch (error) {
				// a parent of another origin: the host's frame
				return true;
			}
		})();
		if (hostFramed) {
			let shadowName = '';
			const nameDescriptor = Reflect.getOwnPropertyDescriptor(global, 'name')!;
			Reflect.defineProperty(global, 'name', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(nameDescriptor.get!, () => shadowName),
				set: proxyModule.wrapFunction(
					nameDescriptor.set!,
					(target, that, args) => {
						shadowName = String(args[0]);
					},
				),
			});
		}

		// outerWidth, outerHeight, screenX/Y and screenLeft/Top: the
		// browser's window less the host's UI around the host's frame, in
		// every document below the real top (../hostGeometry.ts). Not the
		// frame's inner size at 0,0, a window with no toolbar at all
		// (outerHeight equal to innerHeight), which a real one never is
		// outside fullscreen, nor the browser window's own, which counts the
		// host's bars as browser UI
		if ((Reflect.apply(nativeTopOf!, global, []) as unknown) !== global)
			hostGeometry(moduleClient, proxyModule);

		// document.referrer: the host page is never the referrer
		const referrerDescriptor = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'referrer',
		)!;
		Reflect.defineProperty(global.Document.prototype, 'referrer', {
			...referrerDescriptor,
			get: proxyModule.wrapFunction(
				referrerDescriptor.get!,
				(target, that, args) => {
					// the browser judged the policy in proxy URL space, where every
					// page is same-origin and the full routed URL is kept
					const decided = moduleClient.referrerOf(that);
					if (decided !== undefined) return decided;
					const referrer = String(Reflect.apply(target, that, args));
					if (!referrer) return '';
					try {
						const url = new URL(referrer);
						// the proxy origin from the routed prefix, not from location:
						// an about:blank or srcdoc document reads its location origin as
						// "null", and an iframe's initial about:blank has its creator's
						// full (routed) URL as its referrer whatever the policy
						if (
							url.origin === new URL(routedPrefix(moduleClient)).origin &&
							ROUTE_PROTOCOLS.includes(url.protocol) &&
							url.pathname.startsWith(`${moduleClient.directory}html`)
						) {
							return parseRoutedURL(
								referrer,
								moduleClient.codec,
								`${url.origin}${moduleClient.directory}`,
							).url.toString();
						}
					} catch (error) {
						// not a routed URL
					}
					// anything else (the host application) is not a referrer the page may see
					return '';
				},
			),
		});

		// messages from outside the proxied world never reach the page. The
		// Context module later replaces MessageEvent.source with a spoofed
		// value, so take the native getter now (this module applies first).
		const nativeSource = Reflect.getOwnPropertyDescriptor(
			global.MessageEvent.prototype,
			'source',
		)!.get!;
		const sites = this.client.sites;
		const isStompWindow = (source: unknown) => {
			if (!source) return true; // MessagePorts, workers: not a window
			try {
				return moduleClient.names.client in (source as unknown as object);
			} catch (error) {
				// cross-origin: the host, or (the site pool) another site's
				// window unless it is the hub's page
				return !!sites && !siteWindows().isHub(global, source, sites.hub);
			}
		};
		// document.open() (which loadHTML uses to write the real page) drops
		// every listener on the window, so register again after each open
		const filterMessages = () =>
			global.addEventListener(
				'message',
				(event) => {
					let source: Window | null;
					try {
						source = Reflect.apply(nativeSource, event, []) as Window | null;
					} catch (error) {
						// an event the page made that is no MessageEvent
						// (`dispatchEvent(new Event('message'))`): it has no source
						return;
					}
					if (
						typeof source?.postMessage === 'function' &&
						!isStompWindow(source)
					)
						event.stopImmediatePropagation();
				},
				true,
			);
		filterMessages();
		addDocumentOpenListener(global, filterMessages);
	}
}
