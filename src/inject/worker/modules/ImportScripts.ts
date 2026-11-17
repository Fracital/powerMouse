import { routeRefused, routeURL } from '../../../routeURL';
import { routeJS } from '../../../scriptRoutes';
import { SW_IMPORT_ROUTE } from '../../../serviceWorkerTypes';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule, { ownerOf } from '../../modules/Proxy';
import { unrouteText } from '../../modules/Unroute';
import { failsToParse, withStack } from '../../nativeErrors';
import WorkerClient from '../Client';

export default class ImportScriptsModule extends Module<WorkerClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		// (on the scope's prototype, where the browser has it)
		ownerOf(global, 'importScripts').importScripts = proxyModule.wrapFunction(
			global.importScripts,
			(target, that, args) => {
				// the browser parses every URL before it loads any: one that does
				// not parse gets its own SyntaxError, and nothing loads
				if (args.some((arg) => failsToParse(client, String(arg))))
					return Reflect.apply(target, that, args);

				// a module worker's: the browser's TypeError, before anything is
				// judged (called with nothing, it loads nothing)
				Reflect.apply(target, that, []);
				// an emulated service worker's imports are kept with its version,
				// so it starts again without the network (docs/service-workers.md)
				const version = client.serviceWorkerVersion;
				for (let i = 0; i < args.length; i++) {
					const resource = new StompURL(
						new URL(String(args[i]), client.url.toString()),
						client.url,
					);
					// one the worker's script-src refuses fails to load, as the
					// browser fails it (requestVerdict reports it, twice for a
					// report-only policy alone); those before it run
					args[i] = client.requestVerdict('script-src-elem', resource.url, 2)
						? routeRefused(resource)
						: version && /^https?:$/.test(resource.url.protocol)
							? routeURL(`${SW_IMPORT_ROUTE}:${version}`, resource)
							: routeJS(resource, client.url, client.config, 'generic');
				}

				try {
					return Reflect.apply(target, that, args);
				} catch (error) {
					// the browser's NetworkError names the script it was given:
					// the page's URL, as natively
					const DOMError = global.DOMException;
					if (!(error instanceof DOMError)) throw error;
					const message = unrouteText(client, error.message);
					if (message === error.message) throw error;
					throw withStack(new DOMError(message, error.name));
				}
			},
		);
	}
}
