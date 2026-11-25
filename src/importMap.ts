// A page's import map as the proxy gives it to the browser
// (src/scriptRoutes.ts routes its modules). A file of its own because the
// document bundle rewrites an import map only where its page has one: there
// this file is a deferred part (src/inject/dom/deferredParts.ts, made at a
// document's first import map, DocumentClient routeImportMap), with its
// integrity note about 840 bytes no document without one carries. ./rewriteJS.ts exports it with the other
// script routes.
import type { Config } from './config';
import { MODULE_PREFIX_ROUTE, routeJS } from './scriptRoutes';
import StompURL from './StompURL';

/**
 * The route of an import map's trailing-slash prefix target (`react-dom/` maps
 * to `https://esm.sh/react-dom/`): the browser appends the rest of the
 * specifier to it and fetches the result, so the route has to carry the real
 * prefix and let a suffix follow. The prefix URL is codec-sealed as one path
 * segment (the codec never writes a `/`), then a trailing `/` the browser's
 * `react-dom/client` turns into `.../modmap/<sealed>/client`; the service
 * worker opens the segment, resolves the suffix against the real prefix and
 * sends the module on its own route (src/server/rewrites.ts). A prefix the
 * browser escapes above with `../` cannot be carried and loads as a bad
 * specifier, as it rarely is in a package subpath.
 */
export function routeModulePrefix(prefix: URL, url: StompURL): string {
	return `${url.directory}${MODULE_PREFIX_ROUTE}/${new StompURL(prefix, url).encode()}/`;
}

/**
 * An import map's targets, routed as modules: bare specifiers stay bare and
 * reach the browser's map, the URL they map to is proxied. A trailing-slash
 * prefix (a package directory) is routed so the browser's appended suffix
 * resolves through the proxy too (`routeModulePrefix`). Scope keys stay as
 * written: they are URL prefixes the browser matches against the importer's
 * module URL, which a codec route does not preserve, so a scoped override
 * falls back to the global mapping (a known limitation); their targets are
 * routed all the same. An integrity key names a resolved module URL, which is
 * now a routed one the original hash cannot match, so it is left alone and
 * stays inert (the rewritten body would never match it). Invalid JSON is left
 * alone too.
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
				// already routed (a second pass): the JS route is `js:<type>/`,
				// a prefix route `modmap/`
				target.includes(`${url.directory}js:`) ||
				target.includes(`${url.directory}${MODULE_PREFIX_ROUTE}/`)
			)
				continue;
			// a prefix maps to a prefix: both ends must be `/`, or the browser
			// ignores the entry and so do we
			const prefix = specifier.endsWith('/');
			if (prefix !== target.endsWith('/')) continue;
			try {
				const resolved = new URL(target, url.toString());
				entries[specifier] = prefix
					? routeModulePrefix(resolved, url)
					: routeJS(new StompURL(resolved, url), url, config, 'genericModule');
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
