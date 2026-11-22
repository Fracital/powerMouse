import { registrableDomain, type PublicSuffix } from '../partition';
import {
	LEGACY_FS_CLEAR,
	type LegacyFileSystemClear,
} from '../transport/messages';
import type Cookies from './Cookies';
import { forgetAuthorizations } from './httpAuth';
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
 * site, unpartitioned or in the context's partition (`partitionKey`), and
 * what the site's HTTP authentication answered (as Chrome clears its auth
 * cache, measured in Chrome 159: of that site alone);
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
	publicSuffix: PublicSuffix,
): Promise<void> {
	const all = types.has('*');
	if (all || types.has('cookies')) {
		await cookies.clearSite(url, partitionKey).catch(() => {});
		const site = registrableDomain(url.hostname, publicSuffix);
		forgetAuthorizations((host) => host === site || host.endsWith(`.${site}`));
	}
	if (all || types.has('storage')) {
		const key = `${url.origin}${partition}`;
		if (storage) await clearStorageKey(key, storage);
		await clearLegacyFileSystem(key);
		await serviceWorkers.unregisterAll(key).catch(() => {});
	}
}

declare const clients: Clients | undefined;

/** how long the answer waits for a window to drop the legacy file system */
const LEGACY_FS_WAIT_MS = 1500;
/** the drops a window has not answered yet, by id */
const legacyDrops = new Map<string, () => void>();

/**
 * Clear-Site-Data "storage" drops the origin's legacy sandboxed file system
 * too (measured, Chrome 157). STomp keeps each storage key's in a directory
 * of the proxy origin's (src/inject/legacyFileSystem.ts), which only a
 * window or a worker can reach: every window is asked, and the answer waits
 * for the first that dropped it, at most LEGACY_FS_WAIT_MS (with no
 * injected window to ask, the directory stays)
 */
async function clearLegacyFileSystem(key: string): Promise<void> {
	if (typeof clients === 'undefined') return;
	let windows: readonly Client[];
	try {
		windows = await clients.matchAll({
			type: 'window',
			includeUncontrolled: true,
		});
	} catch (error) {
		return;
	}
	if (!windows.length) return;
	const id = crypto.randomUUID();
	const message: LegacyFileSystemClear = { key, id };
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			legacyDrops.delete(id);
			resolve();
		}, LEGACY_FS_WAIT_MS);
		legacyDrops.set(id, () => {
			clearTimeout(timer);
			legacyDrops.delete(id);
			resolve();
		});
		for (const window of windows)
			try {
				window.postMessage({ [LEGACY_FS_CLEAR]: message });
			} catch (error) {
				// a window that went away
			}
	});
}

/** a window dropped what a LEGACY_FS_CLEAR asked (its id) */
export function legacyFileSystemCleared(id: unknown) {
	if (typeof id === 'string') legacyDrops.get(id)?.();
}
