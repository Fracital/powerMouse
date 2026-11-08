import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';

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
 * last segment. The page's own handlers run first and can cancel it.
 */
export default class DownloadModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
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
			event.preventDefault();
			const named = link.getAttribute('download')!.trim();
			this.save(url, named).catch(() => {
				// the fetch failed: nothing to save, as a failed download
			});
		};
		const install = () => global.addEventListener('click', listener);
		install();
		addDocumentOpenListener(global, install);
	}
	async save(url: URL, named: string) {
		const response = await this.client.routedFetch(
			routeBinary(new StompURL(url, this.client.url)),
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
