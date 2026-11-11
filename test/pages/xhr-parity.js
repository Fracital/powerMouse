// The XMLHttpRequest battery of the xhr-parity suite, run by xhr-parity.html
// in the page and in a dedicated worker. Every case describes what the page
// can read (status, the response under each responseType, responseText,
// responseXML and the document it gives, the readystatechange sequence, the
// errors thrown) so the suite can compare the native load with the proxied
// one value by value. `?k=<key>` keys the auth requests of one load.
(() => {
	const inWindow = typeof document !== 'undefined';
	const key = new URLSearchParams(location.search).get('k') ?? 'none';
	const P = '/pages/';
	const TYPES = ['', 'text', 'arraybuffer', 'blob', 'json', 'document'];
	const RESOURCES = [
		'xhrp-data.bin',
		'xhrp-bom.bin',
		'xhrp-bad.bin',
		'xhrp-empty.bin',
		'deep/a/b/xhrp-1252.bin',
		'deep/a/b/xhrp-nometa.bin',
		'xhrp-latin.bin',
		'xhrp-xml1252.bin',
		'xhrp-rss.bin',
		'deep/a/xhrp-svg.bin',
		'deep/a/xhrp-xhtml.bin',
		'xhrp-bytes.bin',
		'xhrp-plainxml.bin',
		'xhrp-badxml.bin',
		'xhrp-ctype.bin',
	];

	const errorName = (f) => {
		try {
			f();
			return 'none';
		} catch (error) {
			return error.name;
		}
	};
	const tag = (value) => Object.prototype.toString.call(value);
	const hex = (buffer) =>
		[...new Uint8Array(buffer)]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

	function describeDocument(d) {
		if (d === null || d === undefined) return d ?? null;
		const read = (f) => {
			try {
				return f();
			} catch (error) {
				return `threw ${error.name}`;
			}
		};
		const link = read(() => d.querySelector('a'));
		return {
			tag: tag(d),
			isDocument: d instanceof Document,
			isXMLDocument: d instanceof XMLDocument,
			contentType: read(() => d.contentType),
			characterSet: read(() => d.characterSet),
			URL: read(() => d.URL),
			documentURI: read(() => d.documentURI),
			baseURI: read(() => d.baseURI),
			root: read(() => d.documentElement?.nodeName ?? null),
			namespace: read(() => d.documentElement?.namespaceURI ?? null),
			title: read(() => d.title),
			text: read(() => d.documentElement?.textContent ?? null),
			attr: read(() => d.documentElement?.getAttribute('a') ?? null),
			href: read(() => (link && typeof link === 'object' ? link.href : null)),
			readyState: read(() => d.readyState),
			compatMode: read(() => d.compatMode),
			noView: read(() => d.defaultView === null),
			parsererror: read(() => !!d.querySelector('parsererror')),
		};
	}

	async function describeValue(value) {
		if (value === null || value === undefined) return value ?? null;
		if (typeof value === 'string') return { string: value };
		if (value instanceof ArrayBuffer)
			return { tag: tag(value), byteLength: value.byteLength, hex: hex(value) };
		if (value instanceof Blob)
			return {
				tag: tag(value),
				type: value.type,
				size: value.size,
				hex: hex(await value.arrayBuffer()),
			};
		if (inWindow && value instanceof Document)
			return { document: describeDocument(value) };
		return { tag: tag(value), json: JSON.stringify(value) };
	}

	/** what a finished request reads back */
	async function readBack(x) {
		const out = {
			readyState: x.readyState,
			status: x.status,
			statusText: x.statusText,
			responseType: x.responseType,
			responseURL: x.responseURL,
			contentType: x.getResponseHeader('content-type'),
		};
		let response;
		try {
			response = x.response;
			out.response = await describeValue(response);
			out.stable = x.response === response;
		} catch (error) {
			out.response = `threw ${error.name}`;
		}
		try {
			out.responseText = { string: x.responseText };
		} catch (error) {
			out.responseText = `threw ${error.name}`;
		}
		if (inWindow)
			try {
				const doc = x.responseXML;
				out.responseXML = describeDocument(doc);
				out.sameDocument =
					x.responseType === 'document' ? doc === response : null;
			} catch (error) {
				out.responseXML = `threw ${error.name}`;
			}
		return out;
	}

	/** one asynchronous request; `setup` runs between open() and send() */
	function asyncCase({ url, type, override, user, password, before }) {
		return new Promise((resolve) => {
			const x = new XMLHttpRequest();
			const states = [];
			const events = [];
			const note = (list, entry) => {
				if (list[list.length - 1] !== entry) list.push(entry);
			};
			x.onreadystatechange = () => {
				let kind;
				try {
					kind = x.response === null ? 'null' : typeof x.response;
				} catch (error) {
					kind = `threw ${error.name}`;
				}
				note(states, `${x.readyState}:${x.status}:${kind}`);
			};
			for (const name of [
				'loadstart',
				'progress',
				'load',
				'error',
				'abort',
				'timeout',
				'loadend',
			])
				x.addEventListener(name, () => note(events, name));
			const out = {};
			x.addEventListener('loadend', async () => {
				Object.assign(out, await readBack(x), { states, events });
				resolve(out);
			});
			try {
				before?.(x);
				if (override !== undefined) out.overrideBeforeOpen = override;
				x.open('GET', url, true, user, password);
				if (type !== undefined) x.responseType = type;
				out.typeAfterSet = x.responseType;
				if (override !== undefined) x.overrideMimeType(override);
				x.send();
			} catch (error) {
				out.thrown = error.name;
				out.readyState = x.readyState;
				resolve(out);
			}
		});
	}

	/** one synchronous request, or the error the browser refuses it with */
	async function syncCase({
		url,
		type,
		override,
		user,
		password,
		before,
		timeout,
	}) {
		const x = new XMLHttpRequest();
		const out = {};
		let states = [];
		x.onreadystatechange = () => states.push(x.readyState);
		try {
			before?.(x);
		} catch (error) {
			out.beforeThrown = error.name;
		}
		try {
			x.open('GET', url, false, user, password);
		} catch (error) {
			out.openThrown = error.name;
			out.readyState = x.readyState;
			return out;
		}
		if (type !== undefined)
			out.setType = errorName(() => (x.responseType = type));
		// whether a timeout may be set is what every case reads, so the one
		// set is far past any load: 10 ms ran out for the native worker's
		// request on a busy machine and not for the proxied one. The case
		// that does time out names its own
		out.setTimeout = errorName(() => (x.timeout = timeout ?? 60000));
		if (override !== undefined) x.overrideMimeType(override);
		try {
			x.send();
		} catch (error) {
			out.sendThrown = error.name;
			out.sendMessage = error.message;
		}
		Object.assign(out, await readBack(x), { states });
		return out;
	}

	const results = {};
	async function run(name, f, spec) {
		// the case in flight, for a report of a load that stalled
		if (inWindow) window.__xhrParity.at = name;
		try {
			results[name] = await f(spec);
		} catch (error) {
			results[name] = `harness threw ${error}`;
		}
	}

	// `query`: the credentials the fixture expects, and its flags
	const auth = (name, query = '&u=user&p=pass') =>
		`/xhr-auth/${name}/r?k=${key}${query}`;

	async function battery() {
		for (const resource of RESOURCES)
			for (const type of TYPES)
				await run(`async ${resource} [${type}]`, asyncCase, {
					url: P + resource,
					type,
				});

		// overrideMimeType: its type and charset win over the response's
		const overrides = [
			['xhrp-bytes.bin', 'text/plain; charset=x-user-defined', ['', 'blob']],
			['xhrp-plainxml.bin', 'text/xml', ['', 'document', 'blob']],
			['deep/a/b/xhrp-1252.bin', 'text/html; charset=utf-8', ['', 'document']],
			['deep/a/b/xhrp-1252.bin', 'text/plain', ['', 'document']],
			['xhrp-data.bin', 'application/xml', ['', 'json']],
			['xhrp-latin.bin', 'not a type', ['', 'blob']],
			['xhrp-ctype.bin', 'TEXT/HTML; Charset=ISO-8859-1', ['', 'blob']],
			['xhrp-rss.bin', 'application/atom+xml', ['document']],
			['xhrp-plainxml.bin', 'image/svg+xml; charset=utf-8', ['document']],
		];
		for (const [resource, override, types] of overrides)
			for (const type of types)
				await run(`override ${resource} ${override} [${type}]`, asyncCase, {
					url: P + resource,
					type,
					override,
				});

		// open() again after a request finished starts over
		await run('reopen after done', async () => {
			const x = new XMLHttpRequest();
			await new Promise((resolve) => {
				x.onloadend = resolve;
				x.open('GET', `${P}xhrp-plainxml.bin`);
				x.overrideMimeType('text/xml');
				x.send();
			});
			const states = [];
			x.onreadystatechange = () => states.push(x.readyState);
			x.open('GET', `${P}xhrp-data.bin`);
			const reopened = {
				readyState: x.readyState,
				status: x.status,
				response: await describeValue(x.response),
				responseText: x.responseText,
				responseURL: x.responseURL,
				contentType: x.getResponseHeader('content-type'),
				all: x.getAllResponseHeaders(),
				states: [...states],
			};
			if (inWindow) reopened.responseXML = describeDocument(x.responseXML);
			// and a second request on it reads its own response
			await new Promise((resolve) => {
				x.onloadend = resolve;
				x.responseType = 'json';
				x.send();
			});
			reopened.second = await readBack(x);
			return reopened;
		});

		// credentials: open()'s user and password, or the URL's, answer the
		// challenge; neither is sent before one
		const authCases = [
			['none', {}],
			['userpass', { user: 'user', password: 'pass' }],
			['url', { url: 'creds' }],
			['override', { url: 'bad', user: 'user', password: 'pass' }],
			['useronly', { user: 'user', query: '&u=user&p=' }],
			['wrong', { user: 'user', password: 'nope' }],
			[
				'nochallenge',
				{ user: 'user', password: 'pass', query: '&u=user&p=pass&nc' },
			],
		];
		for (const [name, spec] of authCases) {
			let url = auth(`${inWindow ? '' : 'w-'}${name}`, spec.query);
			if (spec.url) {
				const full = new URL(url, location.href);
				full.username = spec.url === 'creds' ? 'user' : 'bad';
				full.password = spec.url === 'creds' ? 'pass' : 'bad';
				url = full.href;
			}
			await run(`auth ${name}`, asyncCase, {
				url,
				user: spec.user,
				password: spec.password,
			});
		}
		// what the browser keeps of an answered challenge: a later request
		// under the same directory without credentials
		await run('auth after success', asyncCase, {
			url: auth(`${inWindow ? '' : 'w-'}userpass`).replace('/r?', '/r2?'),
		});

		// synchronous: a document may not set a type or a timeout; a worker may
		const syncTypes = inWindow ? ['', 'text', 'json'] : TYPES;
		for (const resource of RESOURCES)
			for (const type of syncTypes)
				await run(`sync ${resource} [${type}]`, syncCase, {
					url: P + resource,
					type,
				});
		await run('sync type before open', syncCase, {
			url: `${P}xhrp-data.bin`,
			before: (x) => (x.responseType = 'json'),
		});
		await run('sync timeout before open', syncCase, {
			url: `${P}xhrp-data.bin`,
			before: (x) => (x.timeout = 50),
		});
		await run('sync x-user-defined', syncCase, {
			url: `${P}xhrp-bytes.bin`,
			override: 'text/plain; charset=x-user-defined',
		});
		await run('sync override text/xml', syncCase, {
			url: `${P}xhrp-plainxml.bin`,
			override: 'text/xml',
		});
		await run('sync auth userpass', syncCase, {
			url: auth(`${inWindow ? '' : 'w-'}sync`),
			user: 'user',
			password: 'pass',
		});
		// a worker's timeout ends a synchronous request the site has not
		// answered: send() throws and no event fires (/slow answers after 5 s)
		if (!inWindow)
			await run('sync timeout fires', syncCase, {
				url: '/slow?sync#named',
				user: 'user',
				password: 'pass',
				timeout: 300,
			});

		// overrideMimeType once the request is done throws
		await run('override after done', async () => {
			const x = new XMLHttpRequest();
			await new Promise((resolve) => {
				x.onloadend = resolve;
				x.open('GET', `${P}xhrp-data.bin`);
				x.send();
			});
			return {
				afterDone: errorName(() => x.overrideMimeType('text/plain')),
				beforeOpen: errorName(() =>
					new XMLHttpRequest().overrideMimeType('text/plain'),
				),
			};
		});

		const log = await fetch(`/xhr-auth-log?k=${key}`);
		results['upstream authorization'] = await log.json();
		return results;
	}

	if (inWindow) {
		window.__xhrParity = {};
		battery()
			.then((page) => {
				window.__xhrParity.page = page;
				const worker = new Worker(`xhr-parity.js?k=${key}-w`);
				worker.onmessage = (event) => {
					window.__xhrParity.worker = event.data;
					window.__xhrParity.done = true;
				};
				worker.onerror = (event) => {
					window.__xhrParity.worker = `worker error ${event.message}`;
					window.__xhrParity.done = true;
				};
			})
			.catch((error) => {
				window.__xhrParity.fatal = String(error);
				window.__xhrParity.done = true;
			});
	} else {
		battery().then(
			(worker) => postMessage(worker),
			(error) => postMessage({ fatal: String(error) }),
		);
	}
})();
