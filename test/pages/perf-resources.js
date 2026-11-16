// The resource mix of the performance fixture (performance-resources suite,
// test/pages/perf-resources.html): after the markup's loads, one load at a
// time of every kind a page makes, then what resource timing shows of all
// of them.
(async () => {
	const { r, cross, run, attempt, sleep, until, describe, nameOf, tidy } =
		perfLib;
	const record = { steps: {}, frames: {}, workers: {} };
	window.__perf = { page: 'resources', done: false, record };

	addEventListener('message', (event) => {
		if (event.data && event.data.perfChild)
			record.frames[event.data.perfChild] = event.data.record;
	});
	// every resource timing entry as an observer hears of it
	const observed = [];
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) observed.push(nameOf(entry.name));
	}).observe({ type: 'resource', buffered: true });

	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));
	await attempt(() => globalThis.__perfDynamic);
	// loads whose entries are known to differ through the proxy are counted
	// apart, so that the rest of the mix is compared entry by entry: a
	// synchronous XMLHttpRequest, and an image in the markup that no cache
	// may keep
	const APART = ['xhr-sync', 'img-nostore', 'img404'];
	const apart = (entry) => APART.includes(nameOf(entry.name));
	const resources = () =>
		performance.getEntriesByType('resource').filter((entry) => !apart(entry));
	// (the markup's loads start within one tick of the coarsened clock, and
	// their order by start time changes from one native run to the next:
	// they are compared as a set, and only the loads below, each awaited
	// before the next starts, in their order)
	const markupLoads = new Set(resources());
	record.markup = [...markupLoads].map((entry) => nameOf(entry.name)).sort();

	const step = async (name, work) => {
		record.steps[name] = await attempt(work);
		// a load's entry is there when the next one starts
		await sleep(30);
	};
	const text = async (url, init) => {
		const response = await fetch(url, init);
		const body = await response.text();
		return `${response.status} ${response.type} ${body.length}`;
	};
	const xhr = (method, url, body, sync = false) =>
		new Promise((resolve) => {
			const request = new XMLHttpRequest();
			request.open(method, url, !sync);
			request.onloadend = () =>
				resolve(`${request.status} ${request.responseText.length}`);
			request.send(body);
		});
	const element = (tag, attributes, parent = document.head) =>
		new Promise((resolve) => {
			const node = document.createElement(tag);
			node.onload = () => resolve('load');
			node.onerror = () => resolve('error');
			for (const [key, value] of Object.entries(attributes))
				node.setAttribute(key, value);
			parent.append(node);
		});
	const image = (url) =>
		new Promise((resolve) => {
			const node = new Image();
			node.onload = () => resolve('load');
			node.onerror = () => resolve('error');
			node.src = url;
		});
	const encode = encodeURIComponent;

	await step('fetch-get', () => text(r('t=json&n=fetch-get&size=1000')));
	await step('fetch-post', () =>
		text(r('t=json&n=fetch-post&size=700'), { method: 'POST', body: 'posted' }),
	);
	await step('xhr-get', () => xhr('GET', r('t=text&n=xhr-get&size=900')));
	await step('xhr-post', () =>
		xhr('POST', r('t=text&n=xhr-post&size=800'), 'posted'),
	);
	await step('xhr-sync', () =>
		xhr('GET', r('t=text&n=xhr-sync&size=600'), null, true),
	);

	// another origin's, with and without Timing-Allow-Origin
	await step('x-cors', () => text(r('t=json&n=x-cors&cors=1&size=500', cross)));
	await step('x-tao', () =>
		text(r('t=json&n=x-tao&cors=1&tao=*&size=500', cross)),
	);
	await step('x-tao-origin', () =>
		text(r('t=json&n=x-tao-origin&cors=1&tao=origin&size=500', cross)),
	);
	await step('x-tao-other', () =>
		text(
			r(
				`t=json&n=x-tao-other&cors=1&tao=${encode('http://example.test')}&size=500`,
				cross,
			),
		),
	);
	await step('x-opaque', () =>
		text(r('t=json&n=x-opaque&size=500', cross), { mode: 'no-cors' }),
	);

	// redirects
	await step('redir-same', () =>
		text(
			r(
				`n=redir-same&to=${encode(r(`n=redir-same-2&to=${encode(r('t=json&n=redir-same-end'))}`))}`,
			),
		),
	);
	await step('redir-cross-tao', () =>
		text(
			r(
				`n=redir-cross-tao&to=${encode(r('t=json&n=redir-cross-tao-end&cors=1&tao=*', cross))}`,
			),
		),
	);
	await step('redir-cross', () =>
		text(
			r(
				`n=redir-cross&to=${encode(r('t=json&n=redir-cross-end&cors=1', cross))}`,
			),
		),
	);
	await step('redir-back', () =>
		text(
			r(
				`n=redir-back&to=${encode(
					r(
						`n=redir-back-2&cors=1&tao=*&to=${encode(location.origin + r('t=json&n=redir-back-end&cors=1&tao=*'))}`,
						cross,
					),
				)}`,
			),
		),
	);
	await step('redir-img', () =>
		image(
			r(
				`n=redir-img&to=${encode(r(`n=redir-img-2&to=${encode(location.origin + r('t=img&n=redir-img-end'))}`, cross))}`,
				cross,
			),
		),
	);

	// failures
	await step('fetch-404', () => text(r('t=json&n=fetch-404&status=404')));
	await step('script-404', () =>
		element('script', { src: r('t=js&n=script-404&status=404') }),
	);
	await step('abort', async () => {
		const controller = new AbortController();
		const pending = fetch(r('t=json&n=abort&delay=1500'), {
			signal: controller.signal,
		});
		await sleep(150);
		controller.abort();
		return pending.then(
			() => 'resolved',
			(error) => error.name,
		);
	});
	await step('blocked-cors', () =>
		text(r('t=json&n=blocked-cors', cross)).catch((error) => error.name),
	);
	await step('blocked-port', () =>
		text('http://127.0.0.1:9/blocked-port').catch((error) => error.name),
	);

	// caches: the HTTP cache, a revalidation, the memory cache
	for (const round of [1, 2])
		await step(`cache-fetch-${round}`, () =>
			text(r(`t=json&n=cache-fetch&size=1200&cc=${encode('max-age=600')}`)),
		);
	for (const round of [1, 2])
		await step(`cache-304-${round}`, () =>
			text(r('t=json&n=cache-304&size=1100&cc=no-cache&etag=v1')),
		);
	for (const round of [1, 2])
		await step(`cache-img-${round}`, () =>
			image(r(`t=img&n=cache-img&cc=${encode('max-age=600')}`)),
		);
	for (const round of [1, 2])
		await step(`cache-script-${round}`, () =>
			element('script', {
				src: r(`t=js&n=cache-script&size=1500&cc=${encode('max-age=600')}`),
			}),
		);
	for (const round of [1, 2])
		await step(`x-cache-img-${round}`, () =>
			image(r(`t=img&n=x-cache-img&cc=${encode('max-age=600')}`, cross)),
		);

	// Server-Timing
	const metrics = encode(
		'db;dur=53, app;dur=47.2;desc="x y", miss, cache;desc=hit',
	);
	await step('st-same', () => text(r(`t=json&n=st-same&st=${metrics}`)));
	await step('x-st-tao', () =>
		text(r(`t=json&n=x-st-tao&cors=1&tao=*&st=${metrics}`, cross)),
	);
	await step('x-st', () =>
		text(r(`t=json&n=x-st&cors=1&st=${metrics}`, cross)),
	);

	// compressed bodies
	await step('gzip-fetch', () =>
		text(r('t=text&n=gzip-fetch&size=3000&enc=gzip')),
	);
	await step('br-fetch', () => text(r('t=text&n=br-fetch&size=3000&enc=br')));
	await step('gzip-script', () =>
		element('script', { src: r('t=js&n=gzip-script&size=3000&enc=gzip') }),
	);
	await step('gzip-style', () =>
		element('link', {
			rel: 'stylesheet',
			href: r('t=css&n=gzip-style&size=3000&enc=gzip'),
		}),
	);
	await step('x-gzip-tao', () =>
		text(r('t=text&n=x-gzip-tao&size=3000&enc=gzip&cors=1&tao=*', cross)),
	);
	await step('gzip-chunked', () =>
		text(r('t=text&n=gzip-chunked&size=3000&enc=gzip&chunked=1')),
	);
	await step('x-gzip', () =>
		text(r('t=text&n=x-gzip&size=3000&enc=gzip&cors=1', cross)),
	);
	await step('x-gzip-script', () =>
		element('script', {
			src: r('t=js&n=x-gzip-script&size=3000&enc=gzip', cross),
		}),
	);
	await step('x-gzip-script-tao', () =>
		element('script', {
			src: r('t=js&n=x-gzip-script-tao&size=3000&enc=gzip&tao=*', cross),
		}),
	);
	for (const round of [1, 2])
		await step(`cache-gzip-${round}`, () =>
			text(
				r(`t=text&n=cache-gzip&size=3000&enc=gzip&cc=${encode('max-age=600')}`),
			),
		);
	for (const round of [1, 2])
		await step(`cache-gzip-script-${round}`, () =>
			text(
				r(
					`t=js&n=cache-gzip-script&size=3000&enc=gzip&cc=${encode('max-age=600')}`,
				),
			),
		);

	await step('range', () =>
		text(r('t=text&n=range&size=1000'), { headers: { range: 'bytes=10-109' } }),
	);

	await step(
		'sse',
		() =>
			new Promise((resolve) => {
				const source = new EventSource(`/perf/sse?n=sse&run=${run}`);
				source.onmessage = (event) => {
					source.close();
					resolve(event.data);
				};
				source.onerror = () => {
					source.close();
					resolve('error');
				};
			}),
	);
	await step(
		'ws',
		() =>
			new Promise((resolve) => {
				const socket = new WebSocket(
					`ws://${location.host}/perf/ws-echo?n=ws&run=${run}`,
				);
				socket.onmessage = () => resolve('message');
				socket.onerror = () => resolve('error');
			}),
	);
	await step('beacon', async () => {
		const sent = navigator.sendBeacon(`/perf/beacon?n=beacon&run=${run}`, 'x');
		await until(
			() =>
				performance
					.getEntriesByType('resource')
					.some((entry) => entry.name.includes('n=beacon')),
			1500,
		);
		return sent;
	});
	await step('hint', () => text(r('t=json&n=hint&hint=1')));

	// preloads
	await step('preload-fetch', () =>
		element('link', {
			rel: 'preload',
			as: 'fetch',
			crossorigin: '',
			href: r('t=json&n=preload-fetch'),
		}),
	);
	await step('preload-image', () =>
		element('link', {
			rel: 'preload',
			as: 'image',
			href: r('t=img&n=preload-image'),
		}),
	);
	await step('modulepreload', () =>
		element('link', {
			rel: 'modulepreload',
			href: r('t=js&n=modulepreload'),
		}),
	);

	// a style sheet added later, and what it loads
	await step('late-style', async () => {
		const loaded = await element('link', {
			rel: 'stylesheet',
			href: r('t=css&n=late&k=late'),
		});
		const paragraph = document.createElement('p');
		paragraph.className = 'late';
		paragraph.textContent = 'late';
		document.body.append(paragraph);
		await until(
			() =>
				performance
					.getEntriesByType('resource')
					.some((entry) => entry.name.includes('n=latebg')),
			2000,
		);
		return loaded;
	});
	await step('dyn-script', () =>
		element('script', { src: r('t=js&n=dyn-script') }),
	);
	await step('dyn-import', () =>
		import(r('t=js&n=dyn-import')).then(() => 'imported'),
	);
	await step('dyn-frame', () =>
		element(
			'iframe',
			{ src: `/perf/page/child?run=${run}&n=frame-dyn&shared=1` },
			document.body,
		),
	);

	// workers
	const workerRecord = (kind, port) =>
		new Promise((resolve) => {
			port.onmessage = (event) => {
				if (event.data && event.data.perfWorker)
					resolve((record.workers[kind] = event.data.perfWorker));
			};
			setTimeout(() => resolve('no report'), 8000);
		});
	await step('dedicated', async () => {
		const worker = new Worker(
			`/pages/perf-worker.js?kind=dedicated&run=${run}`,
		);
		const answer = await workerRecord('dedicated', worker);
		return typeof answer;
	});
	await step('shared', async () => {
		const worker = new SharedWorker(
			`/pages/perf-worker.js?kind=shared&run=${run}`,
		);
		worker.port.start();
		const answer = await workerRecord('shared', worker.port);
		return typeof answer;
	});
	await step('service', async () => {
		const registration = await navigator.serviceWorker.register(
			`/pages/perf-worker.js?kind=service&run=${run}`,
			{ scope: '/pages/perf-service-scope/' },
		);
		const worker =
			registration.installing ?? registration.waiting ?? registration.active;
		const channel = new MessageChannel();
		const answered = workerRecord('service', channel.port1);
		worker.postMessage('report', [channel.port2]);
		const answer = await answered;
		await registration.unregister();
		return typeof answer;
	});

	await until(() => Object.keys(record.frames).length >= 4, 5000);
	await sleep(300);

	const entries = resources();
	record.apart = {};
	for (const name of APART) {
		const its = performance
			.getEntriesByType('resource')
			.filter((entry) => nameOf(entry.name) === name);
		record.apart[name] = {
			count: its.length,
			first: its[0] ? describe(its[0]) : null,
		};
	}
	record.resources = {};
	const seen = new Map();
	for (const entry of entries) {
		const name = nameOf(entry.name);
		const nth = seen.get(name) ?? 0;
		seen.set(name, nth + 1);
		record.resources[`${name}#${nth}`] = describe(entry);
	}
	record.sequence = entries
		.filter((entry) => !markupLoads.has(entry))
		.map((entry) => nameOf(entry.name));
	record.observed = observed.filter((name) => !APART.includes(name)).sort();
	record.all = performance
		.getEntries()
		.filter((entry) => entry.entryType === 'resource' && !apart(entry)).length;
	// the array an entry's serverTiming is: frozen or not, the same one at
	// each read or not, and its metrics
	const arrayOf = (name) => {
		const entry = entries.find((other) => nameOf(other.name) === name);
		if (!entry) return null;
		const list = entry.serverTiming;
		return {
			frozen: Object.isFrozen(list),
			same: list === entry.serverTiming,
			array: Array.isArray(list),
			plain: Object.getPrototypeOf(list) === Array.prototype,
			length: list.length,
			metric: list[0] ? Object.prototype.toString.call(list[0]) : null,
			sameMetric: list[0] ? list[0] === entry.serverTiming[0] : null,
		};
	};
	record.serverTimingArray = {
		'st-same': arrayOf('st-same'),
		'x:x-st-tao': arrayOf('x:x-st-tao'),
		'x:x-st': arrayOf('x:x-st'),
		'fetch-get': arrayOf('fetch-get'),
	};
	record.byName = [
		performance.getEntriesByName(
			location.origin + r('t=json&n=fetch-get&size=1000'),
		).length,
		performance.getEntriesByName(
			location.origin + r('t=json&n=fetch-get&size=1000'),
			'resource',
		).length,
		performance.getEntriesByName(
			location.origin + r('t=json&n=fetch-get&size=1000'),
			'mark',
		).length,
		performance.getEntriesByName(r('t=json&n=fetch-get&size=1000')).length,
	];
	record.ran = (globalThis.__perfRan ?? []).slice().sort();
	record.href = tidy(location.href);
	window.__perf.done = true;
})();
