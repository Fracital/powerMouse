import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { scopePrefix } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { loadFetch } from '../loadGrants';

/** the name a Content-Disposition header gives, if any */
function dispositionName(header: string | null): string | null {
	if (!header) return null;
	const extended = /filename\*\s*=\s*([\w-]+)''([^;]+)/i.exec(header);
	if (extended)
		try {
			return decodeURIComponent(extended[2].trim());
		} catch (error) {
			// not percent-encoded after all: the plain form below
		}
	const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
	return plain ? (plain[2] ?? plain[1]).trim() : null;
}

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
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const nativePreventDefault = global.Event.prototype.preventDefault;
		// clicks this module cancelled, and which of them the page cancelled
		const ours = new WeakSet<Event>();
		const cancelledByPage = new WeakSet<Event>();
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
				url = new URL(link.getAttribute('href')!, this.client.url.toString());
			} catch (error) {
				return;
			}
			if (!['http:', 'https:'].includes(url.protocol)) return;
			if (url.origin !== this.client.url.url.origin) return;
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
	async save(url: URL, named: string) {
		const response = await loadFetch(
			this.client,
			new URL(
				routeBinary(new StompURL(url, this.client.url)),
				scopePrefix(this.client),
			).href,
			// the browser's own download, not a page's read: no CORS (a load
			// the worker takes no metadata from)
			'download',
			{ credentials: 'include' },
		);
		const last = decodeURIComponent(
			url.pathname.slice(url.pathname.lastIndexOf('/') + 1),
		);
		const name =
			named ||
			dispositionName(response.headers.get('content-disposition')) ||
			last ||
			'download';
		const global = this.client.global;
		const blob = await response.blob();
		const objectURL = global.URL.createObjectURL(blob);
		const anchor = global.document.createElement('a');
		anchor.download = name;
		anchor.href = objectURL;
		anchor.click();
		global.setTimeout(() => global.URL.revokeObjectURL(objectURL), 60000);
	}
}
