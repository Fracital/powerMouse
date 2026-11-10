// The same-origin policy battery (sop-escapes suite): the page at origin A
// (the fixture on 127.0.0.1) reaches origin B (`?b=`, the fixture on
// localhost, another site) every way the policy governs and writes what it
// could see into window.__sop.cases, one JSON value per case. The suite runs
// it natively and through the proxy in both modes and compares the two
// case by case. `?k=` keys this run's requests in the fixture's log
// (test/sop-server.mjs); `?only=<prefix>` runs the cases under one prefix.
(() => {
	const query = new URLSearchParams(location.search);
	const A = location.origin;
	const B = query.get('b');
	const K = query.get('k') || 'k';
	const only = query.get('only');
	const out = (window.__sop = { cases: {}, done: false });
	let serial = 0;
	/** a /sop/r URL on `base` with its own log key */
	const r = (base, params = {}) => {
		const key = `${K}-${++serial}`;
		const url = new URL('/sop/r', base);
		url.searchParams.set('k', key);
		for (const [name, value] of Object.entries(params))
			url.searchParams.set(name, value);
		return { url: url.href, key };
	};
	const log = async (key) =>
		(await fetch(`${A}/sop/log?k=${encodeURIComponent(key)}`)).json();
	const failed = (error) =>
		error && typeof error === 'object'
			? `${error.name}: ${error.message}`
			: String(error);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const describe = async (response) => {
		let body;
		try {
			body = await response.text();
		} catch (error) {
			body = failed(error);
		}
		return {
			type: response.type,
			status: response.status,
			ok: response.ok,
			statusText: response.statusText,
			url: response.url,
			redirected: response.redirected,
			body: response.body === null ? null : body,
			headers: [...response.headers.keys()]
				.filter((name) => !['date', 'connection', 'keep-alive'].includes(name))
				.sort(),
			secret: response.headers.get('x-secret'),
		};
	};
	const tryFetch = async (url, init) => {
		try {
			return await describe(await fetch(url, init));
		} catch (error) {
			return failed(error);
		}
	};
	/** what reached the server: method, Origin, mode and the preflight's ask */
	const reached = async (key) =>
		(await log(key)).map((entry) =>
			[
				entry.method,
				entry.origin ?? '-',
				entry.mode ?? '-',
				entry.acrm ?? '-',
				entry.acrh ?? '-',
				entry.cookie ? 'cookie' : '-',
			].join(' '),
		);

	const cases = [];
	const add = (name, run) => cases.push([name, run]);

	// --- network reads: fetch -------------------------------------------
	const fetchCase = (name, params, init) =>
		add(name, async () => {
			const { url, key } = r(B, params);
			const result = await tryFetch(url, init);
			return { result, reached: await reached(key) };
		});
	fetchCase('fetch/cors without ACAO', {});
	fetchCase('fetch/cors ACAO *', { acao: '*' });
	fetchCase('fetch/cors ACAO A', { acao: A });
	fetchCase('fetch/cors ACAO other origin', { acao: 'http://other.test' });
	fetchCase('fetch/cors ACAO null', { acao: 'null' });
	fetchCase('fetch/cors exposes a header', { acao: '*', aceh: 'x-secret' });
	fetchCase('fetch/cors exposes every header', { acao: '*', aceh: '*' });
	fetchCase(
		'fetch/credentials include, ACAO *',
		{ acao: '*' },
		{
			credentials: 'include',
		},
	);
	fetchCase(
		'fetch/credentials include, ACAO A, ACAC',
		{ acao: A, acac: '1' },
		{ credentials: 'include' },
	);
	fetchCase(
		'fetch/credentials include, ACAO A, no ACAC',
		{ acao: A },
		{
			credentials: 'include',
		},
	);
	fetchCase(
		'fetch/credentials omit, ACAO *',
		{ acao: '*' },
		{
			credentials: 'omit',
		},
	);
	fetchCase(
		'fetch/preflight PUT allowed',
		{ acao: '*', pacam: 'PUT' },
		{
			method: 'PUT',
		},
	);
	fetchCase('fetch/preflight PUT refused', { acao: '*' }, { method: 'PUT' });
	fetchCase(
		'fetch/preflight header allowed',
		{ acao: '*', pacah: 'x-custom' },
		{ headers: { 'x-custom': '1' } },
	);
	fetchCase(
		'fetch/preflight header refused',
		{ acao: '*' },
		{ headers: { 'x-custom': '1' } },
	);
	fetchCase(
		'fetch/preflight JSON content type',
		{ acao: '*', pacah: 'content-type' },
		{
			method: 'POST',
			body: '{}',
			headers: { 'content-type': 'application/json' },
		},
	);
	fetchCase(
		'fetch/simple POST needs no preflight',
		{ acao: '*' },
		{ method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } },
	);
	fetchCase(
		'fetch/preflight answered 500',
		{ acao: '*', pacam: 'PUT', pstatus: '500' },
		{ method: 'PUT' },
	);
	fetchCase(
		'fetch/preflight wildcard methods with credentials',
		{ acao: A, acac: '1', pacam: '*' },
		{ method: 'PUT', credentials: 'include' },
	);
	fetchCase(
		'fetch/preflight wildcard headers',
		{ acao: '*', pacah: '*' },
		{ headers: { 'x-custom': '1' } },
	);
	fetchCase(
		'fetch/preflight refused by its own ACAO',
		{ acao: '*', pacao: 'http://other.test', pacam: 'PUT' },
		{ method: 'PUT' },
	);
	add('fetch/preflight is cached for its max-age', async () => {
		const { url, key } = r(B, { acao: '*', pacam: 'PUT', pmaxage: '60' });
		const first = await tryFetch(url, { method: 'PUT' });
		const second = await tryFetch(url, { method: 'PUT' });
		return {
			first: first.status,
			second: second.status,
			reached: await reached(key),
		};
	});
	fetchCase('fetch/no-cors', {}, { mode: 'no-cors' });
	fetchCase('fetch/no-cors with ACAO', { acao: '*' }, { mode: 'no-cors' });
	fetchCase(
		'fetch/same-origin mode to another origin',
		{ acao: '*' },
		{
			mode: 'same-origin',
		},
	);
	add('fetch/same-origin request is basic', async () => {
		const { url } = r(A, {});
		const result = await tryFetch(url);
		return { type: result.type, body: result.body, secret: result.secret };
	});
	add('fetch/same-origin no-cors is basic', async () => {
		const { url } = r(A, {});
		const result = await tryFetch(url, { mode: 'no-cors' });
		return { type: result.type, status: result.status, body: result.body };
	});
	add('fetch/redirect to another origin without ACAO', async () => {
		const target = r(B, {});
		const { url } = r(A, { redirect: target.url });
		return {
			result: await tryFetch(url),
			reached: await reached(target.key),
		};
	});
	add('fetch/redirect to another origin with ACAO', async () => {
		const target = r(B, { acao: '*' });
		const { url } = r(A, { redirect: target.url });
		const result = await tryFetch(url);
		return {
			type: result.type,
			redirected: result.redirected,
			body: result.body,
			reached: await reached(target.key),
		};
	});
	add('fetch/no-cors redirect to another origin', async () => {
		const target = r(B, {});
		const { url } = r(A, { redirect: target.url });
		const result = await tryFetch(url, { mode: 'no-cors' });
		return { type: result.type, status: result.status, body: result.body };
	});
	add('fetch/redirect manual', async () => {
		const target = r(A, {});
		const { url } = r(A, { redirect: target.url });
		const result = await tryFetch(url, { redirect: 'manual' });
		return {
			type: result.type,
			status: result.status,
			headers: result.headers,
		};
	});
	add('fetch/a cross-origin redirect without ACAO on the hop', async () => {
		const target = r(B, { acao: '*' });
		const { url } = r(B, { redirect: target.url });
		return {
			result: await tryFetch(url),
			reached: await reached(target.key),
		};
	});

	// the proxy's own copies of a page's loads carry a marker header the
	// worker exempts from CORS: a page that sends it gains nothing
	add('fetch/a header that names a load', async () => {
		const marker = { 'x-stomp-load': 'image no-cors' };
		const request = new Request(r(B, {}).url);
		request.headers.set('x-stomp-load', 'image no-cors');
		const result = (value) =>
			typeof value === 'string' ? value : `${value.type} ${value.body}`;
		return [
			result(await tryFetch(r(B, {}).url, { headers: marker })),
			result(await tryFetch(request)),
			result(
				await tryFetch(r(B, {}).url, {
					headers: new Headers(marker),
					mode: 'no-cors',
				}),
			),
		];
	});

	// --- network reads: XMLHttpRequest -----------------------------------
	const xhr = (url, setup = () => {}) =>
		new Promise((resolve) => {
			const request = new XMLHttpRequest();
			request.open('GET', url);
			setup(request);
			const finish = (event) =>
				resolve({
					event,
					status: request.status,
					text: request.responseText,
					headers: request
						.getAllResponseHeaders()
						.split('\r\n')
						.map((line) => line.split(':')[0])
						.filter(
							(name) =>
								name && !['date', 'connection', 'keep-alive'].includes(name),
						)
						.sort(),
					secret: request.getResponseHeader('x-secret'),
				});
			request.onload = () => finish('load');
			request.onerror = () => finish('error');
			request.send();
		});
	add('xhr/without ACAO', async () => {
		const { url, key } = r(B, {});
		return { result: await xhr(url), reached: await reached(key) };
	});
	add('xhr/ACAO *', async () => xhr(r(B, { acao: '*' }).url));
	add('xhr/withCredentials, ACAO *', async () =>
		xhr(r(B, { acao: '*' }).url, (request) => {
			request.withCredentials = true;
		}),
	);
	add('xhr/preflight refused', async () => {
		const { url, key } = r(B, { acao: '*' });
		return {
			result: await xhr(url, (request) =>
				request.setRequestHeader('x-custom', '1'),
			),
			reached: await reached(key),
		};
	});
	add('xhr/synchronous without ACAO', async () => {
		const request = new XMLHttpRequest();
		request.open('GET', r(B, {}).url, false);
		try {
			request.send();
			return { status: request.status, text: request.responseText };
		} catch (error) {
			return failed(error);
		}
	});
	add('xhr/synchronous ACAO *', async () => {
		const request = new XMLHttpRequest();
		request.open('GET', r(B, { acao: '*' }).url, false);
		try {
			request.send();
			return { status: request.status, text: request.responseText };
		} catch (error) {
			return failed(error);
		}
	});

	// --- resources: images, canvas, WebGL --------------------------------
	const image = (src, crossOrigin) =>
		new Promise((resolve) => {
			const element = new Image();
			if (crossOrigin !== undefined) element.crossOrigin = crossOrigin;
			element.onload = () => resolve(element);
			element.onerror = () => resolve(null);
			element.src = src;
		});
	const readback = (canvas) => {
		const result = {};
		try {
			canvas.toDataURL();
			result.toDataURL = 'ok';
		} catch (error) {
			result.toDataURL = failed(error);
		}
		try {
			canvas.toBlob(() => {});
			result.toBlob = 'ok';
		} catch (error) {
			result.toBlob = failed(error);
		}
		try {
			canvas.getContext('2d').getImageData(0, 0, 1, 1);
			result.getImageData = 'ok';
		} catch (error) {
			result.getImageData = failed(error);
		}
		return result;
	};
	const canvas = () => {
		const element = document.createElement('canvas');
		element.width = element.height = 4;
		return element;
	};
	const drawn = async (src, crossOrigin) => {
		const element = await image(src, crossOrigin);
		if (!element) return 'image failed';
		const target = canvas();
		target.getContext('2d').drawImage(element, 0, 0);
		return readback(target);
	};
	add('canvas/same-origin image', () => drawn(r(A, { type: 'png' }).url));
	add('canvas/cross-origin image', () => drawn(r(B, { type: 'png' }).url));
	add('canvas/cross-origin image with ACAO, no crossorigin', () =>
		drawn(r(B, { type: 'png', acao: '*' }).url),
	);
	add('canvas/crossorigin image with ACAO', () =>
		drawn(r(B, { type: 'png', acao: '*' }).url, 'anonymous'),
	);
	add('canvas/crossorigin image without ACAO', () =>
		drawn(r(B, { type: 'png' }).url, 'anonymous'),
	);
	add('canvas/crossorigin use-credentials with ACAO *', () =>
		drawn(r(B, { type: 'png', acao: '*' }).url, 'use-credentials'),
	);
	add('canvas/cross-origin image drawn scaled', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const target = canvas();
		target.getContext('2d').drawImage(element, 0, 0, 1, 1, 0, 0, 2, 2);
		return readback(target);
	});
	add('canvas/a tainted canvas drawn into another', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const first = canvas();
		first.getContext('2d').drawImage(element, 0, 0);
		const second = canvas();
		second.getContext('2d').drawImage(first, 0, 0);
		return readback(second);
	});
	add('canvas/pattern of a cross-origin image', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const target = canvas();
		const context = target.getContext('2d');
		context.fillStyle = context.createPattern(element, 'repeat');
		context.fillRect(0, 0, 4, 4);
		return readback(target);
	});
	add('canvas/ImageBitmap of a cross-origin image', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const bitmap = await createImageBitmap(element);
		const other = canvas();
		other.getContext('2d').drawImage(bitmap, 0, 0);
		return readback(other);
	});
	add('canvas/OffscreenCanvas with a cross-origin image', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const offscreen = new OffscreenCanvas(4, 4);
		const context = offscreen.getContext('2d');
		context.drawImage(element, 0, 0);
		const result = {};
		try {
			context.getImageData(0, 0, 1, 1);
			result.getImageData = 'ok';
		} catch (error) {
			result.getImageData = failed(error);
		}
		try {
			await offscreen.convertToBlob();
			result.convertToBlob = 'ok';
		} catch (error) {
			result.convertToBlob = failed(error);
		}
		return result;
	});
	add('canvas/WebGL texture of a cross-origin image', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const gl = canvas().getContext('webgl');
		if (!gl) return 'no webgl';
		gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
		try {
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				element,
			);
			return 'ok';
		} catch (error) {
			return failed(error);
		}
	});
	add('canvas/SVG image of another site', async () => {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const element = document.createElementNS(
			'http://www.w3.org/2000/svg',
			'image',
		);
		document.body.append(svg);
		svg.append(element);
		await new Promise((resolve) => {
			element.onload = element.onerror = resolve;
			element.setAttribute('href', r(B, { type: 'png' }).url);
		});
		const target = canvas();
		target.getContext('2d').drawImage(element, 0, 0);
		svg.remove();
		return readback(target);
	});
	add(
		'canvas/an image of another site in a written about:blank frame',
		async () => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const written = frame.contentDocument;
			written.open();
			written.write('<img>');
			written.close();
			const element = written.querySelector('img');
			await new Promise((resolve) => {
				element.onload = element.onerror = resolve;
				element.src = r(B, { type: 'png' }).url;
			});
			const target = canvas();
			target.getContext('2d').drawImage(element, 0, 0);
			frame.remove();
			return readback(target);
		},
	);
	add('canvas/a data: image and a blob: image do not taint', async () => {
		const png = await (await fetch(r(A, { type: 'png' }).url)).blob();
		const blobImage = await image(URL.createObjectURL(png));
		const dataImage = await image(
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
		);
		const target = canvas();
		target.getContext('2d').drawImage(blobImage, 0, 0);
		target.getContext('2d').drawImage(dataImage, 0, 0);
		return readback(target);
	});
	// the cost of a draw (SOP_ONLY=bench/ only: its numbers differ by machine)
	add('bench/drawImage', async () => {
		const same = await image(r(A, { type: 'png' }).url);
		const target = canvas().getContext('2d');
		const time = (n) => {
			const start = performance.now();
			for (let i = 0; i < n; i++) target.drawImage(same, 0, 0);
			return performance.now() - start;
		};
		time(10000);
		return { ms: time(200000), draws: 200000 };
	});
	add('canvas/WebGL texture of a same-origin image', async () => {
		const element = await image(r(A, { type: 'png' }).url);
		const gl = canvas().getContext('webgl');
		if (!gl) return 'no webgl';
		gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
		try {
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				element,
			);
			return 'ok';
		} catch (error) {
			return failed(error);
		}
	});

	// --- resources: CORP, scripts, fonts, timing -------------------------
	add('corp/same-origin image of another site', async () =>
		(await image(r(B, { type: 'png', corp: 'same-origin' }).url))
			? 'loaded'
			: 'error',
	);
	add('corp/same-site image of another site', async () =>
		(await image(r(B, { type: 'png', corp: 'same-site' }).url))
			? 'loaded'
			: 'error',
	);
	add('corp/cross-origin image of another site', async () =>
		(await image(r(B, { type: 'png', corp: 'cross-origin' }).url))
			? 'loaded'
			: 'error',
	);
	add('corp/same-origin image of its own origin', async () =>
		(await image(r(A, { type: 'png', corp: 'same-origin' }).url))
			? 'loaded'
			: 'error',
	);
	add('corp/no-cors fetch of a same-origin resource of another site', () =>
		tryFetch(r(B, { corp: 'same-origin' }).url, { mode: 'no-cors' }),
	);
	add('corp/a CORS request ignores CORP', async () => {
		const result = await tryFetch(r(B, { corp: 'same-origin', acao: '*' }).url);
		return typeof result === 'string' ? result : result.body;
	});
	const script = (src, crossOrigin) =>
		new Promise((resolve) => {
			const reports = [];
			const onError = (event) =>
				reports.push({
					message: event.message,
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
					error: event.error === null ? null : typeof event.error,
				});
			window.addEventListener('error', onError);
			const element = document.createElement('script');
			if (crossOrigin !== undefined) element.crossOrigin = crossOrigin;
			element.src = src;
			const settle = (how) =>
				setTimeout(() => {
					window.removeEventListener('error', onError);
					resolve({ how, reports });
				}, 50);
			element.onload = () => settle('load');
			element.onerror = () => settle('error');
			document.head.append(element);
		});
	const thrower = 'throw new Error("secret detail")';
	add('script/cross-origin classic script error is muted', () =>
		script(r(B, { type: 'js', js: thrower }).url),
	);
	add('script/crossorigin script with ACAO is not muted', async () => {
		const result = await script(
			r(B, { type: 'js', js: thrower, acao: '*' }).url,
			'anonymous',
		);
		return result.reports.map((report) => report.message);
	});
	add('script/crossorigin script without ACAO fails', () =>
		script(r(B, { type: 'js', js: 'window.__sopRan = 1' }).url, 'anonymous'),
	);
	add(
		'script/module script of another site without ACAO fails',
		() =>
			new Promise((resolve) => {
				const element = document.createElement('script');
				element.type = 'module';
				element.src = r(B, { type: 'mjs', js: 'window.__sopModule = 1' }).url;
				element.onload = () => resolve(['load', window.__sopModule ?? null]);
				element.onerror = () => resolve(['error', window.__sopModule ?? null]);
				document.head.append(element);
			}),
	);
	const font = async (params) => {
		const face = new FontFace(`sop${++serial}`, `url(${r(B, params).url})`);
		try {
			await face.load();
			return face.status;
		} catch (error) {
			return failed(error);
		}
	};
	add('font/another site without ACAO', () => font({ type: 'font' }));
	add('font/another site with ACAO', () => font({ type: 'font', acao: '*' }));
	const timing = async (params) => {
		const { url } = r(B, { type: 'png', ...params });
		await image(url);
		await sleep(100);
		const entry = performance.getEntriesByName(url)[0];
		if (!entry) return 'no entry';
		return {
			transferSize: entry.transferSize > 0,
			encodedBodySize: entry.encodedBodySize > 0,
			decodedBodySize: entry.decodedBodySize > 0,
			requestStart: entry.requestStart > 0,
			responseStart: entry.responseStart > 0,
			domainLookupStart: entry.domainLookupStart > 0,
			responseStatus: entry.responseStatus,
			serverTiming: entry.serverTiming.length,
		};
	};
	add('timing/another site without Timing-Allow-Origin', () => timing({}));
	add('timing/another site with Timing-Allow-Origin *', () =>
		timing({ tao: '*' }),
	);
	add('timing/another site with ACAO, without TAO', () =>
		timing({ acao: '*' }),
	);
	add('isolation/crossOriginIsolated', () => self.crossOriginIsolated);

	// --- document-level policy -------------------------------------------
	add('document/origins', () => ({
		window: window.origin,
		self: self.origin,
		location: location.origin,
		domain: document.domain,
		secure: isSecureContext,
	}));
	add('document/domain setter', () => {
		const result = {};
		for (const value of [location.hostname, 'localhost', '0.0.1', '']) {
			try {
				document.domain = value;
				result[value || '(empty)'] = `ok ${document.domain}`;
			} catch (error) {
				result[value || '(empty)'] = failed(error);
			}
		}
		return result;
	});

	add(
		'document/domain set to the parent domain by a subdomain',
		() =>
			new Promise((resolve) => {
				const frame = document.createElement('iframe');
				const listen = (event) => {
					if (!event.data?.sopDomain) return;
					window.removeEventListener('message', listen);
					frame.remove();
					resolve(event.data.sopDomain);
				};
				window.addEventListener('message', listen);
				const sub = new URL(B);
				sub.hostname = `a.www.${sub.hostname}`;
				frame.src = `${sub.origin}/pages/sop-domain.html`;
				document.body.append(frame);
			}),
	);
	add('document/domain values', () => {
		const result = {};
		for (const value of ['com', '127.0.0.1.', '[::1]', 'a b']) {
			try {
				document.domain = value;
				result[value] = `ok ${document.domain}`;
			} catch (error) {
				result[value] = failed(error);
			}
		}
		return result;
	});

	// --- another site's document: storage, messages, referrer ------------
	const frameOfB = () =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			frame.src = `${B}/pages/sop-b.html?a=${encodeURIComponent(A)}`;
			const listen = (event) => {
				if (event.data?.sop !== 'ready') return;
				window.removeEventListener('message', listen);
				resolve({ frame, event });
			};
			window.addEventListener('message', listen);
			document.body.append(frame);
		});
	let other = null;
	// an about:srcdoc document's URL names no origin the worker can read; under
	// no-referrer it sends nothing that would
	for (const [label, params] of [
		['', {}],
		[', ACAO A', { acao: A }],
	])
		add(
			`fetch/from a srcdoc frame that sends no referrer${label}`,
			() =>
				new Promise((resolve) => {
					const frame = document.createElement('iframe');
					const listen = (event) => {
						if (!event.data || !('sopSrcdoc' in event.data)) return;
						window.removeEventListener('message', listen);
						frame.remove();
						resolve(event.data.sopSrcdoc);
					};
					window.addEventListener('message', listen);
					frame.srcdoc = `<meta name="referrer" content="no-referrer"><script>
					fetch(${JSON.stringify(r(B, params).url)}).then((response) => response.text()).then(
						(text) => parent.postMessage({ sopSrcdoc: text }, '*'),
						(error) => parent.postMessage({ sopSrcdoc: error.name + ': ' + error.message }, '*'),
					);
				<\/script>`;
					document.body.append(frame);
				}),
		);
	// documents the page makes itself are of its origin (a data: one is
	// opaque): their reads of the page's own origin need no CORS
	const madeDocument = (src) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const listen = (event) => {
				if (!event.data || !('sopMade' in event.data)) return;
				window.removeEventListener('message', listen);
				frame.remove();
				resolve(event.data.sopMade);
			};
			window.addEventListener('message', listen);
			frame.src = src;
			document.body.append(frame);
		});
	const madeMarkup = (url) =>
		`<script>fetch(${JSON.stringify(url)}).then((response) => response.text()).then(
			(text) => parent.postMessage({ sopMade: text }, '*'),
			(error) => parent.postMessage({ sopMade: error.name + ': ' + error.message }, '*'),
		);<\/script>`;
	add('fetch/from a javascript: document to its own origin', () =>
		madeDocument(
			`javascript:'${madeMarkup(r(A, {}).url)
				.replace(/\\/g, '\\\\')
				.replace(/'/g, "\\'")}'`,
		),
	);
	add('fetch/from a blob: document to its own origin', () =>
		madeDocument(
			URL.createObjectURL(
				new Blob([madeMarkup(r(A, {}).url)], { type: 'text/html' }),
			),
		),
	);
	add('fetch/from a data: document to the page origin', () =>
		madeDocument(
			`data:text/html,${encodeURIComponent(madeMarkup(r(A, {}).url))}`,
		),
	);
	let usageBefore = null;
	add('storage/usage before another site writes', async () => {
		usageBefore = (await navigator.storage.estimate()).usage;
		return typeof usageBefore;
	});
	add(
		'navigation/another site sees only its own entries',
		() =>
			new Promise((resolve) => {
				const frame = document.createElement('iframe');
				const listen = (event) => {
					if (event.data?.sop !== 'nav') return;
					window.removeEventListener('message', listen);
					frame.remove();
					resolve(event.data.seen);
				};
				window.addEventListener('message', listen);
				frame.src = `${A}/pages/sop-nav.html?next=${encodeURIComponent(
					`${B}/pages/sop-nav.html`,
				)}`;
				document.body.append(frame);
			}),
	);
	add('frame/another site reports in', async () => {
		other = await frameOfB();
		return {
			origin: other.event.origin,
			wrote: other.event.data.wrote,
			referrer: other.event.data.referrer,
		};
	});
	add('frame/postMessage targetOrigin', async () => {
		if (!other) return 'no frame';
		const heard = [];
		const listen = (event) => {
			if (event.data?.sop === 'heard') heard.push(event.data.what);
		};
		window.addEventListener('message', listen);
		const target = other.frame.contentWindow;
		target.postMessage({ sop: 'say', what: 'to A origin' }, A);
		target.postMessage({ sop: 'say', what: 'to B origin' }, B);
		target.postMessage({ sop: 'say', what: 'to any' }, '*');
		try {
			target.postMessage({ sop: 'say', what: 'bad' }, 'not a url');
		} catch (error) {
			heard.push(failed(error));
		}
		await sleep(500);
		window.removeEventListener('message', listen);
		return heard.sort();
	});
	add('storage/another site wrote nothing here', async () => {
		if (!other) return 'no frame';
		const databases = indexedDB.databases
			? (await indexedDB.databases()).map((info) => info.name)
			: 'none';
		const held = navigator.locks
			? (await navigator.locks.query()).held.map((lock) => lock.name)
			: 'none';
		return {
			localStorage: localStorage.getItem('sop'),
			sessionStorage: sessionStorage.getItem('sop'),
			cookie: document.cookie.includes('sopb='),
			databases,
			caches: await caches.keys(),
			locks: held,
		};
	});
	add('storage/another site hears nothing on a channel', async () => {
		if (!other) return 'no frame';
		const channel = new BroadcastChannel('sop');
		const heard = [];
		channel.onmessage = (event) => heard.push(event.data);
		other.frame.contentWindow.postMessage({ sop: 'broadcast' }, '*');
		await sleep(600);
		channel.close();
		return heard;
	});
	add('storage/usage does not count another site', async () => {
		if (!other) return 'no frame';
		const after = (await navigator.storage.estimate()).usage;
		// the other site wrote a megabyte
		return after - usageBefore > 500000 ? 'counted' : 'not counted';
	});
	add('storage/a lock another site holds is not held here', async () => {
		if (!navigator.locks) return 'none';
		return navigator.locks.request('sop-lock', { ifAvailable: true }, (lock) =>
			lock ? 'granted' : 'unavailable',
		);
	});

	// --- workers ---------------------------------------------------------
	add('worker/of another site', () => {
		try {
			new Worker(r(B, { type: 'js' }).url);
			return 'constructed';
		} catch (error) {
			return failed(error);
		}
	});
	add('worker/shared worker of another site', () => {
		try {
			new SharedWorker(r(B, { type: 'js' }).url);
			return 'constructed';
		} catch (error) {
			return failed(error);
		}
	});
	const inWorker = (source, options) =>
		new Promise((resolve) => {
			const worker = new Worker(
				r(A, { type: options?.type === 'module' ? 'mjs' : 'js', js: source })
					.url,
				options,
			);
			const timer = setTimeout(() => resolve('timeout'), 8000);
			worker.onmessage = (event) => {
				clearTimeout(timer);
				resolve(event.data);
				worker.terminate();
			};
			worker.onerror = (event) => {
				clearTimeout(timer);
				event.preventDefault();
				resolve({ error: event.message ?? 'error' });
				worker.terminate();
			};
		});
	add('worker/reads another site', () => {
		const plain = r(B, {}).url;
		const cors = r(B, { acao: '*' }).url;
		const imported = r(B, { type: 'js', js: 'self.imported = 1' }).url;
		return inWorker(`(async () => {
			const out = { origin: self.origin, location: location.origin };
			const read = async (url, init) => { try { const r = await fetch(url, init); return [r.type, r.status, await r.text()]; } catch (e) { return e.name + ': ' + e.message; } };
			out.plain = await read(${JSON.stringify(plain)});
			out.cors = await read(${JSON.stringify(cors)});
			out.noCors = await read(${JSON.stringify(plain)}, { mode: 'no-cors' });
			try { importScripts(${JSON.stringify(imported)}); out.importScripts = self.imported; } catch (e) { out.importScripts = e.name; }
			postMessage(out);
		})();`);
	});
	add('worker/module worker imports another site without ACAO', () =>
		inWorker(
			`import ${JSON.stringify(r(B, { type: 'mjs', js: 'export default 1' }).url)}; postMessage('imported');`,
			{ type: 'module' },
		),
	);
	add('worker/module worker imports another site with ACAO', () =>
		inWorker(
			`import ${JSON.stringify(r(B, { type: 'mjs', js: 'export default 1', acao: '*' }).url)}; postMessage('imported');`,
			{ type: 'module' },
		),
	);
	add('worker/blob and data workers', async () => ({
		blob: await new Promise((resolve) => {
			const worker = new Worker(
				URL.createObjectURL(
					new Blob(['postMessage(self.origin)'], { type: 'text/javascript' }),
				),
			);
			worker.onmessage = (event) => resolve(event.data);
			worker.onerror = () => resolve('error');
		}),
		data: await new Promise((resolve) => {
			const worker = new Worker(
				'data:text/javascript,postMessage(self.origin)',
			);
			worker.onmessage = (event) => resolve(event.data);
			worker.onerror = () => resolve('error');
		}),
	}));

	(async () => {
		for (const [name, run] of cases) {
			if (only ? !name.startsWith(only) : name.startsWith('bench/')) continue;
			try {
				out.cases[name] = await Promise.race([
					(async () => run())(),
					sleep(10000).then(() => 'timeout'),
				]);
			} catch (error) {
				out.cases[name] = `case threw ${failed(error)}`;
			}
		}
		// the run's key and the page's own URL say nothing about the policy
		out.cases = JSON.parse(JSON.stringify(out.cases).replaceAll(`${K}-`, 'K-'));
		out.done = true;
	})();
})();
