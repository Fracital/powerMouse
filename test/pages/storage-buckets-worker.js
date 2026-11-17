// A worker of storage-buckets.html: it opens a bucket of its own and lists
// what its page's origin has
(async () => {
	try {
		const bucket = await navigator.storageBuckets.open('from-worker');
		postMessage([bucket.name, await navigator.storageBuckets.keys()]);
	} catch (error) {
		postMessage(`${error.name}: ${error.message}`);
	}
})();
