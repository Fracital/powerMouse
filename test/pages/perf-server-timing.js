// A site's own Server-Timing metrics named like the service worker's marks
// (performance-server-timing suite): the page's document and each load
// below come with the metrics of the page's `st` parameter, and the page
// records what its resource timing, its navigation timing and its response
// headers show of them.
(async () => {
	const { r, cross, attempt, sleep, describe, nameOf } = perfLib;
	const record = { steps: {}, resources: {}, headers: {} };
	window.__perf = { page: 'server-timing', done: false, record };
	const st = encodeURIComponent(
		new URLSearchParams(location.search).get('st') ?? '',
	);

	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));

	const step = async (name, work) => {
		record.steps[name] = await attempt(work);
		await sleep(30);
	};
	const fetched = async (name, url) => {
		const response = await fetch(url, { credentials: 'include' });
		await response.text();
		record.headers[name] = response.headers.get('server-timing');
		return `${response.status} ${response.type}`;
	};
	const element = (tag, attributes) =>
		new Promise((resolve) => {
			const node = document.createElement(tag);
			node.onload = () => resolve('load');
			node.onerror = () => resolve('error');
			for (const [key, value] of Object.entries(attributes))
				node.setAttribute(key, value);
			document.body.append(node);
		});

	await step('script', () =>
		element('script', { src: r(`t=js&n=script&st=${st}`) }),
	);
	await step('img', () => element('img', { src: r(`t=img&n=img&st=${st}`) }));
	await step('x-img-tao', () =>
		element('img', { src: r(`t=img&n=x-img-tao&tao=origin&st=${st}`, cross) }),
	);
	await step('x-img', () =>
		element('img', { src: r(`t=img&n=x-img&st=${st}`, cross) }),
	);
	await step('fetch', () => fetched('fetch', r(`t=json&n=fetch&st=${st}`)));
	await step('x-fetch-tao', () =>
		fetched(
			'x-fetch-tao',
			r(`t=json&n=x-fetch-tao&cors=1&tao=*&expose=1&st=${st}`, cross),
		),
	);
	await step('x-fetch-tao-hidden', () =>
		fetched(
			'x-fetch-tao-hidden',
			r(`t=json&n=x-fetch-tao-hidden&cors=1&tao=*&st=${st}`, cross),
		),
	);
	await step('x-fetch', () =>
		fetched('x-fetch', r(`t=json&n=x-fetch&cors=1&expose=1&st=${st}`, cross)),
	);
	await step(
		'xhr',
		() =>
			new Promise((resolve) => {
				const request = new XMLHttpRequest();
				request.open('GET', r(`t=json&n=xhr&st=${st}`));
				request.onloadend = () => {
					record.headers.xhr = request.getResponseHeader('server-timing');
					record.headers.xhrAll = request
						.getAllResponseHeaders()
						.split('\r\n')
						.filter((line) => line.startsWith('server-timing:'));
					resolve(String(request.status));
				};
				request.send();
			}),
	);
	await sleep(300);

	// each metric as its getters read it, beside toJSON (describe)
	const metrics = (entry) =>
		entry.serverTiming.map(
			(metric) => `${metric.name}|${metric.duration}|${metric.description}`,
		);
	for (const entry of performance.getEntriesByType('resource')) {
		const name = nameOf(entry.name).replace(/^x:/, '');
		if (!(name in record.steps)) continue;
		record.resources[name] = { ...describe(entry), metrics: metrics(entry) };
	}
	const navigation = performance.getEntriesByType('navigation')[0];
	record.navigation = {
		serverTiming: navigation.serverTiming.map((metric) => metric.toJSON()),
		json: navigation.toJSON().serverTiming,
		metrics: metrics(navigation),
		redirectCount: navigation.redirectCount,
	};
	window.__perf.done = true;
})();
