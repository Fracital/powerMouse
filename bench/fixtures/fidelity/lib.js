// Shared helpers of the fidelity pages. A page defines
// window.FID = { port, run, role } (filled in by routes.mjs) before loading
// this, then calls FID.main(async () => { ...checks... }). Every observed
// value goes through FID.norm, which writes the fixture port as <port>, the
// run token as <run> and UUIDs (blob: URLs) as <uuid>, so two native loads
// give identical values. Page code avoids syntax newer than ES2017 so old
// rewriters can parse it.
(function () {
	'use strict';
	var FID = window.FID;
	var PORT = FID.port;
	var RUN = FID.run;
	var TIMEOUT = { timeout: true };
	FID.TIMEOUT = TIMEOUT;
	FID.checks = {};
	FID.notes = {};
	FID.url = function (name, path) {
		return (
			(name === 'x' ? 'http://127.0.0.1:' : 'http://' + name + '.bench.test:') +
			PORT +
			path
		);
	};
	FID.q = function (path, extra) {
		return (
			path +
			(path.indexOf('?') < 0 ? '?' : '&') +
			'run=' +
			RUN +
			(extra ? '&' + extra : '')
		);
	};
	var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
	function normString(s) {
		s = s.split(':' + PORT).join(':<port>');
		if (RUN) s = s.split(RUN).join('<run>');
		return s.replace(UUID, '<uuid>');
	}
	// (a proxy may hand back odd objects, e.g. a document where a SecurityError
	// belongs: objects are walked a few levels deep only)
	FID.norm = function norm(v, depth) {
		depth = depth || 0;
		if (typeof v === 'string') return normString(v);
		if (depth > 5 && v && typeof v === 'object') return '[object]';
		if (Array.isArray(v))
			return v.map(function (x) {
				return norm(x, depth + 1);
			});
		if (v && typeof v === 'object') {
			var out = {};
			Object.keys(v)
				.sort()
				.forEach(function (k) {
					out[k] = norm(v[k], depth + 1);
				});
			return out;
		}
		return v;
	};
	FID.err = function (e) {
		return { error: (e && e.name) || String(e) };
	};
	FID.set = function (id, value) {
		FID.checks[id] = FID.norm(value);
	};
	FID.sync = function (id, fn) {
		try {
			FID.set(id, fn());
		} catch (e) {
			FID.set(id, FID.err(e));
		}
	};
	FID.sleep = function (ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	};
	FID.within = function (promise, ms) {
		return Promise.race([
			promise,
			new Promise(function (_, reject) {
				setTimeout(function () {
					reject(TIMEOUT);
				}, ms || 4000);
			}),
		]);
	};
	// a check whose promise does not settle in time has no value (missing)
	FID.check = async function (id, fn, ms) {
		try {
			FID.set(id, await FID.within(Promise.resolve().then(fn), ms));
		} catch (e) {
			if (e === TIMEOUT) FID.notes[id] = 'timeout';
			else FID.set(id, FID.err(e));
		}
	};
	FID.message = function (pred, ms) {
		return new Promise(function (resolve, reject) {
			function on(event) {
				var d = event.data;
				var match = false;
				try {
					match = d && typeof d === 'object' && pred(d, event);
				} catch (e) {
					match = false;
				}
				if (!match) return;
				removeEventListener('message', on);
				clearTimeout(timer);
				resolve(event);
			}
			var timer = setTimeout(function () {
				removeEventListener('message', on);
				reject(TIMEOUT);
			}, ms || 5000);
			addEventListener('message', on);
		});
	};
	FID.frame = function (src, attrs) {
		var frame = document.createElement('iframe');
		attrs = attrs || {};
		Object.keys(attrs).forEach(function (k) {
			frame.setAttribute(k, attrs[k]);
		});
		if (src) frame.src = src;
		document.body.appendChild(frame);
		return frame;
	};
	// a frame.html child on host `name`; resolves with { frame, hello, event }
	FID.child = async function (name, role, attrs, ms) {
		var hello = FID.message(function (d) {
			return d.fid === 'hello' && d.role === role;
		}, ms || 8000);
		var frame = FID.frame(
			FID.url(name, FID.q('/fidelity/frame.html', 'role=' + role)),
			attrs,
		);
		var event = await hello;
		return { frame: frame, hello: event.data, event: event };
	};
	var asked = 0;
	// runs op(...args) in a frame.html child, resolves with its reply
	FID.ask = function (win, op, args, targetOrigin, ms) {
		var id = 'q' + ++asked;
		var reply = FID.message(function (d) {
			return d.fid === 'reply' && d.id === id;
		}, ms || 4000);
		win.postMessage(
			{ fid: 'cmd', id: id, op: op, args: args || [] },
			targetOrigin || '*',
		);
		return reply.then(function (event) {
			return event.data;
		});
	};
	FID.seen = function (tag) {
		return fetch(FID.q('/fidelity/seen', 'tag=' + tag)).then(function (r) {
			return r.json();
		});
	};
	// the leak pages: FID.leak(id, type) is the vector's URL on c.bench.test
	// (or `host`); FID.fire(id, fn) runs a vector and records that it ran
	FID.vectors = {};
	FID.leak = function (id, type, host) {
		return FID.url(
			host || 'c',
			'/leak/' + id + '?run=' + RUN + '&t=' + (type || 'text'),
		);
	};
	FID.fire = function (id, fn) {
		try {
			var result = fn();
			FID.vectors[id] = 'fired';
			if (result && typeof result.then === 'function')
				result.then(null, function (e) {
					// the request went out all the same
					FID.vectors[id] = 'fired, rejected: ' + ((e && e.name) || e);
				});
		} catch (e) {
			FID.vectors[id] = FID.err(e);
		}
	};
	FID.info = function () {
		var r = {};
		function g(k, f) {
			try {
				r[k] = f();
			} catch (e) {
				r[k] = FID.err(e);
			}
		}
		g('href', function () {
			return location.href;
		});
		g('origin', function () {
			return self.origin;
		});
		g('referrer', function () {
			return document.referrer;
		});
		g('ancestorOrigins', function () {
			return Array.from(location.ancestorOrigins);
		});
		g('topIsSelf', function () {
			return top === window;
		});
		g('parentIsTop', function () {
			return parent === top;
		});
		g('frameElement', function () {
			return frameElement ? frameElement.id || frameElement.tagName : null;
		});
		g('name', function () {
			return window.name;
		});
		g('cookie', function () {
			return document.cookie;
		});
		g('lsKeys', function () {
			return Object.keys(localStorage).sort();
		});
		g('historyLength', function () {
			return history.length;
		});
		g('baseURI', function () {
			return document.baseURI;
		});
		g('parentHref', function () {
			return parent.location.href;
		});
		g('domain', function () {
			return document.domain;
		});
		return FID.norm(r);
	};
	FID.finish = function () {
		document.documentElement.setAttribute(
			'data-bench-result',
			JSON.stringify({
				done: true,
				checks: FID.checks,
				notes: FID.notes,
				vectors: FID.vectors,
			}),
		);
	};
	FID.main = function (fn, ms) {
		var finished = false;
		async function go() {
			try {
				await fn();
			} catch (e) {
				FID.notes.main = String((e && e.stack) || e).slice(0, 500);
			}
			if (finished) return;
			finished = true;
			FID.finish();
		}
		setTimeout(function () {
			if (finished) return;
			finished = true;
			FID.notes.deadline = true;
			FID.finish();
		}, ms || 20000);
		if (document.readyState === 'complete') go();
		else addEventListener('load', go);
	};
})();
