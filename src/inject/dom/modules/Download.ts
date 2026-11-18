import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import { heldClicks } from '../heldClicks';
import { clickedLink } from '../links';

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
 * handler cancelled it (../heldClicks.ts).
 */
export default class DownloadModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const clicks = heldClicks(client);
		const listener = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button !== 0) return;
			// (a click the Open module holds opens a tab, as before)
			if (clicks.held(event)) return;
			const link = clickedLink(global, event, 'download');
			if (!link) return;
			let url: URL;
			try {
				// the hooked getter answers with what the page wrote
				url = new URL(link.getAttribute('href')!, client.baseHref);
			} catch (error) {
				return;
			}
			if (!['http:', 'https:'].includes(url.protocol)) return;
			if (url.origin !== client.url.url.origin) return;
			const named = link.getAttribute('download')!.trim();
			clicks.hold(event, () => {
				this.save(url, named).catch(() => {
					// the fetch failed: nothing to save, as a failed download
				});
			});
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
