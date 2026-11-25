import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import { heldClicks } from '../heldClicks';
import { baseTarget, clickedLink, SAME_FRAME } from '../links';

/**
 * Links that would open a new browsing context (`target="_blank"`, a name
 * no frame of the page has, a modifier or middle click) are handed to the host application
 * when it opted in (`config.openTab`); the browser never opens the bare
 * proxied popup. Window hooks go through addDocumentOpenListener because
 * `document.open()` drops them.
 *
 * In a sandboxed document the page's sandbox decides first: without
 * allow-popups the browser refuses the popup (the real frame's sandbox keeps
 * the flag as the page wrote it), and without
 * allow-popups-to-escape-sandbox the popup is sandboxed like its opener, so
 * it is never a host tab: it opens as a window this document makes, which
 * the inject starts with the opener's flags (DocumentClient.sandboxFlags).
 *
 * Either is done once the click has gone through the page, unless a listener
 * of the page cancelled it (../heldClicks.ts), as the browser decides a
 * link's default action: an SPA's router (Discord's channel links are
 * target=_blank) cancels the click and routes the link itself. The host's
 * tab opens as the browser's popup would: only with a transient activation
 * (a script's click with none opens nothing), one for each.
 */
export default class OpenModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const clicks = heldClicks(client);

		const listener = (event: MouseEvent) => {
			// a javascript: link's code, judged as its navigation starts
			const clicked = event.type === 'click' && clickedLink(global, event);
			if (clicked)
				client.jsStarts(
					clicked.getAttribute('target') || baseTarget(global.document),
					clicked.getAttribute('href') ?? '',
					event,
					clicked,
				);
			if (event.defaultPrevented) return;
			if (event.type === 'auxclick' && event.button !== 1) return;
			if (event.type === 'click' && event.button !== 0) return;
			const sandboxed = client.sandboxFlags !== null;
			if (!client.config.openTab && !sandboxed) return;
			const link = clickedLink(global, event);
			if (!link) return;
			// the hooked getters answer with what the page wrote
			const target = (
				link.getAttribute('target') || baseTarget(global.document)
			).toLowerCase();
			const modifier =
				event.type === 'auxclick' ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey;
			if (!modifier && SAME_FRAME.includes(target)) return;
			// a frame of this page by that name: the browser navigates it; a
			// frame of the tab by that name: the Sandbox module does; a popup
			// the tab opened: the browser does (DocumentClient namedWindow)
			if (
				!modifier &&
				(client.hasFrameNamed(link.getAttribute('target')!) ||
					client.namedWindow?.(link.getAttribute('target'), true))
			)
				return;
			// the rest is a deferred part (../linkOpens.ts): without it the
			// click opens nothing, as a popup the browser blocks
			let opens: DeferredParts['linkOpens'];
			try {
				opens = deferred('linkOpens');
			} catch (error) {
				clicks.hold(event, () => {});
				return;
			}
			opens(client, clicks, event, link, target, sandboxed);
		};
		// a refused javascript: URL of statements throws: nothing ran natively,
		// so no listener of the page's hears of it (DocumentClient codeRuns)
		const refusal = (event: ErrorEvent) => {
			if (event.error !== client.codeRefusal) return;
			event.stopImmediatePropagation();
			event.preventDefault();
		};
		const install = () => {
			global.addEventListener('click', listener, true);
			global.addEventListener('auxclick', listener, true);
			global.addEventListener('error', refusal, true);
		};
		install();
		addDocumentOpenListener(global, install);
	}
}
