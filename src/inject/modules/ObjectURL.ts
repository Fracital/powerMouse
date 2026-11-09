import { pageBlobURL, proxyBlobURL, setBlobOrigins } from '../../routeURL';
import { BLOB_MINTED } from '../../transport/messages';
import Client from '../Client';
import { htmlBlobs, htmlBlobURLs } from '../htmlBlobs';
import Module from '../Module';
import { blobsByURL, isBlob } from '../workerBlobs';
import ProxyModule from './Proxy';
import { scopePrefix } from './Unroute';

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
	/**
	 * Tell the service worker about a blob: URL this realm minted, so a
	 * worker started from it is judged as this page (BLOB_MINTED). Sent by
	 * the nearest routed document, whose URL the worker decodes, and only
	 * when that document has this realm's real origin (an about:blank or
	 * srcdoc child, not an opaque one)
	 */
	#register(url: string) {
		const routed = this.client.routedClient();
		if (!routed || routed.url.url.origin !== this.client.url.url.origin) return;
		routed.postToWorker({
			[BLOB_MINTED]: { directory: routed.directory, url },
		});
	}
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		// the page's origin and the proxy's, for every routeURL call from now
		// on. The proxy's is the routed base URL's: an about:blank or srcdoc
		// child that the page reaches into runs this bundle too (the IFrame
		// module injects it), and its location.origin reads "null", which set
		// here made every blob: URL the page minted after that come out in the
		// proxy's form (YouTube Music's and SoundCloud's MediaSource URLs, read
		// back through currentSrc)
		setBlobOrigins(
			this.client.url.url.origin,
			new URL(scopePrefix(this.client)).origin,
		);
		const URLCtor = this.client.global.URL;
		if (typeof URLCtor?.createObjectURL !== 'function') return;
		URLCtor.createObjectURL = proxyModule.wrapFunction(
			URLCtor.createObjectURL,
			(target, that, args) => {
				const url = String(Reflect.apply(target, that, args));
				// an HTML blob the page made: a navigation to it becomes an inline
				// document (htmlBlobs.ts), showing the page's URL as before
				const markup = htmlBlobs.get(args[0] as Blob);
				if (markup !== undefined)
					htmlBlobURLs.set(url, { markup, url: this.client.url.toString() });
				// the registry's entry, for a worker started from it (workerBlobs)
				if (isBlob(args[0])) blobsByURL.set(url, args[0]);
				this.#register(url);
				return pageBlobURL(url);
			},
		);
		URLCtor.revokeObjectURL = proxyModule.wrapFunction(
			URLCtor.revokeObjectURL,
			(target, that, args) => {
				if (args.length) {
					args[0] = proxyBlobURL(String(args[0]));
					htmlBlobURLs.delete(args[0] as string);
					blobsByURL.delete(args[0] as string);
				}
				return Reflect.apply(target, that, args);
			},
		);
	}
}
