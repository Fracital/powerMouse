// SharedWorker for adv-workers.html.
self.onconnect = (event) => {
	const port = event.ports[0];
	port.onmessage = () =>
		port.postMessage({
			href: self.location.href,
			origin: self.origin,
			name: self.name,
		});
	if (port.start) port.start();
};
