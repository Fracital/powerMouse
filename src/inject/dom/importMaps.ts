// A page's import map as its document gives it to the browser
// (DocumentClient routeImportMap), a deferred part of the document bundle
// (./deferredParts.ts), made at a document's first import map: few pages
// have one, and their frames fewer.
import { rewriteImportMap } from '../../importMap';
import { IMPORT_MAP_ROUTE } from '../../sri';
import type DocumentClient from './Client';

/**
 * An import map's `integrity` (its JSON `text`, as the page wrote it) goes
 * to the worker before the browser has the map, so before any module it
 * names is asked for: the worker checks a module script whose element
 * named no integrity of its own against it (server/integrityLoads.ts).
 * The keys are URLs, resolved against the document's base as the browser
 * resolves them; the routed modules never match them in the browser.
 */
function noteIntegrity(client: DocumentClient, text: string) {
	let integrity: unknown;
	try {
		integrity = (JSON.parse(text) as { integrity?: unknown })?.integrity;
	} catch (error) {
		return;
	}
	if (typeof integrity !== 'object' || integrity === null) return;
	const entries: [string, string][] = [];
	for (const [key, value] of Object.entries(integrity)) {
		if (typeof value !== 'string') continue;
		try {
			entries.push([
				new URL(key, client.baseHref).href.replace(/#.*$/s, ''),
				value,
			]);
		} catch (error) {
			// not a URL: the browser ignores the entry
		}
	}
	if (!entries.length) return;
	try {
		client.syncBridge?.jsonAPI(
			`${client.directory}${IMPORT_MAP_ROUTE}`,
			entries,
		);
	} catch (error) {
		// a document with no bridge: the modules go unchecked
	}
}

/** the page's import map `text` with its integrity told and its targets routed */
export function routedImportMap(client: DocumentClient, text: string): string {
	noteIntegrity(client, text);
	return rewriteImportMap(text, client.baseURL, client.config);
}
