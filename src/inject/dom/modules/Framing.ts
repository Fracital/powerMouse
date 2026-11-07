import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../../routeURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import ContextModule, { sameOrigin } from './Context';

/**
 * Makes a proxied document believe it is a top-level page even though the
 * host application shows it in an iframe. The Context module already spoofs
 * `top` and `parent`; this covers the other tells:
 *
 * - `frameElement` is null
 * - `window.name` is empty (the host names frames so its controller can find
 *   them; a page must never see that, but it may still use the name slot as
 *   storage, so writes go to a shadow value)
 * - outer size / screen position match the inner size, like a maximised
 *   window
 * - `document.referrer` never reveals the host; a routed referrer decodes to
 *   the real page URL
 * - `message` events from windows outside the proxied world never reach the
 *   page (the host must not be able to talk to it, and it must not learn
 *   the host exists)
 */
export default class FramingModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;

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
				if (!this.client.nested) return null;
				try {
					const parentClient = (this.client.parent as Record<string, any>)[
						this.client.names.client
					] as DocumentClient;
					if (
						!sameOrigin(this.client.url.toString(), parentClient.url.toString())
					)
						return null;
					return Reflect.apply(nativeFrameElement, global, []);
				} catch (error) {
					return null;
				}
			}),
		});

		// opener: a page opened by another Stomp page keeps it (restricted
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
						if (opener && this.client.names.client in opener)
							return this.client
								.getModule(ContextModule)!
								.newRestricted(opener);
					} catch (error) {
						// cross-origin
					}
					return null;
				}),
				set: openerDescriptor.set,
			});

		// window.name: shadow value, starts empty
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

		// outer size and screen position of a "maximised top-level window"
		const sizes: [string, () => number][] = [
			['outerWidth', () => global.innerWidth],
			['outerHeight', () => global.innerHeight],
			['screenX', () => 0],
			['screenY', () => 0],
			['screenLeft', () => 0],
			['screenTop', () => 0],
		];
		for (const [name, value] of sizes) {
			const descriptor = Reflect.getOwnPropertyDescriptor(global, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(global, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, value),
			});
		}

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
					const referrer = String(Reflect.apply(target, that, args));
					if (!referrer) return '';
					try {
						const url = new URL(referrer);
						if (
							url.origin === global.location.origin &&
							ROUTE_PROTOCOLS.includes(url.protocol) &&
							url.pathname.startsWith(`${this.client.directory}html`)
						) {
							return parseRoutedURL(
								referrer,
								this.client.codec,
								`${url.origin}${this.client.directory}`,
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
		const isStompWindow = (source: unknown) => {
			if (!source) return true; // MessagePorts, workers: not a window
			try {
				return this.client.names.client in (source as unknown as object);
			} catch (error) {
				return false; // cross-origin: the host
			}
		};
		// document.open() (which loadHTML uses to write the real page) drops
		// every listener on the window, so register again after each open
		const filterMessages = () =>
			global.addEventListener(
				'message',
				(event) => {
					const source = Reflect.apply(
						nativeSource,
						event,
						[],
					) as Window | null;
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
