// native-shapes.html's worker: its constructors and the Cookie Store API's
// globals, as natively
importScripts('native-shapes.js');
const { constructors, prototypes } = self.__shapes;
postMessage({
	constructors: constructors(self),
	prototypes: prototypes(self, [
		'XMLHttpRequest',
		'XMLHttpRequestEventTarget',
		'XMLHttpRequestUpload',
		'EventSource',
		'WebSocket',
		'Request',
		'BroadcastChannel',
		'Function',
		'Error',
	]),
	cookieStore: [
		'cookieStore' in self,
		typeof self.CookieStore,
		typeof self.CookieChangeEvent,
	],
});
