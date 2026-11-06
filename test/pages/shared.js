self.onconnect = (event) => {
	const port = event.ports[0];
	fetch('/pages/echo.json')
		.then((r) => r.json())
		.then((j) => port.postMessage(['shared', j.ok]));
};
