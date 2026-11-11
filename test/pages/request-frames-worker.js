// request-frames.html's worker: fetches /echo-headers?from=<what it is sent>
// and says when the answer came
addEventListener('message', async (event) => {
	await fetch(`/echo-headers?from=${event.data}`);
	postMessage(event.data);
});
