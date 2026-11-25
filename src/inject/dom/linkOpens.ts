// What a click on a link that opens a new browsing context does (the Open
// module's listener, ./modules/Open.ts, says when one does), a deferred part
// of the document bundle (./deferredParts.ts) made at a document's first
// such click: only a host that opted in (`config.openTab`) or a sandboxed
// document reaches it, and few clicks of those open a window.
import { mayOpenPopup, popupOpened } from './activation';
import type DocumentClient from './Client';
import type { HeldClicks } from './heldClicks';

/**
 * `link`, clicked (`event`) to open in the browsing context `target` (a
 * new one: a modifier, or a name no frame has), opened as the page's
 * sandbox lets it (`sandboxed`: the document is) or as a host tab
 */
export function linkOpens(
	client: DocumentClient,
	clicks: HeldClicks,
	event: MouseEvent,
	link: Element,
	target: string,
	sandboxed: boolean,
) {
	const global = client.global;
	let url: URL;
	try {
		url = client.encodingParse(link.getAttribute('href')!, client.baseHref);
	} catch (error) {
		// no URL: the click opens nothing, here or in the browser
		return;
	}
	if (!['http:', 'https:'].includes(url.protocol)) return;
	if (sandboxed) {
		// refused by the browser, as natively
		if (!client.allows('allow-popups')) return;
		if (!client.allows('allow-popups-to-escape-sandbox')) {
			// the link's popup has no opener (a _blank target implies
			// noopener) unless it asks for one; a popup that runs no
			// script keeps it, so a document of it the inject starts
			// afresh still finds the opener's sandbox. Opened without
			// one: a window opened on a URL may already be another
			// origin's when open() returns, which refuses to leave its
			// opener, and a sandboxed document may navigate only a popup
			// it is still the opener of
			const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
			const noopener =
				rel.includes('noopener') ||
				rel.includes('noreferrer') ||
				(target === '_blank' && !rel.includes('opener'));
			const features =
				noopener && client.allows('allow-scripts')
					? [rel.includes('noreferrer') ? 'noreferrer' : 'noopener']
					: [];
			clicks.hold(event, () =>
				global.open(url.href, target || '_blank', ...features),
			);
			return;
		}
		if (!client.config.openTab) return;
	}
	const href = url.toString();
	// as the browser's popup blocker decides once the click went
	// through the page: none without a transient activation (a
	// script's click at load opens nothing), one for each
	clicks.hold(event, () => {
		if (mayOpenPopup(client) && client.openInHost(href)) popupOpened(client);
	});
}
