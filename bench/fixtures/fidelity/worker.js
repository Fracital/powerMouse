// A dedicated worker of workers.html: answers 'probe' with what it sees.
importScripts('worker-import.js');
self.onmessage = async function (event) {
	var out = {};
	function g(k, f) {
		try {
			out[k] = f();
		} catch (e) {
			out[k] = { error: e.name };
		}
	}
	g('href', function () {
		return self.location.href;
	});
	g('origin', function () {
		return [
			self.origin,
			self.location.origin,
			self.location.pathname,
			self.location.search,
		];
	});
	g('imported', function () {
		return self.fidImported;
	});
	g('resolve', function () {
		return new URL('rel/x.js', self.location.href).href;
	});
	g('toString', function () {
		return String(self.location);
	});
	try {
		var res = await fetch('/fidelity/echo?w=1');
		var data = await res.json();
		out.fetch = [
			res.url,
			data.headers.host,
			data.headers.referer || null,
			data.headers.origin || null,
		];
	} catch (e) {
		out.fetch = { error: e.name };
	}
	out.event = [event.origin, event.data];
	self.postMessage(out);
};
