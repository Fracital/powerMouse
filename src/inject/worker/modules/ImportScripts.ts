import { routeRefused, routeURL } from '../../../routeURL';
import { routeJS } from '../../../scriptRoutes';
import { SW_IMPORT_ROUTE } from '../../../serviceWorkerTypes';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule, { ownerOf } from '../../modules/Proxy';
import { crossedTo } from '../../modules/ResourceTiming';
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
				const own = client.url.url.origin;
				const pageURLs: string[] = [];
				for (let i = 0; i < args.length; i++) {
					const resource = new StompURL(
						new URL(String(args[i]), client.url.toString()),
						client.url,
					);
					pageURLs.push(resource.url.href);
					// one the worker's script-src refuses fails to load, as the
					// browser fails it (requestVerdict reports it, twice for a
					// report-only policy alone); those before it run
					args[i] = client.requestVerdict('script-src-elem', resource.url, 2)
						? routeRefused(resource)
						: version && /^https?:$/.test(resource.url.protocol)
							? routeURL(`${SW_IMPORT_ROUTE}:${version}`, resource)
							: routeJS(resource, client.url, client.config, 'generic');
				}

				// The browser fetches and runs the scripts one at a time, so
				// each is imported on its own. Every route is same-origin to
				// the browser, which therefore never mutes a script's errors
				// itself: one of another origin (natively fetched without
				// CORS) throws a NetworkError naming its URL whatever it threw
				// or failed to parse, from here, where the page called. A
				// script of the worker's own origin is not caught: its error
				// leaves the browser's call as it was thrown, and an uncaught
				// one is reported where it was (a SyntaxError at the script's
				// line, not this hook's). Its redirects may still have taken
				// it to another origin, which only the service worker saw: it
				// marks the last hop of such a chain (OPAQUE_MARKER), and the
				// import's resource timing entry, there once the call is over,
				// says so.
				const DOMError = global.DOMException;
				const failed = (i: number) =>
					withStack(
						new DOMError(
							`Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${pageURLs[i]}' failed to load.`,
							'NetworkError',
						),
					);
				for (let i = 0; i < args.length; i++) {
					const real = new URL(pageURLs[i]!);
					if (/^https?:$/.test(real.protocol) && real.origin !== own) {
						try {
							Reflect.apply(target, that, [args[i]]);
						} catch (error) {
							throw failed(i);
						}
						continue;
					}
					let threw = true;
					try {
						Reflect.apply(target, that, [args[i]]);
						threw = false;
					} finally {
						// (a throw here replaces what the browser threw)
						if (threw && crossedTo(global, String(args[i])))
							// eslint-disable-next-line no-unsafe-finally
							throw failed(i);
					}
				}
			},
		);
	}
}
