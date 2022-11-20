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

		/*createClient(${JSON.stringify(
		config
	)}, ${JSON.stringify(url.codec.key)});*/

		const injectContext = (context: typeof globalThis) => {
			if (CLIENT_KEY in context) return;

			const client = new DocumentClient(
				parseConfig(this.client.config, this.client.config.codec),
				globalThis
			);

			addClientModules(client);

			Reflect.defineProperty(context, CLIENT_KEY, {
				value: client,
				configurable: false,
				enumerable: false,
			});
		};

		const getContentWindowDescriptor = Reflect.getOwnPropertyDescriptor(
			HTMLIFrameElement.prototype,
			'contentWindow'
		)!;

		const windowModule = this.client.getModule(ContextModule)!;

		const getContentWindow = (iframe: HTMLIFrameElement) => {
			const context: typeof globalThis | null =
				getContentWindowDescriptor.get!.call(iframe);

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

		Reflect.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					HTMLIFrameElement.prototype,
					'contentWindow'
				)!.get!,
				(target, that) => getContentWindow(that)
			),
		});

		Reflect.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					HTMLIFrameElement.prototype,
					'contentDocument'
				)!.get!,
				(target, that) => {
					const context = getContentWindow(that);

					if (!context || windowModule.restrictedContexts.has(context)) {
						return null;
					}

					return context.document;
				}
			),
		});
	}
}
