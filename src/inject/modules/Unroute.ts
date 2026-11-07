import { parseRoutedURL } from '../../routeURL';
import Client from '../Client';
import type DocumentClient from '../dom/Client';
import Module from '../Module';
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
 * The page's URL for a routed one. A string that is not under the directory
 * comes back as it is; `null` means the proxy's own machinery (an inject
 * bundle, `whoami`), which no page URL corresponds to.
 */
export function unrouteURL(client: Client, url: string): string | null {
	const prefix = routedPrefix(client);
	if (!url.startsWith(prefix)) return url;
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
			if (!target.startsWith(prefix)) return match;
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
	toString(): string;
}

type PrepareStackTrace = (error: unknown, sites: CallSite[]) => unknown;

/**
 * Strings the browser builds from request URLs come back as the page's URLs:
 * performance entries (name, toJSON, the lists from performance.*,
 * PerformanceObserver and takeRecords, which also drop the inject bundles'
 * entries) and error stacks (V8 through Error.prepareStackTrace, with a
 * page's own formatter still run on cleaned frames and inject frames
 * dropped; engines with a `stack` accessor on Error.prototype through that
 * getter).
 */
export default class UnrouteModule extends Module<Client> {
	apply() {
		this.applyPerformance();
		this.applyErrorStacks();
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

		const fileName = (site: CallSite): string | null | undefined => {
			const name = site.getFileName();
			return typeof name === 'string'
				? (unrouteURL(this.client, name) ?? name)
				: name;
		};
		// a frame inside the inject bundle: no page URL corresponds to it
		const isInternal = (site: CallSite) => {
			const name = site.getFileName();
			return typeof name === 'string' && unrouteURL(this.client, name) === null;
		};
		// what a page's own formatter sees: the same frame, naming page URLs
		const cleanSite = (site: CallSite): CallSite =>
			new Proxy(site, {
				get: (target, key) => {
					if (key === 'getFileName' || key === 'getScriptNameOrSourceURL')
						return () => fileName(target);
					if (key === 'getEvalOrigin' || key === 'toString')
						return () => clean(Reflect.apply((target as any)[key], target, []));
					const value = Reflect.get(target, key, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		// Error.prototype.toString, which V8 also uses for the first line
		const header = (error: any): string => {
			try {
				const name = error.name === undefined ? 'Error' : String(error.name);
				const message =
					error.message === undefined ? '' : String(error.message);
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
			if (typeof pagePrepare === 'function') {
				const result = Reflect.apply(pagePrepare, ErrorCtor, [
					error,
					shown.map(cleanSite),
				]);
				return clean(result);
			}
			return unrouteText(
				this.client,
				header(error) + shown.map((site) => `\n    at ${site}`).join(''),
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
