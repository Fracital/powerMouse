// The same-origin policy battery (sop-escapes suite): the page at origin A
// (the fixture on 127.0.0.1) reaches origin B (`?b=`, the fixture on
// localhost, another site) every way the policy governs and writes what it
// could see into window.__sop.cases, one JSON value per case. The suite runs
// it natively and through the proxy in both modes and compares the two
// case by case. `?k=` keys this run's requests in the fixture's log
// (test/sop-server.mjs); `?only=<prefix>` runs the cases under one prefix.
(() => {
	// WebGL's texture uploads as a page can take them before any WebGL
	// context exists (the first thing it does); and what a reflective read of
	// one of the interfaces shows before anything named it
	const webglNeighbours = (() => {
		const keys = Object.getOwnPropertyNames(window);
		return ['WebGLRenderingContext', 'WebGL2RenderingContext'].map(
			(name) => keys[keys.indexOf(name) - 1] ?? null,
		);
	})();
	const webglDescriptor = Object.keys(
		Object.getOwnPropertyDescriptor(window, 'WebGL2RenderingContext') ?? {},
	);
	const earlyUploads = {
		texImage2D: window.WebGLRenderingContext?.prototype.texImage2D,
		texSubImage2D: window.WebGLRenderingContext?.prototype.texSubImage2D,
		texImage2D2: window.WebGL2RenderingContext?.prototype.texImage2D,
	};
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

	// the same through the prototypes the browser reads an init through:
	// whatever they add, the request is the page's own read, refused
	add('fetch/a load header through replaced prototypes', async () => {
		const marker = ['x-stomp-load', 'image no-cors'];
		const results = [];
		const attempt = async (patch, unpatch, run) => {
			patch();
			try {
				const value = await run();
				results.push(typeof value === 'string' ? value : value.type);
			} finally {
				unpatch();
			}
		};
		const iterator = Headers.prototype[Symbol.iterator];
		await attempt(
			() => {
				Headers.prototype[Symbol.iterator] = function* () {
					yield* iterator.call(this);
					yield marker;
				};
			},
			() => {
				Headers.prototype[Symbol.iterator] = iterator;
			},
			() => tryFetch(r(B, {}).url, { headers: new Headers({ a: '1' }) }),
		);
		await attempt(
			() => {
				Object.prototype.headers = Object.fromEntries([marker]);
			},
			() => {
				delete Object.prototype.headers;
			},
			() => tryFetch(r(B, {}).url, {}),
		);
		const getter = Object.getOwnPropertyDescriptor(
			Request.prototype,
			'headers',
		);
		await attempt(
			() => {
				Object.defineProperty(Request.prototype, 'headers', {
					configurable: true,
					get: () => new Headers([marker]),
				});
			},
			() => Object.defineProperty(Request.prototype, 'headers', getter),
			() => tryFetch(new Request(r(B, {}).url)),
		);
		const forEach = Headers.prototype.forEach;
		await attempt(
			() => {
				Headers.prototype.forEach = function (callback) {
					forEach.call(this, callback);
					callback(marker[1], marker[0], this);
				};
			},
			() => {
				Headers.prototype.forEach = forEach;
			},
			() =>
				xhr(r(B, {}).url).then((result) =>
					result.event === 'error' ? 'error' : result.text,
				),
		);
		return results;
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
	add(
		'canvas/WebGL uploads taken before any context, of a cross-origin image',
		async () => {
			const element = await image(r(B, { type: 'png' }).url);
			const result = {};
			for (const [method, type] of [
				['texImage2D', 'webgl'],
				['texSubImage2D', 'webgl'],
				['texImage2D2', 'webgl2'],
			]) {
				const gl = canvas().getContext(type);
				const upload = earlyUploads[method];
				if (!gl || !upload) {
					result[method] = 'no webgl';
					continue;
				}
				gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
				try {
					if (method === 'texSubImage2D') {
						gl.texImage2D(
							gl.TEXTURE_2D,
							0,
							gl.RGBA,
							1,
							1,
							0,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							null,
						);
						upload.call(
							gl,
							gl.TEXTURE_2D,
							0,
							0,
							0,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							element,
						);
					} else
						upload.call(
							gl,
							gl.TEXTURE_2D,
							0,
							gl.RGBA,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							element,
						);
					result[method] = 'ok';
				} catch (error) {
					result[method] = failed(error);
				}
			}
			return result;
		},
	);
	add(
		'canvas/a WebGL interface read reflectively first',
		() => webglDescriptor,
	);
	add(
		'canvas/where the WebGL interfaces are among the window keys',
		() => webglNeighbours,
	);
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
	// the worker reuses an output it just gave a document for the same
	// request again: a load the policy lets through and the same URL as a
	// load it refuses must each get their own verdict, both orders
	add(
		'script/the same script plain, then crossorigin without ACAO',
		async () => {
			const { url } = r(B, {
				type: 'js',
				js: 'window.__sopTwice = (window.__sopTwice || 0) + 1',
			});
			const first = await script(url);
			const second = await script(url, 'anonymous');
			return [first.how, second.how, window.__sopTwice];
		},
	);
	add(
		'script/the same script crossorigin without ACAO, then plain',
		async () => {
			const { url } = r(B, {
				type: 'js',
				js: 'window.__sopOnce = (window.__sopOnce || 0) + 1',
			});
			const first = await script(url, 'anonymous');
			const second = await script(url);
			return [first.how, second.how, window.__sopOnce];
		},
	);
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
	const timing = async (base, params, load = image) => {
		const { url } = r(base, { type: 'png', st: '1', ...params });
		await load(url);
		await sleep(100);
		const entry = performance.getEntriesByName(url)[0];
		if (!entry) return 'no entry';
		const json = entry.toJSON();
		return {
			// (the transfer size and protocol have cases of their own)
			encodedBodySize: entry.encodedBodySize > 0,
			decodedBodySize: entry.decodedBodySize > 0,
			requestStart: entry.requestStart > 0,
			responseStart: entry.responseStart > 0,
			connectStart: entry.connectStart > 0,
			domainLookupStart: entry.domainLookupStart > 0,
			workerStart: entry.workerStart,
			responseStatus: entry.responseStatus,
			initiatorType: entry.initiatorType,
			serverTiming: entry.serverTiming.map((metric) => metric.name),
			json: {
				initiatorType: json.initiatorType,
				requestStart: json.requestStart > 0,
				encodedBodySize: json.encodedBodySize > 0,
				workerStart: json.workerStart,
				serverTiming: json.serverTiming.map((metric) => metric.name),
			},
		};
	};
	add('timing/its own origin', () => timing(A, {}));
	const wire = async (base, params) => {
		const { url } = r(base, { type: 'png', ...params });
		await image(url);
		await sleep(100);
		const entry = performance.getEntriesByName(url)[0];
		if (!entry) return 'no entry';
		return {
			transferSize: entry.transferSize - entry.encodedBodySize,
			encodedBodySize: entry.encodedBodySize,
			decodedBodySize: entry.decodedBodySize,
			nextHopProtocol: entry.nextHopProtocol,
			deliveryType: entry.deliveryType,
			json: [
				entry.toJSON().transferSize - entry.encodedBodySize,
				entry.toJSON().nextHopProtocol,
			],
		};
	};
	add('timing/the transfer size and protocol of its own resource', () =>
		wire(A, {}),
	);
	add('timing/the transfer size and protocol of another site with TAO', () =>
		wire(B, { tao: '*' }),
	);
	add('timing/the transfer size and protocol of another site without TAO', () =>
		wire(B, {}),
	);
	// A script loaded by one document after another: from the network, then
	// from the cache (nothing transferred), after a 304 (the headers'
	// stand-in) or from the network again when the origin sends the same
	// bytes with a 200. Through the proxy the later loads are answered with
	// the response the rewrite cache keeps, which is the same Response for
	// each.
	const scriptLoads = async (params) => {
		const { url, key } = r(A, {
			type: 'js',
			js: `/* ${'padding '.repeat(80)} */ window.sopLoaded = 1;`,
			...params,
		});
		const out = [];
		for (let visit = 0; visit < 3; visit++) {
			const frame = document.createElement('iframe');
			const loaded = new Promise((resolve) => (frame.onload = resolve));
			frame.src = r(A, {
				type: 'raw',
				ct: 'text/html',
				body: `<!doctype html><script src="${url}"></script>`,
				visit,
			}).url;
			document.body.append(frame);
			await loaded;
			const entry = frame.contentWindow.performance.getEntriesByName(url)[0];
			if (!entry) out.push('no entry');
			else {
				const size = (transferSize) =>
					transferSize === 0
						? 'nothing'
						: transferSize === 300
							? 'the headers'
							: transferSize - entry.encodedBodySize === 300
								? 'the body and the headers'
								: transferSize - entry.encodedBodySize;
				out.push({
					transferred: size(entry.transferSize),
					deliveryType: entry.deliveryType,
					nextHopProtocol: entry.nextHopProtocol,
					json: [
						size(entry.toJSON().transferSize),
						entry.toJSON().deliveryType,
						entry.toJSON().nextHopProtocol,
					],
					ran: frame.contentWindow.sopLoaded,
				});
			}
			frame.remove();
			// (the rewrite cache keeps a response after it went out)
			await sleep(400);
		}
		// (how often the origin was asked)
		out.push((await log(key)).length);
		return out;
	};
	add('timing/a script three documents load, fresh in the cache', () =>
		scriptLoads({ cc: 'max-age=3600' }),
	);
	add('timing/a script three documents load, revalidated with a 304', () =>
		scriptLoads({ cc: 'max-age=0', etag: 'v1' }),
	);
	add('timing/a script three documents load, no-cache with a validator', () =>
		scriptLoads({ cc: 'no-cache', etag: 'v2' }),
	);
	add('timing/a script three documents load, sent again each time', () =>
		scriptLoads({ cc: 'no-cache' }),
	);
	add('timing/another site without Timing-Allow-Origin', () => timing(B, {}));
	add('timing/another site with Timing-Allow-Origin *', () =>
		timing(B, { tao: '*' }),
	);
	add('timing/another site with Timing-Allow-Origin naming this origin', () =>
		timing(B, { tao: A }),
	);
	add('timing/another site with Timing-Allow-Origin naming another', () =>
		timing(B, { tao: 'http://other.test' }),
	);
	add('timing/a fetch of another site with ACAO and TAO', () =>
		timing(B, { acao: '*', tao: '*' }, (url) =>
			fetch(url).then((response) => response.arrayBuffer()),
		),
	);
	add('timing/another site with ACAO, without TAO', () =>
		timing(B, { acao: '*' }),
	);
	add('isolation/crossOriginIsolated', () => self.crossOriginIsolated);
	// --- the rest of the Left list (docs/same-origin-policy.md) -----------
	add('canvas/an image of its own origin redirected to another', () =>
		drawn(r(A, { redirect: r(B, { type: 'png' }).url }).url),
	);
	add('canvas/an image of another origin redirected back to its own', () =>
		drawn(r(B, { redirect: r(A, { type: 'png' }).url }).url),
	);
	add('canvas/an image redirected to another origin and back', () =>
		drawn(
			r(A, { redirect: r(B, { redirect: r(A, { type: 'png' }).url }).url }).url,
		),
	);
	add('canvas/a redirected image in a written about:blank frame', async () => {
		const frame = document.createElement('iframe');
		document.body.append(frame);
		const written = frame.contentDocument;
		written.open();
		written.write('<img>');
		written.close();
		const element = written.querySelector('img');
		await new Promise((resolve) => {
			element.onload = element.onerror = resolve;
			element.src = r(A, { redirect: r(B, { type: 'png' }).url }).url;
		});
		const target = canvas();
		target.getContext('2d').drawImage(element, 0, 0);
		frame.remove();
		return readback(target);
	});
	// drawn while it loads (nothing is drawn yet), and again once it has
	add('canvas/a redirected image drawn before and after it loads', async () => {
		const element = new Image();
		const loaded = new Promise((resolve) => {
			element.onload = () => resolve(true);
			element.onerror = () => resolve(false);
		});
		element.src = r(A, { redirect: r(B, { type: 'png' }).url }).url;
		const target = canvas();
		const context = target.getContext('2d');
		context.drawImage(element, 0, 0);
		const before = readback(target);
		if (!(await loaded)) return 'image failed';
		context.drawImage(element, 0, 0);
		return { before, after: readback(target) };
	});
	// what the page does to its resource timing buffer says nothing about
	// where an image came from
	add(
		'canvas/a redirected image, the timing buffer cleared or full',
		async () => {
			const redirected = () =>
				r(A, { redirect: r(B, { type: 'png' }).url }).url;
			const result = {};
			const first = await image(redirected());
			if (!first) return 'image failed';
			performance.clearResourceTimings();
			let target = canvas();
			target.getContext('2d').drawImage(first, 0, 0);
			result.cleared = readback(target);
			performance.setResourceTimingBufferSize(0);
			const second = await image(redirected());
			performance.setResourceTimingBufferSize(250);
			if (!second) return 'image failed';
			target = canvas();
			target.getContext('2d').drawImage(second, 0, 0);
			result.full = readback(target);
			const getEntriesByName = performance.getEntriesByName;
			performance.getEntriesByName = () => [];
			try {
				const third = await image(redirected());
				if (!third) return 'image failed';
				target = canvas();
				target.getContext('2d').drawImage(third, 0, 0);
				result.replaced = readback(target);
			} finally {
				performance.getEntriesByName = getEntriesByName;
			}
			return result;
		},
	);
	// a frame of this origin draws another site's image into its own canvas,
	// with its own realm's methods; the page then draws that canvas
	const frameCanvas = async (setup) => {
		const element = await image(r(B, { type: 'png' }).url);
		const frame = document.createElement('iframe');
		const loaded = new Promise((resolve) => (frame.onload = resolve));
		setup(frame);
		document.body.append(frame);
		await loaded;
		const child = frame.contentDocument.createElement('canvas');
		child.width = child.height = 4;
		child.getContext('2d').drawImage(element, 0, 0);
		const result = { frame: readback(child) };
		const target = canvas();
		target.getContext('2d').drawImage(child, 0, 0);
		result.page = readback(target);
		frame.remove();
		return result;
	};
	add('canvas/a blank frame tainted its canvas, the page draws it', () =>
		frameCanvas(() => {}),
	);
	add('canvas/a srcdoc frame tainted its canvas, the page draws it', () =>
		frameCanvas((frame) => {
			frame.srcdoc = '<p>frame</p>';
		}),
	);
	// a window the page opened, with realms and methods crossed: the popup's
	// canvas drawn with the popup's methods and read with the page's, and the
	// page's canvas drawn with the popup's methods
	add('canvas/a popup tainted its canvas, the opener draws it', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const popup = window.open('about:blank');
		if (!popup) return 'no popup';
		try {
			const child = popup.document.createElement('canvas');
			child.width = child.height = 4;
			child.getContext('2d').drawImage(element, 0, 0);
			const result = { popup: readback(child) };
			const target = canvas();
			target.getContext('2d').drawImage(child, 0, 0);
			result.page = readback(target);
			const crossed = canvas();
			popup.CanvasRenderingContext2D.prototype.drawImage.call(
				crossed.getContext('2d'),
				element,
				0,
				0,
			);
			result.crossed = readback(crossed);
			const bitmap = await popup.createImageBitmap(element);
			const fromBitmap = canvas();
			fromBitmap.getContext('2d').drawImage(bitmap, 0, 0);
			result.bitmap = readback(fromBitmap);
			return result;
		} finally {
			popup.close();
		}
	});
	add('canvas/VideoFrame of a cross-origin image', async () => {
		if (typeof VideoFrame !== 'function') return 'no VideoFrame';
		const element = await image(r(B, { type: 'png' }).url);
		try {
			new VideoFrame(element, { timestamp: 0 }).close();
			return 'ok';
		} catch (error) {
			return failed(error);
		}
	});
	add('canvas/a tainted ImageBitmap drawn in a worker', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const bitmap = await createImageBitmap(element);
		const source = `onmessage = async (event) => {
			const canvas = new OffscreenCanvas(4, 4);
			canvas.getContext('2d').drawImage(event.data, 0, 0);
			try {
				await canvas.convertToBlob();
				postMessage('ok');
			} catch (error) {
				postMessage(error.name + ': ' + error.message);
			}
		};`;
		const worker = new Worker(
			URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
		);
		const answered = new Promise(
			(resolve) => (worker.onmessage = (e) => resolve(e.data)),
		);
		worker.postMessage(bitmap, [bitmap]);
		const answer = await Promise.race([
			answered,
			sleep(4000).then(() => 'timeout'),
		]);
		worker.terminate();
		return answer;
	});
	add('canvas/a tainted ImageBitmap cloned or transferred', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const result = {};
		const attempt = async (name, send) => {
			const bitmap = await createImageBitmap(element);
			try {
				await send(bitmap);
				result[name] = 'ok';
			} catch (error) {
				result[name] = failed(error);
			}
		};
		const worker = new Worker(
			URL.createObjectURL(
				new Blob(['onmessage = () => {};'], { type: 'text/javascript' }),
			),
		);
		await attempt('worker', (bitmap) => worker.postMessage({ list: [bitmap] }));
		await attempt('worker transfer', (bitmap) =>
			worker.postMessage(1, { transfer: [bitmap] }),
		);
		worker.terminate();
		await attempt('structuredClone', (bitmap) =>
			structuredClone(new Map([[1, bitmap]])),
		);
		await attempt('window', (bitmap) => window.postMessage(bitmap, '*'));
		await attempt('window, another origin named', (bitmap) =>
			window.postMessage(bitmap, B),
		);
		await attempt('port', (bitmap) =>
			new MessageChannel().port1.postMessage(new Set([bitmap])),
		);
		await attempt('channel', (bitmap) => {
			const channel = new BroadcastChannel(`sop-${K}`);
			try {
				channel.postMessage(bitmap);
			} finally {
				channel.close();
			}
		});
		await attempt('history', (bitmap) => history.replaceState({ bitmap }, ''));
		const clean = await createImageBitmap(canvas());
		result.clean = structuredClone(clean) ? 'ok' : 'none';
		return result;
	});
	add('fetch/no-cors redirect to another origin and back', async () => {
		const back = r(A, {});
		const away = r(B, { redirect: back.url });
		const { url } = r(A, { redirect: away.url });
		const result = await tryFetch(url, { mode: 'no-cors' });
		return {
			type: result.type,
			status: result.status,
			body: result.body,
			url: result.url,
		};
	});
	add('timing/an XMLHttpRequest of another site with ACAO and TAO', () =>
		timing(
			B,
			{ acao: '*', tao: '*' },
			(url) =>
				new Promise((resolve) => {
					const request = new XMLHttpRequest();
					request.open('GET', url);
					request.onloadend = resolve;
					request.send();
				}),
		),
	);
	// the proxy's own Server-Timing metrics are never the page's, and a
	// site's reach it only as the protocol exposes them
	add('timing/the Server-Timing header as the page reads it', async () => {
		const fetched = async (base, params) => {
			try {
				const response = await fetch(r(base, { st: '1', ...params }).url);
				return [
					response.headers.get('server-timing'),
					response.clone().headers.get('server-timing'),
					[...response.headers.keys()].includes('server-timing'),
				];
			} catch (error) {
				return failed(error);
			}
		};
		const requested = (base, params) =>
			new Promise((resolve) => {
				const request = new XMLHttpRequest();
				request.open('GET', r(base, { st: '1', ...params }).url);
				request.onloadend = () =>
					resolve([
						request.status,
						request.getResponseHeader('server-timing'),
						/server-timing/i.test(request.getAllResponseHeaders()),
					]);
				request.send();
			});
		return {
			own: await fetched(A, {}),
			ownWithout: await fetched(A, { st: '' }),
			hidden: await fetched(B, { acao: '*', tao: '*' }),
			exposed: await fetched(B, {
				acao: '*',
				tao: '*',
				aceh: 'server-timing',
			}),
			exposedWithoutTiming: await fetched(B, {
				acao: '*',
				aceh: 'server-timing',
			}),
			xhrOwn: await requested(A, {}),
			xhrOwnWithout: await requested(A, { st: '' }),
			xhrHidden: await requested(B, { acao: '*', tao: '*' }),
			xhrExposed: await requested(B, {
				acao: '*',
				tao: '*',
				aceh: 'server-timing',
			}),
		};
	});
	// an upload listener makes a cross-origin request go after a preflight
	// (the CORS-preflight flag), whatever its method and headers
	const upload = (listen) => {
		const { url, key } = r(B, { acao: '*' });
		return new Promise((resolve) => {
			const request = new XMLHttpRequest();
			request.open('POST', url);
			if (listen) request.upload.onprogress = () => {};
			request.onloadend = async () =>
				resolve({ status: request.status, reached: await reached(key) });
			request.send('body');
		});
	};
	add('xhr/an upload listener before send', () => upload(true));
	add('xhr/no upload listener', () => upload(false));
	add('cache/an opaque response read back from the Cache API', async () => {
		const { url } = r(B, {});
		const response = await fetch(url, { mode: 'no-cors' });
		const cache = await caches.open(`sop-${K}`);
		await cache.put(url, response);
		const kept = await cache.match(url);
		await caches.delete(`sop-${K}`);
		return {
			type: kept?.type,
			status: kept?.status,
			body: kept ? (await kept.arrayBuffer()).byteLength : null,
			headers: kept ? [...kept.headers.keys()] : null,
		};
	});
	add('isolation/SharedArrayBuffer without COOP and COEP', () => {
		let memory;
		try {
			memory = new WebAssembly.Memory({
				initial: 1,
				maximum: 1,
				shared: true,
			}).buffer.constructor.name;
		} catch (error) {
			memory = failed(error);
		}
		let posted;
		try {
			postMessage(new SharedArrayBuffer(8), '*');
			posted = 'ok';
		} catch (error) {
			posted = failed(error);
		}
		return {
			type: typeof SharedArrayBuffer,
			memory,
			posted,
		};
	});

	// --- stylesheets ------------------------------------------------------
	const CSS = '.sop-rule { color: rgb(1, 2, 3) }';
	const rulesOf = (styleSheet) => {
		const result = {};
		const attempt = (name, run) => {
			try {
				result[name] = run();
			} catch (error) {
				result[name] = failed(error);
			}
		};
		attempt('cssRules', () => styleSheet.cssRules.length);
		attempt('rules', () => styleSheet.rules.length);
		attempt('insertRule', () =>
			styleSheet.insertRule('.sop-x { color: blue }', 0),
		);
		attempt('deleteRule', () => styleSheet.deleteRule(0));
		attempt('addRule', () => styleSheet.addRule('.sop-y', 'color: blue'));
		attempt('removeRule', () => styleSheet.removeRule(0));
		return result;
	};
	const sheetCase = (href, crossOrigin) =>
		new Promise((resolve) => {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			if (crossOrigin !== undefined) link.crossOrigin = crossOrigin;
			link.onload = () => {
				const result = rulesOf(link.sheet);
				link.remove();
				resolve(result);
			};
			link.onerror = () => {
				link.remove();
				resolve('sheet failed');
			};
			link.href = href;
			document.head.append(link);
		});
	add("css/the rules of its own origin's stylesheet", () =>
		sheetCase(r(A, { type: 'css', css: CSS }).url),
	);
	add("css/the rules of another site's stylesheet", () =>
		sheetCase(r(B, { type: 'css', css: CSS }).url),
	);
	add("css/the rules of another site's stylesheet, with ACAO only", () =>
		sheetCase(r(B, { type: 'css', css: CSS, acao: '*' }).url),
	);
	add("css/the rules of another site's crossorigin stylesheet with ACAO", () =>
		sheetCase(r(B, { type: 'css', css: CSS, acao: '*' }).url, 'anonymous'),
	);
	add('css/the rules of a stylesheet redirected to another site', () =>
		sheetCase(r(A, { redirect: r(B, { type: 'css', css: CSS }).url }).url),
	);
	add('css/the rules of a stylesheet another site redirects back', () =>
		sheetCase(r(B, { redirect: r(A, { type: 'css', css: CSS }).url }).url),
	);
	add(
		'css/the rules of a stylesheet imported from another site',
		() =>
			new Promise((resolve) => {
				const style = document.createElement('style');
				style.textContent = `@import url(${JSON.stringify(
					r(B, { type: 'css', css: CSS }).url,
				)});`;
				style.onload = style.onerror = () => {
					let result;
					try {
						result = {
							own: style.sheet.cssRules.length,
							imported: rulesOf(style.sheet.cssRules[0].styleSheet),
						};
					} catch (error) {
						result = failed(error);
					}
					style.remove();
					resolve(result);
				};
				document.head.append(style);
			}),
	);

	// a stylesheet's imports, by how the stylesheet itself was loaded
	const imports = (base, params, crossOrigin, inner) =>
		new Promise((resolve) => {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			if (crossOrigin !== undefined) link.crossOrigin = crossOrigin;
			link.onload = () => {
				let result;
				try {
					const rule = link.sheet.cssRules[0];
					result = rule.styleSheet ? rulesOf(rule.styleSheet) : 'no sheet';
				} catch (error) {
					result = failed(error);
				}
				link.remove();
				resolve(result);
			};
			link.onerror = () => {
				link.remove();
				resolve('sheet failed');
			};
			link.href = r(base, {
				type: 'css',
				css: `@import url(${JSON.stringify(inner)});`,
				...params,
			}).url;
			document.head.append(link);
		});
	add('css/the rules of the stylesheets a stylesheet imports', async () => ({
		ownImportsOwn: await imports(
			A,
			{},
			undefined,
			r(A, { type: 'css', css: CSS }).url,
		),
		ownImportsOther: await imports(
			A,
			{},
			undefined,
			r(B, { type: 'css', css: CSS, acao: '*' }).url,
		),
		corsImportsWithACAO: await imports(
			B,
			{ acao: '*' },
			'anonymous',
			r(B, { type: 'css', css: CSS, acao: '*' }).url,
		),
		corsImportsWithout: await imports(
			B,
			{ acao: '*' },
			'anonymous',
			r(B, { type: 'css', css: CSS }).url,
		),
		corsImportsOwn: await imports(
			B,
			{ acao: '*' },
			'anonymous',
			r(A, { type: 'css', css: CSS }).url,
		),
		otherImportsOwn: await imports(
			B,
			{},
			undefined,
			r(A, { type: 'css', css: CSS }).url,
		),
	}));

	// --- captured and decoded media --------------------------------------
	add('canvas/captureStream of a tainted canvas', async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const target = canvas();
		const result = {};
		const tracks = (stream) =>
			stream.getVideoTracks().map((track) => track.readyState);
		result.clean = tracks(target.captureStream());
		target.getContext('2d').drawImage(element, 0, 0);
		try {
			result.tainted = tracks(target.captureStream());
		} catch (error) {
			result.tainted = failed(error);
		}
		return result;
	});
	// a stream captured while the canvas was clean: what its player shows once
	// the canvas holds another site's image (red), and the track's state
	const capturedThenTainted = async () => {
		const element = await image(r(B, { type: 'png' }).url);
		const target = canvas();
		const context = target.getContext('2d');
		const stream = target.captureStream();
		const clone = stream.getVideoTracks()[0].clone();
		const player = document.createElement('video');
		player.muted = true;
		player.srcObject = new MediaStream([clone]);
		// (settles with the first frame, which the canvas has yet to give)
		player.play().catch(() => {});
		const shown = () => {
			const probe = canvas();
			const probing = probe.getContext('2d');
			probing.drawImage(player, 0, 0, probe.width, probe.height);
			try {
				const [red, green, blue] = probing.getImageData(1, 1, 1, 1).data;
				return green > red + 60 && green > blue + 60
					? 'green'
					: red > green + 60 && red > blue + 60
						? 'red'
						: 'neither';
			} catch (error) {
				return failed(error);
			}
		};
		context.fillStyle = '#00ff00';
		let before = 'neither';
		for (let i = 0; i < 40 && before !== 'green'; i++) {
			context.fillRect(0, 0, target.width, target.height);
			await sleep(50);
			before = shown();
		}
		context.drawImage(element, 0, 0, target.width, target.height);
		await sleep(500);
		const result = {
			// (Chrome keeps the last clean frame; a track that ended shows none)
			shown: {
				before,
				after: shown() === 'red' ? 'the image' : 'not the image',
			},
			tracks: [stream.getVideoTracks()[0].readyState, clone.readyState],
		};
		player.srcObject = null;
		return result;
	};
	add(
		'canvas/what a stream captured before its canvas was tainted shows',
		async () => (await capturedThenTainted()).shown,
	);
	add(
		'canvas/the tracks of a stream captured before its canvas was tainted',
		async () => (await capturedThenTainted()).tracks,
	);
	// A video once it has a frame to give. Chrome fires loadeddata before its
	// first frame is presented now and then (on a busy machine, natively
	// too): read then, a canvas draws nothing, createImageBitmap says "The
	// image source is not usable" and VideoFrame "Invalid source state". The
	// first video frame callback comes once it is
	const video = (src, crossOrigin) =>
		new Promise((resolve) => {
			const element = document.createElement('video');
			element.muted = true;
			element.preload = 'auto';
			if (crossOrigin !== undefined) element.crossOrigin = crossOrigin;
			const presented = new Promise((frame) =>
				element.requestVideoFrameCallback(frame),
			);
			element.onloadeddata = async () => {
				await Promise.race([presented, sleep(10000)]);
				resolve(element);
			};
			element.onerror = () => resolve(null);
			element.src = src;
		});
	const videoCase = async (src, crossOrigin) => {
		const element = await video(src, crossOrigin);
		if (!element) return 'video failed';
		const target = canvas();
		target.getContext('2d').drawImage(element, 0, 0);
		const result = { canvas: readback(target) };
		try {
			const bitmap = await createImageBitmap(element);
			const drawn = canvas();
			drawn.getContext('2d').drawImage(bitmap, 0, 0);
			result.bitmap = readback(drawn).getImageData;
		} catch (error) {
			result.bitmap = failed(error);
		}
		try {
			new VideoFrame(element).close();
			result.videoFrame = 'ok';
		} catch (error) {
			result.videoFrame = failed(error);
		}
		try {
			result.captureStream = element.captureStream().getTracks().length;
		} catch (error) {
			result.captureStream = failed(error);
		}
		element.removeAttribute('src');
		element.load();
		return result;
	};
	add('media/a video of its own origin', () =>
		videoCase(r(A, { type: 'webm' }).url),
	);
	add('media/a video of another site', () =>
		videoCase(r(B, { type: 'webm' }).url),
	);
	add('media/a crossorigin video of another site with ACAO', () =>
		videoCase(r(B, { type: 'webm', acao: '*' }).url, 'anonymous'),
	);
	add('media/a video redirected to another site', () =>
		videoCase(r(A, { redirect: r(B, { type: 'webm' }).url }).url),
	);
	/** whether Web Audio hears a playing element */
	const hears = async (audio) => {
		const context = new AudioContext();
		try {
			const analyser = context.createAnalyser();
			const quiet = context.createGain();
			quiet.gain.value = 0;
			context.createMediaElementSource(audio).connect(analyser);
			analyser.connect(quiet);
			quiet.connect(context.destination);
			await context.resume();
			const data = new Uint8Array(analyser.fftSize);
			let sound = false;
			for (let i = 0; i < 30 && !sound; i++) {
				await sleep(50);
				analyser.getByteTimeDomainData(data);
				sound = data.some((value) => value !== 128);
			}
			return sound;
		} finally {
			await context.close();
		}
	};
	// what Web Audio hears of an element's sound: another site's is silence
	const heard = async (src, crossOrigin, make) => {
		const audio = new Audio();
		if (crossOrigin !== undefined) audio.crossOrigin = crossOrigin;
		audio.src = src;
		const context = new AudioContext();
		try {
			const source = make
				? new MediaElementAudioSourceNode(context, { mediaElement: audio })
				: context.createMediaElementSource(audio);
			const analyser = context.createAnalyser();
			const quiet = context.createGain();
			quiet.gain.value = 0;
			source.connect(analyser);
			analyser.connect(quiet);
			quiet.connect(context.destination);
			await context.resume();
			await audio.play();
			const data = new Uint8Array(analyser.fftSize);
			let sound = false;
			for (let i = 0; i < 30 && !sound; i++) {
				await sleep(50);
				analyser.getByteTimeDomainData(data);
				sound = data.some((value) => value !== 128);
			}
			return { state: context.state, sound };
		} catch (error) {
			return failed(error);
		} finally {
			audio.pause();
			await context.close();
		}
	};
	add('media/Web Audio hears an element of its own origin', () =>
		heard(r(A, { type: 'wav' }).url),
	);
	add('media/Web Audio hears an element of another site', async () => ({
		method: await heard(r(B, { type: 'wav' }).url),
		constructor: await heard(r(B, { type: 'wav' }).url, undefined, true),
	}));
	add(
		'media/Web Audio hears a crossorigin element of another site with ACAO',
		() => heard(r(B, { type: 'wav', acao: '*' }).url, 'anonymous'),
	);
	add('media/Web Audio hears an element redirected to another site', () =>
		heard(r(A, { redirect: r(B, { type: 'wav' }).url }).url),
	);

	const sound = (src) =>
		new Promise((resolve) => {
			const audio = new Audio();
			audio.onloadedmetadata = () =>
				resolve(`loaded, ${Math.round(audio.duration)} s`);
			audio.onerror = () => resolve(`error ${audio.error?.code}`);
			audio.src = src;
		});
	add('media/a sound over 64 KiB behind a redirect', async () => ({
		own: await sound(
			r(A, { redirect: r(A, { type: 'wav', long: 1 }).url }).url,
		),
		other: await sound(
			r(A, { redirect: r(B, { type: 'wav', long: 1 }).url }).url,
		),
	}));
	add('media/a captured video that then plays another site', async () => {
		const element = await video(r(A, { type: 'webm' }).url);
		if (!element) return 'video failed';
		const result = {};
		const states = (tracks) =>
			tracks.map((track) => `${track.kind} ${track.readyState}`).sort();
		const stream = element.captureStream();
		const first = stream.getTracks();
		const cloned = first.map((track) => track.clone());
		const copy = stream.clone();
		await element.play();
		await sleep(200);
		result.before = states(stream.getTracks());
		const loaded = new Promise((resolve) => {
			element.onloadeddata = () => resolve('loaded');
			element.onerror = () => resolve('error');
		});
		// a listener of the page's that stops the event
		element.addEventListener('loadedmetadata', (event) =>
			event.stopImmediatePropagation(),
		);
		element.src = r(B, { type: 'webm' }).url;
		result.switched = await loaded;
		await element.play().catch(() => {});
		await sleep(400);
		result.first = states(first);
		result.clones = states(cloned);
		result.copy = states(copy.getTracks());
		result.active = stream.active;
		try {
			result.again = states(element.captureStream().getTracks());
		} catch (error) {
			result.again = failed(error);
		}
		element.removeAttribute('src');
		element.load();
		return result;
	});
	add('media/Web Audio hears an element as its source changes', async () => {
		const audio = new Audio();
		audio.loop = true;
		const context = new AudioContext();
		const source = context.createMediaElementSource(audio);
		const analyser = context.createAnalyser();
		const quiet = context.createGain();
		quiet.gain.value = 0;
		// connected through the prototype's method, taken before any source
		AudioNode.prototype.connect.call(source, analyser);
		analyser.connect(quiet);
		quiet.connect(context.destination);
		await context.resume();
		const listen = async (src) => {
			audio.src = src;
			try {
				if (
					(await Promise.race([
						audio.play(),
						sleep(1500).then(() => 'late'),
					])) === 'late'
				)
					return 'play() did not settle';
			} catch (error) {
				return failed(error);
			}
			const data = new Uint8Array(analyser.fftSize);
			let heard = false;
			for (let i = 0; i < 20 && !heard; i++) {
				await sleep(50);
				analyser.getByteTimeDomainData(data);
				heard = data.some((value) => value !== 128);
			}
			return heard;
		};
		const result = {
			own: await listen(r(A, { type: 'wav' }).url),
			other: await listen(r(B, { type: 'wav' }).url),
			ownAgain: await listen(r(A, { type: 'wav' }).url),
			redirected: await listen(
				r(A, { redirect: r(B, { type: 'wav', long: 1 }).url }).url,
			),
		};
		audio.pause();
		await context.close();
		return result;
	});
	// a load that is not over (a stream): no resource timing entry says what
	// it came through
	const loading = async (src) => {
		const audio = new Audio();
		audio.src = src;
		const result = {};
		try {
			if (
				(await Promise.race([audio.play(), sleep(3000).then(() => 'late')])) ===
				'late'
			)
				return 'play() did not settle';
			result.entries = performance.getEntriesByName(src).length;
			result.heard = await hears(audio);
			result.captureStream = audio.captureStream().getTracks().length;
		} catch (error) {
			result.captureStream = failed(error);
		}
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
		return result;
	};
	add('media/a sound of its own origin that is still loading', () =>
		loading(r(A, { type: 'wav', long: 1, hold: 1 }).url),
	);
	add('media/a sound redirected to another site that is still loading', () =>
		loading(
			r(A, { redirect: r(B, { type: 'wav', long: 1, hold: 1 }).url }).url,
		),
	);

	// --- other requests the policy governs --------------------------------
	add('beacon/a JSON beacon to another site', async () => {
		const { url, key } = r(B, {});
		const sent = navigator.sendBeacon(
			url,
			new Blob(['{}'], { type: 'application/json' }),
		);
		await sleep(500);
		return { sent, reached: await reached(key) };
	});
	add('beacon/a text beacon to another site', async () => {
		const { url, key } = r(B, {});
		const sent = navigator.sendBeacon(url, 'text');
		await sleep(500);
		return { sent, reached: await reached(key) };
	});
	const events = (params) =>
		new Promise((resolve) => {
			const source = new EventSource(r(B, params).url);
			source.onopen = () => {
				source.close();
				resolve('open');
			};
			source.onerror = () => {
				source.close();
				resolve('error');
			};
		});
	add('eventsource/another site without ACAO', () =>
		events({ type: 'raw', ct: 'text/event-stream', body: 'data: x\n\n' }),
	);
	add('eventsource/another site with ACAO', () =>
		events({
			type: 'raw',
			ct: 'text/event-stream',
			body: 'data: x\n\n',
			acao: '*',
		}),
	);
	// opaque response blocking: a no-cors response of another site that is a
	// document or data, not a script or media, never reaches the page
	const blocked = (tag, params) =>
		new Promise((resolve) => {
			const element = document.createElement(tag);
			element.onload = () => {
				element.remove();
				resolve('load');
			};
			element.onerror = () => {
				element.remove();
				resolve('error');
			};
			element.src = r(B, { type: 'raw', ...params }).url;
			document.head.append(element);
		});
	add('orb/scripts of another site by type', async () => ({
		json: await blocked('script', {
			ct: 'application/json',
			body: '{"secret": 1}',
		}),
		jsonArray: await blocked('script', {
			ct: 'application/json',
			body: '[1, 2]',
		}),
		jsonThatIsScript: await blocked('script', {
			ct: 'application/json',
			body: 'window.sopOrb = 1;',
		}),
		html: await blocked('script', {
			ct: 'text/html',
			body: '<!doctype html><html><body>secret</body></html>',
		}),
		xml: await blocked('script', {
			ct: 'text/xml',
			body: '<?xml version="1.0"?><secret/>',
		}),
		plain: await blocked('script', { ct: 'text/plain', body: 'var a = 1;' }),
		plainJson: await blocked('script', {
			ct: 'text/plain',
			body: '{"secret": 1}',
		}),
		plainNosniff: await blocked('script', {
			ct: 'text/plain',
			body: 'var a = 1;',
			nosniff: '1',
		}),
		octets: await blocked('script', {
			ct: 'application/octet-stream',
			body: 'var a = 1;',
		}),
		javascript: await blocked('script', {
			ct: 'text/javascript',
			body: 'var a = 1;',
		}),
	}));
	add('orb/a no-cors fetch of JSON of another site', async () => {
		const { url, key } = r(B, {
			type: 'raw',
			ct: 'application/json',
			body: '{"secret": 1}',
		});
		const result = await tryFetch(url, { mode: 'no-cors' });
		return {
			result: typeof result === 'string' ? result : result.type,
			reached: await reached(key),
		};
	});

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
	// the same frame in other shapes: loaded a second time, sandboxed into an
	// opaque origin (its Origin is null, which ACAO A does not name), nested
	// in another srcdoc frame, and with a script the parser finds before any
	// of the frame's own script runs
	const srcdocFrame = (markup, setup = () => {}, reports = 1) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const seen = [];
			const listen = (event) => {
				if (!event.data || !('sopSrcdoc2' in event.data)) return;
				seen.push(event.data.sopSrcdoc2);
				if (seen.length < reports) {
					frame.contentWindow.location.reload();
					return;
				}
				window.removeEventListener('message', listen);
				frame.remove();
				resolve(reports === 1 ? seen[0] : seen);
			};
			window.addEventListener('message', listen);
			setup(frame);
			frame.srcdoc = markup;
			document.body.append(frame);
		});
	const noReferrer = '<meta name="referrer" content="no-referrer">';
	const reads = (params, target = 'parent') => `<script>
		fetch(${JSON.stringify(r(B, params).url)}).then((response) => response.text()).then(
			(text) => ${target}.postMessage({ sopSrcdoc2: text }, '*'),
			(error) => ${target}.postMessage({ sopSrcdoc2: error.name + ': ' + error.message }, '*'),
		);
	<\/script>`;
	add('fetch/from a srcdoc frame that sends no referrer, loaded twice', () =>
		srcdocFrame(noReferrer + reads({ acao: A }), undefined, 2),
	);
	add(
		'fetch/from a sandboxed srcdoc frame that sends no referrer',
		async () => ({
			named: await srcdocFrame(noReferrer + reads({ acao: A }), (frame) =>
				frame.setAttribute('sandbox', 'allow-scripts'),
			),
			any: await srcdocFrame(noReferrer + reads({ acao: '*' }), (frame) =>
				frame.setAttribute('sandbox', 'allow-scripts'),
			),
		}),
	);
	add('fetch/from a srcdoc frame in a srcdoc frame, no referrer', () => {
		const inner = (noReferrer + reads({ acao: A }, 'top'))
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;');
		return srcdocFrame(`${noReferrer}<iframe srcdoc="${inner}"></iframe>`);
	});
	add('script/a crossorigin script in a srcdoc frame, no referrer', () =>
		srcdocFrame(
			`${noReferrer}<script crossorigin src="${
				r(B, { type: 'js', js: 'window.ran = 1', acao: A }).url
			}"><\/script><script>parent.postMessage({ sopSrcdoc2: window.ran ?? 'did not run' }, '*');<\/script>`,
		),
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
	add('worker/XMLHttpRequest with an upload listener', async () => {
		const { url, key } = r(B, { acao: '*' });
		const plain = r(B, { acao: '*' });
		const send = (target, listen) => `await new Promise((resolve) => {
			const request = new XMLHttpRequest();
			request.open('POST', ${JSON.stringify(target)});
			${listen ? "request.upload.addEventListener('progress', () => {});" : ''}
			request.onloadend = () => resolve(statuses.push(request.status));
			request.send('body');
		});`;
		const statuses = await inWorker(`(async () => {
			const statuses = [];
			${send(url, true)}
			${send(plain.url, false)}
			postMessage(statuses);
		})();`);
		return {
			statuses,
			listener: await reached(key),
			none: await reached(plain.key),
		};
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
