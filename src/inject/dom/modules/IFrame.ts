import { parseConfig } from '../../../config';
import { CLIENT_KEY } from '../../../rewriteJS';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import { addClientModules } from '../document';
import ContextModule from './Context';

export default class IFrameModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const injectContext = (context: typeof globalThis) => {
			if (CLIENT_KEY in context) return;

			const client = new DocumentClient(
				parseConfig(this.client.config, this.client.codec.key),
				context,
			);

			addClientModules(client);

			Reflect.defineProperty(context, CLIENT_KEY, {
				value: client,
				configurable: false,
				enumerable: false,
			});
		};

		// a popup the page opens without a URL (about:blank) is a document
		// nobody fetched: inject it like a child frame, so what the page writes
		// into it is rewritten; the page gets the window as a top-level page
		// would. Wraps the DOMHooks hook, which routed the URL (or handed a
		// tab to the host and returned null).
		this.client.global.open = proxyModule.wrapFunction(
			this.client.global.open,
			(target, that, args) => {
				const opened = Reflect.apply(target, that, args) as
					typeof globalThis | null;
				if (!opened) return opened;
				try {
					if (opened.location.href === 'about:blank') {
						injectContext(opened);
						if (!opened[CLIENT_KEY]!.applied) opened[CLIENT_KEY]!.apply();
					}
				} catch (error) {
					// cross-origin: not ours to inject
				}
				return opened;
			},
		);

		const windowModule = this.client.getModule(ContextModule)!;

		// the three elements that embed a document the page can reach: iframe,
		// the frameset's frame, and object with an HTML or SVG document (embed
		// exposes none of this)
		const embedders = [
			this.client.global.HTMLIFrameElement,
			this.client.global.HTMLFrameElement,
			this.client.global.HTMLObjectElement,
		].filter((ctor) => typeof ctor === 'function');
		for (const ctor of embedders) {
			const getContentWindowDescriptor = Reflect.getOwnPropertyDescriptor(
				ctor.prototype,
				'contentWindow',
			);
			const getContentDocumentDescriptor = Reflect.getOwnPropertyDescriptor(
				ctor.prototype,
				'contentDocument',
			);
			if (
				!getContentWindowDescriptor?.get ||
				!getContentDocumentDescriptor?.get
			)
				continue;

			const getContentWindow = (element: Element) => {
				const context = getContentWindowDescriptor.get!.call(element) as
					typeof globalThis | null;

				if (context) {
					injectContext(context);

					const restricted = windowModule.newRestricted(context);
					if (!context[CLIENT_KEY]!.applied) {
						context[CLIENT_KEY]!.apply();
					}

					return restricted;
				}

				return null;
			};

			Reflect.defineProperty(ctor.prototype, 'contentWindow', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					getContentWindowDescriptor.get,
					(target, that) => getContentWindow(that),
				),
			});

			Reflect.defineProperty(ctor.prototype, 'contentDocument', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					getContentDocumentDescriptor.get,
					(target, that) => {
						const context = getContentWindow(that);

						if (!context || windowModule.restrictedContexts.has(context)) {
							return null;
						}

						return context.document;
					},
				),
			});
		}
	}
}
