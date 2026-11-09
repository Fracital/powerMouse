import { routeJS } from '../../../rewriteJS';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { failsToParse } from '../../nativeErrors';
import WorkerClient from '../Client';

export default class ImportScriptsModule extends Module<WorkerClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		this.client.global.importScripts = proxyModule.wrapFunction(
			this.client.global.importScripts,
			(target, that, args) => {
				// the browser parses every URL before it loads any: one that does
				// not parse gets its own SyntaxError, and nothing loads
				if (args.some((arg) => failsToParse(this.client, String(arg))))
					return Reflect.apply(target, that, args);

				for (let i = 0; i < args.length; i++)
					args[i] = routeJS(
						new StompURL(
							new URL(String(args[i]), this.client.url.toString()),
							this.client.url,
						),
						this.client.url,
						this.client.config,
						'generic',
					);

				return Reflect.apply(target, that, args);
			},
		);
	}
}
