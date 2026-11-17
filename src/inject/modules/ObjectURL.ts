import {
	isDocumentKind,
	pageBlobURL,
	proxyBlobURL,
	setBlobOrigins,
	setBlobRoute,
} from '../../routeURL';
import { BLOB_MINTED } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { LazyMap } from '../ownCollections';
import {
	blobOf,
	blobTable,
	forgetBlob,
	isBlob,
	mintedURLs,
	PRIVATE_URL_MS,
	recordBlob,
} from '../workerBlobs';
import ProxyModule from './Proxy';
import { realmOrigin } from './Unroute';

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
	/** the Blobs behind the URLs this realm minted (workerBlobs) */
	#blobs = blobTable();
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
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		// the page's origin and the proxy's, for every routeURL call from now
		// on. The proxy's is the realm's own as the browser has it: an
		// about:blank or srcdoc child that the page reaches into runs this
		// bundle too (the IFrame module injects it), and its location.origin
		// reads "null", which set here made every blob: URL the page minted
		// after that come out in the proxy's form (YouTube Music's and
		// SoundCloud's MediaSource URLs, read back through currentSrc)
		const proxy = realmOrigin(client);
		setBlobOrigins(client.url.url.origin, proxy);
		const URLCtor = client.global.URL;
		if (typeof URLCtor?.createObjectURL !== 'function') return;
		const create = URLCtor.createObjectURL;
		const revoke = URLCtor.revokeObjectURL;
		const own = `blob:${proxy}/`;
		// The page's bytes the inject never read (a slice, a Blob of Blobs, a
		// Response's or a FileReader's Blob, one another realm made or a
		// worker's): a document, a script or a stylesheet loaded from one is
		// read by the service worker and rewritten there (an inline document,
		// the script and stylesheet routes in src/server/rewrites.ts). A
		// Blob this realm holds is read from a private URL of it, so the
		// page's revoke right after the load starts reaches no load, as
		// natively; it goes a while after that revoke.
		const privates = new Map<string, string>();
		// The routed URL of each blob: module this realm loaded: a module map
		// holds a module by its URL, so an import of a revoked blob: URL the
		// map already has answers with that module natively. Routed again
		// after the revoke, the URL lost its private copy and the import was
		// a new fetch of a revoked Blob (TypeError)
		const modules = new LazyMap<string, string>();
		// the realm's own crossOriginIsolated, as the browser answers it
		const isolated = Reflect.getOwnPropertyDescriptor(
			client.global,
			'crossOriginIsolated',
		)?.get;
		setBlobRoute((kind, href, given) => {
			if (!href.startsWith(own)) return null;
			const uuid = href.slice(own.length);
			// the browser's form, which this realm never showed the page: the
			// one blob: URL registry holds every site's Blobs, and another
			// site's is one the page's real origin could not resolve
			if (
				given === href &&
				given !== pageBlobURL(given) &&
				!mintedURLs.has(href)
			)
				return `blob:null/${uuid}`;
			const script = /^js:(generic|genericModule|worker)$/.exec(kind)?.[1];
			const html = isDocumentKind(kind);
			if (!script && kind !== 'css' && !html) return null;
			const blob = blobOf(href);
			if (html)
				// (natively an HTML or XML document runs; nothing else does)
				return blob &&
					!/^(text\/html|[\w!#$&^.-]+\/([\w!#$&^.+-]+\+)?xml)\s*(;|$)/i.test(
						blob.type,
					)
					? null
					: client.inlineDocument(
							'',
							client.url.toString(),
							client.url.toString(),
							blob ?? href,
							// (a blob: document inherits its creator's embedder policy)
							!!isolated && Reflect.apply(isolated, client.global, []) === true,
						);
			if (script === 'genericModule' && !blob) {
				const kept = modules.get(href);
				if (kept) return kept;
			}
			let at = '';
			if (blob) {
				let copy = privates.get(href);
				if (!copy) {
					copy = proxyBlobURL(String(Reflect.apply(create, URLCtor, [blob])));
					privates.set(href, copy);
				}
				at = `~${copy.slice(own.length)}`;
			}
			// (the page's URL, which its loads read back: StompURL's encode is
			// for URLs with a host)
			const { directory, codec } = client.url;
			// a worker's classic script (the one it starts with, or one a
			// worker imports) runs whatever the Blob's type, as natively:
			// `wjs` is served as JavaScript
			const kindOf =
				script === 'genericModule'
					? 'module'
					: script === 'worker' ||
						  (script &&
								typeof (client.global as { importScripts?: unknown })
									.importScripts === 'function')
						? 'wjs'
						: script
							? 'js'
							: 'css';
			const routed = `${directory}blob~${kindOf}${at}/${codec.encode(pageBlobURL(href))}`;
			if (script === 'genericModule' && blob) modules.set(href, routed);
			return routed;
		}, client.global === globalThis);
		URLCtor.createObjectURL = proxyModule.wrapFunction(
			URLCtor.createObjectURL,
			(target, that, args) => {
				const url = String(Reflect.apply(target, that, args));
				// the registry's entry, for a worker started from it (workerBlobs)
				// and for the loads routed above
				if (isBlob(args[0])) recordBlob(url, args[0], this.#blobs);
				mintedURLs.add(url);
				this.#register(url);
				return pageBlobURL(url);
			},
		);
		URLCtor.revokeObjectURL = proxyModule.wrapFunction(
			URLCtor.revokeObjectURL,
			(target, that, args) => {
				if (args.length) {
					args[0] = proxyBlobURL(String(args[0]));
					const url = args[0] as string;
					forgetBlob(url);
					mintedURLs.delete(url);
					const copy = privates.get(url);
					if (copy) {
						privates.delete(url);
						client.global.setTimeout(
							() => Reflect.apply(revoke, URLCtor, [copy]),
							PRIVATE_URL_MS,
						);
					}
				}
				return Reflect.apply(target, that, args);
			},
		);
	}
}
