import { pageBlobURL, proxyBlobURL, setBlobOrigins } from '../../routeURL';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

/**
 * `URL.createObjectURL` mints a blob: URL under the origin of the realm that
 * called it, which is the proxy's: the page gets it under its real origin
 * instead (`blob:<real origin>/<uuid>`), so `new URL(u).origin`, what it
 * stores and what it shows carry no trace of the proxy. Everything the page
 * hands such a URL to maps it back to the browser's form (routeURL, which
 * every URL-taking API goes through) and `revokeObjectURL` does the same
 * here. Both documents and workers.
 */
export default class ObjectURLModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		// the page's origin and the proxy's (the global's own, native at this
		// point), for every routeURL call from now on
		setBlobOrigins(
			this.client.url.url.origin,
			this.client.global.location.origin,
		);
		const URLCtor = this.client.global.URL;
		if (typeof URLCtor?.createObjectURL !== 'function') return;
		URLCtor.createObjectURL = proxyModule.wrapFunction(
			URLCtor.createObjectURL,
			(target, that, args) =>
				pageBlobURL(String(Reflect.apply(target, that, args))),
		);
		URLCtor.revokeObjectURL = proxyModule.wrapFunction(
			URLCtor.revokeObjectURL,
			(target, that, args) => {
				if (args.length) args[0] = proxyBlobURL(String(args[0]));
				return Reflect.apply(target, that, args);
			},
		);
	}
}
