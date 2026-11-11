// What a realm sees of a WebSocket, as a list a suite can compare with the
// browser's own (test/suites/adblock.mjs). Loaded by adblock-ws.html, and as
// its dedicated worker, its shared worker and its service worker, where it
// answers a list of URLs with their sequences.
self.__socketSequence = (url) =>
	new Promise((resolve) => {
		const seq = [];
		let socket;
		try {
			socket = new WebSocket(url);
		} catch (error) {
			return resolve([['threw', error.name]]);
		}
		seq.push(['constructed', socket.readyState]);
		Promise.resolve().then(() => seq.push(['microtask', socket.readyState]));
		// a task queued from the error listener: natively the close event
		// comes before it
		const channel = new MessageChannel();
		channel.port1.onmessage = () => seq.push(['task queued in error']);
		const finish = () =>
			setTimeout(() => {
				channel.port1.close();
				resolve(seq);
			}, 100);
		const give = setTimeout(() => {
			seq.push(['no close in 8 s', socket.readyState]);
			finish();
		}, 8000);
		socket.onopen = () => seq.push(['open', socket.readyState]);
		socket.onmessage = (event) => {
			let target = null;
			try {
				target = JSON.parse(event.data).url;
			} catch (error) {
				// not the echo
			}
			seq.push(['message', target]);
		};
		socket.onerror = (event) => {
			seq.push([
				'error',
				socket.readyState,
				Object.prototype.toString.call(event),
				event.bubbles,
				event.cancelable,
			]);
			channel.port2.postMessage(0);
		};
		socket.onclose = (event) => {
			clearTimeout(give);
			seq.push([
				'close',
				socket.readyState,
				event.code,
				event.reason,
				event.wasClean,
				socket.protocol,
				socket.extensions,
				socket.bufferedAmount,
			]);
			finish();
		};
	});

if (typeof WorkerGlobalScope !== 'undefined') {
	const answer = async (urls, port) =>
		port.postMessage(await Promise.all(urls.map(self.__socketSequence)));
	if (typeof SharedWorkerGlobalScope !== 'undefined')
		self.onconnect = (event) => {
			const port = event.ports[0];
			port.onmessage = (message) => answer(message.data, port);
		};
	else if (typeof ServiceWorkerGlobalScope !== 'undefined')
		self.addEventListener('message', (event) =>
			event.waitUntil(answer(event.data, event.ports[0])),
		);
	else self.onmessage = (event) => answer(event.data, self);
}
