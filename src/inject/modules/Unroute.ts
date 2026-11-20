import { serializeCSSURL } from '../../cssURL';
import { originalOf } from '../../cssURLs';
import { originalSource } from '../../functionSource';
import {
	linkRouteURL,
	pageBlobURL,
	parseRoutedURL,
	ROUTE_PROTOCOLS,
} from '../../routeURL';
import { workerErrorKey } from '../../transport/messages';
import { beforeFragment, fragmentOf } from '../../urlShape';
import { LINK_SEGMENT } from '../../visited';
import Client from '../Client';
import { blobLoads } from '../dom/blobLoads';
import type DocumentClient from '../dom/Client';
import Module from '../Module';
import { skippedFrames } from '../nativeErrors';
import { LazyWeakMap, LazyWeakSet } from '../ownCollections';
import { reportParts } from '../reportParts';
import type { ReportView } from '../reportsSeen';
import ProxyModule from './Proxy';
import ResourceBufferModule from './ResourceBuffer';

/**
 * The proxy-origin prefix every route of this context starts with. A
 * document's origin comes from its base URL: an about:srcdoc frame reads its
 * location origin as "null", while its base URL is the parent's routed one.
 */
export function routedPrefix(client: Client): string {
	const base = client.isDOM
		? (client as DocumentClient).baseURI
		: client.global.location;
	return `${base.origin}${client.directory}`;
}

/**
 * The proxy-origin prefix of the scope the routed prefix lives under: where
 * the proxy's own files (the inject bundles) are served from.
 */
export function scopePrefix(client: Client): string {
	const base = client.isDOM
		? (client as DocumentClient).baseURI
		: client.global.location;
	return `${base.origin}${client.scope}`;
}

/**
 * The origin this realm's blob: URLs are minted under, as the browser has
 * it: a document's own (an about:blank or srcdoc child's inherited one,
 * though its location reads "null"), a worker's location's
 */
export function realmOrigin(client: Client): string {
	return client.isDOM
		? (client as DocumentClient).realOrigin()
		: client.global.location.origin;
}

/**
 * The page's URL for a routed one. A string that is not under the scope
 * comes back as it is; `null` means the proxy's own machinery (an inject
 * bundle under the scope, `whoami` under the address), which no page URL
 * corresponds to.
 */
export function unrouteURL(client: Client, url: string): string | null {
	// a blob: URL the page made carries the proxy origin: the page's is shown
	url = pageBlobURL(url);
	let prefix = routedPrefix(client);
	if (!url.startsWith(prefix)) {
		const scope = scopePrefix(client);
		if (!url.startsWith(scope)) return url;
		// a link's route (src/visited.ts) stands for its URL
		if (url.startsWith(`${scope}${LINK_SEGMENT}/`))
			return (
				linkRouteURL(
					url.slice(scope.length + LINK_SEGMENT.length + 1),
					client.codec,
				)?.href ?? null
			);
		// another controller's address (a sibling tab's, or the one an
		// orphaned URL was redirected to): a route all the same, read with
		// this page's codec, which is the one a host uses in practice
		const other = /^([A-Za-z0-9_-]{1,32})\/[^/]+\//.exec(
			url.slice(scope.length),
		);
		if (!other) return null;
		prefix = `${scope}${other[1]}/`;
	}
	try {
		const real = parseRoutedURL(url, client.codec, prefix).url.toString();
		// a url() the CSS rewriter routed keeps the page's token after
		// `#url(` (src/cssURLs.ts): the URL's own fragment is the token's
		const token = originalOf(url);
		return token ? beforeFragment(real) + fragmentOf(token.url) : real;
	} catch (error) {
		return null;
	}
}

/**
 * The URL a computed style's url() shows for the target the browser has
 * (a route, or a copy, with the page's token after `#url(`): absolute, as
 * natively. A route stands for its real URL; a copy (a document no worker
 * controls) and anything else is the page's token resolved against the
 * document. Null when there is nothing to resolve.
 */
export function computedURL(client: Client, text: string): string | null {
	const marker = text.indexOf('#url(');
	const target = marker === -1 ? text : text.slice(0, marker);
	if (target.startsWith(scopePrefix(client))) return unrouteURL(client, text);
	const original = originalOf(text);
	if (!original) return null;
	try {
		return new URL(original.url, client.url.toString()).href;
	} catch (error) {
		return null;
	}
}

// a stack frame carries `:line:column` after the script URL
const LINE_COLUMN = /(?::\d+){1,2}$/;
// a frame's location always has both, the last two
const FRAME_LINE_COLUMN = /:\d+:\d+$/;
// a frame line of V8's stack (`    at f (url:1:2)`, `    at url:1:2`)
const FRAME_LINE = /^\s*at\s/;

/**
 * Every routed URL inside free text (an error stack, a message) replaced by
 * the page's URL. Internal URLs (the inject bundles) are left alone; callers
 * that can drop them do so before formatting.
 *
 * A codec's text may itself end in `:digits` (`:` is one of its characters),
 * so where the route ends is told by where it stands, not by its look: in a
 * frame (a line of V8's stack, or after `@` in Gecko's) the location always
 * ends in `:line:column`, the last two; anywhere else (a message) a URL has
 * none. Reading a route's own `:0` as a column decoded the rest to another
 * URL (`?ms=3009` came back as `?ms=30:1`).
 */
export function unrouteText(
	client: Client,
	text: string,
	/** `text` is one frame (a call site's text): its URLs are locations */
	frame = false,
): string {
	// a blob: URL the page made carries the proxy origin: the page's is shown
	const proxyBlob = `blob:${realmOrigin(client)}/`;
	if (text.includes(proxyBlob))
		text = text.split(proxyBlob).join(`blob:${client.url.url.origin}/`);
	// a route the browser quotes as the page's script wrote it: a module
	// request's specifier, which the rewriter writes as the route's path
	// ("The requested module '/<directory>/js:genericModule/...' does not
	// provide an export named 'x'")
	const routed = routedPrefix(client);
	const quotedPath = `'${client.directory}`;
	if (text.includes(quotedPath)) {
		const origin = routed.slice(0, routed.length - client.directory.length);
		text = text.replace(
			new RegExp(
				`'(${client.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s'"<>]*)'`,
				'g',
			),
			(match, path: string) => {
				const real = unrouteURL(client, origin + path);
				return real !== null && real !== origin + path ? `'${real}'` : match;
			},
		);
	}
	// this controller's routes, and a link's (src/visited.ts), which names
	// no controller
	const prefixes = [routed, `${scopePrefix(client)}${LINK_SEGMENT}/`].filter(
		(prefix) => text.includes(prefix),
	);
	if (!prefixes.length) return text;
	const pattern = new RegExp(
		`(?:${prefixes
			.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('|')})[^\\s()'"<>,]*`,
		'g',
	);
	return text.replace(pattern, (match, offset: number, whole: string) => {
		const line = whole.slice(whole.lastIndexOf('\n', offset - 1) + 1, offset);
		const inFrame = frame || FRAME_LINE.test(line) || whole[offset - 1] === '@';
		const suffix = inFrame ? (FRAME_LINE_COLUMN.exec(match)?.[0] ?? '') : '';
		const url = match.slice(0, match.length - suffix.length);
		const real = unrouteURL(client, url);
		if (real !== null && real !== url) return real + suffix;
		// not a route as it stands: one with a line and column after all
		const short = LINE_COLUMN.exec(url)?.[0] ?? '';
		const shorter = unrouteURL(client, url.slice(0, url.length - short.length));
		return short && shorter !== null && shorter !== url
			? shorter + short + suffix
			: match;
	});
}

// a url() token whose target is routed and keeps the page's token after
// `#url(`: quoted (cssText), with `&quot;` (markup), or unquoted with escaped
// parentheses (the rewriter's own text)
const ROUTED_CSS_URL =
	/url\((&quot;|["']|)([^"')\s]*?)#url(\\?)\(((?:\\.|&quot;|[^\\)])*?)\3\)\1\)/g;
// an @import's string whose target is routed, the page's string kept after
// `#url(` (the rewriter's own text; a rule's cssText has a url() instead)
const ROUTED_CSS_STRING = /(?<!\()"([^"\s]*?)#url\(((?:\\.|[^\\)])*?)\)"/g;

// what the markup serializer escapes in an attribute value, and back
const ATTRIBUTE_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'"': '&quot;',
	'\u00a0': '&nbsp;',
	'<': '&lt;',
	'>': '&gt;',
};
const ATTRIBUTE_ENTITIES = Object.fromEntries(
	Object.entries(ATTRIBUTE_ESCAPES).map(([char, entity]) => [entity, char]),
);

/**
 * CSS text (a rule's cssText, a style element's text, serialised markup) with
 * every routed url() replaced by the url() the page wrote, which the rewriter
 * keeps after `#url(` for idempotence. `serialized`: as the browser
 * serialises a parsed url() (a rule's cssText, a style attribute the CSSOM
 * wrote), `url("...")` whatever quotes the page wrote; otherwise the page's
 * own token (the text it wrote). A url() in a serialised attribute (quoted
 * with `&quot;`) is one the CSSOM wrote, since the markers of an attribute
 * the page wrote are folded back before: serialised, and escaped as the
 * markup serializer escapes an attribute value.
 */
export function unrouteCSS(
	client: Client,
	text: string,
	serialized = false,
): string {
	if (!text.includes('#url')) return text;
	const prefix = routedPrefix(client);
	text = text.replace(
		ROUTED_CSS_STRING,
		(match, target: string, token: string) =>
			target.startsWith(prefix) ? token.replace(/\\(.)/g, '$1') : match,
	);
	return text.replace(
		ROUTED_CSS_URL,
		(match, quote: string, target: string, escape: string, inner: string) => {
			// a route, or the copy of one the inject made for a document no
			// service worker controls (the token stays after the marker)
			if (!target.startsWith(prefix) && !blobLoads.has(target)) return match;
			const markup = quote === '&quot;';
			let token = markup
				? inner.replace(
						/&(?:amp|quot|nbsp|lt|gt);/g,
						(entity) => ATTRIBUTE_ENTITIES[entity],
					)
				: inner;
			token = token.replace(/\\(.)/g, '$1');
			try {
				token = decodeURIComponent(token);
			} catch (error) {
				// not percent-encoded
			}
			if (!serialized && !markup) return `url(${token})`;
			const css = serializeCSSURL(`url(${token.trim()})`);
			return markup
				? css.replace(/[&"\u00a0<>]/g, (char) => ATTRIBUTE_ESCAPES[char])
				: css;
		},
	);
}

/** V8's structured stack frame, the argument of Error.prepareStackTrace */
interface CallSite {
	getFileName(): string | null | undefined;
	getScriptNameOrSourceURL(): string | null | undefined;
	getEvalOrigin(): string | undefined;
	getFunctionName(): string | null;
	isEval(): boolean;
	getLineNumber(): number | null | undefined;
	getColumnNumber(): number | null | undefined;
	toString(): string;
}

type PrepareStackTrace = (error: unknown, sites: CallSite[]) => unknown;

/** where an uncaught error is reported from */
export interface ErrorLocation {
	/** the script's URL as the browser has it (a route), or null for none */
	routed: string | null;
	/** the script's URL as the page has it ('' for none, as for eval code) */
	filename: string;
	lineno: number;
	colno: number;
}

/**
 * The access API's helpers that call a function the rewriter wrote into the
 * page's script to do the page's write (src/inject/modules/Access.ts): V8
 * names their frames by their keys, which the minified bundle keeps
 */
const WRITERS = ['set1', 'set2'];

const NO_LOCATION: ErrorLocation = {
	routed: null,
	filename: '',
	lineno: 0,
	colno: 0,
};

/**
 * Error events on Worker objects whose worker placed the error at the
 * page's call site (the Worker module keys them): the browser located it in
 * the inject, and an event there carries no error object to tell from.
 */
export const reportedLocations = new LazyWeakMap<object, ErrorLocation>();

/** what an uncaught error's report carries (ErrorEvent, onerror) */
interface ErrorReport {
	message: unknown;
	filename: unknown;
	lineno: unknown;
	colno: unknown;
	error: unknown;
}
const REPORT_KEYS = [
	'message',
	'filename',
	'lineno',
	'colno',
	'error',
] as const;
// an error in a script of another origin fetched without CORS, as reported
const MUTED: ErrorReport = {
	message: 'Script error.',
	filename: '',
	lineno: 0,
	colno: 0,
	error: null,
};
/** a DataCloneError's message: what it was thrown for, the value as text, the verdict */
const UNCLONEABLE = /^([^:]*: )([\s\S]+)( could not be cloned\.)$/;

/** a page's ReportingObserver, as the reports the inject makes reach it (../reportsSeen.ts madeReport) */
export interface MadeObserver {
	callback: Function;
	/** the types it takes, or null for every type */
	types: string[] | null;
	/** it is to be handed the reports made before it first observes */
	buffered: boolean;
	/** the reports the inject made that it is still to be handed */
	pending: unknown[];
}
/** the page's observers, and the reports the inject made (the newest 100) */
export interface MadeReports {
	observers: LazyWeakMap<object, MadeObserver>;
	/** the observers that observe, in the order they started */
	observing: object[];
	buffer: { type: string; report: object }[];
}

/**
 * Strings the browser builds from request URLs come back as the page's URLs:
 * performance entries (name, toJSON, the lists from performance.*,
 * PerformanceObserver and takeRecords, which also drop the inject bundles'
 * entries) and error stacks (V8 through Error.prepareStackTrace, with a
 * page's own formatter still run on cleaned frames and inject frames
 * dropped; engines with a `stack` accessor on Error.prototype through that
 * getter), uncaught errors' reports (ErrorEvent, onerror, a DOMException's
 * message) and Reporting API reports.
 */
export default class UnrouteModule extends Module<Client> {
	apply() {
		this.applyPerformance();
		this.applyErrorStacks();
		this.applyErrorReports();
		this.applyReports();
	}
	applyPerformance() {
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global as typeof globalThis & Record<string, any>;
		const { PerformanceEntry, Performance } = global;
		if (!PerformanceEntry || !Performance) return;

		const nameDescriptor = Reflect.getOwnPropertyDescriptor(
			PerformanceEntry.prototype,
			'name',
		)!;
		const nativeName = (entry: PerformanceEntry): string =>
			Reflect.apply(nameDescriptor.get!, entry, []);
		// null for an entry of the proxy's own machinery, and for one the
		// page's resource timing would not have natively (ResourceTiming)
		const pageName = (entry: PerformanceEntry): string | null =>
			client.unreportedEntry?.(entry)
				? null
				: unrouteURL(client, String(nativeName(entry)));

		Reflect.defineProperty(PerformanceEntry.prototype, 'name', {
			...nameDescriptor,
			get: proxyModule.wrapFunction(
				nameDescriptor.get!,
				(target, that: PerformanceEntry, args) => {
					const name = Reflect.apply(target, that, args);
					return unrouteURL(client, String(name)) ?? name;
				},
			),
		});

		// each timing class serialises itself
		for (const name of [
			'PerformanceEntry',
			'PerformanceResourceTiming',
			'PerformanceNavigationTiming',
		]) {
			const prototype = global[name]?.prototype;
			if (!prototype || !Object.hasOwn(prototype, 'toJSON')) continue;
			prototype.toJSON = proxyModule.wrapFunction(
				prototype.toJSON,
				(target, that, args) => {
					const json: { name?: unknown } = Reflect.apply(target, that, args);
					if (json && typeof json.name === 'string')
						json.name = unrouteURL(client, json.name) ?? json.name;
					return json;
				},
			);
		}

		const startOf = Reflect.getOwnPropertyDescriptor(
			PerformanceEntry.prototype,
			'startTime',
		)?.get;
		// A load this context made for a document below it that no worker
		// controls (an about:blank frame's fetch, Client.routedFetch) is that
		// document's natively, entry and all: the entry of it here goes to
		// the document it was made for, which shows it as its own, and is
		// none of this page's
		const adopted = new LazyWeakSet<object>();
		const madeForChild = (entry: object): boolean => {
			if (adopted.has(entry)) return true;
			const loads = client.childLoads;
			if (!loads.length || !startOf) return false;
			const name = String(nativeName(entry as PerformanceEntry));
			const start = Reflect.apply(startOf, entry, []) as number;
			const index = loads.findIndex(
				(load) => load.url === name && load.from <= start && start <= load.to,
			);
			if (index === -1) return false;
			const [load] = loads.splice(index, 1);
			adopted.add(entry);
			if (load.of.adoptedLoads.length < 1024) load.of.adoptedLoads.push(entry);
			return true;
		};
		const pageEntry = (entry: object) =>
			pageName(entry as PerformanceEntry) !== null &&
			!madeForChild(entry) &&
			(client.admitEntry?.(entry) ?? true);
		const visible = (entries: PerformanceEntry[]) => entries.filter(pageEntry);
		const filterList = <T extends Function>(fn: T) =>
			proxyModule.wrapFunction(fn, (target, that, args) =>
				visible(Reflect.apply(target, that, args)),
			);
		// the page's buffer is counted in the page's entries only, from here
		// on (ResourceBuffer.ts)
		const buffer = client.getModule(ResourceBufferModule);
		buffer?.start(pageEntry);
		/**
		 * `entries` (what the browser's buffer has of the page's, by start
		 * time) with the page's entries that are in its buffer though the
		 * browser's own task has not taken them in yet, and the entries of
		 * the loads an ancestor made for this document, when the read is of
		 * this context's performance object and takes in resources
		 */
		const withWaiting = (
			entries: PerformanceEntry[],
			that: unknown,
			type?: unknown,
			name?: string,
		) => {
			if (that !== global.performance) return entries;
			let waiting = (buffer?.read() ?? []) as PerformanceEntry[];
			if (!client.controlled) {
				// (the ancestor's count brought up to now: it gives this
				// document its entries as it hears of them)
				const ancestor = client.controlledClient();
				if (ancestor && ancestor !== client)
					ancestor.getModule(ResourceBufferModule)?.read();
				if (client.adoptedLoads.length)
					waiting = [
						...waiting,
						...(client.adoptedLoads as PerformanceEntry[]),
					];
			}
			if (!waiting.length || (type !== undefined && type !== 'resource'))
				return entries;
			if (name !== undefined)
				waiting = waiting.filter((entry) => pageName(entry) === name);
			for (const entry of waiting) {
				if (entries.includes(entry)) continue;
				const start = startOf ? Reflect.apply(startOf, entry, []) : 0;
				let index = entries.length;
				while (
					index > 0 &&
					startOf &&
					Reflect.apply(startOf, entries[index - 1], []) > start
				)
					index--;
				entries.splice(index, 0, entry);
			}
			return entries;
		};

		// (an observer's list as the browser has it, for the callbacks below)
		const nativeListEntries =
			global.PerformanceObserverEntryList?.prototype.getEntries;
		for (const prototype of [
			Performance.prototype,
			global.PerformanceObserverEntryList?.prototype,
		]) {
			if (!prototype) continue;
			const getEntries = prototype.getEntries;
			const getEntriesByType = prototype.getEntriesByType;
			prototype.getEntries = proxyModule.wrapFunction(
				getEntries,
				(target, that, args) =>
					withWaiting(visible(Reflect.apply(target, that, args)), that),
			);
			prototype.getEntriesByType = proxyModule.wrapFunction(
				getEntriesByType,
				(target, that, args) => {
					const entries = visible(Reflect.apply(target, that, args));
					// (the browser has read the type: a string here)
					return args[0] === 'resource'
						? withWaiting(entries, that, 'resource')
						: entries;
				},
			);
			prototype.getEntriesByName = proxyModule.wrapFunction(
				prototype.getEntriesByName,
				(target, that, args) => {
					// the native argument check, and the browser's own words
					// for a name that is no string
					if (!args.length || typeof args[0] === 'symbol')
						return Reflect.apply(target, that, args);
					// the page asks by its own URL, which no native entry carries
					const name = `${args[0]}`;
					const typed = args.length > 1 && args[1] !== undefined;
					const type = typed ? `${args[1]}` : undefined;
					const entries: PerformanceEntry[] = typed
						? Reflect.apply(getEntriesByType, that, [type])
						: Reflect.apply(getEntries, that, []);
					return withWaiting(
						entries.filter(
							(entry) => pageName(entry) === name && pageEntry(entry),
						),
						that,
						type,
						name,
					);
				},
			);
		}

		const NativeObserver = global.PerformanceObserver;
		if (typeof NativeObserver !== 'function') return;
		NativeObserver.prototype.takeRecords = filterList(
			NativeObserver.prototype.takeRecords,
		);
		const typeOf = Reflect.getOwnPropertyDescriptor(
			PerformanceEntry.prototype,
			'entryType',
		)?.get;
		// An observer hears of the proxy's own entries too: a callback whose
		// entries are all the proxy's would be called with an empty list,
		// which the browser never does, and what a buffered observer is told
		// was dropped counts the page's entries only
		global.PerformanceObserver = proxyModule.wrapFunction(
			NativeObserver,
			(target, that, args, newTarget) => {
				// not a constructor call, or not a callback: the browser's error
				if (!newTarget || typeof args[0] !== 'function')
					return newTarget
						? Reflect.construct(target, args, newTarget)
						: Reflect.apply(target, that, args);
				const callback = args[0] as Function;
				args[0] = function (this: unknown, ...called: unknown[]) {
					try {
						const entries: PerformanceEntry[] = Reflect.apply(
							nativeListEntries,
							called[0],
							[],
						);
						if (entries.length && !entries.some(pageEntry)) return;
						const options = called[2] as
							{ droppedEntriesCount?: unknown } | undefined;
						if (
							buffer?.notThePages &&
							options &&
							typeof options.droppedEntriesCount === 'number' &&
							options.droppedEntriesCount > 0 &&
							typeOf &&
							entries.some(
								(entry) => Reflect.apply(typeOf, entry, []) === 'resource',
							)
						)
							options.droppedEntriesCount = Math.max(
								0,
								options.droppedEntriesCount - buffer.notThePages,
							);
					} catch (error) {
						// not the browser's own call: as it came
					}
					return Reflect.apply(callback, this, called);
				};
				return Reflect.construct(target, args, newTarget);
			},
			true,
		);
	}
	/** the first of the page's frames in each error's stack, once formatted */
	#pageSites = new LazyWeakMap<object, ErrorLocation>();
	/**
	 * Where the page's code threw `error`: the first frame of its stack that
	 * is not the inject's. The stack is formatted here if nothing has read it
	 * yet (V8 formats it once, through Error.prepareStackTrace).
	 */
	pageLocation(error: unknown): ErrorLocation | undefined {
		if (
			(typeof error !== 'object' || error === null) &&
			typeof error !== 'function'
		)
			return undefined;
		if (!this.#pageSites.has(error))
			try {
				Reflect.get(error, 'stack');
			} catch (failure) {
				// no stack to read
			}
		return this.#pageSites.get(error);
	}
	/**
	 * Where the page called a hooked method that the browser may answer with
	 * a report (a deprecation's names the script and position of the caller,
	 * which the browser takes to be the hook): the report shows these instead
	 * (applyReports), oldest first.
	 */
	#reportSites: ErrorLocation[] = [];
	/** the first of the page's frames on the stack now (applyErrorStacks) */
	#callerLocation?: () => ErrorLocation | undefined;
	/** where the page first opened a synchronous request (noteSynchronousRequest) */
	#synchronousSite?: ErrorLocation;
	/**
	 * The page opens a synchronous request on a document's main thread,
	 * from inside the hook that stands for `open()`: true the first time,
	 * with the page's call site kept. The browser deprecates such a request
	 * and reports it once a page, where it is opened; the page's go through
	 * the bridge, which opens none, so the hook has the browser open one
	 * that is never sent, and the report the browser then makes names the
	 * hook: it shows the place kept here (applyReports).
	 */
	noteSynchronousRequest(): boolean {
		if (this.#synchronousSite) return false;
		this.#synchronousSite = this.#callerLocation?.() ?? NO_LOCATION;
		return true;
	}
	/** the page's call site, from inside a hook (none: no script of the page's called it) */
	callerSite(): ErrorLocation {
		return this.#callerLocation?.() ?? NO_LOCATION;
	}
	/** note the page's call site, from inside a hook (#reportSites) */
	noteReportSite() {
		if (this.#reportSites.length >= 16) return;
		const site = this.#callerLocation?.();
		if (site) this.#reportSites.push(site);
	}
	// (taken when the module is made: a brand check no trap of a Proxy sees)
	readonly #isError = (
		this.client.global as { Error?: { isError?: (value: unknown) => boolean } }
	).Error?.isError;
	/**
	 * A reported error's own message, with any route in it unrouted, as the
	 * report's message is: the browser's error for a module that fails to
	 * link names the module by its route ("The requested module '...' does
	 * not provide an export named 'x'"). Only an error object itself is
	 * touched (a Proxy of the page's is no error to the brand check, and is
	 * not asked anything), and only a message that names a route changes.
	 */
	#unroutedError(error: unknown): unknown {
		if (!this.#isError?.(error)) return error;
		const message = Reflect.getOwnPropertyDescriptor(
			error as object,
			'message',
		);
		if (!message || typeof message.value !== 'string') return error;
		const unrouted = unrouteText(this.client, message.value);
		if (unrouted !== message.value)
			Reflect.defineProperty(error as object, 'message', {
				...message,
				value: unrouted,
			});
		return error;
	}
	/**
	 * Whether the load of a route of the page's own origin was marked by the
	 * worker as another origin's (redirected through one without CORS): the
	 * ResourceTiming module's observer, which no page's use of its timing
	 * buffer changes (a document's only)
	 */
	opaqueLoad?: (routed: string) => boolean;
	/** a URL of the inject's own (a bundle), which no page URL stands for */
	#isInternal(name: unknown): boolean {
		return (
			typeof name === 'string' &&
			name !== '' &&
			unrouteURL(this.client, name) === null
		);
	}
	/**
	 * Whether the browser mutes errors of the script at `routed`: a classic
	 * script of another real origin fetched without CORS, or one of the
	 * page's own origin whose redirects went through another (Chrome mutes
	 * both, measured on 157). Every route is same-origin for the browser, so
	 * it never mutes one itself. A module is
	 * always fetched with CORS, and a classic script with it when its element
	 * says `crossorigin`.
	 */
	#muted(routed: string | null): boolean {
		const client = this.client;
		if (!routed || !client.isDOM) return false;
		let parsed;
		try {
			parsed = parseRoutedURL(routed, client.codec, routedPrefix(client));
		} catch (error) {
			return false;
		}
		if (
			!parsed.resource.startsWith('js:') ||
			parsed.resource.endsWith('Module')
		)
			return false;
		const real = parsed.url.url;
		if (
			!ROUTE_PROTOCOLS.includes(real.protocol) ||
			(real.origin === client.url.url.origin && !this.opaqueLoad?.(routed))
		)
			return false;
		for (const script of client.global.document.querySelectorAll(
			'script[crossorigin]',
		))
			if ((script as HTMLScriptElement).src === real.href) return false;
		return true;
	}
	/**
	 * What an uncaught error's report reads as natively, from what the
	 * browser reported. The browser names the script the error was thrown
	 * from: a route, read back as the page's URL, or the inject's bundle when
	 * a hook called the native API that threw (the hook's frame is the
	 * thrower), placed where the page's code made that call, as natively.
	 * The message is the browser's, with any route in it unrouted. An error
	 * at the window from a script the browser would mute reads as muted.
	 */
	#fixReport(
		native: ErrorReport,
		event: object | undefined,
		atGlobal: boolean,
	): ErrorReport {
		const { filename } = native;
		let location = event ? reportedLocations.get(event) : undefined;
		if (!location && this.#isInternal(filename))
			location = this.pageLocation(native.error) ?? NO_LOCATION;
		// a script that has no file name for the browser and is the page's
		// for its stack: one of the page's markup (see rewriteInlineScripts)
		if (!location && filename === '') {
			const site = this.pageLocation(native.error);
			if (site?.routed) location = site;
		}
		const routed = location
			? location.routed
			: typeof filename === 'string'
				? filename
				: null;
		if (atGlobal && this.#muted(routed)) return { ...MUTED };
		return {
			message:
				typeof native.message === 'string'
					? unrouteText(this.client, native.message)
					: native.message,
			filename: location
				? location.filename
				: typeof filename === 'string'
					? (unrouteURL(this.client, filename) ?? filename)
					: filename,
			lineno: location ? location.lineno : native.lineno,
			colno: location ? location.colno : native.colno,
			error: this.#unroutedError(native.error),
		};
	}
	/**
	 * Uncaught errors read as natively: `ErrorEvent` (message, filename,
	 * lineno, colno, error), the arguments of a global `onerror` (an own
	 * property of a window, inherited in a worker) and a DOMException's
	 * message, which the browser writes with the routed URL it refused
	 * (importScripts). A dedicated worker also tells its Worker object where
	 * an error the browser located in the inject came from: the event there
	 * has no error object to find it from.
	 */
	applyErrorReports() {
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global as typeof globalThis & Record<string, any>;

		const domMessage = Reflect.getOwnPropertyDescriptor(
			global.DOMException?.prototype ?? {},
			'message',
		);
		if (domMessage?.get)
			Reflect.defineProperty(global.DOMException.prototype, 'message', {
				...domMessage,
				get: proxyModule.wrapFunction(domMessage.get, (target, that, args) => {
					const message = Reflect.apply(target, that, args);
					if (typeof message !== 'string') return message;
					// a value that cannot be cloned is quoted: a function, by
					// its source, which is the page's (src/functionSource.ts)
					const quoted = UNCLONEABLE.exec(message);
					const source = quoted && originalSource(quoted[2]!);
					return unrouteText(
						client,
						source ? `${quoted[1]}${source}${quoted[3]}` : message,
					);
				}),
			});

		const prototype = global.ErrorEvent?.prototype;
		const natives: Partial<Record<keyof ErrorReport, () => unknown>> = {};
		for (const key of REPORT_KEYS) {
			const getter = prototype
				? Reflect.getOwnPropertyDescriptor(prototype, key)?.get
				: undefined;
			if (getter) natives[key] = getter;
		}
		const read = (event: object, key: keyof ErrorReport) =>
			natives[key] ? Reflect.apply(natives[key], event, []) : undefined;
		const nativeTarget = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			'target',
		)?.get;
		const reports = new LazyWeakMap<object, ErrorReport>();
		const reportOf = (event: object): ErrorReport => {
			const known = reports.get(event);
			if (known) return known;
			const target = nativeTarget
				? Reflect.apply(nativeTarget, event, [])
				: null;
			const report = this.#fixReport(
				{
					message: read(event, 'message'),
					filename: read(event, 'filename'),
					lineno: read(event, 'lineno'),
					colno: read(event, 'colno'),
					error: read(event, 'error'),
				},
				event,
				target === global,
			);
			// an event the page made reads its fields before it is dispatched
			if (target !== null) reports.set(event, report);
			return report;
		};
		for (const key of REPORT_KEYS) {
			const getter = natives[key];
			if (!getter) continue;
			const hooked = proxyModule.wrapFunction(getter, (target, that, args) => {
				// the native brand check first
				Reflect.apply(target, that, args);
				return reportOf(that)[key];
			});
			Reflect.defineProperty(prototype, key, {
				...Reflect.getOwnPropertyDescriptor(prototype, key),
				get: hooked,
			});
		}

		let owner: object | null = global;
		let onerror: PropertyDescriptor | undefined;
		while (
			owner &&
			!(onerror = Reflect.getOwnPropertyDescriptor(owner, 'onerror'))
		)
			owner = Reflect.getPrototypeOf(owner);
		if (owner && onerror?.get && onerror.set) {
			let handler: unknown = null;
			const call = (...args: unknown[]) => {
				if (typeof handler !== 'function') return;
				// an ErrorEvent's handler gets its fields, any other event itself
				if (args.length > 1) {
					const report = this.#fixReport(
						{
							message: args[0],
							filename: args[1],
							lineno: args[2],
							colno: args[3],
							error: args[4],
						},
						undefined,
						true,
					);
					args = REPORT_KEYS.map((key) => report[key]);
				}
				return Reflect.apply(handler, global, args);
			};
			const windowSet = onerror.set;
			/** the window's handler becomes `value`, called through `call` */
			const assign = (value: unknown) => {
				handler =
					typeof value === 'function' ||
					(typeof value === 'object' && value !== null)
						? value
						: null;
				Reflect.apply(windowSet, global, [handler === null ? null : call]);
			};
			// what the browser holds is `call` only while the page's handler came
			// through here: one a <body onerror> attribute compiled is the
			// browser's own function, and the page reads that
			const shown = (native: unknown) => (native === call ? handler : native);
			Reflect.defineProperty(owner, 'onerror', {
				...onerror,
				get: proxyModule.wrapFunction(onerror.get, (target, that, args) =>
					shown(Reflect.apply(target, that, args)),
				),
				set: proxyModule.wrapFunction(onerror.set, (target, that, args) => {
					if (that !== global) return Reflect.apply(target, that, args);
					assign(args[0]);
				}),
			});
			// A body's and a frameset's onerror are the window's (the HTML
			// "window-reflecting" handlers): read there, the page got the inject's
			// wrapper where it had set a function on the window, and one set
			// there was not the window's to read
			const ownerDocument = Reflect.getOwnPropertyDescriptor(
				global.Node?.prototype ?? {},
				'ownerDocument',
			)?.get;
			const defaultView = Reflect.getOwnPropertyDescriptor(
				global.Document?.prototype ?? {},
				'defaultView',
			)?.get;
			for (const name of ['HTMLBodyElement', 'HTMLFrameSetElement']) {
				const reflecting = global[name]?.prototype as object | undefined;
				const descriptor =
					reflecting && Reflect.getOwnPropertyDescriptor(reflecting, 'onerror');
				if (
					!reflecting ||
					!descriptor?.get ||
					!descriptor.set ||
					!ownerDocument ||
					!defaultView
				)
					continue;
				Reflect.defineProperty(reflecting, 'onerror', {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
						shown(Reflect.apply(target, that, args)),
					),
					set: proxyModule.wrapFunction(
						descriptor.set,
						(target, that, args) => {
							// the native getter first: it throws for anything but a body
							Reflect.apply(descriptor.get!, that, []);
							const view = Reflect.apply(
								defaultView,
								Reflect.apply(ownerDocument, that, []),
								[],
							);
							if (view !== global) return Reflect.apply(target, that, args);
							assign(args[0]);
						},
					),
				});
			}
		}

		// the first listener of a dedicated worker, before any of the page's:
		// the message goes ahead of the browser's report on the same queue
		const post = global.postMessage;
		if (!client.isDOM && typeof post === 'function' && natives.filename)
			global.addEventListener('error', (event: Event) => {
				let filename: unknown;
				try {
					filename = read(event, 'filename');
				} catch (error) {
					// an event the page made that is no ErrorEvent
					// (`dispatchEvent(new Event('error'))`): it names no file, and
					// the throw here was reported to the page's onerror as an
					// error of its own
					return;
				}
				if (!this.#isInternal(filename)) return;
				const location = this.pageLocation(read(event, 'error')) ?? NO_LOCATION;
				try {
					Reflect.apply(post, global, [
						{
							[workerErrorKey(client.names.globalName)]: {
								message: read(event, 'message'),
								...location,
							},
						},
					]);
				} catch (error) {
					// the worker is closing
				}
			});
	}
	/**
	 * The page's ReportingObservers and the reports the inject made itself
	 * (its own violations, ../reportsSeen.ts madeReport), which reach them
	 * as the browser's own reach them
	 */
	readonly madeReports: MadeReports = {
		observers: new LazyWeakMap(),
		observing: [],
		buffer: [],
	};
	/**
	 * Reports a page reads through ReportingObserver (a deprecation, an
	 * intervention, a policy violation) name the page's URLs: the report's
	 * `url` (the document's), and the URLs in its body, in their getters and
	 * in toJSON.
	 */
	applyReports() {
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global as typeof globalThis & Record<string, any>;
		// The bodies the page sees are hooked from the first reports of their
		// kind (`seen`, below), before the page's callback or takeRecords has
		// them, not by walking the globals here: reading `global[name]` for
		// every exposed `*ReportBody` made each of those interfaces in every
		// frame (frame-cost), and a document that never gets a report of a
		// kind has no body of it to un-route. A report reaches the page only
		// through a ReportingObserver (its callback or takeRecords), both of
		// which pass through `seen` first, so the body's prototype is hooked
		// before the page reads a url on it: the same prototype the walk
		// reached, `global[name].prototype`, taken from the report's body.

		// Report and most bodies are not exposed: their prototypes are taken
		// from the first reports, before the page's callback has them
		const view: ReportView = {
			client,
			proxyModule,
			hooked: new LazyWeakSet<object>(),
			synchronousSite: () => this.#synchronousSite,
			firstSite: () => this.#reportSites[0],
		};
		// (a deferred part, ../reportsSeen.ts: without it, no report reaches
		// the page)
		const seen = (reports: unknown) => reportParts.seen!()(view, reports);
		const Observer = global.ReportingObserver;
		if (typeof Observer !== 'function') return;
		const nativeTakeRecords = Reflect.getOwnPropertyDescriptor(
			Observer.prototype,
			'takeRecords',
		)?.value;
		const { observers } = this.madeReports;
		if (typeof nativeTakeRecords === 'function')
			Observer.prototype.takeRecords = proxyModule.wrapFunction(
				nativeTakeRecords,
				(target, that, args) => {
					const records = seen(Reflect.apply(target, that, args));
					// and the reports the inject made that it holds
					const pending = observers.get(that)?.pending;
					if (pending?.length && Array.isArray(records)) {
						for (let i = 0; i < pending.length; i++)
							records[records.length] = pending[i];
						pending.length = 0;
					}
					return records;
				},
			);
		// whether each observes, and the reports the inject made that a
		// buffered one is handed as it starts
		for (const name of ['observe', 'disconnect'] as const) {
			const native = Reflect.getOwnPropertyDescriptor(
				Observer.prototype,
				name,
			)?.value;
			if (typeof native === 'function')
				Observer.prototype[name] = proxyModule.wrapFunction(
					native,
					(target, that, args) => {
						const result = Reflect.apply(target, that, args);
						const observer = observers.get(that);
						if (!observer) return result;
						const { observing } = this.madeReports;
						let at = -1;
						for (let i = 0; i < observing.length; i++)
							if (observing[i] === that) at = i;
						if (name === 'disconnect') {
							if (at >= 0) {
								for (let i = at + 1; i < observing.length; i++)
									observing[i - 1] = observing[i];
								observing.length--;
							}
							return result;
						}
						if (at >= 0) return result;
						observing[observing.length] = that as object;
						// handed the reports before once, as it first observes
						// (as the browser's registers it)
						if (observer.buffered) {
							observer.buffered = false;
							if (this.madeReports.buffer.length)
								reportParts.made?.().buffered(this.madeReports, that, observer);
						}
						return result;
					},
				);
		}
		global.ReportingObserver = proxyModule.wrapFunction(
			Observer,
			(target, that, args, newTarget) => {
				// called without new: the browser's TypeError
				if (!newTarget) return Reflect.apply(target, that, args);
				const callback = args[0];
				if (typeof callback === 'function') {
					args[0] = function (this: unknown, ...called: unknown[]) {
						const came = Array.isArray(called[0]) ? called[0].length : 0;
						try {
							called[0] = seen(called[0]);
						} catch (error) {
							return;
						}
						// (nothing left: there was no report of the page's. A list
						// that came empty is the browser's own call, after the page
						// took its records)
						if (came && Array.isArray(called[0]) && !called[0].length) return;
						return Reflect.apply(callback, this, called);
					};
				}
				const made = Reflect.construct(target, args, newTarget);
				if (typeof callback === 'function') {
					// the types it takes (strings of an array, as most pages
					// give them; any other list takes the inject's reports too)
					let types: string[] | null = null;
					let buffered = false;
					try {
						const options = args[1] as
							{ types?: unknown; buffered?: unknown } | null | undefined;
						if (options && typeof options === 'object') {
							buffered = !!options.buffered;
							const given = options.types;
							if (Array.isArray(given)) {
								types = [];
								for (let i = 0; i < given.length; i++)
									if (typeof given[i] === 'string')
										types[types.length] = given[i];
							}
						}
					} catch (error) {
						// options the browser read already
					}
					observers.set(made, {
						callback,
						types,
						buffered,
						pending: [],
					});
				}
				return made;
			},
			true,
		);
	}
	applyErrorStacks() {
		const moduleClient = this.client;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const ErrorCtor = moduleClient.global.Error as typeof Error & {
			captureStackTrace?: Function;
			prepareStackTrace?: PrepareStackTrace;
		};
		// a realm hooked already: its Error is the page's (below)
		if (errorProxies.has(ErrorCtor)) return;
		const clean = (value: unknown) =>
			typeof value === 'string' ? unrouteText(moduleClient, value) : value;

		const protoStack = Reflect.getOwnPropertyDescriptor(
			ErrorCtor.prototype,
			'stack',
		);
		if (protoStack?.get) {
			// SpiderMonkey: one accessor on the prototype
			Reflect.defineProperty(ErrorCtor.prototype, 'stack', {
				...protoStack,
				get: proxyModule.wrapFunction(protoStack.get, (target, that, args) =>
					clean(Reflect.apply(target, that, args)),
				),
			});
			return;
		}

		// V8: `stack` is an own accessor of every error, so the only hook is
		// the formatter V8 consults when the string is first built
		if (typeof ErrorCtor.captureStackTrace !== 'function') return;

		// a script of the page's markup runs inside the write that loads it,
		// which gives it no file name: it has the source URL the inject names
		// it with (rewriteInlineScripts), the page's URL natively
		const scriptName = (site: CallSite) =>
			site.getFileName() ??
			(site.isEval() ? undefined : site.getScriptNameOrSourceURL());
		const fileName = (site: CallSite): string | null | undefined => {
			const name = scriptName(site);
			return typeof name === 'string'
				? (unrouteURL(moduleClient, name) ?? name)
				: name;
		};
		// a frame inside the inject bundle: no page URL corresponds to it
		// (or a function the inject made with a realm's Function: its code has
		// no URL, only the source URL the Client gives it, under the scope)
		const isInternal = (site: CallSite) => {
			const name = site.getFileName() ?? site.getScriptNameOrSourceURL();
			return (
				typeof name === 'string' && unrouteURL(moduleClient, name) === null
			);
		};
		// V8 infers a name for an anonymous function from the code around it,
		// and around the page's is the rewriter's (a frame read
		// `$s$j.set2.t$t.<computed>`): no name of the page's, so the frame
		// reads as an anonymous function's
		const { names } = moduleClient;
		const helpers = [names.access, names.globalProxy, names.client];
		const helperName = (name: unknown) =>
			typeof name === 'string' &&
			helpers.some((helper) => name.includes(helper));
		const FRAME = /^(async |new )?(\S+(?: \[as [^\]]*\])?) \((.*)\)$/s;
		const unnamed = (text: string) => {
			const frame = FRAME.exec(text);
			return frame && helperName(frame[2])
				? `${frame[1] ?? ''}${frame[3]}`
				: text;
		};
		// code the page handed to `new Function` or `eval` runs through the
		// inject bundle, so V8 names the bundle as the eval origin of its
		// frames; the page would see its own call site there (the next frame
		// of the page's), or nothing. The bundle lives under the scope, the
		// routes under the address below it: one prefix covers both
		const prefix = scopePrefix(moduleClient);
		const internalURL = new RegExp(
			`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s()'"<>,]*`,
			'g',
		);
		const pageCaller = (index: number, sites: CallSite[]) => {
			for (let i = index + 1; i < sites.length; i++) {
				const name = fileName(sites[i]);
				if (typeof name !== 'string' || isInternal(sites[i])) continue;
				const line = sites[i].getLineNumber();
				const column = sites[i].getColumnNumber();
				const caller = sites[i].getFunctionName();
				return {
					location:
						typeof line === 'number'
							? `${name}:${line}${typeof column === 'number' ? `:${column}` : ''}`
							: name,
					name: caller && !helperName(caller) ? caller : '<anonymous>',
				};
			}
			return { location: '<anonymous>', name: '<anonymous>' };
		};
		const isInternalMatch = (match: string) =>
			unrouteURL(moduleClient, match.replace(LINE_COLUMN, '')) === null;
		// the eval origin of a function the page made with `new Function`
		// (the Function module made it, with the realm's eval): natively the
		// page's call, and the frame of such a function reads `eval`
		const internalOrigin = new RegExp(
			`^(async )?(\\S+) \\(eval at \\S+ \\((${internalURL.source})\\)`,
		);
		const cleanFrame = (
			text: string,
			index: number,
			sites: CallSite[],
		): string =>
			unrouteText(
				moduleClient,
				text
					.replace(internalOrigin, (match, async, name, url) => {
						if (!isInternalMatch(url)) return match;
						const caller = pageCaller(index, sites);
						return `${async ?? ''}${name === 'anonymous' ? 'eval' : name} (eval at ${caller.name} (${caller.location})`;
					})
					.replace(internalURL, (match) =>
						isInternalMatch(match) ? pageCaller(index, sites).location : match,
					),
				true,
			);
		// what a page's own formatter sees: the same frame, naming page URLs
		// the sites a page's formatter is given, to tell its own call of this
		// formatter from V8's
		const cleanedSites = new LazyWeakSet<object>();
		const cleanSite = (
			site: CallSite,
			index: number,
			sites: CallSite[],
		): CallSite => {
			const cleaned = new Proxy(site, {
				get: (target, key) => {
					if (key === 'getFileName' || key === 'getScriptNameOrSourceURL')
						return () => fileName(target);
					if (key === 'getFunctionName')
						return () => {
							const name = target.getFunctionName();
							return helperName(name) ? null : name;
						};
					if (key === 'getEvalOrigin' || key === 'toString')
						return () => {
							const value = Reflect.apply((target as any)[key], target, []);
							return typeof value === 'string'
								? cleanFrame(
										key === 'toString' ? unnamed(value) : value,
										index,
										sites,
									)
								: value;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
			cleanedSites.add(cleaned);
			return cleaned;
		};
		// Error.prototype.toString, which V8 also uses for the first line. V8
		// takes that line when it makes the error, unless a formatter is
		// installed (this one), which reads the message when the stack is
		// first read. Blink names the call in the message of an error it
		// throws ("Failed to execute 'fetch' on 'Window': ...") after V8 made
		// it, so natively the line of such an error has the message without
		// that; a DOMException is made with the whole message.
		const objectToString = Object.prototype.toString;
		const BINDING_CONTEXT =
			/^Failed to (?:execute '[^']*' on |construct |read the '[^']*' property from |set the '[^']*' property on )'[^']*': /;
		const header = (error: any): string => {
			try {
				const name = error.name === undefined ? 'Error' : String(error.name);
				let message = error.message === undefined ? '' : String(error.message);
				if (
					Reflect.apply(objectToString, error, []) !== '[object DOMException]'
				)
					message = message.replace(BINDING_CONTEXT, '');
				if (name === '') return message;
				if (message === '') return name;
				return `${name}: ${message}`;
			} catch (error) {
				return 'Error';
			}
		};

		// The page's Error (see below) and its own `prepareStackTrace`, which
		// lives here rather than on Error: whatever descriptor the page gave
		// the key, as an own property would hold it
		let pageError: typeof ErrorCtor = ErrorCtor;
		const pageOwn = Object.create(null) as Record<string, unknown>;
		// what an assignment walks past when Error inherits from nothing
		const nothing = Object.create(null) as object;
		const KEY = 'prepareStackTrace';
		// where the page's Error.prepareStackTrace is found: its own, or what
		// Error inherits (natively nothing)
		const pageHolder = (): object | null =>
			Reflect.getOwnPropertyDescriptor(pageOwn, KEY)
				? pageOwn
				: Reflect.getPrototypeOf(ErrorCtor);
		// its value, read on `receiver` (the page's Error, or a subclass)
		const pagePrepare = (receiver: unknown): unknown => {
			const holder = pageHolder();
			return holder === null ? undefined : Reflect.get(holder, KEY, receiver);
		};
		// Error.stackTraceLimit. V8 reads the real Error's (a data property:
		// an accessor or anything but a number captures no stack at all) when
		// it captures a stack, and every frame of the inject's counts, though
		// the formatter below drops them all: the page's own frames fell off the
		// end of a stack that ran through hooks. The real Error holds the
		// page's limit and HEADROOM more, and the formatter cuts what is left
		// to the page's (the one when the error was made, where it is known
		// which). The page reads and writes its own value as an own property
		// of Error holds it, here beside its formatter, unless it made Error
		// keep it for good (`limitPinned`, the real Error then holds it as
		// it is).
		const LIMIT = 'stackTraceLimit';
		const nativeLimit = Reflect.getOwnPropertyDescriptor(ErrorCtor, LIMIT);
		const limiting =
			!!nativeLimit && 'value' in nativeLimit && !!nativeLimit.configurable;
		let limitPinned = false;
		if (limiting) Reflect.defineProperty(pageOwn, LIMIT, nativeLimit);
		// what V8 would read of the page's: an own data property, or one that
		// Error inherits
		const pageLimit = (): unknown => {
			let descriptor = Reflect.getOwnPropertyDescriptor(
				limitPinned ? ErrorCtor : pageOwn,
				LIMIT,
			);
			for (
				let holder = Reflect.getPrototypeOf(ErrorCtor);
				!descriptor && holder;
				holder = Reflect.getPrototypeOf(holder)
			)
				descriptor = Reflect.getOwnPropertyDescriptor(holder, LIMIT);
			return descriptor && 'value' in descriptor ? descriptor.value : undefined;
		};
		// the real one, from the page's (a page that turned stacks off still
		// has them captured for the inject's own use, and reads none)
		const syncLimit = () => {
			if (!limiting || limitPinned) return;
			const limit = pageLimit();
			Reflect.defineProperty(ErrorCtor, LIMIT, {
				value:
					typeof limit === 'number' && limit >= 1 ? limit + HEADROOM : HEADROOM,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		};
		syncLimit();
		// the page's limit once an error of its own was made (the page's
		// Error, a subclass, Error.captureStackTrace): a limit raised around
		// one and put back before its stack is read holds for that stack
		const limits = new WeakMap<object, unknown>();
		const madeWith = <T>(made: T): T => {
			if (
				(typeof made === 'object' && made !== null) ||
				typeof made === 'function'
			)
				Reflect.apply(weakMapSet, limits, [made, pageLimit()]);
			return made;
		};
		// The page's frame that called into the inject, for a hook that has to
		// say where it was called from (noteReportSite): the stack of an error
		// made here, formatted without the page's formatter.
		let locating = false;
		this.#callerLocation = () => {
			const error = new ErrorCtor();
			locating = true;
			try {
				Reflect.get(error, 'stack');
			} catch (failure) {
				// no stack to read
			} finally {
				locating = false;
			}
			return this.#pageSites.get(error);
		};
		moduleClient.callerScript = () => {
			const routed = this.#callerLocation?.()?.routed;
			if (!routed) return null;
			try {
				const parsed = parseRoutedURL(
					routed,
					moduleClient.codec,
					routedPrefix(moduleClient),
				);
				// a script's own route (not a document's, whose markup scripts
				// are named for it)
				return parsed.resource.startsWith('js:') ? parsed.url.url.href : null;
			} catch (error) {
				return null;
			}
		};
		const prepare: PrepareStackTrace = (error, sites) => {
			// V8 passes the error and its call sites. A page that calls the
			// formatter it read, to hand off to the one installed before its own,
			// passes what it has (Notion's: the error as `this`, the sites the
			// one argument). Natively there is none before the page's, so such a
			// call gets the default text and does not reach the page's formatter,
			// which would call this one again.
			const fromV8 =
				Array.isArray(sites) && !sites.some((site) => cleanedSites.has(site));
			if (!Array.isArray(sites)) sites = [];
			let shown: CallSite[];
			try {
				const internal = sites.map(isInternal);
				shown = sites.filter(
					(site, index) =>
						!internal[index] &&
						// the arrow the rewriter hands set1 / set2 to write with
						// (`(t$t, t$p, t$v) => t$t[t$p] = t$v`) is in the page's
						// script, and a write it does that throws (a setter, a
						// strict-mode write) has it as a frame of the page's: natively
						// the write is in the page's own function
						!(
							internal[index + 1] &&
							WRITERS.includes(sites[index + 1].getFunctionName() ?? '')
						),
				);
			} catch (error) {
				shown = sites;
			}
			// where the page's code threw it, for the error's report
			if (
				fromV8 &&
				((typeof error === 'object' && error !== null) ||
					typeof error === 'function') &&
				shown.length
			)
				try {
					const routed = scriptName(shown[0]);
					this.#pageSites.set(error, {
						routed: typeof routed === 'string' ? routed : null,
						filename: fileName(shown[0]) ?? '',
						lineno: shown[0].getLineNumber() ?? 0,
						colno: shown[0].getColumnNumber() ?? 0,
					});
				} catch (failure) {
					// a frame that cannot say
				}
			const skip =
				typeof error === 'object' && error !== null
					? skippedFrames.get(error)
					: undefined;
			if (skip) shown = shown.slice(skip);
			if (fromV8 && !locating && limiting) {
				const limit =
					typeof error === 'object' &&
					error !== null &&
					Reflect.apply(weakMapHas, limits, [error])
						? Reflect.apply(weakMapGet, limits, [error])
						: pageLimit();
				// (natively no stack was captured, and the formatter not asked)
				if (typeof limit !== 'number') return undefined;
				// (none below one, NaN included; a fraction counts whole frames)
				const kept = limit >= 1 ? limit : 0;
				if (shown.length > kept) shown = shown.slice(0, kept);
			}
			// (a stack the inject formats for itself is not the page's to format)
			const own = fromV8 && !locating ? pagePrepare(pageError) : undefined;
			if (typeof own === 'function') {
				const result = Reflect.apply(own, pageError, [
					error,
					shown.map((site, index) => cleanSite(site, index, shown)),
				]);
				return clean(result);
			}
			return (
				unrouteText(moduleClient, header(error)) +
				shown
					.map(
						(site, index) =>
							`\n    at ${cleanFrame(unnamed(String(site)), index, shown)}`,
					)
					.join('')
			);
		};

		// V8 reads the formatter off the realm's own Error, and natively the
		// page reads the same property (`undefined` until it sets one). Here
		// the page's Error is a Proxy over the real one, and every way a page
		// reaches Error leads to it: the global, `Error.prototype.constructor`
		// and the prototype of TypeError and its siblings. The accessor tells
		// the two readers apart by receiver: V8's is the real Error and gets
		// this formatter, so a formatter the page installs runs on cleaned
		// frames and its result is cleaned too; the page's is the Proxy (or a
		// constructor inheriting from it) and gets its own property or nothing.
		// The Proxy answers for the key's existence the same way; construction,
		// calls and every other property are the real Error's.
		let pinned = false;
		Reflect.defineProperty(ErrorCtor, KEY, {
			configurable: true,
			enumerable: false,
			get(this: unknown) {
				return this === ErrorCtor ? prepare : pagePrepare(this);
			},
			set(this: unknown, value: unknown) {
				if (pinned) {
					Reflect.set(pageOwn, KEY, value);
					return;
				}
				// an assignment as to an object without the accessor: the page's
				// own property, or one the receiver gets
				Reflect.set(
					pageHolder() ?? nothing,
					KEY,
					value,
					this === ErrorCtor ? pageError : this,
				);
			},
		});
		// the page's stackTraceLimit is asked of the page's own, not the real
		const limited = (key: PropertyKey) =>
			key === LIMIT && limiting && !limitPinned;
		// where the page's limit is found: its own, or what Error inherits
		const limitHolder = (): object =>
			Reflect.getOwnPropertyDescriptor(pageOwn, LIMIT)
				? pageOwn
				: (Reflect.getPrototypeOf(ErrorCtor) ?? nothing);
		// An error the page makes: its limit noted once it is made (V8 converts
		// the message and reads the options first). V8 leaves out of the
		// stack every frame down to the one of the constructor it is given
		// as new.target, which is this trap when the page's is its Error (as
		// it is when the page calls Error without `new`): no frame of the
		// inject's is the error's first, which is where the browser places
		// an uncaught one (a frame of the inject's there moved an error of
		// eval code to the page's script). Its `prototype` is Error's, which
		// the error is made with.
		const made = function (
			target: typeof ErrorCtor,
			second: unknown,
			third: unknown,
		) {
			// (a call: `that` and the arguments; a construction: the
			// arguments and new.target)
			const constructing = typeof third === 'function';
			return madeWith(
				Reflect.construct(
					target,
					(constructing ? second : third) as unknown[],
					constructing && third !== pageError ? third : made,
				),
			);
		};
		made.prototype = ErrorCtor.prototype;
		const handler: ProxyHandler<typeof ErrorCtor> = {
			get: (target, key, receiver) =>
				limited(key)
					? Reflect.get(limitHolder(), key, receiver)
					: Reflect.get(target, key, receiver),
			set: (target, key, value, receiver) =>
				limited(key)
					? Reflect.set(limitHolder(), key, value, receiver)
					: Reflect.set(target, key, value, receiver),
			apply: made,
			construct: made,
			has: (target, key) => {
				if (limited(key)) return Reflect.has(limitHolder(), key);
				if (key !== KEY || pinned) return Reflect.has(target, key);
				const holder = pageHolder();
				return holder !== null && Reflect.has(holder, key);
			},
			getOwnPropertyDescriptor: (target, key) =>
				(key !== KEY || pinned) && !limited(key)
					? Reflect.getOwnPropertyDescriptor(target, key)
					: Reflect.getOwnPropertyDescriptor(pageOwn, key),
			defineProperty: (target, key, descriptor) => {
				if (limited(key)) {
					const had = !!Reflect.getOwnPropertyDescriptor(pageOwn, key);
					if (!Reflect.defineProperty(pageOwn, key, descriptor)) return false;
					const defined = Reflect.getOwnPropertyDescriptor(pageOwn, key)!;
					if (!defined.configurable) {
						// kept for good: the real Error holds it as the page has it
						limitPinned = true;
						return Reflect.defineProperty(target, key, defined);
					}
					// (one made anew is listed last, as natively)
					if (!had) Reflect.deleteProperty(target, key);
					syncLimit();
					return true;
				}
				if (key !== KEY || pinned)
					return Reflect.defineProperty(target, key, descriptor);
				if (!Reflect.defineProperty(pageOwn, key, descriptor)) return false;
				const defined = Reflect.getOwnPropertyDescriptor(pageOwn, key)!;
				// a Proxy reports no non-configurable property its target does not
				// have: the page's own replaces the formatter, and this realm's
				// stacks are no longer cleaned
				if (!defined.configurable) {
					pinned = true;
					Reflect.defineProperty(target, key, defined);
				}
				return true;
			},
			deleteProperty: (target, key) => {
				if (limited(key)) {
					if (!Reflect.deleteProperty(pageOwn, key)) return false;
					syncLimit();
					return true;
				}
				return key !== KEY || pinned
					? Reflect.deleteProperty(target, key)
					: Reflect.deleteProperty(pageOwn, key);
			},
			ownKeys: (target) => {
				let keys = Reflect.ownKeys(target);
				if (limited(LIMIT) && !Reflect.getOwnPropertyDescriptor(pageOwn, LIMIT))
					keys = keys.filter((key) => key !== LIMIT);
				if (pinned) return keys;
				const shown = keys.filter((key) => key !== KEY);
				// a property the page made comes after the string keys Error had
				if (Reflect.getOwnPropertyDescriptor(pageOwn, KEY)) {
					const symbol = shown.findIndex((key) => typeof key === 'symbol');
					shown.splice(symbol === -1 ? shown.length : symbol, 0, KEY);
				}
				return shown;
			},
			preventExtensions: (target) => {
				// a non-extensible target's Proxy reports exactly the target's own
				// properties: from here on the accessor shows (it still cleans, and
				// reads and writes the page's own property)
				pinned = true;
				if (limited(LIMIT)) {
					const own = Reflect.getOwnPropertyDescriptor(pageOwn, LIMIT);
					if (own) Reflect.defineProperty(target, LIMIT, own);
					else Reflect.deleteProperty(target, LIMIT);
					limitPinned = true;
				}
				return Reflect.preventExtensions(target);
			},
		};
		// Error.captureStackTrace notes the limit too; with no function of the
		// page's to start after, the stack starts after this one, as it starts
		// after the native's own natively
		const capture = ErrorCtor.captureStackTrace;
		if (limiting && typeof capture === 'function') {
			const hook = {
				captureStackTrace(this: unknown, object: unknown, caller: unknown) {
					const result = Reflect.apply(capture, this, [
						object,
						typeof caller === 'function' ? caller : hook,
					]);
					madeWith(object);
					return result;
				},
			}.captureStackTrace;
			proxyModule.mirrorSource(capture, hook);
			proxyModule.adopt(hook);
			ErrorCtor.captureStackTrace = hook;
		}
		pageError = new Proxy(ErrorCtor, handler);
		errorProxies.add(pageError);
		proxyModule.functionStrings.set(pageError, ErrorCtor.toString());
		const global = moduleClient.global as unknown as Record<string, unknown>;
		const constructor = Reflect.getOwnPropertyDescriptor(
			ErrorCtor.prototype,
			'constructor',
		);
		if (constructor && 'value' in constructor)
			Reflect.defineProperty(ErrorCtor.prototype, 'constructor', {
				...constructor,
				value: pageError,
			});
		const wasm = Reflect.getOwnPropertyDescriptor(global, 'WebAssembly')?.value;
		for (const [holder, names] of [
			[global, ERROR_SUBCLASSES],
			[wasm, WASM_ERRORS],
		] as const) {
			if (typeof holder !== 'object' || holder === null) continue;
			for (const name of names) {
				const ctor = Reflect.getOwnPropertyDescriptor(holder, name)?.value;
				if (
					typeof ctor === 'function' &&
					Reflect.getPrototypeOf(ctor) === ErrorCtor
				)
					Reflect.setPrototypeOf(ctor, pageError);
			}
		}
		const own = Reflect.getOwnPropertyDescriptor(global, 'Error');
		if (own && 'value' in own)
			Reflect.defineProperty(global, 'Error', { ...own, value: pageError });
	}
}

// the constructors whose prototype is Error (a page's `class extends Error`
// is made after the inject, from the page's Error)
const ERROR_SUBCLASSES = [
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'AggregateError',
	'SuppressedError',
];
const WASM_ERRORS = [
	'CompileError',
	'LinkError',
	'RuntimeError',
	'SuspendError',
];
/**
 * How many frames more than the page's Error.stackTraceLimit V8 captures,
 * for the inject's own (applyErrorStacks): a hook is a few, and a stack can
 * run through several. Measured, Chrome 157: an error made 120 frames deep
 * costs about 15 us with a limit of 10 and 21 with one of 30 to 100.
 */
const HEADROOM = 50;
// taken when the bundle loads: the limits a page's errors were made under
// are kept with no method a page could have replaced
const weakMapGet = WeakMap.prototype.get;
const weakMapHas = WeakMap.prototype.has;
const weakMapSet = WeakMap.prototype.set;
// the page's Error of every realm this bundle hooked: one never wraps another
const errorProxies = new WeakSet<object>();
