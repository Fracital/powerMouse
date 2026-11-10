// sop-partitions: a dedicated worker that reports what it sees of each store
importScripts('sop-part-list.js');
self
	.listStores()
	.then(postMessage, (error) =>
		postMessage({ error: `${error.name}: ${error.message}` }),
	);
