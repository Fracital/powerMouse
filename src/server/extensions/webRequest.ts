// chrome.webRequest from the request path (docs/extensions.md "webRequest"):
// a background context tells the worker which events it listens to, for
// which URLs and types (extapi `webRequest`), and the worker asks it as the
// request goes: onBeforeRequest beside the blocker's decision, before the
// caches; onBeforeSendHeaders and onHeadersReceived around the transport's
// fetch; onCompleted and onErrorOccurred from the request log. Only a
// listener whose filter matches is asked, over the extension's own channel
// (no host page in between), and a blocking one only when the extension
// may block: MV2 with webRequestBlocking, or installed by policy. A
// blocking listener that does not answer within the budget lets the request
// go on, and is dropped once it has missed one.
import { matchesAny } from '../../extensions/match';
import type {
	WebRequestDetails,
	WebRequestListener,
	WebRequestVerdict,
} from '../../extensions/types';
import { EXTENSION_BUS_PREFIX } from '../../transport/messages';
import { extensionState } from './store';

/** how long a request waits for the blocking listeners (Chrome has no bound; a page cannot wait forever) */
export const WEB_REQUEST_BUDGET_MS = 500;

interface Registration {
	context: string;
	channel: string;
	extensionId: string;
	listeners: WebRequestListener[];
}

/** a request's webRequest type from its fetch destination */
export function webRequestType(
	destination: string,
	navigation: boolean,
	top: boolean,
): string {
	switch (destination) {
		case 'document':
			return top ? 'main_frame' : 'sub_frame';
		case 'iframe':
		case 'frame':
			return 'sub_frame';
		case 'style':
			return 'stylesheet';
		case 'script':
		case 'worker':
		case 'sharedworker':
		case 'serviceworker':
			return destination === 'script' ? 'script' : 'other';
		case 'image':
			return 'image';
		case 'font':
			return 'font';
		case 'object':
		case 'embed':
			return 'object';
		case 'audio':
		case 'video':
		case 'track':
			return 'media';
		case 'report':
			return 'csp_report';
		case 'websocket':
			return 'websocket';
		case '':
		case 'empty':
		case 'fetch':
			return navigation ? (top ? 'main_frame' : 'sub_frame') : 'xmlhttprequest';
		default:
			return 'other';
	}
}

const STATE_KEY = 'webRequest';

export class WebRequests {
	#registrations = new Map<string, Registration>();
	#loaded: Promise<void> | null = null;
	#buses = new Map<string, BroadcastChannel>();
	#waiting = new Map<string, (verdict: WebRequestVerdict | null) => void>();
	#counter = 0;
	/** whether any listener at all is registered (the request path's synchronous question) */
	any = false;
	/** listens for an event that the log feeds (onCompleted, onErrorOccurred, onResponseStarted) */
	completes = false;

	load(): Promise<void> {
		this.#loaded ??= (async () => {
			try {
				const kept = (await extensionState.get('_', STATE_KEY)) as
					Registration[] | undefined;
				for (const registration of kept ?? [])
					if (!this.#registrations.has(registration.context))
						this.#registrations.set(registration.context, registration);
			} catch (error) {
				// no store: what registers from now on
			}
			this.#changed(false);
		})();
		return this.#loaded;
	}

	#changed(save = true) {
		const all = [...this.#registrations.values()];
		this.any = all.some((registration) => registration.listeners.length > 0);
		this.completes = all.some((registration) =>
			registration.listeners.some((listener) =>
				['onCompleted', 'onErrorOccurred', 'onResponseStarted'].includes(
					listener.event,
				),
			),
		);
		if (save) extensionState.put('_', STATE_KEY, all).catch(() => {});
	}

	/** a background context's listeners, all of them (none: it went away) */
	async register(
		context: string,
		channel: string,
		extensionId: string,
		listeners: WebRequestListener[],
		mayBlock: boolean,
	) {
		await this.load();
		if (!listeners.length) this.#registrations.delete(context);
		else
			this.#registrations.set(context, {
				context,
				channel,
				extensionId,
				listeners: listeners.map((listener) => ({
					...listener,
					extensionId,
					blocking: listener.blocking && mayBlock,
				})),
			});
		this.#changed();
	}

	/** an extension went away or was turned off */
	forget(extensionId: string) {
		let changed = false;
		for (const [context, registration] of this.#registrations)
			if (registration.extensionId === extensionId) {
				this.#registrations.delete(context);
				changed = true;
			}
		if (changed) this.#changed();
	}

	#bus(name: string): BroadcastChannel {
		let bus = this.#buses.get(name);
		if (!bus) {
			bus = new BroadcastChannel(name);
			bus.onmessage = (event) => {
				const data = event.data as {
					t?: string;
					id?: string;
					verdict?: WebRequestVerdict | null;
				};
				if (data?.t !== 'wr-reply' || typeof data.id !== 'string') return;
				this.#waiting.get(data.id)?.(data.verdict ?? null);
			};
			this.#buses.set(name, bus);
		}
		return bus;
	}

	/**
	 * Tell the listeners of `event` whose filter takes the request; with
	 * `blocking`, wait for the blocking ones (within the budget) and merge
	 * what they answered. Null: nothing changes.
	 */
	async dispatch(
		channel: string,
		event: WebRequestListener['event'],
		details: WebRequestDetails,
		enabled: (extensionId: string) => boolean,
	): Promise<WebRequestVerdict | null> {
		if (!this.any) return null;
		const waits: Promise<WebRequestVerdict | null>[] = [];
		for (const registration of [...this.#registrations.values()]) {
			if (registration.channel !== channel) continue;
			if (!enabled(registration.extensionId)) continue;
			const wanted = registration.listeners.filter(
				(listener) =>
					listener.event === event &&
					matchesAny(listener.urls, details.url) &&
					(!listener.types?.length || listener.types.includes(details.type)),
			);
			if (!wanted.length) continue;
			const blocking = wanted.some((listener) => listener.blocking);
			const extra = new Set(wanted.flatMap((listener) => listener.extra));
			const told: WebRequestDetails = { ...details };
			if (!extra.has('requestHeaders')) delete told.requestHeaders;
			if (!extra.has('responseHeaders')) delete told.responseHeaders;
			delete told.client;
			const id = `${registration.context}:${++this.#counter}`;
			const message = {
				t: 'wr',
				id,
				context: registration.context,
				event,
				details: told,
				client: details.client ?? '',
				blocking,
			};
			const bus = this.#bus(
				`${EXTENSION_BUS_PREFIX}${channel}|${registration.extensionId}`,
			);
			if (!blocking) {
				bus.postMessage(message);
				continue;
			}
			waits.push(
				new Promise<WebRequestVerdict | null>((resolve) => {
					const timer = setTimeout(() => {
						this.#waiting.delete(id);
						// a listener that misses its budget once is gone (its page
						// is, most likely): no later request waits for it
						this.#registrations.delete(registration.context);
						this.#changed();
						resolve(null);
					}, WEB_REQUEST_BUDGET_MS);
					this.#waiting.set(id, (verdict) => {
						clearTimeout(timer);
						this.#waiting.delete(id);
						resolve(verdict);
					});
					bus.postMessage(message);
				}),
			);
		}
		if (!waits.length) return null;
		const verdicts = (await Promise.all(waits)).filter(
			(verdict): verdict is WebRequestVerdict => !!verdict,
		);
		if (!verdicts.length) return null;
		// as Chrome merges: a cancel wins; then the first redirect; the
		// headers of the last listener that changed them
		const merged: WebRequestVerdict = {};
		for (const verdict of verdicts) {
			if (verdict.cancel) return { cancel: true };
			if (verdict.redirectUrl && !merged.redirectUrl)
				merged.redirectUrl = verdict.redirectUrl;
			if (verdict.requestHeaders)
				merged.requestHeaders = verdict.requestHeaders;
			if (verdict.responseHeaders)
				merged.responseHeaders = verdict.responseHeaders;
		}
		return Object.keys(merged).length ? merged : null;
	}
}

export const webRequests = new WebRequests();
