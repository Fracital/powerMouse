// The navigation probes of a /csp/doc?s=nav page (test/csp-server.mjs):
// each tries something base-uri, form-action, frame-ancestors or a frame's
// frame-src governs and says what happened, as the page sees it. The
// script is the first of the head, so the violations of the markup's own
// <base> elements are seen; the probes run once the document is parsed.
// `window.__csp` holds the outcomes and the securitypolicyviolation events
// the document saw, once every probe the query names is done; with `post`
// the document also posts them to its parent (a probe of the parent's ran
// it in a frame: `sub:<probe>` in a frame of the same policies, `sub-other:`
// at the other origin, `sub-plain:` without them).
(() => {
	const query = new URLSearchParams(location.search);
	const names = (query.get('probes') ?? '').split(',').filter(Boolean);
	const other = location.origin.includes('127.0.0.1')
		? location.origin.replace('127.0.0.1', 'localhost')
		: location.origin.replace('localhost', '127.0.0.1');
	// (the same keys natively and proxied: a probe's key is cleared before it runs)
	const run = 'n';
	const FIELDS = [
		'blockedURI',
		'violatedDirective',
		'effectiveDirective',
		'originalPolicy',
		'disposition',
		'documentURI',
		'statusCode',
		'sample',
	];
	const events = [];
	document.addEventListener('securitypolicyviolation', (event) => {
		const shaped = {};
		for (const field of FIELDS) shaped[field] = event[field];
		shaped.target =
			event.target === document
				? 'document'
				: event.target instanceof Element
					? event.target.localName
					: String(event.target);
		events.push(shaped);
	});
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const error = (e) => `${e?.name}: ${e?.message}`;
	const policyQuery = () => {
		const kept = new URLSearchParams();
		for (const name of ['p', 'ro', 'm'])
			for (const value of query.getAll(name)) kept.append(name, value);
		return kept;
	};
	/** the paths of the fixture this run's `key` reached */
	const logged = async (key) =>
		(await (await fetch(`/csp/log?k=${run}-${key}&clear`)).json()).join(' ');
	/** the messages of `source()` (a window), until `done` says so or `ms` pass with none */
	const collect = (source, done, ms = 3000, cap = 12000) =>
		new Promise((resolve) => {
			const messages = [];
			let timer;
			const finish = () => {
				removeEventListener('message', listener);
				clearTimeout(timer);
				resolve(messages);
			};
			const quiet = () => {
				clearTimeout(timer);
				timer = setTimeout(finish, ms);
			};
			const listener = (event) => {
				if (event.source !== source()) return;
				messages.push(event.data);
				if (done(event.data)) finish();
				else quiet();
			};
			addEventListener('message', listener);
			quiet();
			setTimeout(finish, cap);
		});
	/** events as compared: what the page reads of them, in a stable order */
	const shapedEvents = (list) =>
		list.map((event) => JSON.stringify(event)).sort();

	/**
	 * What a frame at `src` showed: its loads, the messages its documents
	 * posted, whether its document is readable and how its location reads,
	 * once nothing happened for a while
	 */
	const frame = (src, attributes = {}) =>
		new Promise((resolve) => {
			const node = document.createElement('iframe');
			let loads = 0;
			const messages = [];
			let timer;
			const finish = () => {
				removeEventListener('message', listener);
				let readable;
				try {
					readable = node.contentDocument === null ? 'null' : 'readable';
				} catch (e) {
					readable = e.name;
				}
				let href;
				try {
					href = node.contentWindow.location.href;
					href = href === 'about:blank' ? href : 'readable';
				} catch (e) {
					href = e.name;
				}
				node.remove();
				resolve(
					`loads ${loads}; messages ${messages.join('|') || 'none'}; document ${readable}; location ${href}`,
				);
			};
			const quiet = () => {
				clearTimeout(timer);
				timer = setTimeout(finish, 2000);
			};
			const listener = (event) => {
				if (event.source !== node.contentWindow) return;
				messages.push(String(event.data));
				quiet();
			};
			addEventListener('message', listener);
			node.addEventListener('load', () => {
				loads++;
				quiet();
			});
			for (const [name, value] of Object.entries(attributes))
				node.setAttribute(name, value);
			node.src = src;
			document.body.append(node);
			quiet();
			setTimeout(finish, 15000);
		});

	/**
	 * A document under `params` (this one's policies by default) at
	 * `origin` running `probe` in a frame: its report, or what reached this
	 * window from the frame instead (a form's destination says it arrived)
	 */
	const sub = async (
		probe,
		origin = location.origin,
		params = policyQuery(),
	) => {
		const node = document.createElement('iframe');
		params.set('s', 'nav');
		params.set('probes', probe);
		params.set('post', '1');
		node.src = `${origin}/csp/doc?${params}`;
		const messages = collect(
			() => node.contentWindow,
			(data) => typeof data === 'object' || /^arrived/.test(data),
			6000,
			20000,
		);
		document.body.append(node);
		const got = await messages;
		node.remove();
		return got
			.map((data) =>
				typeof data === 'object'
					? `report ${data.results} events ${JSON.stringify(data.events)}`
					: String(data),
			)
			.join(' / ');
	};

	/** a form with `fields`, submitted by `how` (submit, requestSubmit, click) */
	const submit = (attributes, fields = {}, how = 'submit') => {
		const form = document.createElement('form');
		for (const [name, value] of Object.entries(attributes))
			form.setAttribute(name, value);
		for (const [name, value] of Object.entries(fields)) {
			const input = document.createElement('input');
			input.type = 'hidden';
			input.name = name;
			input.value = value;
			form.append(input);
		}
		const button = document.createElement('button');
		form.append(button);
		document.body.append(form);
		if (how === 'click') button.click();
		else if (how === 'requestSubmit') form.requestSubmit();
		else form.submit();
		return form;
	};
	/** a same-frame submission (run in a sub document): what is left after it, and the server's log */
	const submitHere = async (key, attributes, fields, how) => {
		let threw = 'none';
		try {
			submit(attributes, fields, how);
		} catch (e) {
			threw = error(e);
		}
		await wait(2500);
		return `stayed, threw ${threw}, log ${await logged(key)}`;
	};
	/** a submission into a frame of this document named for it */
	const submitToFrame = async (key, attributes, fields) => {
		const node = document.createElement('iframe');
		node.name = `t-${key}`;
		document.body.append(node);
		const messages = collect(
			() => node.contentWindow,
			() => false,
			3000,
		);
		submit({ ...attributes, target: node.name }, fields);
		const got = await messages;
		let url;
		try {
			url = node.contentDocument?.URL ?? 'null';
		} catch (e) {
			url = e.name;
		}
		node.remove();
		return `messages ${got.join('|') || 'none'}; frame ${url}; log ${await logged(key)}`;
	};
	/** a submission into a new window: whether one opened and said it arrived */
	const submitToBlank = async (key, attributes, fields) => {
		const messages = new Promise((resolve) => {
			const listener = (event) => {
				if (typeof event.data !== 'string' || !event.data.startsWith('arrived'))
					return;
				removeEventListener('message', listener);
				resolve(event.data);
			};
			addEventListener('message', listener);
			setTimeout(() => resolve('none'), 4000);
		});
		submit({ ...attributes, target: '_blank' }, fields);
		return `messages ${await messages}; log ${await logged(key)}`;
	};
	const form = (path, key) => `${path}?k=${run}-${key}`;

	/** a <base> of `href` appended to the head: the base URL, a relative link and the base's href */
	const baseRead = (base) => {
		const link = document.createElement('a');
		link.href = 'rel';
		return `baseURI ${document.baseURI}; link ${link.href}; base ${base?.href ?? 'none'}`;
	};
	const addBase = (href) => {
		const base = document.createElement('base');
		base.href = href;
		document.head.append(base);
		return base;
	};

	const PROBES = {
		// base-uri
		'base-parsed': () => baseRead(document.querySelector('base')),
		'base-other': () => {
			const base = addBase(`${other}/x/`);
			const read = baseRead(base);
			base.remove();
			return read;
		},
		'base-self': () => {
			const base = addBase('/x/');
			const read = baseRead(base);
			base.remove();
			return read;
		},
		'base-change': () => {
			const base = addBase('/y/');
			const before = baseRead(base);
			base.href = `${other}/z/`;
			const after = baseRead(base);
			base.remove();
			return `${before} / ${after}`;
		},
		'base-two': () => {
			const first = addBase(`${other}/x/`);
			const second = addBase('/y/');
			const read = baseRead(first);
			first.remove();
			second.remove();
			return read;
		},
		// form-action, same frame (run as sub:)
		'form-get-other': () =>
			submitHere(
				'get-other',
				{ action: `${other}/csp/form`, method: 'get' },
				{ q: 'v', k: `${run}-get-other` },
			),
		'form-get-other-click': () =>
			submitHere(
				'get-other-click',
				{ action: `${other}/csp/form`, method: 'get' },
				{ q: 'v', k: `${run}-get-other-click` },
				'click',
			),
		'form-get-self': () =>
			submitHere(
				'get-self',
				{ action: '/csp/form', method: 'get' },
				{ q: 'v', k: `${run}-get-self` },
				'requestSubmit',
			),
		'form-post-other': () =>
			submitHere(
				'post-other',
				{
					action: `${other}${form('/csp/form', 'post-other')}`,
					method: 'post',
				},
				{ q: 'v' },
			),
		'form-redirect-other': () =>
			submitHere(
				'redirect-other',
				{ action: '/csp/to', method: 'get' },
				{
					u: `${other}${form('/csp/form', 'redirect-other')}&q=r`,
					k: `${run}-redirect-other`,
				},
			),
		'form-post-redirect-other': () =>
			submitHere(
				'post-redirect-other',
				{
					action: `${form('/csp/to', 'post-redirect-other')}&u=${encodeURIComponent(`${other}${form('/csp/form', 'post-redirect-other')}&q=pr`)}`,
					method: 'post',
				},
				{ q: 'v' },
			),
		'form-redirect-self': () =>
			submitHere(
				'redirect-self',
				{ action: '/csp/to', method: 'get' },
				{
					u: `${form('/csp/form', 'redirect-self')}&q=rs`,
					k: `${run}-redirect-self`,
				},
			),
		'form-javascript': () =>
			submitHere(
				'javascript',
				{ action: "javascript:parent.postMessage('js-ran', '*')" },
				{},
			),
		// form-action, other targets (run in the page itself)
		'form-blank-other': () =>
			submitToBlank(
				'blank-other',
				{ action: `${other}/csp/form` },
				{ q: 'b', k: `${run}-blank-other` },
			),
		'form-blank-self': () =>
			submitToBlank(
				'blank-self',
				{ action: '/csp/form' },
				{ q: 'bs', k: `${run}-blank-self` },
			),
		'form-frame-other': () =>
			submitToFrame(
				'frame-other',
				{ action: `${other}/csp/form` },
				{ q: 'f', k: `${run}-frame-other` },
			),
		'form-frame-redirect-other': () =>
			submitToFrame(
				'frame-redirect-other',
				{ action: '/csp/to' },
				{
					u: `${other}${form('/csp/form', 'frame-redirect-other')}&q=fr`,
					k: `${run}-frame-redirect-other`,
				},
			),
		// frame-ancestors (the framed document's own policy)
		'fa-other-self': () =>
			frame(
				`${other}/csp/framed?p=${encodeURIComponent("frame-ancestors 'self'")}`,
			),
		'fa-self-self': () =>
			frame(`/csp/framed?p=${encodeURIComponent("frame-ancestors 'self'")}`),
		'fa-self-none': () =>
			frame(`/csp/framed?p=${encodeURIComponent("frame-ancestors 'none'")}`),
		'fa-other-host': () =>
			frame(
				`${other}/csp/framed?p=${encodeURIComponent(`frame-ancestors ${location.origin}`)}`,
			),
		'fa-self-other-only': () =>
			frame(`/csp/framed?p=${encodeURIComponent(`frame-ancestors ${other}`)}`),
		'fa-other-star': () =>
			frame(`${other}/csp/framed?p=${encodeURIComponent('frame-ancestors *')}`),
		'fa-self-meta-none': () =>
			frame(`/csp/framed?m=${encodeURIComponent("frame-ancestors 'none'")}`),
		'fa-self-ro-none': () =>
			frame(`/csp/framed?ro=${encodeURIComponent("frame-ancestors 'none'")}`),
		'fa-self-two': () =>
			frame(
				`/csp/framed?p=${encodeURIComponent("frame-ancestors 'self'")}&p=${encodeURIComponent("frame-ancestors 'none'")}`,
			),
		// a frame's navigations other than the src set here (the parent's frame-src)
		'frame-redirect-other': () =>
			frame(`/csp/to?u=${encodeURIComponent(`${other}/csp/framed?r=1`)}`),
		'frame-redirect-self': () =>
			frame(`/csp/to?u=${encodeURIComponent('/csp/framed?r=2')}`),
		'frame-other-redirect-self': () =>
			frame(
				`${other}/csp/to?u=${encodeURIComponent(`${location.origin}/csp/framed?r=3`)}`,
			),
		'frame-nav-other': () =>
			frame(`/csp/go?u=${encodeURIComponent(`${other}/csp/framed?n=1`)}`),
		'frame-nav-self': () =>
			frame(`/csp/go?u=${encodeURIComponent('/csp/framed?n=2')}`),
		'frame-link-other': () =>
			frame(
				`/csp/go?how=link&u=${encodeURIComponent(`${other}/csp/framed?n=3`)}`,
			),
		'frame-form-other': () =>
			frame(
				`/csp/go?how=form&u=${encodeURIComponent(`${other}/csp/framed?n=4`)}`,
			),
		'frame-nav-redirect-other': () =>
			frame(
				`/csp/go?u=${encodeURIComponent(`/csp/to?u=${encodeURIComponent(`${other}/csp/framed?n=5`)}`)}`,
			),
		'frame-other-nav-self': () =>
			frame(
				`${other}/csp/go?u=${encodeURIComponent(`${location.origin}/csp/framed?n=6`)}`,
			),
	};

	PROBES['form-during-parse'] = () => {
		const params = policyQuery();
		params.set('parse', 'submit');
		return sub('', location.origin, params);
	};

	const runProbe = async (name) => {
		// (a probe's key may be left from another case's run of it)
		await logged(name.replace(/^[\w-]+:/, '').replace(/^form-/, ''));
		const prefix = /^(sub|sub-other|sub-plain):/.exec(name)?.[1];
		if (prefix) {
			const probe = name.slice(prefix.length + 1);
			if (prefix === 'sub-other') return sub(probe, other);
			if (prefix === 'sub-plain')
				return sub(probe, location.origin, new URLSearchParams());
			return sub(probe);
		}
		return PROBES[name] ? PROBES[name]() : 'no such probe';
	};

	// a submission while the document is parsed (natively the parser stops,
	// even though the policy refuses it), reported to the parent a moment later
	if (query.get('parse') === 'submit') {
		const form = document.createElement('form');
		form.action = `${other}/csp/form`;
		document.documentElement.append(form);
		form.submit();
		const state = document.readyState;
		let loaded = false;
		document.addEventListener('DOMContentLoaded', () => (loaded = true));
		setTimeout(
			() =>
				parent.postMessage(
					{
						results: JSON.stringify({
							parse: `after submit ${state}; DOMContentLoaded ${loaded}; rest parsed ${!!document.getElementById('after')}`,
						}),
						events: shapedEvents(events),
					},
					'*',
				),
			2500,
		);
		return;
	}
	const start = async () => {
		const results = {};
		for (const name of names) {
			try {
				results[name] = await runProbe(name);
			} catch (e) {
				results[name] = `probe threw ${error(e)}`;
			}
		}
		// the violation events of the last probes are queued as tasks
		await wait(500);
		window.__csp = { done: true, case: query.get('case'), results, events };
		if (query.has('post'))
			parent.postMessage(
				{
					results: JSON.stringify(results),
					events: shapedEvents(events),
				},
				'*',
			);
	};
	if (document.readyState === 'loading')
		document.addEventListener('DOMContentLoaded', start);
	else start();
})();
