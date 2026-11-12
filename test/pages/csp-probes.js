// The probes of a /csp/doc page (test/csp-server.mjs): each tries one load
// or one kind of code a Content-Security-Policy governs and says what
// happened, as the page sees it. `window.__csp` holds the outcomes and the
// securitypolicyviolation events the document saw, in order, once every
// probe the query names is done.
(() => {
	const query = new URLSearchParams(location.search);
	const names = (query.get('probes') ?? '').split(',').filter(Boolean);
	const other = location.origin.includes('127.0.0.1')
		? location.origin.replace('127.0.0.1', 'localhost')
		: location.origin.replace('localhost', '127.0.0.1');
	const events = [];
	document.addEventListener('securitypolicyviolation', (event) => {
		const target = event.target;
		events.push({
			blockedURI: event.blockedURI,
			violatedDirective: event.violatedDirective,
			effectiveDirective: event.effectiveDirective,
			originalPolicy: event.originalPolicy,
			disposition: event.disposition,
			documentURI: event.documentURI,
			referrer: event.referrer,
			sourceFile: event.sourceFile,
			statusCode: event.statusCode,
			sample: event.sample,
			target:
				target === document
					? 'document'
					: target instanceof Element
						? target.localName
						: String(target),
			bubbles: event.bubbles,
			composed: event.composed,
			isTrusted: event.isTrusted,
		});
	});
	const wait = (ms, value = 'timeout') =>
		new Promise((resolve) => setTimeout(() => resolve(value), ms));
	const settle = (promise, ms = 3000) => Promise.race([promise, wait(ms)]);
	const error = (e) => `${e?.name}: ${e?.message}`;
	const blob = (text, type = 'text/plain') =>
		URL.createObjectURL(new Blob([text], { type }));
	const PNG =
		'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
	const pngBlob = () => {
		const bytes = Uint8Array.from(atob(PNG.split(',')[1]), (c) =>
			c.charCodeAt(0),
		);
		return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
	};
	/** the first of `kinds` an element appended with `attributes` fires */
	const element = (tag, attributes, kinds, parent = document.body) =>
		settle(
			new Promise((resolve) => {
				const node = document.createElement(tag);
				for (const kind of kinds)
					node.addEventListener(kind, () => resolve(kind));
				for (const [name, value] of Object.entries(attributes))
					node.setAttribute(name, value);
				parent.append(node);
			}),
		);
	const image = (src) =>
		settle(
			new Promise((resolve) => {
				const img = new Image();
				img.onload = () => resolve(`load ${img.naturalWidth}`);
				img.onerror = () => resolve('error');
				img.src = src;
			}),
		);
	const fetched = (url, init) =>
		settle(
			fetch(url, init).then(
				async (response) => `ok ${response.status} ${await response.text()}`,
				error,
			),
		);
	const xhr = (url) =>
		settle(
			new Promise((resolve) => {
				const request = new XMLHttpRequest();
				request.open('GET', url);
				request.onload = () => resolve(`load ${request.status}`);
				request.onerror = () => resolve('error');
				try {
					request.send();
				} catch (e) {
					resolve(`threw ${error(e)}`);
				}
			}),
		);
	const socket = (url) =>
		settle(
			new Promise((resolve) => {
				let ws;
				try {
					ws = new WebSocket(url);
				} catch (e) {
					return resolve(`threw ${error(e)}`);
				}
				ws.onopen = () => {
					resolve('open');
					ws.close();
				};
				ws.onerror = () => resolve('error');
			}),
		);
	const source = (url) =>
		settle(
			new Promise((resolve) => {
				const events = new EventSource(url);
				events.onmessage = (event) => {
					resolve(`message ${event.data}`);
					events.close();
				};
				events.onerror = () => {
					resolve(`error ${events.readyState}`);
					events.close();
				};
			}),
		);
	const worker = (url, options) =>
		settle(
			new Promise((resolve) => {
				let started;
				try {
					started = new Worker(url, options);
				} catch (e) {
					return resolve(`threw ${error(e)}`);
				}
				started.onmessage = (event) => resolve(`message ${event.data}`);
				started.onerror = () => resolve('error');
			}),
		);
	/** whether a frame at `src` posts to this window, and what the element fired */
	const frame = (src, attributes = {}) =>
		settle(
			new Promise((resolve) => {
				const node = document.createElement('iframe');
				let loaded = false;
				const listener = (event) => {
					if (event.source !== node.contentWindow) return;
					removeEventListener('message', listener);
					resolve(`message ${event.data}`);
				};
				addEventListener('message', listener);
				node.addEventListener('load', () => {
					if (loaded) return;
					loaded = true;
					setTimeout(() => resolve('load, no message'), 1500);
				});
				node.addEventListener('error', () => resolve('error'));
				for (const [name, value] of Object.entries(attributes))
					node.setAttribute(name, value);
				node.src = src;
				document.body.append(node);
			}),
			6000,
		);
	const font = (url) =>
		settle(
			new FontFace('probe', `url(${url})`).load().then(
				(face) => `loaded ${face.status}`,
				(e) => `rejected ${error(e)}`,
			),
		);
	const media = (src) =>
		settle(
			new Promise((resolve) => {
				const audio = new Audio();
				audio.onloadedmetadata = () => resolve('loadedmetadata');
				audio.onerror = () => resolve(`error ${audio.error?.code}`);
				audio.src = src;
			}),
		);
	const object = (data, type) =>
		element('object', type ? { data, type } : { data }, ['load', 'error']);
	/** what a script element that sets a global does */
	const script = (attributes, text) =>
		settle(
			new Promise((resolve) => {
				window.__ran = undefined;
				const node = document.createElement('script');
				for (const [name, value] of Object.entries(attributes))
					node.setAttribute(name, value);
				node.onload = () => resolve(`load, ran ${window.__ran}`);
				node.onerror = () => resolve(`error, ran ${window.__ran}`);
				if (text !== undefined) {
					node.textContent = text;
					document.body.append(node);
					resolve(`inline, ran ${window.__ran}`);
				} else document.body.append(node);
			}),
		);
	const evaluated = (run) => {
		try {
			return `ran ${run()}`;
		} catch (e) {
			return `threw ${error(e)}`;
		}
	};
	const style = (text) => {
		const node = document.createElement('style');
		node.textContent = text;
		document.head.append(node);
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue('--csp-probe')
			.trim();
		node.remove();
		return value || 'none';
	};
	const sheet = (href) =>
		settle(
			new Promise((resolve) => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.onload = () => {
					resolve(
						`load ${getComputedStyle(document.documentElement).getPropertyValue('--csp-style').trim()}`,
					);
					link.remove();
				};
				link.onerror = () => resolve('error');
				link.href = href;
				document.head.append(link);
			}),
		);
	const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

	const PROBES = {
		// connect-src
		'fetch-data': () => fetched('data:,x'),
		'fetch-blob': () => fetched(blob('blob')),
		'fetch-self': () => fetched('/csp/ok'),
		'fetch-other': () => fetched(`${other}/csp/ok`),
		'fetch-redirect-other': () =>
			fetched(`/csp/to?u=${encodeURIComponent(`${other}/csp/ok?x=1#f`)}`),
		'fetch-redirect-self': () =>
			fetched(`/csp/to?u=${encodeURIComponent('/csp/ok?x=1#f')}`),
		'fetch-other-path': () => fetched(`${other}/csp/ok?q=1#frag`),
		'xhr-data': () => xhr('data:,x'),
		'xhr-blob': () => xhr(blob('blob')),
		'xhr-self': () => xhr('/csp/ok'),
		'xhr-other': () => xhr(`${other}/csp/ok`),
		'xhr-sync-other': () => {
			const request = new XMLHttpRequest();
			try {
				request.open('GET', `${other}/csp/ok`, false);
				request.send();
				return `sent ${request.status}`;
			} catch (e) {
				return `threw ${error(e)}`;
			}
		},
		'ws-other': () => socket(`${other.replace(/^http/, 'ws')}/ws-echo`),
		// a policy in a meta the page never inserts applies to nothing
		'ws-other-detached-meta': () => {
			const meta = document.createElement('meta');
			meta.httpEquiv = 'Content-Security-Policy';
			meta.content = "connect-src 'none'";
			return socket(`${other.replace(/^http/, 'ws')}/ws-echo`);
		},
		'es-self': () => source('/csp/sse'),
		'es-other': () => source(`${other}/csp/sse`),
		'beacon-other': () => String(navigator.sendBeacon(`${other}/csp/ok`)),
		// img-src
		'img-data': () => image(PNG),
		'img-blob': () => image(pngBlob()),
		'img-self': () => image('/csp/img.png'),
		'img-other': () => image(`${other}/csp/img.png`),
		'img-redirect-other': () =>
			image(`/csp/to?u=${encodeURIComponent(`${other}/csp/img.png?r=1`)}`),
		'img-other-redirect-self': () =>
			image(
				`${other}/csp/to?u=${encodeURIComponent(`${location.origin}/csp/img.png?r=2`)}`,
			),
		// font-src
		'font-data': () =>
			fetch('/csp/font.woff')
				.then((response) => response.arrayBuffer())
				.then((buffer) => {
					let binary = '';
					for (const byte of new Uint8Array(buffer))
						binary += String.fromCharCode(byte);
					return font(`data:font/ttf;base64,${btoa(binary)}`);
				}),
		'font-self': () => font('/csp/font.woff'),
		'font-other': () => font(`${other}/csp/font.woff`),
		// media-src
		'media-self': () => media('/csp/sound.wav'),
		'media-other': () => media(`${other}/csp/sound.wav`),
		'media-blob': () =>
			fetch('/csp/sound.wav')
				.then((response) => response.blob())
				.then((body) => media(URL.createObjectURL(body))),
		// object-src
		'object-self': () => object('/csp/img.png', 'image/png'),
		'object-other': () => object(`${other}/csp/img.png`, 'image/png'),
		'object-data': () => object('data:text/html,<p>object</p>', 'text/html'),
		'object-blob': () =>
			object(blob('<p>object</p>', 'text/html'), 'text/html'),
		// frame-src / child-src
		'frame-self': () => frame('/csp/frame.html'),
		'frame-other': () => frame(`${other}/csp/frame.html`),
		'frame-other-path': () => frame(`${other}/csp/frame.html?q=1#f`),
		'frame-redirect-other': () =>
			frame(`/csp/to?u=${encodeURIComponent(`${other}/csp/frame.html?r=1`)}`),
		'frame-data': () =>
			frame(
				'data:text/html,<script>parent.postMessage("data-frame","*")<\/script>',
			),
		'frame-blob': () =>
			frame(
				blob(
					'<script>parent.postMessage("blob-frame","*")<\/script>',
					'text/html',
				),
			),
		'frame-srcdoc': () =>
			settle(
				new Promise((resolve) => {
					const node = document.createElement('iframe');
					node.srcdoc = '<p>srcdoc</p>';
					node.onload = () =>
						resolve(
							`load ${node.contentDocument?.body?.textContent ?? 'unreadable'}`,
						);
					document.body.append(node);
				}),
			),
		// worker-src
		'worker-self': () => worker('/csp/worker.js'),
		'worker-other': () => worker(`${other}/csp/worker.js`),
		'worker-blob': () =>
			worker(blob('postMessage("blob-worker")', 'text/javascript')),
		'worker-data': () =>
			worker('data:text/javascript,postMessage("data-worker")'),
		// script-src
		'script-self': () => script({ src: '/csp/run.js' }),
		'script-other': () => script({ src: `${other}/csp/run.js` }),
		'script-data': () => script({ src: 'data:text/javascript,window.__ran=1' }),
		'script-blob': () =>
			script({ src: blob('window.__ran=1', 'text/javascript') }),
		'script-inline': () => script({}, 'window.__ran = 1'),
		'script-inline-nonce': () =>
			script({ nonce: 'probes' }, 'window.__ran = 1'),
		eval: () => evaluated(() => eval('1 + 1')),
		function: () => evaluated(() => new Function('return 2')()),
		'timeout-string': () =>
			settle(
				new Promise((resolve) => {
					window.__timeout = undefined;
					try {
						setTimeout('window.__timeout = 1');
					} catch (e) {
						return resolve(`threw ${error(e)}`);
					}
					setTimeout(() => resolve(`ran ${window.__timeout}`), 200);
				}),
			),
		'wasm-compile': () =>
			settle(
				WebAssembly.compile(WASM).then(
					() => 'compiled',
					(e) => `rejected ${error(e)}`,
				),
			),
		'wasm-module': () => evaluated(() => !!new WebAssembly.Module(WASM)),
		'handler-attribute': () => {
			window.__ran = undefined;
			const node = document.createElement('button');
			node.setAttribute('onclick', 'window.__ran = 1');
			document.body.append(node);
			node.click();
			return `ran ${window.__ran}`;
		},
		'javascript-url': () =>
			frame(
				"javascript:\"<script>parent.postMessage('js-frame','*')<\/script>\"",
			),
		// style-src
		'style-inline': () => style(':root { --csp-probe: inline }'),
		'style-attribute': () => {
			const node = document.createElement('div');
			node.setAttribute('style', '--csp-probe: attribute');
			document.body.append(node);
			const value = getComputedStyle(node).getPropertyValue('--csp-probe');
			node.remove();
			return value.trim() || 'none';
		},
		'style-cssom': () => {
			const node = document.createElement('div');
			node.style.setProperty('--csp-probe', 'cssom');
			document.body.append(node);
			const value = getComputedStyle(node).getPropertyValue('--csp-probe');
			node.remove();
			return value.trim() || 'none';
		},
		'markup-styles': () => {
			const root = getComputedStyle(document.documentElement);
			return ['nonce', 'plain']
				.map(
					(kind) =>
						`${kind} ${root.getPropertyValue(`--csp-markup-${kind}`).trim() || 'none'}`,
				)
				.join(', ');
		},
		'style-self': () => sheet('/csp/style.css'),
		'style-other': () => sheet(`${other}/csp/style.css`),
		'style-data': () => sheet('data:text/css,:root{--csp-style:data}'),
	};

	(async () => {
		const results = {};
		for (const name of names) {
			try {
				results[name] = PROBES[name] ? await PROBES[name]() : 'no such probe';
			} catch (e) {
				results[name] = `probe threw ${error(e)}`;
			}
		}
		// the violation events of the last probes are queued as tasks
		await wait(500);
		window.__csp = { done: true, case: query.get('case'), results, events };
	})();
})();
