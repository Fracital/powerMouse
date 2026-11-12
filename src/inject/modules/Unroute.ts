import { serializeCSSURL } from '../../cssURL';
import { originalOf } from '../../cssURLs';
import {
	linkRouteURL,
	pageBlobURL,
	parseRoutedURL,
	ROUTE_PROTOCOLS,
} from '../../routeURL';
import { WORKER_ERROR } from '../../transport/messages';
import { beforeFragment, fragmentOf } from '../../urlShape';
import { LINK_SEGMENT } from '../../visited';
import Client from '../Client';
import { blobLoads } from '../dom/blobLoads';
import type DocumentClient from '../dom/Client';
import Module from '../Module';
import { skippedFrames } from '../nativeErrors';
import ProxyModule from './Proxy';

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
	// this controller's routes, and a link's (src/visited.ts), which names
	// no controller
	const prefixes = [
		routedPrefix(client),
		`${scopePrefix(client)}${LINK_SEGMENT}/`,
	].filter((prefix) => text.includes(prefix));
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
export const reportedLocations = new WeakMap<object, ErrorLocation>();

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
/** the deprecation report's id for a synchronous request on a document's main thread */
const SYNCHRONOUS_REQUEST_REPORT =
	'XMLHttpRequestSynchronousInNonWorkerOutsideBeforeUnload';
// the members of a report and its body that hold a URL
const REPORT_URL_KEYS = [
	'url',
	'sourceFile',
	'documentURL',
	'blockedURL',
	'referrer',
];

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
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const { PerformanceEntry, Performance } = global;
		if (!PerformanceEntry || !Performance) return;

		const nameDescriptor = Reflect.getOwnPropertyDescriptor(
			PerformanceEntry.prototype,
			'name',
		)!;
		const nativeName = (entry: PerformanceEntry): string =>
			Reflect.apply(nameDescriptor.get!, entry, []);
		// null for an entry of the proxy's own machinery
		const pageName = (entry: PerformanceEntry): string | null =>
			unrouteURL(this.client, String(nativeName(entry)));

		Reflect.defineProperty(PerformanceEntry.prototype, 'name', {
			...nameDescriptor,
			get: proxyModule.wrapFunction(
				nameDescriptor.get!,
				(target, that: PerformanceEntry, args) => {
					const name = Reflect.apply(target, that, args);
					return unrouteURL(this.client, String(name)) ?? name;
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
						json.name = unrouteURL(this.client, json.name) ?? json.name;
					return json;
				},
			);
		}

		const visible = (entries: PerformanceEntry[]) =>
			entries.filter((entry) => pageName(entry) !== null);
		const filterList = <T extends Function>(fn: T) =>
			proxyModule.wrapFunction(fn, (target, that, args) =>
				visible(Reflect.apply(target, that, args)),
			);

		for (const prototype of [
			Performance.prototype,
			global.PerformanceObserverEntryList?.prototype,
		]) {
			if (!prototype) continue;
			const getEntries = prototype.getEntries;
			const getEntriesByType = prototype.getEntriesByType;
			prototype.getEntries = filterList(getEntries);
			prototype.getEntriesByType = filterList(getEntriesByType);
			prototype.getEntriesByName = proxyModule.wrapFunction(
				prototype.getEntriesByName,
				(target, that, args) => {
					// the native argument check
					if (!args.length) return Reflect.apply(target, that, args);
					// the page asks by its own URL, which no native entry carries
					const name = String(args[0]);
					const entries: PerformanceEntry[] =
						args.length > 1 && args[1] !== undefined
							? Reflect.apply(getEntriesByType, that, [args[1]])
							: Reflect.apply(getEntries, that, []);
					return entries.filter((entry) => pageName(entry) === name);
				},
			);
		}

		if (global.PerformanceObserver)
			global.PerformanceObserver.prototype.takeRecords = filterList(
				global.PerformanceObserver.prototype.takeRecords,
			);
	}
	/** the first of the page's frames in each error's stack, once formatted */
	#pageSites = new WeakMap<object, ErrorLocation>();
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
	/** note the page's call site, from inside a hook (#reportSites) */
	noteReportSite() {
		if (this.#reportSites.length >= 16) return;
		const site = this.#callerLocation?.();
		if (site) this.#reportSites.push(site);
	}
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
	 * script of another real origin fetched without CORS. Every route is
	 * same-origin for the browser, so it never mutes one itself. A module is
	 * always fetched with CORS, and a classic script with it when its element
	 * says `crossorigin`.
	 */
	#muted(routed: string | null): boolean {
		if (!routed || !this.client.isDOM) return false;
		let parsed;
		try {
			parsed = parseRoutedURL(
				routed,
				this.client.codec,
				routedPrefix(this.client),
			);
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
			real.origin === this.client.url.url.origin
		)
			return false;
		for (const script of this.client.global.document.querySelectorAll(
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
			error: native.error,
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
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;

		const domMessage = Reflect.getOwnPropertyDescriptor(
			global.DOMException?.prototype ?? {},
			'message',
		);
		if (domMessage?.get)
			Reflect.defineProperty(global.DOMException.prototype, 'message', {
				...domMessage,
				get: proxyModule.wrapFunction(domMessage.get, (target, that, args) => {
					const message = Reflect.apply(target, that, args);
					return typeof message === 'string'
						? unrouteText(this.client, message)
						: message;
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
		const reports = new WeakMap<object, ErrorReport>();
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
			Reflect.defineProperty(owner, 'onerror', {
				...onerror,
				get: proxyModule.wrapFunction(onerror.get, (target, that, args) =>
					that === global ? handler : Reflect.apply(target, that, args),
				),
				set: proxyModule.wrapFunction(onerror.set, (target, that, args) => {
					if (that !== global) return Reflect.apply(target, that, args);
					const value = args[0];
					handler =
						typeof value === 'function' ||
						(typeof value === 'object' && value !== null)
							? value
							: null;
					Reflect.apply(target, that, [handler === null ? null : call]);
				}),
			});
		}

		// the first listener of a dedicated worker, before any of the page's:
		// the message goes ahead of the browser's report on the same queue
		const post = global.postMessage;
		if (!this.client.isDOM && typeof post === 'function' && natives.filename)
			global.addEventListener('error', (event: Event) => {
				if (!this.#isInternal(read(event, 'filename'))) return;
				const location = this.pageLocation(read(event, 'error')) ?? NO_LOCATION;
				try {
					Reflect.apply(post, global, [
						{
							[WORKER_ERROR]: {
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
	 * Reports a page reads through ReportingObserver (a deprecation, an
	 * intervention, a policy violation) name the page's URLs: the report's
	 * `url` (the document's), and the URLs in its body, in their getters and
	 * in toJSON.
	 */
	applyReports() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const unroute = (value: unknown) =>
			typeof value === 'string'
				? (unrouteURL(this.client, value) ?? value)
				: value;
		const unrouteJSON = (json: Record<string, unknown>) => {
			const site = Object.hasOwn(json, 'sourceFile')
				? siteFor(json.sourceFile)
				: undefined;
			if (site) {
				json.sourceFile = site.filename;
				if (Object.hasOwn(json, 'lineNumber')) json.lineNumber = site.lineno;
				if (Object.hasOwn(json, 'columnNumber')) json.columnNumber = site.colno;
			}
			for (const key of REPORT_URL_KEYS)
				if (Object.hasOwn(json, key) && typeof json[key] === 'string')
					json[key] = unroute(json[key]);
		};
		// A report that names one of the inject's bundles as its source was
		// made inside a hook the page called (a deprecated `unload` listener
		// added through the hooked addEventListener): the browser takes the
		// hook for the caller. It shows the page's call site, which the hook
		// noted (noteReportSite; a deprecation is reported once a document,
		// so the first one noted is the one reported).
		const siteFor = (sourceFile: unknown) =>
			typeof sourceFile === 'string' &&
			unrouteURL(this.client, sourceFile) === null
				? this.#reportSites[0]
				: undefined;
		const hooked = new WeakSet<object>();
		const hook = (prototype: any) => {
			if (!prototype || hooked.has(prototype)) return;
			hooked.add(prototype);
			const nativeSource = Reflect.getOwnPropertyDescriptor(
				prototype,
				'sourceFile',
			)?.get;
			for (const key of REPORT_URL_KEYS) {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, key, {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const value = Reflect.apply(target, that, args);
							return key === 'sourceFile'
								? (siteFor(value)?.filename ?? unroute(value))
								: unroute(value);
						},
					),
				});
			}
			if (nativeSource)
				for (const [key, part] of [
					['lineNumber', 'lineno'],
					['columnNumber', 'colno'],
				] as const) {
					const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
					if (!descriptor?.get) continue;
					Reflect.defineProperty(prototype, key, {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const value = Reflect.apply(target, that, args);
								const site = siteFor(Reflect.apply(nativeSource, that, []));
								return site ? site[part] : value;
							},
						),
					});
				}
			if (Object.hasOwn(prototype, 'toJSON'))
				prototype.toJSON = proxyModule.wrapFunction(
					prototype.toJSON,
					(target, that, args) => {
						const json: Record<string, any> = Reflect.apply(target, that, args);
						if (json && typeof json === 'object') {
							unrouteJSON(json);
							if (json.body && typeof json.body === 'object')
								unrouteJSON(json.body);
						}
						return json;
					},
				);
		};
		for (const name of Reflect.ownKeys(global))
			if (typeof name === 'string' && name.endsWith('ReportBody'))
				hook(global[name]?.prototype);

		// Report and most bodies are not exposed: their prototypes are taken
		// from the first reports, before the page's callback has them
		const Observer = global.ReportingObserver;
		if (typeof Observer !== 'function') return;
		const nativeTakeRecords = Reflect.getOwnPropertyDescriptor(
			Observer.prototype,
			'takeRecords',
		)?.value;
		// A report about the inject's own code is not the page's. There is
		// one: a document with no top to take the rewriter library from (a
		// frame under a top of another build) fetches it with a synchronous
		// request (src/inject/rewriter.ts), which the browser reports as
		// deprecated, naming the inject bundle. No request of the page's
		// raises that report here: its synchronous requests go through the
		// bridge (dom/modules/Sync.ts).
		const own = (report: unknown) => {
			try {
				const { type, body } = report as {
					type?: unknown;
					body?: { id?: unknown; sourceFile?: unknown } | null;
				};
				return (
					type === 'deprecation' &&
					body?.id === SYNCHRONOUS_REQUEST_REPORT &&
					typeof body.sourceFile === 'string' &&
					unrouteURL(this.client, body.sourceFile) === null
				);
			} catch (error) {
				return false;
			}
		};
		const seen = (reports: unknown) => {
			if (Array.isArray(reports) && reports.some(own))
				reports = reports.filter((report) => !own(report));
			if (Array.isArray(reports))
				for (const report of reports) {
					if (typeof report !== 'object' || report === null) continue;
					hook(Reflect.getPrototypeOf(report));
					try {
						const body = (report as Report).body;
						if (body) hook(Reflect.getPrototypeOf(body));
					} catch (error) {
						// a report without a body
					}
				}
			return reports;
		};
		if (typeof nativeTakeRecords === 'function')
			Observer.prototype.takeRecords = proxyModule.wrapFunction(
				nativeTakeRecords,
				(target, that, args) => seen(Reflect.apply(target, that, args)),
			);
		global.ReportingObserver = proxyModule.wrapFunction(
			Observer,
			(target, that, args, newTarget) => {
				// called without new: the browser's TypeError
				if (!newTarget) return Reflect.apply(target, that, args);
				if (typeof args[0] === 'function') {
					const callback = args[0];
					args[0] = function (this: unknown, ...called: unknown[]) {
						called[0] = seen(called[0]);
						// (nothing left: there was no report of the page's)
						if (Array.isArray(called[0]) && !called[0].length) return;
						return Reflect.apply(callback, this, called);
					};
				}
				return Reflect.construct(target, args, newTarget);
			},
			true,
		);
	}
	applyErrorStacks() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const ErrorCtor = this.client.global.Error as typeof Error & {
			captureStackTrace?: Function;
			prepareStackTrace?: PrepareStackTrace;
		};
		// a realm hooked already: its Error is the page's (below)
		if (errorProxies.has(ErrorCtor)) return;
		const clean = (value: unknown) =>
			typeof value === 'string' ? unrouteText(this.client, value) : value;

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
				? (unrouteURL(this.client, name) ?? name)
				: name;
		};
		// a frame inside the inject bundle: no page URL corresponds to it
		// (or a function the inject made with a realm's Function: its code has
		// no URL, only the source URL the Client gives it, under the scope)
		const isInternal = (site: CallSite) => {
			const name = site.getFileName() ?? site.getScriptNameOrSourceURL();
			return typeof name === 'string' && unrouteURL(this.client, name) === null;
		};
		// V8 infers a name for an anonymous function from the code around it,
		// and around the page's is the rewriter's (a frame read
		// `$s$j.set2.t$t.<computed>`): no name of the page's, so the frame
		// reads as an anonymous function's
		const { names } = this.client;
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
		const prefix = scopePrefix(this.client);
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
			unrouteURL(this.client, match.replace(LINE_COLUMN, '')) === null;
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
				this.client,
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
		const cleanedSites = new WeakSet<object>();
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
				unrouteText(this.client, header(error)) +
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
		const handler: ProxyHandler<typeof ErrorCtor> = {
			has: (target, key) => {
				if (key !== KEY || pinned) return Reflect.has(target, key);
				const holder = pageHolder();
				return holder !== null && Reflect.has(holder, key);
			},
			getOwnPropertyDescriptor: (target, key) =>
				key !== KEY || pinned
					? Reflect.getOwnPropertyDescriptor(target, key)
					: Reflect.getOwnPropertyDescriptor(pageOwn, key),
			defineProperty: (target, key, descriptor) => {
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
			deleteProperty: (target, key) =>
				key !== KEY || pinned
					? Reflect.deleteProperty(target, key)
					: Reflect.deleteProperty(pageOwn, key),
			ownKeys: (target) => {
				const keys = Reflect.ownKeys(target);
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
				return Reflect.preventExtensions(target);
			},
		};
		pageError = new Proxy(ErrorCtor, handler);
		errorProxies.add(pageError);
		proxyModule.functionStrings.set(pageError, ErrorCtor.toString());
		const global = this.client.global as unknown as Record<string, unknown>;
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
// the page's Error of every realm this bundle hooked: one never wraps another
const errorProxies = new WeakSet<object>();
