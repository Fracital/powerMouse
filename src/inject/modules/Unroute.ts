import { pageBlobURL, parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import { WORKER_ERROR } from '../../transport/messages';
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
		return parseRoutedURL(url, client.codec, prefix).url.toString();
	} catch (error) {
		return null;
	}
}

// a stack frame carries `:line:column` after the script URL
const LINE_COLUMN = /(?::\d+){1,2}$/;

/**
 * Every routed URL inside free text (an error stack) replaced by the page's
 * URL. Internal URLs (the inject bundles) are left alone; callers that can
 * drop them do so before formatting.
 */
export function unrouteText(client: Client, text: string): string {
	// a blob: URL the page made carries the proxy origin: the page's is shown
	const proxyBlob = `blob:${client.global.location.origin}/`;
	if (text.includes(proxyBlob))
		text = text.split(proxyBlob).join(`blob:${client.url.url.origin}/`);
	const prefix = routedPrefix(client);
	if (!text.includes(prefix)) return text;
	const pattern = new RegExp(
		`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s()'"<>,]*`,
		'g',
	);
	return text.replace(pattern, (match) => {
		const suffix = LINE_COLUMN.exec(match)?.[0] ?? '';
		const url = match.slice(0, match.length - suffix.length);
		const real = unrouteURL(client, url);
		if (real !== null && real !== url) return real + suffix;
		// no line and column after all (a URL that ends in `:digits`)
		const whole = unrouteURL(client, match);
		return whole !== null && whole !== match ? whole : match;
	});
}

// a url() token whose target is routed and keeps the page's token after
// `#url(`: quoted (cssText), with `&quot;` (markup), or unquoted with escaped
// parentheses (the rewriter's own text)
const ROUTED_CSS_URL =
	/url\((&quot;|["']|)([^"')\s]*?)#url(\\?)\(((?:\\.|&quot;|[^\\)])*?)\3\)\1\)/g;

/**
 * CSS text (a rule's cssText, a style element's text, serialised markup) with
 * every routed url() replaced by the url() the page wrote, which the rewriter
 * keeps after `#url(` for idempotence.
 */
export function unrouteCSS(client: Client, text: string): string {
	if (!text.includes('#url')) return text;
	const prefix = routedPrefix(client);
	return text.replace(
		ROUTED_CSS_URL,
		(match, quote: string, target: string, escape: string, inner: string) => {
			// a route, or the copy of one the inject made for a document no
			// service worker controls (the token stays after the marker)
			if (!target.startsWith(prefix) && !blobLoads.has(target)) return match;
			let token = inner.replace(/&quot;/g, '"').replace(/\\(.)/g, '$1');
			try {
				token = decodeURIComponent(token);
			} catch (error) {
				// not percent-encoded
			}
			return `url(${token})`;
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
			for (const key of REPORT_URL_KEYS)
				if (Object.hasOwn(json, key) && typeof json[key] === 'string')
					json[key] = unroute(json[key]);
		};
		const hooked = new WeakSet<object>();
		const hook = (prototype: any) => {
			if (!prototype || hooked.has(prototype)) return;
			hooked.add(prototype);
			for (const key of REPORT_URL_KEYS) {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, key, {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
						unroute(Reflect.apply(target, that, args)),
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
		const seen = (reports: unknown) => {
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
						seen(called[0]);
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
			);
		// what a page's own formatter sees: the same frame, naming page URLs
		const cleanSite = (
			site: CallSite,
			index: number,
			sites: CallSite[],
		): CallSite =>
			new Proxy(site, {
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

		let pagePrepare: unknown;
		const prepare: PrepareStackTrace = (error, sites) => {
			let shown: CallSite[];
			try {
				shown = sites.filter((site) => !isInternal(site));
			} catch (error) {
				shown = sites;
			}
			// where the page's code threw it, for the error's report
			if (
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
			if (typeof pagePrepare === 'function') {
				const result = Reflect.apply(pagePrepare, ErrorCtor, [
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

		// an accessor, so a formatter the page installs runs on cleaned frames
		// and its result is cleaned too. V8 and the page read the same
		// property, so the page sees this formatter rather than `undefined`.
		Reflect.defineProperty(ErrorCtor, 'prepareStackTrace', {
			configurable: true,
			enumerable: false,
			get: () => prepare,
			set: (value: unknown) => {
				pagePrepare = value === prepare ? undefined : value;
			},
		});
	}
}
