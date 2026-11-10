import {
	mixedContentVerdict,
	noticeNamesTop,
	noticeText,
	restrictsMixedContent,
	type MixedContentNotice,
	type MixedContentVerdict,
} from '../../mixedContent';
import { MIXED_CONTENT_NOTICE } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';

/**
 * Mixed content (src/mixedContent.ts) for the requests no service worker
 * sees, a WebSocket and a beacon's answer, and the console: the worker
 * decides every other request and sends its notices here, written in
 * Chrome's words. Chrome names the page the content is mixed in: the
 * proxied top when it is https, for a block; the document itself for an
 * upgrade.
 */
export default class MixedContentModule extends Module<Client> {
	#console?: {
		error: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
	};
	apply() {
		// the console as it is before the page runs: a page that replaces
		// console.error does not see the browser's own messages either
		const console = this.client.global.console;
		if (console) this.#console = { error: console.error, warn: console.warn };
		this.client.onServiceWorkerMessage((data) => {
			if (typeof data !== 'object' || data === null) return;
			const notices = (data as Record<string, unknown>)[MIXED_CONTENT_NOTICE];
			if (Array.isArray(notices)) this.report(notices);
		});
	}
	/** the URL the page knows itself by (about:srcdoc for a srcdoc document) */
	#ownURL(): string {
		if (this.client.isDOM)
			try {
				const document = (this.client.global as { document?: Document })
					.document;
				if (document) return String(document.URL);
			} catch (error) {
				// a document that went away: its client's URL
			}
		return this.client.url.toString();
	}
	/** the URL of the outermost proxied document above this one, when this is a nested document */
	#topURL(): string | null {
		const top = (this.client as { proxiedTop?: typeof globalThis }).proxiedTop;
		if (!top || top === this.client.global) return null;
		try {
			const client = (top as Record<string, unknown>)[
				this.client.names.client
			] as Client | undefined;
			return client ? client.url.toString() : null;
		} catch (error) {
			return null;
		}
	}
	/** what Chrome does with a request of this context that no worker sees */
	verdict(url: URL, destination: string, type?: string): MixedContentVerdict {
		return mixedContentVerdict({
			url,
			destination,
			type,
			context: this.client.url.url,
			top: this.#topURL(),
			upgradeInsecure: this.client.upgradeInsecureRequests,
		});
	}
	/** print notices as Chrome would, naming the page it would */
	report(notices: MixedContentNotice[]) {
		const console = this.#console;
		if (!console) return;
		for (const notice of notices) {
			if (typeof notice !== 'object' || notice === null) continue;
			const top = noticeNamesTop(notice) ? this.#topURL() : null;
			const page = top && restrictsMixedContent(top) ? top : this.#ownURL();
			const { level, text } = noticeText(notice, page);
			Reflect.apply(console[level], this.client.global.console, [text]);
		}
	}
}
