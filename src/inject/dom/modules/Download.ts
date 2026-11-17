import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { LazyWeakSet } from '../../ownCollections';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';

/**
 * A link with a `download` attribute. Chrome hands no download to a service
 * worker, so the browser would fetch the routed URL from the proxy origin's
 * own server and save its error page under the route's name. A same-origin
 * download (the only kind the attribute applies to; across origins the
 * browser navigates, which the worker serves) is fetched through the proxy
 * here and saved from a blob: URL, under the name the browser would pick on
 * the real site: the attribute's, the Content-Disposition's, or the URL's
 * last segment.
 *
 * The browser's own download is cancelled as the click starts (a handler
 * that stops the click's propagation still downloads, as it does natively);
 * once the click has gone through the page, the copy is saved unless a
 * handler cancelled it. Until then the page reads `defaultPrevented` and
 * `returnValue` as its own calls left them.
 */
export default class DownloadModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;
		const nativePreventDefault = global.Event.prototype.preventDefault;
		// clicks this module cancelled, and which of them the page cancelled
		const ours = new LazyWeakSet<Event>();
		const cancelledByPage = new LazyWeakSet<Event>();
		global.Event.prototype.preventDefault = proxyModule.wrapFunction(
			nativePreventDefault,
			(target, that, args) => {
				if (that instanceof global.Event && ours.has(that) && that.cancelable)
					cancelledByPage.add(that);
				return Reflect.apply(target, that, args);
			},
		);
		for (const [property, read] of [
			['defaultPrevented', (event: Event) => cancelledByPage.has(event)],
			['returnValue', (event: Event) => !cancelledByPage.has(event)],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				global.Event.prototype,
				property,
			);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(global.Event.prototype, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
					that instanceof global.Event && ours.has(that)
						? read(that)
						: Reflect.apply(target, that, args),
				),
				...(descriptor.set && property === 'returnValue'
					? {
							set: proxyModule.wrapFunction(
								descriptor.set,
								(target, that, args) => {
									if (
										that instanceof global.Event &&
										ours.has(that) &&
										!args[0]
									)
										cancelledByPage.add(that);
									return Reflect.apply(target, that, args);
								},
							),
						}
					: {}),
			});
		}

		const listener = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0) return;
			const link = event
				.composedPath()
				.find(
					(node): node is HTMLAnchorElement | HTMLAreaElement =>
						node instanceof global.Element &&
						(node.nodeName === 'A' || node.nodeName === 'AREA') &&
						node.hasAttribute('href') &&
						node.hasAttribute('download'),
				);
			if (!link) return;
			let url: URL;
			try {
				// the hooked getter answers with what the page wrote
				url = new URL(link.getAttribute('href')!, client.baseURL.toString());
			} catch (error) {
				return;
			}
			if (!['http:', 'https:'].includes(url.protocol)) return;
			if (url.origin !== client.url.url.origin) return;
			ours.add(event);
			Reflect.apply(nativePreventDefault, event, []);
			const named = link.getAttribute('download')!.trim();
			// after the click has gone through every handler of the page
			global.setTimeout(() => {
				if (cancelledByPage.has(event)) return;
				this.save(url, named).catch(() => {
					// the fetch failed: nothing to save, as a failed download
				});
			}, 0);
		};
		const install = () =>
			global.addEventListener('click', listener, { capture: true });
		install();
		addDocumentOpenListener(global, install);
	}
	/** a same-origin download's copy, saved (../downloadSave.ts, a deferred part) */
	async save(url: URL, named: string): Promise<void> {
		return deferred('saveDownload')(this.client, url, named);
	}
}
