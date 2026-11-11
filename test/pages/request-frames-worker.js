// request-frames.html's workers: each fetches /echo-headers?from=<what it is
// sent> and says when the answer came (a shared worker on its port)
const serve = (target) => async (event) => {
	await fetch(`/echo-headers?from=${event.data}`);
	target.postMessage(event.data);
};
if (typeof onconnect === 'undefined') addEventListener('message', serve(self));
else
	addEventListener('connect', (event) => {
		const port = event.ports[0];
		port.addEventListener('message', serve(port));
		port.start();
	});
