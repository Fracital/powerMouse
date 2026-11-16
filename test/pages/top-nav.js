// A frame that navigates its top or its parent by script (top-navigation
// suite). test/pages/top-nav.html on 127.0.0.1 (A) is the top; it builds the
// case's chain of frames, each hop of one origin (A, localhost as B,
// www.localhost as C), sandboxed or not, or a srcdoc or a written
// about:blank child of the hop above, and the innermost document runs the
// case's form: `top.location = u`, `top.location.href = u`, `assign`,
// `replace` (with no URL too, or one that does not parse: `bad`), the same
// on `parent`, or a read of top.location.href. With
// `user` it waits for a click on its #go button (`stale`: the click, then 6
// s, past Chrome's transient activation). What it caught goes to the fixture
// as a beacon (/echo-post, shape `result`), the top's history.length at load
// as `top`, and the document the navigation lands on (/echo-headers?html)
// reports its referrer, whether it is the top and its history.length as
// `landed`, with its request's headers kept under the case's key.
var TOP_NAV_FLAGS = {
	sb0: 'allow-scripts',
	sb1: 'allow-scripts allow-top-navigation',
	sb2: 'allow-scripts allow-top-navigation-by-user-activation',
	sb3: 'allow-scripts allow-top-navigation allow-top-navigation-by-user-activation',
	sb4: 'allow-scripts allow-same-origin',
	sb5: 'allow-scripts allow-same-origin allow-top-navigation',
	sb6: 'allow-scripts allow-same-origin allow-top-navigation-by-user-activation',
	sb7: 'allow-scripts allow-same-origin allow-top-navigation allow-top-navigation-by-user-activation',
};
var TOP_NAV_CASES = (function () {
	var cases = {};
	var B = [{ o: 'B' }];
	var add = function (name, chain, form, extra) {
		var spec = { chain: chain, form: form };
		for (var key in extra || {}) spec[key] = extra[key];
		cases[name] = spec;
	};
	// a frame of another site
	['top=', 'top.href', 'top.assign', 'top.replace'].forEach(function (form) {
		add('x ' + form, B, form);
		add('x ' + form + ' user', B, form, { user: 'click' });
	});
	add('x top.href stale', B, 'top.href', { user: 'stale' });
	add('x top.read', B, 'top.read');
	add('x top.href to-own user', B, 'top.href', { user: 'click', to: 'B' });
	add('x top.href to-own', B, 'top.href', { to: 'B' });
	add('x top.href to-own stale', B, 'top.href', { user: 'stale', to: 'B' });
	add('x top.replace to-own', B, 'top.replace', { to: 'B' });
	add('x top= to-own', B, 'top=', { to: 'B' });
	add('x top.href no-referrer user', B, 'top.href', {
		user: 'click',
		policy: 'no-referrer',
	});
	add('x top.href unsafe-url user', B, 'top.href', {
		user: 'click',
		policy: 'unsafe-url',
	});
	// a frame of the top's origin (the control)
	['top.href', 'top.assign', 'top.replace', 'top.read'].forEach(
		function (form) {
			add('s ' + form, [{ o: 'A' }], form);
			add('s ' + form + ' user', [{ o: 'A' }], form, { user: 'click' });
		},
	);
	// two levels: a grandchild of a third origin, of the top's, of its
	// parent's, a srcdoc and a written about:blank child
	var C = [{ o: 'B' }, { o: 'C' }];
	add('xc top.href', C, 'top.href');
	add('xc top.href user', C, 'top.href', { user: 'click' });
	add('xc parent.href', C, 'parent.href');
	add('xc parent= user', C, 'parent=', { user: 'click' });
	add('xa top.href', [{ o: 'B' }, { o: 'A' }], 'top.href');
	add('xa top.href user', [{ o: 'B' }, { o: 'A' }], 'top.href', {
		user: 'click',
	});
	add('xb parent.href user', [{ o: 'B' }, { o: 'B' }], 'parent.href', {
		user: 'click',
	});
	add('xa parent.href', [{ o: 'B' }, { o: 'A' }], 'parent.href');
	add('xb parent.href', [{ o: 'B' }, { o: 'B' }], 'parent.href');
	['srcdoc', 'blank'].forEach(function (kind) {
		var chain = [{ o: 'B' }, { kind: kind }];
		var short = kind === 'srcdoc' ? 'xd' : 'xw';
		add(short + ' top.href', chain, 'top.href');
		add(short + ' top.href user', chain, 'top.href', { user: 'click' });
		add(short + ' parent.href', chain, 'parent.href');
	});
	// a frame of another site, sandboxed with each set of the flags that
	// govern it
	Object.keys(TOP_NAV_FLAGS).forEach(function (flags) {
		var chain = [{ o: 'B', sandbox: TOP_NAV_FLAGS[flags] }];
		add(flags + ' top.href', chain, 'top.href');
		add(flags + ' top.href user', chain, 'top.href', { user: 'click' });
	});
	['top=', 'top.assign', 'top.replace'].forEach(function (form) {
		add('sb0 ' + form, [{ o: 'B', sandbox: TOP_NAV_FLAGS.sb0 }], form);
		add('sb5 ' + form, [{ o: 'B', sandbox: TOP_NAV_FLAGS.sb5 }], form);
	});
	// no URL, and one that does not parse: the browser's own errors
	add('s top.assign()', [{ o: 'A' }], 'top.assign()');
	add('s top.replace()', [{ o: 'A' }], 'top.replace()');
	add('s top.href bad', [{ o: 'A' }], 'top.href', { bad: true });
	add('x top.replace()', B, 'top.replace()');
	return cases;
})();

function topNavOrigin(name, port) {
	return (
		'http://' +
		{ A: '127.0.0.1', B: 'localhost', C: 'www.localhost' }[name] +
		':' +
		port
	);
}

function topNavRun(params) {
	var spec = TOP_NAV_CASES[params.c];
	// (a document the page made, srcdoc or a written about:blank, reports
	// through its parent's realm: a beacon a written about:blank document
	// starts itself does not arrive through the proxy, a divergence of its
	// own; natively that document's URL is its parent's)
	var send = !params.r
		? function (shape, value) {
				navigator.sendBeacon(
					new URL(
						'/echo-post?k=' + encodeURIComponent(params.k) + '&shape=' + shape,
						document.baseURI,
					).href,
					JSON.stringify(value),
				);
			}
		: function (shape, value) {
				parent.topNavSend(shape, JSON.parse(JSON.stringify(value)));
			};
	window.topNavSend = send;
	if (params.d === 0) send('top', { length: history.length });
	var hop = spec.chain[params.d];
	var next = { c: params.c, k: params.k, d: params.d + 1, p: params.p };
	if (hop) {
		var frame = document.createElement('iframe');
		frame.style.cssText = 'width:90vw;height:80vh;border:0';
		if (hop.sandbox !== undefined) frame.setAttribute('sandbox', hop.sandbox);
		if (hop.kind) {
			next.r = 1;
			var markup =
				'<!doctype html><body><script src="' +
				new URL('/pages/top-nav.js', document.baseURI).href +
				'"></scr' +
				'ipt><script>topNavRun(' +
				JSON.stringify(next) +
				')</scr' +
				'ipt>';
			if (hop.kind === 'srcdoc') {
				frame.srcdoc = markup;
				document.body.append(frame);
			} else {
				document.body.append(frame);
				var written = frame.contentDocument;
				written.open();
				written.write(markup);
				written.close();
			}
		} else {
			frame.src =
				topNavOrigin(hop.o, params.p) +
				'/pages/top-nav.html?' +
				new URLSearchParams({
					c: params.c,
					k: params.k,
					d: String(next.d),
					p: params.p,
				});
			document.body.append(frame);
		}
		return;
	}
	if (spec.policy) {
		var meta = document.createElement('meta');
		meta.name = 'referrer';
		meta.content = spec.policy;
		document.head.append(meta);
	}
	var target =
		topNavOrigin(spec.to || 'A', params.p) +
		'/echo-headers?html&k=' +
		encodeURIComponent(params.k);
	if (spec.bad) target = 'http://[';
	var act = function () {
		var result = {};
		var started = performance.now();
		try {
			switch (spec.form) {
				case 'top=':
					top.location = target;
					break;
				case 'top.href':
					top.location.href = target;
					break;
				case 'top.assign':
					top.location.assign(target);
					break;
				case 'top.replace':
					top.location.replace(target);
					break;
				case 'top.assign()':
					top.location.assign();
					break;
				case 'top.replace()':
					top.location.replace();
					break;
				case 'parent=':
					parent.location = target;
					break;
				case 'parent.href':
					parent.location.href = target;
					break;
				case 'top.read':
					result.value = String(top.location.href);
					break;
			}
			result.threw = null;
		} catch (error) {
			result.threw = String(error && error.name);
			result.message = String(error && error.message);
			result.domException = error instanceof DOMException;
		}
		result.active = navigator.userActivation.isActive;
		send('result', result);
		// the resource timing entries of what started since, other than the
		// beacons (which may or may not have ended), as this document and the
		// one that reports for it see them: as it goes away, or a while later
		// when it stays
		var reported = false;
		var report = function () {
			if (reported) return;
			reported = true;
			var names = [];
			var realms = params.r ? [window, parent] : [window];
			for (var i = 0; i < realms.length; i++) {
				var entries = realms[i].performance.getEntriesByType('resource').concat(
					realms[i].performance.getEntries().filter(function (entry) {
						return entry.entryType === 'resource';
					}),
				);
				for (var j = 0; j < entries.length; j++) {
					if (entries[j].startTime < started && realms[i] === window) continue;
					var name = entries[j].name;
					try {
						name = new URL(name).pathname;
					} catch (error) {
						// not a URL: as it is
					}
					if (name !== '/echo-post' && names.indexOf(name) === -1)
						names.push(name);
				}
			}
			send('entries', names.sort());
		};
		addEventListener('pagehide', report);
		setTimeout(report, 1500);
	};
	if (spec.user) {
		var button = document.createElement('button');
		button.id = 'go';
		button.textContent = 'go';
		button.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
		button.onclick = function () {
			if (spec.user === 'stale') setTimeout(act, 6000);
			else act();
		};
		document.body.append(button);
		window.__topNavReady = params.k + ':click';
	} else {
		window.__topNavReady = params.k + ':auto';
		setTimeout(act, 100);
	}
}
