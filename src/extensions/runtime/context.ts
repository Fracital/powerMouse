// One extension context in this document (a content script world, an
// extension page, a background): its chrome.* events, the callback-or-
// promise shape of its methods with runtime.lastError, its calls to the
// worker (`extapi`) and its bus to the extension's other contexts and the
// controller's hub. Ported from STicks (context.ts, events.ts, realm.ts),
// where every context lived in the host page; here each is in its own
// document and they meet on a BroadcastChannel.
import { EXTENSION_BUS_PREFIX } from '../../transport/messages';
import { displayExtensionURL } from '../origin';
import {
	EXTENSION_API_ROUTE,
	type ContextKind,
	type ShippedExtension,
} from '../types';
import type { ErrorConsole } from './errors';
import { listen, natives } from './natives';

export const NO_RECEIVER =
	'Could not establish connection. Receiving end does not exist.';

/** an error chrome.* reports through runtime.lastError or a rejected promise */
export class ApiError extends Error {}

export const messageOf = (error: unknown) =>
	error && typeof error === 'object' && 'message' in error
		? String((error as Error).message)
		: String(error);

/** a copy, as Chrome serializes messages and storage */
export const copy = <T>(value: T): T =>
	value === undefined || value === null
		? value
		: (natives.JSON.parse(natives.JSON.stringify(value) ?? 'null') as T);

/**
 * Whether a URL passes an event's filters (events.UrlFilter, as
 * webNavigation's listeners give them): any one filter, all of its
 * conditions; no filters, every URL
 */
export function urlFiltersMatch(filters: unknown, href: string): boolean {
	if (!Array.isArray(filters) || !filters.length) return true;
	let url: URL;
	try {
		url = new URL(href);
	} catch (error) {
		return false;
	}
	const host = url.hostname;
	// the URL without its fragment, its port spelled out only when not the scheme's own
	const whole = href.split('#')[0];
	const path = url.pathname;
	const query = url.search.replace(/^\?/, '');
	const port = Number(url.port) || DEFAULT_PORTS[url.protocol] || 0;
	const text = (value: unknown) => (typeof value === 'string' ? value : null);
	const test = (
		filter: Record<string, unknown>,
		key: string,
		check: (value: string) => boolean,
	) => {
		const value = text(filter[key]);
		return value === null || check(value);
	};
	return filters.some((raw) => {
		if (!raw || typeof raw !== 'object') return false;
		const filter = raw as Record<string, unknown>;
		const dotted = `.${host}`;
		const matches = (value: string) => {
			try {
				return new RegExp(value).test(whole);
			} catch (error) {
				return false;
			}
		};
		return (
			test(filter, 'hostContains', (value) => dotted.includes(value)) &&
			test(filter, 'hostEquals', (value) => host === value.toLowerCase()) &&
			test(filter, 'hostPrefix', (value) => host.startsWith(value)) &&
			test(filter, 'hostSuffix', (value) => host.endsWith(value)) &&
			test(filter, 'pathContains', (value) => path.includes(value)) &&
			test(filter, 'pathEquals', (value) => path === value) &&
			test(filter, 'pathPrefix', (value) => path.startsWith(value)) &&
			test(filter, 'pathSuffix', (value) => path.endsWith(value)) &&
			test(filter, 'queryContains', (value) => query.includes(value)) &&
			test(filter, 'queryEquals', (value) => query === value) &&
			test(filter, 'queryPrefix', (value) => query.startsWith(value)) &&
			test(filter, 'querySuffix', (value) => query.endsWith(value)) &&
			test(filter, 'urlContains', (value) => whole.includes(value)) &&
			test(filter, 'urlEquals', (value) => whole === value) &&
			test(filter, 'urlMatches', matches) &&
			test(filter, 'originAndPathMatches', (value) => {
				try {
					return new RegExp(value).test(url.origin + path);
				} catch (error) {
					return false;
				}
			}) &&
			test(filter, 'urlPrefix', (value) => whole.startsWith(value)) &&
			test(filter, 'urlSuffix', (value) => whole.endsWith(value)) &&
			(!Array.isArray(filter.schemes) ||
				filter.schemes.includes(url.protocol.slice(0, -1))) &&
			(!Array.isArray(filter.ports) ||
				filter.ports.some((entry) =>
					Array.isArray(entry)
						? port >= Number(entry[0]) && port <= Number(entry[1])
						: port === Number(entry),
				))
		);
	});
}

const DEFAULT_PORTS: Record<string, number> = {
	'http:': 80,
	'https:': 443,
	'ws:': 80,
	'wss:': 443,
	'ftp:': 21,
};

type Listener = { fn: (...args: unknown[]) => unknown; options?: unknown };

/** one chrome.* event in one context */
export class ChromeEvent {
	listeners: Listener[] = [];
	readonly api: Record<string, unknown>;
	constructor(
		readonly context: Context,
		readonly name: string,
		changed?: () => void,
	) {
		const find = (fn: unknown) =>
			this.listeners.findIndex((listener) => listener.fn === fn);
		this.api = {
			addListener: (fn: unknown, ...options: unknown[]) => {
				if (typeof fn !== 'function')
					throw new natives.TypeError(`${name}.addListener needs a function`);
				if (find(fn) < 0) {
					this.listeners.push({
						fn: fn as Listener['fn'],
						options: options.length ? options : undefined,
					});
					changed?.();
				}
			},
			removeListener: (fn: unknown) => {
				const index = find(fn);
				if (index >= 0) {
					this.listeners.splice(index, 1);
					changed?.();
				}
			},
			hasListener: (fn: unknown) => find(fn) >= 0,
			hasListeners: () => this.listeners.length > 0,
			// a declarative event's rules (declarativeContent, webRequest's
			// old declarative API): kept, as Chrome answers them back
			addRules: (rules: unknown, cb?: unknown) => {
				const added = (Array.isArray(rules) ? rules : []).map(
					(rule: Record<string, unknown>) => ({
						...rule,
						id: String(rule?.id ?? `_${++this.#ruleIds}_`),
						priority: Number(rule?.priority ?? 100),
					}),
				);
				for (const rule of added) this.#rules.set(rule.id, rule);
				answer(cb, added);
			},
			removeRules: (ids?: unknown, cb?: unknown) => {
				if (typeof ids === 'function') [cb, ids] = [ids, undefined];
				if (Array.isArray(ids))
					for (const id of ids) this.#rules.delete(String(id));
				else this.#rules.clear();
				answer(cb, undefined);
			},
			getRules: (ids?: unknown, cb?: unknown) => {
				if (typeof ids === 'function') [cb, ids] = [ids, undefined];
				const all = [...this.#rules.values()];
				answer(
					cb,
					Array.isArray(ids)
						? all.filter((rule) => ids.includes(rule.id))
						: all,
				);
			},
		};
		const answer = (cb: unknown, value: unknown) => {
			if (typeof cb === 'function')
				natives.setTimeout(() => (cb as (value: unknown) => void)(value), 0);
		};
	}
	#rules = new Map<string, Record<string, unknown> & { id: string }>();
	#ruleIds = 0;

	/** call every listener (that `accept` takes); what each returned */
	dispatch(args: unknown[], accept?: (options: unknown) => boolean): unknown[] {
		const results: unknown[] = [];
		for (const listener of [...this.listeners]) {
			if (accept && !accept(listener.options)) continue;
			try {
				results.push(listener.fn(...args));
			} catch (error) {
				this.context.listenerError(error);
			}
		}
		return results;
	}
}

/** what a context knows of the tab it is in (the hub's answer to hello) */
export interface TabPlace {
	tabId: number;
	frameId: number;
	tab: Record<string, unknown> | null;
}

/** what a context tells the others about itself */
export interface Presence {
	ctx: string;
	kind: ContextKind;
	tabId: number;
	frameId: number;
	url: string;
	/** has runtime.onMessage listeners, runtime.onConnect listeners */
	m: boolean;
	c: boolean;
	/**
	 * a document's own content context, the one that runs what scripting
	 * and tabs inject (entry.ts contentContext); its isolated and
	 * USER_SCRIPT worlds' contexts are content contexts of the same frame
	 * that never answer an injection
	 */
	x?: true;
}

export type BusMessage = Record<string, unknown> & { t: string };

let contexts = 0;

export class Context {
	readonly id = `${Math.random().toString(36).slice(2)}${++contexts}`;
	readonly events = new Map<string, ChromeEvent>();
	lastError: { message: string } | undefined;
	lastErrorChecked = false;
	/** a USER_SCRIPT world's: its messages go to runtime.onUserScriptMessage */
	userScript = false;
	/** a document's own content context, which answers injections (Presence.x) */
	injects = false;
	place: TabPlace = { tabId: -1, frameId: -1, tab: null };
	/** settles once the hub said where the context is (content scripts, popups) */
	placed: Promise<void> = natives.Promise.resolve();
	/** the other contexts of the extension under this controller */
	readonly peers = new Map<string, Presence>();
	/** what reports its errors to the extensions page (errors.ts) */
	errors: ErrorConsole | null = null;
	/**
	 * The extension was disabled, removed or reloaded under this content
	 * context: Chrome's "Extension context invalidated." (runtime.id reads
	 * undefined, its calls fail)
	 */
	invalidated = false;
	readonly bus: BroadcastChannel;
	readonly #handlers = new Map<string, ((message: BusMessage) => void)[]>();
	#calls = 0;
	#hubCalls = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	#announce = 0;

	constructor(
		readonly ext: ShippedExtension,
		/** (a page the hub says is a popup becomes one: entry.ts pageContext) */
		public kind: ContextKind,
		/** the controller's address */
		readonly channel: string,
		readonly url: string,
		/** a content document's token for the worker */
		readonly token: string | undefined,
	) {
		this.bus = new natives.BroadcastChannel(
			`${EXTENSION_BUS_PREFIX}${channel}|${ext.id}`,
		);
		this.bus.onmessage = (event) => this.#receive(event.data as BusMessage);
		this.on('presence', (message) => {
			const presence = message.p as Presence;
			if (presence.ctx !== this.id) this.peers.set(presence.ctx, presence);
		});
		this.on('bye', (message) => {
			this.peers.delete(String(message.ctx));
		});
		this.on('roll', () => this.announce());
		this.on('contextGone', () => {
			if (this.kind === 'content') this.invalidated = true;
		});
		// what the hub tells the extension's pages (action.onClicked, a
		// notification's or a menu's click)
		this.on('event', (message) => {
			if (this.kind === 'content') return;
			// a filtered event (webNavigation's): each listener's own URL filters
			const url = typeof message.url === 'string' ? message.url : null;
			this.events
				.get(String(message.name))
				?.dispatch(
					Array.isArray(message.args) ? message.args : [],
					url === null
						? undefined
						: (options) =>
								urlFiltersMatch(
									(Array.isArray(options)
										? (options[0] as { url?: unknown } | undefined)
										: undefined
									)?.url,
									url,
								),
				);
		});
		this.on('hubr', (message) => {
			if (message.to !== this.id) return;
			const waiting = this.#hubCalls.get(String(message.id));
			if (!waiting) return;
			this.#hubCalls.delete(String(message.id));
			if (typeof message.error === 'string')
				waiting.reject(new ApiError(message.error));
			else waiting.resolve(message.value);
		});
		listen(natives.global, 'pagehide', () =>
			this.post({ t: 'bye', ctx: this.id }),
		);
	}

	#receive(message: BusMessage) {
		if (!message || typeof message.t !== 'string') return;
		for (const handler of this.#handlers.get(message.t) ?? [])
			try {
				handler(message);
			} catch (error) {
				this.listenerError(error);
			}
	}

	on(type: string, handler: (message: BusMessage) => void) {
		const list = this.#handlers.get(type);
		if (list) list.push(handler);
		else this.#handlers.set(type, [handler]);
	}

	post(message: BusMessage) {
		this.bus.postMessage(message);
	}

	/** what the others know of this context */
	presence(): Presence {
		const has = (name: string) => !!this.events.get(name)?.listeners.length;
		return {
			ctx: this.id,
			kind: this.kind,
			tabId: this.place.tabId,
			frameId: this.place.frameId,
			url: this.url,
			m:
				has('runtime.onMessage') ||
				has('runtime.onMessageExternal') ||
				has('runtime.onUserScriptMessage'),
			c:
				has('runtime.onConnect') ||
				has('runtime.onConnectExternal') ||
				has('runtime.onUserScriptConnect'),
			...(this.injects ? { x: true as const } : {}),
		};
	}

	/** tell the others (once per task, however many listeners changed) */
	announce() {
		if (this.#announce) return;
		this.#announce = natives.setTimeout(() => {
			this.#announce = 0;
			this.post({ t: 'presence', p: this.presence() });
		}, 0) as unknown as number;
	}

	event(name: string): ChromeEvent {
		let event = this.events.get(name);
		if (!event) {
			const announces = /^runtime\.on(Message|Connect|UserScript)/.test(name);
			event = new ChromeEvent(
				this,
				name,
				announces ? () => this.announce() : undefined,
			);
			this.events.set(name, event);
		}
		return event;
	}

	listenerError(error: unknown) {
		this.errors?.listener(error);
		natives.console.error(`${this.ext.name}: Error in event handler:`, error);
	}

	/** a call of the controller's hub (it answers over the bus) */
	hub(name: string, ...args: unknown[]): Promise<unknown> {
		const id = `${this.id}:${++this.#calls}`;
		return new natives.Promise((resolve, reject) => {
			this.#hubCalls.set(id, { resolve, reject });
			this.post({ t: 'hub', id, from: this.id, call: name, args });
		});
	}

	/** a call of the worker's backend (src/server/extensions/api.ts) */
	async worker(
		area: string,
		name: string,
		...args: unknown[]
	): Promise<unknown> {
		const response = await natives.fetch(
			`${this.channel}${EXTENSION_API_ROUTE}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: natives.JSON.stringify({
					ext: this.ext.id,
					token: this.token,
					context: this.id,
					area,
					call: name,
					args,
				}),
			},
		);
		// (read as text and parsed here: an isolated world's values are its own realm's)
		const answer = natives.JSON.parse(await response.text()) as {
			value?: unknown;
			error?: string;
		};
		if (typeof answer?.error === 'string') throw new ApiError(answer.error);
		return answer?.value ?? undefined;
	}

	/** the sender a message of this context carries: an extension page's at chrome-extension://, as in Chrome */
	sender(): Record<string, unknown> {
		const origin =
			this.kind === 'content'
				? new URL(this.url).origin
				: `chrome-extension://${this.ext.id}`;
		return {
			id: this.ext.id,
			url: displayExtensionURL(this.url),
			origin,
			...(this.place.tab ? { tab: copy(this.place.tab) } : {}),
			...(this.place.frameId >= 0 ? { frameId: this.place.frameId } : {}),
			documentId: this.id,
			documentLifecycle: 'active',
		};
	}

	#callback(
		cb: (...args: unknown[]) => unknown,
		error: unknown,
		value: unknown,
		hasValue: boolean,
	) {
		this.lastError =
			error === undefined ? undefined : { message: messageOf(error) };
		this.lastErrorChecked = false;
		try {
			if (error !== undefined || !hasValue) cb();
			else cb(value);
		} catch (thrown) {
			this.listenerError(thrown);
		} finally {
			if (this.lastError && !this.lastErrorChecked)
				natives.console.error(
					`Unchecked runtime.lastError: ${this.lastError.message}`,
				);
			this.lastError = undefined;
		}
	}

	/**
	 * A chrome.* method: promise-returning, or callback-taking when its last
	 * argument is a function (runtime.lastError set during the callback)
	 */
	method(
		run: (...args: any[]) => unknown,
		{ voidResult = false } = {},
	): (...args: unknown[]) => unknown {
		return (...args: unknown[]) => {
			// (a content script whose extension went under it: Chrome's bindings
			// throw before the call is made)
			if (this.invalidated)
				throw new natives.Error('Extension context invalidated.');
			const cb =
				typeof args[args.length - 1] === 'function'
					? (args.pop() as (...values: unknown[]) => unknown)
					: null;
			let result: Promise<unknown>;
			try {
				result = natives.Promise.resolve(run(...args));
			} catch (error) {
				result = natives.Promise.reject(error);
			}
			if (cb) {
				result.then(
					(value) => this.#callback(cb, undefined, copy(value), !voidResult),
					(error: unknown) =>
						this.#callback(
							cb,
							error ?? new natives.Error('unknown error'),
							undefined,
							false,
						),
				);
				return undefined;
			}
			return new natives.Promise((resolve, reject) => {
				result.then(
					(value) => resolve(voidResult ? undefined : copy(value)),
					(error: unknown) => reject(new natives.Error(messageOf(error))),
				);
			});
		};
	}

	/** a synchronous chrome.* method (getURL, getManifest, getMessage) */
	sync(run: (...args: any[]) => unknown): (...args: unknown[]) => unknown {
		return (...args: unknown[]) => {
			try {
				return run(...args);
			} catch (error) {
				throw new natives.Error(messageOf(error));
			}
		};
	}
}
