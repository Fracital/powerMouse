import type Cookies from './Cookies';
import { serviceWorkers } from './serviceWorkers';
import { clearStorageKey, type StorageHosts } from './Storage';

/**
 * The types a Clear-Site-Data header names: its quoted strings, as Chrome
 * reads them (measured: an unquoted `cookies` clears nothing)
 */
export function siteDataTypes(header: string | null): Set<string> {
	const types = new Set<string>();
	for (const part of (header ?? '').split(',')) {
		const match = /^\s*"([^"]*)"\s*$/.exec(part);
		if (match) types.add(match[1]);
	}
	return types;
}

/**
 * What a Clear-Site-Data answer of `url` (a potentially trustworthy origin)
 * drops besides the caches (cache.ts clearsCache), for its site alone: the
 * browser would wipe every proxied site's state and STomp's own, so it never
 * gets the header (filterHeaders). "cookies": the jar's cookies of the
 * site, unpartitioned or in the context's partition (`partitionKey`);
 * "storage": what the storage key of the context (`url`'s origin and its
 * `partition`) keeps, and its emulated service workers. "*" is both.
 * "executionContexts" does nothing natively (measured, Chrome 157).
 */
export async function clearSiteData(
	types: Set<string>,
	url: URL,
	partition: string,
	partitionKey: string | undefined,
	cookies: Cookies,
	storage: StorageHosts | undefined,
): Promise<void> {
	const all = types.has('*');
	if (all || types.has('cookies'))
		await cookies.clearSite(url, partitionKey).catch(() => {});
	if (all || types.has('storage')) {
		const key = `${url.origin}${partition}`;
		if (storage) await clearStorageKey(key, storage);
		await serviceWorkers.unregisterAll(key).catch(() => {});
	}
}
