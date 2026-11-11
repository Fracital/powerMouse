// A worker of test/pages/rewriter-fallback.html (dedicated, shared or a
// service worker): it answers its location as a function it makes from a
// string reads it, which is the worker's own URL only when the function
// was rewritten
const answer = () => {
	try {
		return { href: new Function('return location.href')() };
	} catch (error) {
		return { error: String(error) };
	}
};
self.onmessage = (event) => (event.ports[0] || self).postMessage(answer());
self.onconnect = (event) => event.ports[0].postMessage(answer());
