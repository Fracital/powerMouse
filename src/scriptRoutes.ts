// The parts of the JS rewriter that need no parser: the names it routes, the
// routes of scripts and modules, import maps. The inject's core uses these on
// every URL it routes; the rewriter itself (rewriteJS.ts, with meriyah and
// escodegen) is loaded only where a script is rewritten
// (src/inject/rewriter.ts), and reached from here through src/rewriters.ts.
import type { Config } from './config';
import { DEFAULT_NAMES } from './helperNames';
import { workerKind } from './partition';
import { rewriter } from './rewriters';
import { createDataURI, parseDataURI, routeBinary, routeURL } from './routeURL';
import StompURL from './StompURL';
import { dataBody } from './urlShape';

// the default helper names; the rewriter and the inject read a config's own
// (src/helperNames.ts), these are for code that has none to hand (tests)
export const ACCESS_KEY = DEFAULT_NAMES.access;
export const GLOBAL_PROXY = DEFAULT_NAMES.globalProxy;
export const GLOBAL_NAME = DEFAULT_NAMES.globalName;
export const CLIENT_KEY = DEFAULT_NAMES.client;

export const PROVIDERS = ['window', 'document'];
export const UNDEFINABLE = ['eval', 'location', 'top'];

/**
 * The function a rewritten `x.postMessage(...)` calls, read the way the
 * original call reads it: a null or undefined receiver throws the TypeError
 * the property read would have thrown (`fetch_tests_from_window(null)` after
 * a blocked `window.open`), not one from inside the access API's apply, and
 * so does a postMessage that is not callable. With `optional` (`x?.post...`)
 * a missing receiver or method answers undefined instead.
 */
export function postMessageMethod(
	target: any,
	optional = false,
): ((...args: any[]) => any) | undefined {
	if (target === null || target === undefined) {
		if (optional) return undefined;
		throw new TypeError(
			`Cannot read properties of ${target} (reading 'postMessage')`,
		);
	}
	const method = target.postMessage;
	if (optional && (method === null || method === undefined)) return undefined;
	if (typeof method !== 'function')
		throw new TypeError('postMessage is not a function');
	return method;
}

export type ScriptType =
	'generic' | 'genericModule' | 'worker' | 'workerModule' | 'workletModule';

/** whether a script of `type` is a module (a page's, a worker's or a worklet's) */
export function isModuleType(type: ScriptType): boolean {
	return (
		type === 'genericModule' ||
		type === 'workerModule' ||
		type === 'workletModule'
	);
}

/** the route kind a static import of a module script takes while a rewrite asks for one (withImportKind) */
let importKind: string | null = null;

/**
 * `rewrite` (a synchronous rewrite of a module) with every static import of
 * a module script over http(s) routed as `kind`: an emulated service
 * worker's modules go to its version's route, which keeps them with the
 * version (docs/service-workers.md)
 */
export function withImportKind<T>(kind: string, rewrite: () => T): T {
	const before = importKind;
	importKind = kind;
	try {
		return rewrite();
	} finally {
		importKind = before;
	}
}

/**
 * The route of a module an import loads, by its `with { type }`: a JSON
 * module is no script and goes as it is (its body is the module, and its
 * MIME type the browser checks); a CSS module is a stylesheet, its url()s
 * routed; anything else is a module script, rewritten
 */
export function routeImport(
	resource: StompURL,
	base: StompURL,
	config: Config,
	type: ScriptType,
	moduleType: unknown,
): string {
	if (moduleType === 'json') return routeBinary(resource);
	if (moduleType === 'css') return routeURL('css', resource);
	if (importKind !== null && /^https?:$/.test(resource.url.protocol))
		return routeURL(importKind, resource);
	return routeJS(resource, base, config, type);
}

/**
 * The route of a script of `type`. A worker's names the partition of the
 * context that starts it (src/partition.ts), which it takes on: a worker of
 * a site framed by another keeps to that partition's stores.
 */
export function routeJS(
	resource: StompURL,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
	partition = '',
	/** code a data: script runs first, after a worker's bootstrap (modifyJS's) */
	preamble = '',
	/** a dedicated worker whose creator is not cross-origin isolated natively (src/partition.ts workerKind) */
	unisolated = false,
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			dataBody(resource.url),
		);
		return createDataURI({
			mime,
			data: rewriter('modifyJS')(data, url, config, type, preamble),
			attributes,
		});
	}

	return routeURL(
		type === 'worker' || type === 'workerModule'
			? workerKind(type, partition, resource.codec, unisolated)
			: `js:${type}`,
		resource,
	);
}

/** a URL-like specifier: absolute, scheme-relative, or starting with `/`, `./`, `../` */
export const BARE_SPECIFIER = /^(?!\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i;

/** a relative URL-like specifier: starting with `/`, `./`, `../` */
export const RELATIVE_SPECIFIER = /^(?:\/|\.\.?\/)/;

/**
 * A module specifier as the URL parser reads it before deciding its shape:
 * the parser removes every tab, newline and carriage return and trims
 * leading and trailing C0 controls and spaces. A specifier written
 * `ht\rtp://host/x` or `  http://host/x` is an absolute URL to the browser,
 * which fetches it directly, so the bare-specifier test and the URL
 * resolution must see the same stripped text, or a routed import leaks the
 * origin.
 */
export function stripSpecifier(specifier: string): string {
	return specifier
		.replace(/[\t\n\r]/g, '')
		.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '');
}

/** `react`, `#private`, `@scope/pkg`: not a URL, resolved by an import map */
export function isBareSpecifier(specifier: string): boolean {
	return BARE_SPECIFIER.test(stripSpecifier(specifier));
}

/** the route kind whose path is a codec-sealed module prefix and a literal suffix */
export const MODULE_PREFIX_ROUTE = 'modmap';

/**
 * What the browser is given of a speculation rules script: no rule. The
 * browser would prefetch and prerender an absolute URL of the page's rules
 * by itself, past the worker (the user's address reaching the site), and a
 * relative one against the proxy origin; through the worker a prefetch of
 * another site would carry the jar's cookies, which Chrome never sends
 * with it, and a prerendered route is not the one a link navigates to. A
 * proxied top is a frame of the host, where Chrome acts on no rules at all:
 * every proxied document does as natively a frame does. `{}` is a rule set
 * with nothing in it, so the script has started, as the page's had.
 */
export const NO_SPECULATION = '{}';

// taken as the bundle loads, before any page script: the text it makes is
// the browser's, which a stringify of the page's could break out of
const stringify = JSON.stringify;

/**
 * Rules in markup (the page's own, or markup it writes) are given to the
 * browser as a rule set whose one key the browser does not know, holding
 * the page's text, which the inject reads back for the page from the
 * element the parser made of it (`parsedSpeculationRules`)
 */
export const markedSpeculationRules = (text: string) =>
	`{"":${stringify(text)}}`;

/** the page's text of a script the browser holds `text` for (markedSpeculationRules), or null */
export function parsedSpeculationRules(text: string): string | null {
	if (!text.startsWith('{"":"')) return null;
	try {
		const value = JSON.parse(text)[''];
		return typeof value === 'string' ? value : null;
	} catch (error) {
		return null;
	}
}

/** whether a script's `type` makes it speculation rules */
export const isSpeculationRules = (type: string | null) =>
	(type || '').trim().toLowerCase() === 'speculationrules';
