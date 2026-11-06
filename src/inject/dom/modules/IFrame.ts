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

		const getContentWindowDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLIFrameElement.prototype,
			'contentWindow',
		)!;

		const windowModule = this.client.getModule(ContextModule)!;

		const getContentWindow = (iframe: HTMLIFrameElement) => {
			const context = getContentWindowDescriptor.get!.call(iframe) as
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

		Reflect.defineProperty(
			this.client.global.HTMLIFrameElement.prototype,
			'contentWindow',
			{
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					Reflect.getOwnPropertyDescriptor(
						this.client.global.HTMLIFrameElement.prototype,
						'contentWindow',
					)!.get!,
					(target, that) => getContentWindow(that),
				),
			},
		);

		Reflect.defineProperty(
			this.client.global.HTMLIFrameElement.prototype,
			'contentDocument',
			{
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					Reflect.getOwnPropertyDescriptor(
						this.client.global.HTMLIFrameElement.prototype,
						'contentDocument',
					)!.get!,
					(target, that) => {
						const context = getContentWindow(that);

						if (!context || windowModule.restrictedContexts.has(context)) {
							return null;
						}

						return context.document;
					},
				),
			},
		);
	}
}
