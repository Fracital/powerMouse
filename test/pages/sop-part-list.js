// sop-partitions: the names a worker sees in each store it has, imported by
// the dedicated, blob: and shared workers of test/pages/sop-part.html
self.listStores = async () => {
	const opfs = [];
	for await (const name of (await navigator.storage.getDirectory()).keys())
		opfs.push(name);
	return {
		databases: (await indexedDB.databases()).map((info) => info.name),
		caches: await caches.keys(),
		opfs,
		locks: (await navigator.locks.query()).held.map((lock) => lock.name),
		// the cookies its requests carry (absolute: a blob: worker's base
		// resolves nothing)
		sent: await (await fetch(new URL('/sop/cookies', self.origin))).json(),
	};
};
