// The mixed-content page's worker: its own requests to the insecure
// server, reported to the page. A worker of an https page is a secure
// context too, so its fetch and importScripts of http are mixed content.
const params = new URLSearchParams(location.search);
const B = params.get('b');
const tag = params.get('tag');
const HB = 'http://plain.mixed.test:' + B;
const HA = 'http://' + location.host;
const q = (c) => '?c=' + tag + '.' + c;
(async () => {
	const r = {};
	r.fetch = await fetch(HB + '/data.txt' + q('worker-fetch')).then(
		(res) => 'ok ' + res.status,
		(e) => 'reject ' + e.name,
	);
	r.fetchSameHost = await fetch(
		HA + '/data.txt' + q('worker-fetch-same-host'),
	).then(
		(res) => 'ok ' + res.status,
		(e) => 'reject ' + e.name,
	);
	if (typeof importScripts === 'function')
		try {
			importScripts(HB + '/s.js' + q('worker-import'));
			r.importScripts = 'ok';
		} catch (e) {
			r.importScripts = 'threw ' + e.name;
		}
	r.websocket = await new Promise((resolve) => {
		let ws;
		try {
			ws = new WebSocket(
				'ws://plain.mixed.test:' + B + '/' + q('worker-websocket'),
			);
		} catch (e) {
			resolve('throw ' + e.name);
			return;
		}
		ws.onopen = () => {
			ws.close();
			resolve('open');
		};
		ws.onclose = (e) => resolve('close ' + e.code);
	});
	postMessage(r);
})();
