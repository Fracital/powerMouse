// request-frames-sw.html's service worker: fetches /echo-headers?from=<what
// it is sent> and tells the sender when the answer came
addEventListener('message', (event) => {
	event.waitUntil(
		fetch(`/echo-headers?from=${event.data}`).then(() =>
			event.source.postMessage(event.data),
		),
	);
});
