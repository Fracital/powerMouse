import { routeURL } from '../../../routeURL';
import { routeJS } from '../../../scriptRoutes';
import { SW_IMPORT_ROUTE } from '../../../serviceWorkerTypes';
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

				// an emulated service worker's imports are kept with its version,
				// so it starts again without the network (docs/service-workers.md)
				const version = this.client.serviceWorkerVersion;
				for (let i = 0; i < args.length; i++) {
					const resource = new StompURL(
						new URL(String(args[i]), this.client.url.toString()),
						this.client.url,
					);
					args[i] =
						version && /^https?:$/.test(resource.url.protocol)
							? routeURL(`${SW_IMPORT_ROUTE}:${version}`, resource)
							: routeJS(
									resource,
									this.client.url,
									this.client.config,
									'generic',
								);
				}

				return Reflect.apply(target, that, args);
			},
		);
	}
}
