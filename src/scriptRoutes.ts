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
	'generic' | 'genericModule' | 'worker' | 'workerModule';

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
) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			resource.url.pathname + resource.url.search,
		);
		return createDataURI({
			mime,
			data: rewriter('modifyJS')(data, url, config, type),
			attributes,
		});
	}

	return routeURL(
		type === 'worker' || type === 'workerModule'
			? workerKind(type, partition)
			: `js:${type}`,
		resource,
	);
}

/** a URL-like specifier: absolute, scheme-relative, or starting with `/`, `./`, `../` */
export const BARE_SPECIFIER = /^(?!\/|\.\.?\/|[a-z][a-z0-9+.-]*:)/i;

/** `react`, `#private`, `@scope/pkg`: not a URL, resolved by an import map */
export function isBareSpecifier(specifier: string): boolean {
	return BARE_SPECIFIER.test(specifier);
}

/**
 * An import map's targets, routed as modules: bare specifiers stay bare and
 * reach the browser's map, the URL they map to is proxied. Entries ending in
 * `/` (package prefixes) and scope keys are URL prefixes the browser matches
 * against module URLs, which a routed URL does not preserve, so they are
 * left as written (a known limitation). Invalid JSON is left alone too.
 */
export function rewriteImportMap(
	json: string,
	url: StompURL,
	config: Config,
): string {
	let map: {
		imports?: Record<string, string>;
		scopes?: Record<string, Record<string, string>>;
		integrity?: Record<string, string>;
	};
	try {
		map = JSON.parse(json);
	} catch (error) {
		return json;
	}
	if (typeof map !== 'object' || map === null) return json;
	const route = (entries: Record<string, string> | undefined) => {
		if (typeof entries !== 'object' || entries === null) return;
		for (const [specifier, target] of Object.entries(entries)) {
			if (
				typeof target !== 'string' ||
				specifier.endsWith('/') ||
				target.endsWith('/') ||
				// already routed (a second pass): the JS route is `js:<type>/`
				target.includes(`${url.directory}js:`)
			)
				continue;
			try {
				entries[specifier] = routeJS(
					new StompURL(new URL(target, url.toString()), url),
					url,
					config,
					'genericModule',
				);
			} catch (error) {
				// not a URL: the browser reports it
			}
		}
	};
	route(map.imports);
	if (typeof map.scopes === 'object' && map.scopes !== null)
		for (const scope of Object.values(map.scopes)) route(scope);
	return JSON.stringify(map);
}
