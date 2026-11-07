// a worker reports where it believes it runs: once on start (a module
// worker's queue may flush before its handler exists) and on request
const report = () =>
	self.postMessage({
		href: self.location.href,
		origin: self.origin,
		locationOrigin: location.origin,
		pathname: location.pathname,
		string: String(location),
		name: self.name,
		stack: new Error('w').stack,
	});
self.onmessage = report;
report();
