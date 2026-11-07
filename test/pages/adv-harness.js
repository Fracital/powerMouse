// Shared by the adv-*.html fixture pages (the adversarial-* suites). A probe
// records what it saw under window.__adv.probes and the page prints the whole
// object as JSON in <pre id="result">; the suite decides which values are
// leaks (the host window, the host document, the demo origin, a /stomp/ URL,
// or a value the page itself marked TELL:/LEAK:). Probes never throw into
// each other: an exception is recorded by name and the next probe runs.
(() => {
	const probes = {};
	const pending = new Set();
	const adv = { probes, done: false, closing: false };
	window.__adv = adv;
	const render = () => {
		const el = document.getElementById('result');
		if (el) el.textContent = JSON.stringify(adv, null, 1);
	};
	const record = (name, value, error) => {
		probes[name] = error
			? {
					error: (error && error.name) || String(error),
					message: String((error && error.message) || '').slice(0, 160),
				}
			: { value };
		render();
	};
	const finish = () => {
		adv.done = true;
		render();
	};
	window.__advRecord = record;
	// a probe whose payload already recorded a hit under its own name (eval,
	// Function, a timer) returns undefined; that must not erase the hit
	window.__advProbe = (name, fn) => {
		try {
			const value = fn();
			if (value !== undefined || !(name in probes)) record(name, value);
		} catch (error) {
			record(name, undefined, error);
		}
	};
	window.__advAsync = (name, fn, ms = 4000) => {
		pending.add(name);
		const timer = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('timeout')), ms),
		);
		Promise.race([Promise.resolve().then(fn), timer])
			.then(
				(value) => record(name, value),
				(error) => record(name, undefined, error),
			)
			.finally(() => {
				pending.delete(name);
				if (adv.closing && !pending.size) finish();
			});
	};
	// what a payload that ran through some route reports: who `top` was and
	// what `location.href` read
	window.__advHit = (name, top, href) => record(name, { top, href });
	window.__advChild = window.__advHit;
	// describe a window-like value relative to this page
	window.__advWho = (x) => {
		try {
			if (x === window) return 'self';
			if (x === null) return 'null';
			if (x === undefined) return 'undefined';
			if (typeof x !== 'object' && typeof x !== 'function') return typeof x;
			if (x.window === x) return 'OTHER-WINDOW';
			return 'object';
		} catch (error) {
			// a cross-origin window throws on anything but the allowed names
			return 'OTHER-WINDOW(' + error.name + ')';
		}
	};
	window.__advDoc = (d) => {
		if (d === document) return 'self-document';
		if (d && d.nodeType === 9) return 'OTHER-DOCUMENT(' + d.title + ')';
		return String(d);
	};
	// payload text for routes that run source: the route is contained when the
	// payload saw the spoofed top and the page's own URL
	window.__advPayload = (name) =>
		'__advHit(' +
		JSON.stringify(name) +
		', top === window ? "self" : "OTHER-WINDOW", location.href)';
	// the same for a child frame: its top should be its parent (this page)
	window.__advChildPayload = (name) =>
		'parent.__advChild(' +
		JSON.stringify(name) +
		', top === parent ? "parent" : top === window ? "self" : "OTHER-WINDOW", location.href)';
	// any frame that cannot call into us posts instead
	addEventListener('message', (event) => {
		const data = event.data;
		if (data && typeof data === 'object' && typeof data.__adv === 'string') {
			const copy = { ...data };
			delete copy.__adv;
			// a posting child frame is another window by right; only the page's
			// own probes decide whether a source is suspicious
			copy.source = event.source === window ? 'self' : 'another window';
			copy.origin = event.origin;
			record(data.__adv, copy);
		}
	});
	window.__advFinish = (ms = 1500) => {
		adv.closing = true;
		setTimeout(() => {
			if (!pending.size) finish();
			else setTimeout(finish, 6000);
		}, ms);
	};
})();
