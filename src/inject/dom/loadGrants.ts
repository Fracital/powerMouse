import {
	LOAD_CHANNEL,
	LOAD_HEADER,
	SW_REVIVE,
	type LoadGrantMessage,
} from '../../transport/messages';
import type Client from '../Client';

/**
 * This bundle's load grants (src/server/loadGrants.ts). A load the inject
 * copies for a document no service worker controls is a fetch from a
 * document one does control, which the worker judges as the load it stands
 * for only when the inject announced that very request beforehand, on a
 * MessagePort it opened to the worker before any of the page's script ran.
 * The port, the natives it is used with and the tokens are in this
 * module's scope: a request a page makes itself, whatever header it
 * carries, names no grant.
 *
 * Only a bundle that runs in a document the worker served has a channel
 * (the worker takes none from any other client). Any other bundle (an
 * about:srcdoc document's, an object's or embed's document's) goes through
 * the nearest bundle above it that has one: the request is made from that
 * bundle's realm, since a grant is for the client that announced it.
 *
 * Everything is taken when the bundle loads (the page has run nothing yet):
 * the service worker container before the Navigator module hides it, the
 * natives before the page can replace them, a channel's ports' getters
 * among them (a channel opened again is made long after the page ran).
 *
 * A worker that restarted takes a channel only with the nonce it sent this
 * client (SW_REVIVE's `load`). The bundle listens for it from the start, in
 * the capturing phase, so it hears the nonce before any listener the page
 * could add and its answer is the first the worker gets.
 */
export interface LoadSource {
	/** the client whose `nativeFetch` and sync bridge make the granted request */
	client: Client;
	/** the token to send as LOAD_HEADER with a request for `url` as `load` */
	announce(url: string, load: string): string | null;
}

type Post = (message: unknown, transfer: Transferable[]) => void;

const taken = (() => {
	try {
		// throws in a document with an opaque origin
		const container = globalThis.navigator.serviceWorker;
		return {
			container,
			controllerOf: Reflect.getOwnPropertyDescriptor(
				Reflect.getPrototypeOf(container) as object,
				'controller',
			)!.get!,
			workerPost: globalThis.ServiceWorker.prototype.postMessage as Post,
			portPost: globalThis.MessagePort.prototype.postMessage as Post,
			portStart: globalThis.MessagePort.prototype.start,
			Channel: globalThis.MessageChannel,
			port1Of: Reflect.getOwnPropertyDescriptor(
				globalThis.MessageChannel.prototype,
				'port1',
			)!.get!,
			port2Of: Reflect.getOwnPropertyDescriptor(
				globalThis.MessageChannel.prototype,
				'port2',
			)!.get!,
			own: Reflect.getOwnPropertyDescriptor,
			listen: globalThis.EventTarget.prototype.addEventListener,
			dataOf: Reflect.getOwnPropertyDescriptor(
				globalThis.MessageEvent.prototype,
				'data',
			)!.get!,
			random: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
			now: Date.now,
		};
	} catch (error) {
		return null;
	}
})();

/** how long an announced load is told again to a worker that restarted */
const RETOLD_MS = 5_000;

let port: MessagePort | null = null;
let recent: (LoadGrantMessage & { at: number })[] = [];
/** this bundle's own, or the one it goes through; undefined until asked */
let source: LoadSource | null | undefined;
let first: Client | null = null;

const ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** a token: 22 random characters of base64url (132 bits) */
function mint(): string {
	const bytes = new Uint8Array(22);
	taken!.random(bytes);
	let text = '';
	for (let i = 0; i < bytes.length; i++) text += ALPHABET[bytes[i] & 63];
	return text;
}

/**
 * Open a channel to the worker that controls this realm. The first is used
 * at once (announcements follow it in order); one opened again, for a
 * worker that restarted, only once the worker says it took it: a worker
 * that did not restart takes no second one, and one that did takes the one
 * that carries its nonce (`answer`).
 */
function open(directory: string, answer?: string): boolean {
	if (!taken) return false;
	try {
		const controller = Reflect.apply(
			taken.controllerOf,
			taken.container,
			[],
		) as ServiceWorker | null;
		if (!controller) return false;
		const channel = new taken.Channel();
		const mine = Reflect.apply(taken.port1Of, channel, []) as MessagePort;
		const theirs = Reflect.apply(taken.port2Of, channel, []) as MessagePort;
		if (port === null) port = mine;
		Reflect.apply(taken.listen, mine, [
			'message',
			() => {
				if (port === mine) return;
				port = mine;
				const since = taken.now() - RETOLD_MS;
				recent = recent.filter((grant) => grant.at >= since);
				for (const { token, url, load } of recent)
					Reflect.apply(taken.portPost, mine, [{ token, url, load }, []]);
			},
		]);
		Reflect.apply(taken.portStart, mine, []);
		Reflect.apply(taken.workerPost, controller, [
			{
				[LOAD_CHANNEL]:
					answer === undefined ? { directory } : { directory, answer },
			},
			[theirs],
		]);
		return true;
	} catch (error) {
		return false;
	}
}

function announce(url: string, load: string): string | null {
	if (!taken || !port) return null;
	try {
		const token = mint();
		Reflect.apply(taken.portPost, port, [{ token, url, load }, []]);
		const at = taken.now();
		recent.push({ token, url, load, at });
		if (recent.length > 64)
			recent = recent.filter((grant) => grant.at >= at - RETOLD_MS);
		return token;
	} catch (error) {
		return null;
	}
}

/**
 * The bundle's first client (its own realm's), made before any of the
 * page's script runs: when the realm is a document the worker served, the
 * channel is opened now, and opened again when the worker says it
 * restarted (SW_REVIVE).
 */
export function initLoads(client: Client) {
	if (first) return;
	first = client;
	let routed = false;
	try {
		const { origin, href } = globalThis.location;
		routed = href.startsWith(`${origin}${client.directory}`);
	} catch (error) {
		// a realm with no location: no channel
	}
	if (!routed || !taken || !open(client.directory)) return;
	source = { client, announce };
	try {
		Reflect.apply(taken.listen, taken.container, [
			'message',
			(event: MessageEvent) => {
				// the worker's, not one the page dispatched (isTrusted is the
				// event's own, and cannot be redefined)
				if (!event.isTrusted) return;
				const data = Reflect.apply(taken.dataOf, event, []) as unknown;
				if (typeof data !== 'object' || data === null) return;
				// own values only: the message is the worker's, its prototypes
				// are the page's
				const revive = taken.own(data, SW_REVIVE)?.value as unknown;
				if (typeof revive !== 'object' || revive === null) return;
				const nonce = taken.own(revive, 'load')?.value as unknown;
				open(client.directory, typeof nonce === 'string' ? nonce : undefined);
			},
			// before any listener the page adds, whatever phase it asks for
			true,
		]);
	} catch (error) {
		// nothing to hear: the channel stays as it is
	}
}

/**
 * What this bundle's copies are fetched through: its own channel, or the
 * one the bundle above its realm goes through (asked once). Null when
 * there is none: a copy is then an ordinary request.
 */
export function loadSource(): LoadSource | null {
	if (source !== undefined) return source;
	source = null;
	if (!first?.isDOM) return source;
	try {
		const above = (first as unknown as { parent?: typeof globalThis }).parent;
		if (above && above !== first.global) {
			const next = (above as unknown as Record<string, unknown>)[
				first.names.client
			] as { loadSource?: () => LoadSource | null } | undefined;
			if (typeof next?.loadSource === 'function') source = next.loadSource();
		}
	} catch (error) {
		// a parent of another origin: none
	}
	return source;
}

/**
 * Fetch `url` (a routed URL) as the load `load` names, for a document of
 * `client`: announced, then made from the realm that announced it. With
 * nothing to announce through, the request is an ordinary one.
 */
export function loadFetch(
	client: Client,
	url: string,
	load: string,
	init: RequestInit = {},
): Promise<Response> {
	const from = loadSource();
	const token = from ? from.announce(url, load) : null;
	if (!from || token === null) return client.routedFetch(url, init);
	// the grant's token rides alongside the caller's headers (a request that
	// names a load still sends its own Accept, Content-Type and the rest); every
	// caller passes a plain header record or none
	init = { ...init, headers: { ...init.headers, [LOAD_HEADER]: token } };
	// from another document's realm the referrer would be that document's
	// URL: an about:blank document's own strips to none (Client.routedFetch)
	if (from.client !== client)
		try {
			if (/^about:blank([?#]|$)/.test(client.global.location.href))
				init.referrer = '';
		} catch (error) {
			// a window being torn down: as the realm's
		}
	return from.client.nativeFetch(url, init);
}
