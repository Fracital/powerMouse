import {
	CLIENT_HINTS,
	type ClientHintsReport,
} from '../../../transport/messages';
import Module from '../../Module';
import DocumentClient, { addDocumentOpenListener } from '../Client';

/**
 * Tells the service worker what this document's requests' client hints
 * carry (src/server/clientHints.ts): its viewport, the pixel ratio and the
 * media preferences, none of which a worker can read (a frame's allow
 * attribute rides on its navigation hint, NavigationHint). Sent at once,
 * before the page's markup is written and its first subresource asked for,
 * and again when one of them changes. A routed document only: an
 * about:blank or srcdoc document's requests are its creator's to the
 * worker, which judges them by that document.
 */
export default class ClientHintsModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		if (client.routedClient() !== client) return;
		const matchMedia = global.matchMedia?.bind(global);
		const query = (text: string) => {
			try {
				return matchMedia?.(text) ?? null;
			} catch (error) {
				return null;
			}
		};
		const dark = query('(prefers-color-scheme: dark)');
		const motion = query('(prefers-reduced-motion: reduce)');
		const transparency = query('(prefers-reduced-transparency: reduce)');
		const send = (accept?: string[]) => {
			const report: ClientHintsReport = {
				directory: client.directory,
				dpr: global.devicePixelRatio,
				colorScheme: dark?.matches ? 'dark' : 'light',
				reducedMotion: motion?.matches ? 'reduce' : 'no-preference',
				reducedTransparency: transparency?.matches ? 'reduce' : 'no-preference',
				viewport: [global.innerWidth, global.innerHeight],
				...(accept ? { accept } : {}),
			};
			client.postToWorker({ [CLIENT_HINTS]: report });
		};
		client.reportAcceptCH = (hints) => {
			// an Accept-CH meta counts in a top-level document only (measured),
			// for the requests that start after it: the ones the parser started
			// before the script inserted it reach the worker first
			if (!client.nested && hints.length)
				global.setTimeout(() => send(hints), 0);
		};
		send();
		let pending: ReturnType<typeof setTimeout> | null = null;
		const changed = () => {
			if (pending !== null) return;
			pending = global.setTimeout(() => {
				pending = null;
				send();
			}, 100);
		};
		const listen = () => global.addEventListener('resize', changed);
		listen();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, listen);
		for (const list of [dark, motion, transparency])
			list?.addEventListener('change', () => send());
	}
}
