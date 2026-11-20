// An MV3 extension's service worker controls its own pages
// (docs/extensions.md "Service worker"), so its `fetch` handler answers
// what they load: Violentmonkey's popup asks it for `/get-data.js`, which no
// file of the package is. The page that emulates the worker tells this
// worker it has a handler (extapi `serviceWorker`), and a request Chrome
// would give it is posted to it over the extension's own channel before the
// HTTP cache, as a real worker sits there: it says at once whether it took
// the request (respondWith) or lets it go on to the package, then sends the
// response it made. Measured in Chrome 157: a navigation to one of the
// extension's pages reaches it, a web page's frame of one included, and so
// does every load of those pages and their workers; a web page's own
// request (a content script's too) for a web_accessible_resource does not,
// nor does the worker's own.
import { extensionOfHost } from '../../extensions/origin';
import { BACKGROUND_PAGE, serviceWorkerPage } from '../../extensions/types';
import { EXTENSION_BUS_PREFIX } from '../../transport/messages';
import type { ExtensionRegistry } from './registry';
import { extensionState } from './store';

/** how long a request waits for the worker to say whether it takes it (a page still starting says so once its script ran) */
const TAKE_MS = 5000;
/** after a worker missed that once: until it speaks again */
const MISSED_TAKE_MS = 500;
/** how long a taken request waits for its response, as Chrome bounds an event */
const ANSWER_MS = 300_000;

const STATE_KEY = 'fetchEvents';

interface Registration {
	context: string;
	channel: string;
	extensionId: string;
}

/** a request as the worker's FetchEvent shows it */
export interface FetchedRequest {
	url: string;
	method: string;
	headers: [string, string][];
	body: ArrayBuffer | null;
	mode: string;
	credentials: string;
	cache: string;
	redirect: string;
	referrer: string;
	referrerPolicy: string;
	integrity: string;
	keepalive: boolean;
	destination: string;
}

/** the worker's response, as it crosses the channel */
interface Answer {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: ArrayBuffer | null;
}

interface Pending {
	key: string;
	message: Record<string, unknown>;
	taken: string | null;
	timer: ReturnType<typeof setTimeout>;
	settle(response: Response | null): void;
}

const NULL_BODY = [101, 103, 204, 205, 304];

function responseOf(answer: Answer | undefined): Response {
	if (!answer || !answer.status) return Response.error();
	try {
		return new Response(
			NULL_BODY.includes(answer.status) ? null : answer.body,
			{
				status: answer.status,
				statusText: answer.statusText,
				headers: answer.headers,
			},
		);
	} catch (error) {
		return Response.error();
	}
}

/**
 * The extension whose worker Chrome gives the request to, or null: one of
 * its pages navigated to, or a load whose client is one of its pages or
 * workers, but neither its generated background pages nor anything they load
 */
export function workerOf(
	registry: ExtensionRegistry,
	url: URL,
	navigation: boolean,
	client: URL | null,
): string | null {
	const id = extensionOfHost(url.hostname);
	if (!id || url.protocol !== 'https:') return null;
	const loaded = registry.get(id);
	const script = loaded?.record.enabled
		? loaded.record.manifest.background?.service_worker
		: undefined;
	if (!script) return null;
	const own = new Set([`/${serviceWorkerPage(script)}`, `/${BACKGROUND_PAGE}`]);
	if (navigation) return own.has(url.pathname) ? null : id;
	return client?.origin === url.origin && !own.has(client.pathname) ? id : null;
}

export class FetchEvents {
	#registrations = new Map<string, Registration>();
	#missed = new Set<string>();
	#loaded: Promise<void> | null = null;
	#buses = new Map<string, BroadcastChannel>();
	#pending = new Map<string, Pending>();
	#counter = 0;

	load(): Promise<void> {
		this.#loaded ??= (async () => {
			try {
				const kept = (await extensionState.get('_', STATE_KEY)) as
					Registration[] | undefined;
				for (const registration of kept ?? [])
					this.#registrations.set(
						`${registration.channel}|${registration.extensionId}`,
						registration,
					);
			} catch (error) {
				// no store: what registers from now on
			}
		})();
		return this.#loaded;
	}

	#save() {
		extensionState
			.put('_', STATE_KEY, [...this.#registrations.values()])
			.catch(() => {});
	}

	/** a worker's page has a fetch handler (or no longer has one) */
	async register(
		context: string,
		channel: string,
		extensionId: string,
		handles: boolean,
	) {
		await this.load();
		const key = `${channel}|${extensionId}`;
		this.#missed.delete(key);
		if (handles)
			this.#registrations.set(key, { context, channel, extensionId });
		// (a version that no longer listens, whichever page says so)
		else this.#registrations.delete(key);
		this.#save();
		// what waited for a page that was still starting
		for (const pending of this.#pending.values())
			if (pending.key === key && !pending.taken)
				this.#bus(channel, extensionId).postMessage(pending.message);
	}

	/** an extension went away or was turned off */
	forget(extensionId: string) {
		for (const [key, registration] of this.#registrations)
			if (registration.extensionId === extensionId)
				this.#registrations.delete(key);
		this.#save();
	}

	#bus(channel: string, extensionId: string): BroadcastChannel {
		const name = `${EXTENSION_BUS_PREFIX}${channel}|${extensionId}`;
		let bus = this.#buses.get(name);
		if (!bus) {
			bus = new BroadcastChannel(name);
			bus.onmessage = (event) => this.#receive(event.data);
			this.#buses.set(name, bus);
		}
		return bus;
	}

	#receive(data: {
		t?: string;
		id?: string;
		ctx?: string;
		take?: boolean;
		answer?: Answer;
	}) {
		if (data?.t !== 'fetch-r' || typeof data.id !== 'string') return;
		const pending = this.#pending.get(data.id);
		if (!pending) return;
		this.#missed.delete(pending.key);
		const from = String(data.ctx ?? '');
		if (pending.taken === null) {
			clearTimeout(pending.timer);
			if (!data.take) return pending.settle(null);
			pending.taken = from;
			pending.timer = setTimeout(
				() => pending.settle(Response.error()),
				ANSWER_MS,
			);
			return;
		}
		// (another page of the same worker answered first)
		if (pending.taken === from && !data.take)
			pending.settle(responseOf(data.answer));
	}

	/**
	 * The response the extension's worker makes for the request, or null:
	 * it has no fetch handler, did not call respondWith, or is not there
	 */
	async dispatch(
		channel: string,
		extensionId: string,
		request: FetchedRequest,
		clientId: string,
		resultingClientId: string,
	): Promise<Response | null> {
		await this.load();
		const key = `${channel}|${extensionId}`;
		if (!this.#registrations.has(key)) return null;
		const id = `f${++this.#counter}:${Date.now().toString(36)}`;
		const message = {
			t: 'fetch',
			id,
			request,
			clientId,
			resultingClientId,
		};
		return new Promise<Response | null>((resolve) => {
			const pending: Pending = {
				key,
				message,
				taken: null,
				timer: setTimeout(
					() => {
						// a worker that is not there: the next request asks it briefly
						this.#missed.add(key);
						pending.settle(null);
					},
					this.#missed.has(key) ? MISSED_TAKE_MS : TAKE_MS,
				),
				settle: (response) => {
					clearTimeout(pending.timer);
					this.#pending.delete(id);
					resolve(response);
				},
			};
			this.#pending.set(id, pending);
			this.#bus(channel, extensionId).postMessage(message);
		});
	}
}

export const fetchEvents = new FetchEvents();
