// What a Storage Access handle (src/inject/dom/storageAccess.ts) hands out
// is the site's first-party storage, kept in the stores every proxied
// document of the proxy origin uses, never the browser's unpartitioned
// stores of the proxy origin: its indexedDB, caches and locks are the
// handle's own native objects (their identity and brand are the browser's),
// and each hook of the Partition, IndexedDB and StorageEstimate modules
// that meets one as its receiver works on the window's object in its place,
// under the first-party key. A receiver not in the map is its own, under the
// context's key.

/** an object a handle gave out: the window's object it stands for, and the key */
export const storageRedirects = new WeakMap<object, [object, string]>();

/** the object a hook works on and the key it scopes names by */
export function redirected(
	that: unknown,
	key: string,
): [receiver: any, key: string] {
	return (
		(typeof that === 'object' &&
			that !== null &&
			storageRedirects.get(that)) || [that, key]
	);
}

/**
 * `name` without the key's suffix, or the first-party one's (`origin`): a
 * name made through a handle reads back as natively
 */
export function unsuffixed(name: string, key: string, origin: string): string {
	for (const own of [key, origin])
		if (name.endsWith(`@${own}`)) return name.slice(0, -own.length - 1);
	return name;
}
