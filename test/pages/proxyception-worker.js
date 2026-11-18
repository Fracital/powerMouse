// A worker of the proxyception page: its URL and a fetch, or an error thrown
// at a known place (the page reads where the browser reports it)
self.onmessage = async (event) => {
	if (event.data === 'throw') {
		setTimeout(() => {
			throw new Error('thrown in the worker');
		});
		return;
	}
	const response = await fetch('/pages/echo.json');
	postMessage([location.href, response.status, response.url]);
};
