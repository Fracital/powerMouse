// The navigations of the performance fixture (performance-navigation suite,
// test/pages/perf-navigation.html): the page walks itself through every
// kind of navigation a page can make (a plain one, through same-origin
// redirects, through another origin's redirect, from another origin's
// document, a reload, one with Server-Timing, back) and records after each
// what navigation timing and the two older interfaces show. The records
// ride in sessionStorage; the last document publishes them.
(async () => {
	const { cross, run, tidy, pick, timeShape, sleep } = perfLib;
	const params = new URLSearchParams(location.search);
	const step = Number(params.get('step') ?? 0);
	const KEY = `perf-navigation-${run}`;
	const state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') ?? {
		records: {},
		reloaded: false,
		back: false,
	};
	const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
	const page = (query) => `/perf/page/navigation?run=${run}${query}`;
	const encode = encodeURIComponent;
	/** a name without the run and the step */
	const plain = (text) => tidy(text).replace(/&step=\d+/, '&step=N');

	const NAVIGATION_TIMES = [
		'unloadEventStart',
		'unloadEventEnd',
		'domInteractive',
		'domContentLoadedEventStart',
		'domContentLoadedEventEnd',
		'domComplete',
		'loadEventStart',
		'loadEventEnd',
	];
	const LEGACY = [
		'navigationStart',
		'unloadEventStart',
		'unloadEventEnd',
		'redirectStart',
		'redirectEnd',
		'fetchStart',
		'domainLookupStart',
		'domainLookupEnd',
		'connectStart',
		'connectEnd',
		'secureConnectionStart',
		'requestStart',
		'responseStart',
		'responseEnd',
		'domLoading',
		'domInteractive',
		'domContentLoadedEventStart',
		'domContentLoadedEventEnd',
		'domComplete',
		'loadEventStart',
		'loadEventEnd',
	];
	const zeroes = (object, names) =>
		names.filter((name) => object[name] === 0).join(',');
	const inOrder = (object, names) => {
		const values = names
			.map((name) => object[name])
			.filter((value) => typeof value === 'number' && value !== 0);
		return values.every((value, i) => i === 0 || value >= values[i - 1]);
	};

	/** a navigation's confidence: everything of it but the value, which the browser draws */
	const confidence = (entry) => {
		if (!('confidence' in entry)) return 'absent';
		const read = entry.confidence;
		if (read === null) return null;
		const json = entry.toJSON().confidence;
		return {
			keys: Object.keys(read.toJSON()).join(','),
			rate: read.randomizedTriggerRate,
			valued: read.value === 'high' || read.value === 'low',
			steady: entry.confidence.value === read.value,
			fresh: entry.confidence !== read,
			prototype: Object.prototype.toString.call(read),
			isConfidence: read instanceof PerformanceTimingConfidence,
			jsonKeys: json === null ? null : Object.keys(json).join(','),
			jsonAgrees: json !== null && json.value === read.value,
			text: JSON.stringify(read) === JSON.stringify(json),
			own: Object.keys(read).join(','),
		};
	};
	const record = () => {
		const entries = performance.getEntriesByType('navigation');
		const [entry] = entries;
		const json = entry.toJSON();
		const timing = performance.timing;
		const navigation = performance.navigation;
		const observed = [];
		new PerformanceObserver((list) => {
			for (const seen of list.getEntries())
				observed.push(`${seen.entryType} ${plain(seen.name)} ${seen.type}`);
		}).observe({ type: 'navigation', buffered: true });
		const out = {
			count: entries.length,
			name: plain(entry.name),
			jsonName: plain(json.name),
			byName: performance.getEntriesByName(location.href).length,
			byNameTyped: performance.getEntriesByName(location.href, 'navigation')
				.length,
			inAll: performance
				.getEntries()
				.filter((other) => other.entryType === 'navigation').length,
			isFirst: performance.getEntries()[0] === entry,
			same: performance.getEntriesByType('navigation')[0] === entry,
			...pick(entry, [
				'entryType',
				'initiatorType',
				'startTime',
				'type',
				'redirectCount',
				'activationStart',
				'criticalCHRestart',
				'deliveryType',
			]),
			durationPositive: entry.duration > 0,
			durationIsLoadEnd: entry.duration === entry.loadEventEnd,
			notRestoredReasons:
				'notRestoredReasons' in entry
					? entry.notRestoredReasons === null
						? null
						: plain(JSON.stringify(entry.notRestoredReasons))
					: 'absent',
			confidence: confidence(entry),
			serverTiming: entry.serverTiming.map((metric) => metric.toJSON()),
			jsonServerTiming: json.serverTiming,
			redirect: {
				startZero: entry.redirectStart === 0,
				endZero: entry.redirectEnd === 0,
				startIsZeroTime: entry.redirectStart === entry.startTime,
				endBeforeFetch: entry.redirectEnd <= entry.fetchStart,
			},
			times: {
				zero: zeroes(entry, NAVIGATION_TIMES),
				ordered: inOrder(entry, [
					'responseStart',
					'domInteractive',
					'domContentLoadedEventStart',
					'domContentLoadedEventEnd',
					'domComplete',
					'loadEventStart',
					'loadEventEnd',
				]),
				unloadOrdered: entry.unloadEventStart <= entry.unloadEventEnd,
				jsonZero: zeroes(json, NAVIGATION_TIMES),
			},
			jsonKeys: Object.keys(json).join(','),
			jsonType: json.type,
			jsonRedirectCount: json.redirectCount,
			prototype: Object.prototype.toString.call(entry),
			timing: {
				zero: zeroes(timing, LEGACY),
				ordered: inOrder(timing, [
					'navigationStart',
					'fetchStart',
					'domainLookupStart',
					'domainLookupEnd',
					'connectStart',
					'connectEnd',
					'requestStart',
					'responseStart',
					'responseEnd',
					'domInteractive',
					'domContentLoadedEventStart',
					'domContentLoadedEventEnd',
					'domComplete',
					'loadEventStart',
					'loadEventEnd',
				]),
				redirectOrdered:
					timing.redirectStart === 0 ||
					(timing.navigationStart <= timing.redirectStart &&
						timing.redirectStart <= timing.redirectEnd &&
						timing.redirectEnd <= timing.fetchStart),
				unloadZeroAsEntry:
					(timing.unloadEventStart === 0) === (entry.unloadEventStart === 0),
				redirectZeroAsEntry:
					(timing.redirectStart === 0) === (entry.redirectStart === 0),
				// the entry's times are the old interface's, counted from the
				// time origin
				startIsOrigin:
					Math.abs(timing.navigationStart - performance.timeOrigin) < 2,
				integers: LEGACY.every((name) => Number.isInteger(timing[name])),
				jsonKeys: Object.keys(timing.toJSON()).join(','),
				jsonZero: zeroes(timing.toJSON(), LEGACY),
				keys: Object.keys(Object.getPrototypeOf(timing)).join(','),
				prototype: Object.prototype.toString.call(timing),
				same: performance.timing === timing,
			},
			navigation: {
				type: navigation.type,
				redirectCount: navigation.redirectCount,
				json: JSON.stringify(navigation.toJSON()),
				keys: Object.keys(Object.getPrototypeOf(navigation)).join(','),
				prototype: Object.prototype.toString.call(navigation),
				same: performance.navigation === navigation,
			},
			performanceJSON: Object.keys(performance.toJSON()).join(','),
			referrer: plain(document.referrer),
			observed,
		};
		return out;
	};

	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));
	// (loadEventEnd is set once the load event's listeners have run)
	await sleep(50);

	const keep = (name) => {
		state.records[name] = record();
		save();
	};
	const origin = location.origin;
	if (step === 0) {
		keep('direct');
		// two redirects of the page's own origin
		location.href = `/perf/r?n=nav-redirect&run=${run}&to=${encode(
			`/perf/r?n=nav-redirect-2&run=${run}&to=${encode(page('&step=1'))}`,
		)}`;
	} else if (step === 1) {
		keep('redirected');
		// through another origin and back
		location.href = `/perf/r?n=nav-cross&run=${run}&to=${encode(
			`${cross}/perf/r?n=nav-cross-2&run=${run}&to=${encode(origin + page('&step=2'))}`,
		)}`;
	} else if (step === 2) {
		keep('crossRedirected');
		// through a document of another origin
		location.href = `${cross}/perf/page/navigation-hop?run=${run}&next=${encode(
			origin + page('&step=3'),
		)}`;
	} else if (step === 3 && !state.reloaded) {
		keep('fromCross');
		state.reloaded = true;
		save();
		location.reload();
	} else if (step === 3 && !state.back) {
		keep('reloaded');
		location.href = page(
			`&step=4&st=${encode('db;dur=53, app;dur=47.2;desc="x y", miss')}`,
		);
	} else if (step === 4) {
		keep('serverTiming');
		state.back = true;
		save();
		history.back();
	} else {
		keep('back');
		// documents in frames: through redirects of the page's origin,
		// through another origin's, another origin's document, and each
		// kind of document a frame's next navigation leaves behind
		const frames = {};
		addEventListener('message', (event) => {
			if (event.data && event.data.perfNavigationChild)
				frames[event.data.perfNavigationChild] = event.data.record;
		});
		const child = (name, next = '') =>
			`/perf/page/navigation-child?run=${run}&n=${name}${next ? `&next=${encode(next)}` : ''}`;
		const hop = (to, at = '') =>
			`${at}/perf/r?n=nav-frame&run=${run}&to=${encode(to)}`;
		const sources = [
			hop(hop(child('frameRedirected'))),
			hop(hop(origin + child('frameCrossRedirected'), cross)),
			hop(cross + child('frameOther')),
			child(
				'frameFirst',
				origin +
					child(
						'frameSecond',
						cross + child('frameThird', origin + child('frameFourth')),
					),
			),
		];
		for (const source of sources) {
			const frame = document.createElement('iframe');
			frame.src = source;
			document.body.append(frame);
		}
		await perfLib.until(() => Object.keys(frames).length >= 7, 10000);
		state.records.frames = frames;
		window.__perf = { page: 'navigation', done: true, record: state.records };
	}
})();
