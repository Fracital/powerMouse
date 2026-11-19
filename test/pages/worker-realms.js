// A worker that tries the three ways a worker reaches the network: an
// imported script, a fetch and a WebSocket, each answered by the fixture.
// `self.BASE` is the page's base when the worker starts from a blob: URL,
// whose own URL resolves nothing. With `?nested` it starts a worker of its
// own and reports that one's answers as well. It answers a 'ping' with
// 'pong' while it runs.
self.addEventListener('message', (event) => {
	if (event.data === 'ping') postMessage('pong');
});
(() => {
	const base = self.BASE || location.href;
	const report = {};
	try {
		importScripts(new URL('worker-realms-import.js', base).href);
		report.imported = self.__workerRealmsImported === true;
	} catch (error) {
		report.imported = String(error);
	}
	const socket = () =>
		new Promise((resolve) => {
			try {
				const url = new URL('/ws-echo', base);
				url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				const ws = new WebSocket(url.href);
				ws.onmessage = (event) =>
					resolve(
						typeof event.data === 'string' && event.data.includes('"url"')
							? 'message'
							: 'other message',
					);
				ws.onerror = () => resolve('error');
				setTimeout(() => resolve('timeout'), 10000);
			} catch (error) {
				resolve(String(error));
			}
		});
	const nested = () =>
		new Promise((resolve) => {
			try {
				const inner = new Worker(new URL('worker-realms.js', base).href);
				inner.onmessage = (event) => resolve(event.data);
				inner.onerror = (event) => resolve(`error ${event.message}`);
				setTimeout(() => resolve('timeout'), 20000);
			} catch (error) {
				resolve(String(error));
			}
		});
	(async () => {
		try {
			const answer = await fetch(new URL('worker-realms-data.txt', base));
			report.fetched = (await answer.text()).trim();
		} catch (error) {
			report.fetched = String(error);
		}
		report.socket = await socket();
		if (/[?&]nested/.test(location.search) || self.NESTED)
			report.nested = await nested();
		postMessage(report);
	})();
})();
