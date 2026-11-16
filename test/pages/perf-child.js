// A frame of the performance fixture (performance-* suites): it loads an
// image and a fetch of its own and tells its parent what its own
// performance object shows.
(async () => {
	const { describe, describeNavigation, attempt, sleep } = perfLib;
	const script = document.currentScript;
	const params = new URLSearchParams(
		location.search || new URL(script.src).search,
	);
	const name = params.get('n') ?? 'frame';
	const run = params.get('run') ?? '';
	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));
	await attempt(() =>
		fetch(`/perf/r?t=json&n=${name}-fetch&run=${run}`).then((response) =>
			response.text(),
		),
	);
	await new Promise((resolve) => {
		const image = new Image();
		image.onload = image.onerror = resolve;
		image.src = `/perf/r?t=img&n=${name}-img&run=${run}`;
	});
	// what the parent's document loaded already and may keep: this
	// document's entries for the renderer's memory cache and the HTTP cache
	if (params.get('shared')) {
		const kept = encodeURIComponent('max-age=600');
		await new Promise((resolve) => {
			const image = new Image();
			image.onload = image.onerror = resolve;
			image.src = `/perf/r?t=img&n=cache-img&cc=${kept}&run=${run}`;
		});
		await attempt(() =>
			fetch(
				`/perf/r?t=json&n=cache-fetch&size=1200&cc=${kept}&run=${run}`,
			).then((response) => response.text()),
		);
		await new Promise((resolve) => {
			const script = document.createElement('script');
			script.onload = script.onerror = resolve;
			script.src = `/perf/r?t=js&n=cache-script&size=1500&cc=${kept}&run=${run}`;
			document.head.append(script);
		});
	}
	await sleep(100);
	const navigation = performance.getEntriesByType('navigation');
	parent.postMessage(
		{
			perfChild: name,
			record: {
				navigationCount: navigation.length,
				navigation: navigation[0] ? describeNavigation(navigation[0]) : null,
				resources: Object.fromEntries(
					performance
						.getEntriesByType('resource')
						.map((entry) => [perfLib.nameOf(entry.name), describe(entry)]),
				),
				nowBelowAge:
					performance.now() <= Date.now() - performance.timeOrigin + 50,
			},
		},
		'*',
	);
})();
