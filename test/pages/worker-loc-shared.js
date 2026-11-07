self.onconnect = (event) => {
	const port = event.ports[0];
	port.onmessage = () => {
		port.postMessage({
			name: self.name,
			href: location.href,
			origin: self.origin,
		});
	};
	port.start();
};
