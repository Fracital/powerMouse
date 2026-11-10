// The mixed-content-sw page's worker: it claims the page, notes every
// fixture request it sees (and leaves it to the network), and on a message
// fetches http itself, reporting what it saw and what its fetches did.
const seen = [];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
	event.waitUntil(self.clients.claim()),
);
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.searchParams.has('c')) seen.push(url.href);
});
self.addEventListener('message', (event) => {
	const { B, tag } = event.data;
	const q = (c) => '?c=' + tag + '.' + c;
	const get = (url) =>
		fetch(url).then(
			(response) => 'ok ' + response.status,
			(error) => 'reject ' + error.name,
		);
	event.waitUntil(
		(async () => {
			const fetchPlain = await get(
				'http://plain.mixed.test:' + B + '/data.txt' + q('sw-worker-fetch'),
			);
			const fetchSameHost = await get(
				'http://' +
					location.host +
					'/data.txt' +
					q('sw-worker-fetch-same-host'),
			);
			event.ports[0].postMessage({
				fetchPlain,
				fetchSameHost,
				seen: seen.slice(),
			});
		})(),
	);
});
