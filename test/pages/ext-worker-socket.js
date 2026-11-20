// a dedicated worker's request and WebSocket (extensions suite: they are in
// the tab of the page that made the worker)
fetch('/pages/ext-plain.txt?ext-tab-probe=wfetch')
	.catch(() => {})
	.then(() => {
		const socket = new WebSocket(
			new URL(
				'/open/ws-echo?ext-tab-probe=wsocket',
				location.href.replace(/^http/, 'ws'),
			).href,
		);
		socket.onopen = socket.onerror = () => {
			socket.close();
			postMessage('done');
		};
	});
