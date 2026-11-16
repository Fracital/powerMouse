// What the worker keeps between the loads of a document for subresource
// integrity (src/sri.ts) beyond the mark a route carries: an import map's
// `integrity`, by the URL of each module it names. The inject gives a
// document's maps over the synchronous bridge as it writes them, before any
// module of theirs is asked for (IMPORT_MAP_ROUTE), and a module script's
// route without a mark of its own is checked against it, as natively a
// module script without an `integrity` attribute is. No response bytes are
// kept: a refused stylesheet asked for again is answered with bytes made to
// fail (REFUSED_FRAGMENT).
import type { RouteContext } from '../transport/messages';
import type Router from './Router';
import { json } from './Router';

/** the documents whose import maps are kept, the least recently given first out */
const MAP_CLIENTS = 256;
/** per document, its import maps' integrity by module URL */
const maps = new Map<string, Map<string, string>>();

/** the integrity a document's import maps give the module at `url` (no fragment), if any */
export function importMapIntegrity(
	clientId: string | undefined,
	url: string,
): string | null {
	if (!clientId) return null;
	return maps.get(clientId)?.get(url.replace(/#.*$/s, '')) ?? null;
}

export function registerIntegrityLoads(router: Router) {
	router.routes.set(
		/^\/sri\/importmap$/,
		async (request: Request, _url: string, context?: RouteContext) => {
			const clientId = context?.clientId;
			let entries: unknown;
			try {
				[entries] = (await request.json()) as unknown[];
			} catch (error) {
				return json(400, null);
			}
			if (!clientId || !Array.isArray(entries)) return json(200, false);
			const map = maps.get(clientId) ?? new Map<string, string>();
			maps.delete(clientId);
			maps.set(clientId, map);
			// a later map's entry for a URL an earlier one named is ignored, as
			// the browser merges them
			for (const entry of entries)
				if (
					Array.isArray(entry) &&
					typeof entry[0] === 'string' &&
					typeof entry[1] === 'string' &&
					!map.has(entry[0])
				)
					map.set(entry[0], entry[1]);
			while (maps.size > MAP_CLIENTS) maps.delete(maps.keys().next().value!);
			return json(200, true);
		},
	);
}
