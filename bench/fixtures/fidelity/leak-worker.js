// The worker of leak-js.html: fires the worker-side leak vectors.
var base = 'http://c.bench.test:__PORT__/leak/';
var run = '__RUN__';
var fired = {};
try {
	importScripts(base + 'worker-importscripts?run=' + run + '&t=js');
	fired['worker-importscripts'] = 'fired';
} catch (e) {
	fired['worker-importscripts'] = { error: e.name };
}
try {
	fetch(base + 'worker-fetch?run=' + run + '&t=text').catch(function () {});
	fired['worker-fetch'] = 'fired';
} catch (e) {
	fired['worker-fetch'] = { error: e.name };
}
try {
	var ws = new WebSocket(
		base.replace('http:', 'ws:') + 'worker-websocket?run=' + run,
	);
	ws.onerror = function () {};
	fired['worker-websocket'] = 'fired';
} catch (e) {
	fired['worker-websocket'] = { error: e.name };
}
self.postMessage(fired);
