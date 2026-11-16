// The clocks and the memory figures of the performance fixture
// (performance-clocks suite, test/pages/perf-clocks.html): what a page reads
// of its time origin and its frames' and workers', of how fine its clock is,
// of performance.memory in itself and its frames, and (isolated, `coi=1`)
// of performance.measureUserAgentSpecificMemory(). Nothing here is a time:
// every value is a relation between two readings or a shape.
(async () => {
	const { run, attempt, sleep, until, tidy } = perfLib;
	const record = {};
	window.__perf = { page: 'clocks', ready: false, done: false, record };
	const frames = {};
	addEventListener('message', (event) => {
		if (event.data && event.data.perfClock)
			frames[event.data.perfClock] = {
				...event.data.record,
				heardAt: Date.now(),
			};
	});
	const scriptNow = performance.now();
	// (made here: an about:blank frame in the markup is another matter)
	const blankFrame = document.createElement('iframe');
	blankFrame.id = 'blank';
	blankFrame.src = 'about:blank';
	document.body.append(blankFrame);
	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));

	/** the smallest step of a clock, in microseconds */
	const step = (read) => {
		let smallest = Infinity;
		let last = read();
		for (let i = 0; i < 200000 && smallest > 0.0051; i++) {
			const next = read();
			if (next !== last) {
				smallest = Math.min(smallest, next - last);
				last = next;
			}
		}
		return Math.round(smallest * 1000);
	};
	const origin = performance.timeOrigin;
	/** the time origins of the page and of its site's frames and workers (record.grain) */
	const origins = [origin];
	const navigation = performance.getEntriesByType('navigation')[0];

	record.self = await attempt(() => ({
		crossOriginIsolated: self.crossOriginIsolated,
		originType: typeof origin,
		originStable: performance.timeOrigin === origin,
		// the origin is a past moment of the wall clock, and now() counts from it
		originBeforeNow: origin <= Date.now(),
		wallAgrees: Math.abs(Date.now() - (origin + performance.now())) < 250,
		originBeforeFirstScript: origin <= window.__firstDate,
		firstScriptAfterResponse: window.__firstNow >= navigation.responseStart,
		firstScriptBeforeInteractive:
			window.__firstNow <= navigation.domInteractive,
		scriptsInOrder: window.__firstNow <= scriptNow,
		nowStep: step(() => performance.now()),
		eventStep: step(() => new Event('x').timeStamp),
		eventNear: (() => {
			const before = performance.now();
			const stamp = new Event('x').timeStamp;
			return stamp >= before && stamp <= performance.now();
		})(),
		timeline: [
			typeof document.timeline.currentTime,
			document.timeline.currentTime <= performance.now(),
		].join(','),
		json: (() => {
			const json = performance.toJSON();
			return {
				keys: Object.keys(json).join(','),
				timeOrigin: json.timeOrigin === origin,
				timing: Object.keys(json.timing ?? {}).join(','),
				navigation: JSON.stringify(json.navigation),
				memory: JSON.stringify(Object.keys(json.memory ?? {})),
				string: tidy(JSON.stringify(performance)).replace(/\d+(\.\d+)?/g, 'N'),
			};
		})(),
	}));

	// frames: each has a clock of its own, started after its parent's
	await until(() => Object.keys(frames).length >= 3, 6000);
	const blank = document.getElementById('blank').contentWindow;
	const made = document.createElement('iframe');
	const madeAt = Date.now();
	const madeNow = performance.now();
	document.body.append(made);
	const madeWindow = made.contentWindow;
	const frameClock = (name, its) => {
		if (!its) return 'no report';
		if (name !== 'cross') origins.push(its.timeOrigin);
		return {
			originAfterParent: its.timeOrigin >= origin,
			originBeforeReport: its.timeOrigin <= its.date + 1,
			nowBelowParent: its.now <= performance.now(),
			wallAgrees: Math.abs(its.date - (its.timeOrigin + its.now)) < 250,
			navigation: its.navigation,
		};
	};
	const reach = (name, w) =>
		attempt(() => ({
			...frameClock(name, {
				timeOrigin: w.performance.timeOrigin,
				now: w.performance.now(),
				date: Date.now(),
				navigation: w.performance
					.getEntriesByType('navigation')
					.map((entry) => `${tidy(entry.name)} ${entry.type}`)
					.join(),
			}),
			sameOriginAsParent: w.performance.timeOrigin === origin,
			samePerformance: w.performance === performance,
			ownInterface: w.performance instanceof w.Performance,
			notParents: !(w.performance instanceof Performance),
		}));
	record.frames = {
		same: frameClock('same', frames.same),
		cross: frameClock('cross', frames.cross),
		srcdoc: frameClock('srcdoc', frames.srcdoc),
		sameReached: await reach(
			'same',
			document.getElementById('same').contentWindow,
		),
		blank: await reach('blank', blank),
		made: {
			...(await reach('made', madeWindow)),
			originAfterCreation: madeWindow.performance.timeOrigin >= madeAt - 1,
			nowSinceCreation:
				madeWindow.performance.now() <= performance.now() - madeNow + 5,
		},
	};

	// workers
	const workerClock = (kind) =>
		attempt(
			() =>
				new Promise((resolve) => {
					const createdAt = Date.now();
					const code = `/pages/perf-clock-worker.js?kind=${kind}&run=${run}`;
					const answer = (data) => {
						const heardAt = Date.now();
						origins.push(data.timeOrigin);
						resolve({
							originAfterParent: data.timeOrigin >= origin,
							originAfterCreation: data.timeOrigin >= createdAt - 1,
							originBeforeAnswer: data.timeOrigin <= heardAt + 1,
							firstNowSmall: data.firstNow <= heardAt - createdAt + 5,
							wallAgrees:
								Math.abs(data.date - (data.timeOrigin + data.now)) < 250,
							nowStep: data.nowStep,
							crossOriginIsolated: data.crossOriginIsolated,
							memory: data.memory,
							measure: data.measure,
							json: data.json,
						});
					};
					if (kind === 'shared') {
						const worker = new SharedWorker(code);
						worker.port.onmessage = (event) => answer(event.data);
						worker.port.start();
					} else {
						const worker = new Worker(code);
						worker.onmessage = (event) => answer(event.data);
					}
					setTimeout(() => resolve('no report'), 8000);
				}),
		);
	record.workers = {
		dedicated: await workerClock('dedicated'),
		shared: await workerClock('shared'),
	};
	// How fine a time origin is: a tenth of a millisecond without isolation,
	// five microseconds with it. One origin lands on a tenth by chance one
	// time in twenty, so the page's and those of its site's frames and
	// workers are read together: with isolation hardly ever all on tenths
	record.grain = {
		onTenths: origins.every(
			(at) => Math.abs(at * 10 - Math.round(at * 10)) < 1e-3,
		),
		count: origins.length,
		raw: origins,
	};

	// performance.memory
	record.memory = await attempt(async () => {
		const read = () => performance.memory;
		const memory = read();
		if (!memory) return 'absent';
		const forIn = [];
		for (const key in memory) forIn.push(key);
		const first = memory.usedJSHeapSize;
		const burst = new Set();
		for (let i = 0; i < 50; i++) burst.add(read().usedJSHeapSize);
		// 24 MB the page keeps, then a reading a little later
		const kept = [];
		for (let i = 0; i < 24; i++) kept.push(new Array(131072).fill(i));
		window.__perfKept = kept;
		await sleep(120);
		const later = read().usedJSHeapSize;
		for (const name of ['same', 'cross'])
			document
				.getElementById(name)
				.contentWindow.postMessage('perfClockAgain', '*');
		const mine = read();
		const reached =
			document.getElementById('same').contentWindow.performance.memory;
		const sameNow = reached.usedJSHeapSize === read().usedJSHeapSize;
		const blankNow =
			blank.performance.memory.usedJSHeapSize === read().usedJSHeapSize;
		const stamp = Date.now();
		await until(
			() => frames.same?.heardAt >= stamp && frames.cross?.heardAt >= stamp,
			3000,
		);
		return {
			type: Object.prototype.toString.call(memory),
			sameObject: read() === read(),
			ownKeys: Reflect.ownKeys(memory).join(','),
			forIn: forIn.join(','),
			json: JSON.stringify(memory).replace(/\d+/g, 'N'),
			types: [
				typeof memory.jsHeapSizeLimit,
				typeof memory.totalJSHeapSize,
				typeof memory.usedJSHeapSize,
			].join(','),
			ordered:
				memory.usedJSHeapSize <= memory.totalJSHeapSize &&
				memory.totalJSHeapSize <= memory.jsHeapSizeLimit,
			integers: [
				mine.usedJSHeapSize,
				mine.totalJSHeapSize,
				mine.jsHeapSizeLimit,
			]
				.map(Number.isInteger)
				.join(','),
			// a bucketed figure is a round one, an exact one hardly ever
			usedRound: [first, later].map((value) => value % 1000 === 0).join(','),
			totalRound: mine.totalJSHeapSize % 1000 === 0,
			limitRound: mine.jsHeapSizeLimit % 1000 === 0,
			burstValues: burst.size,
			grewWithThePage: later - first > 2 * 1024 * 1024,
			limitStable: read().jsHeapSizeLimit === memory.jsHeapSizeLimit,
			writable: (() => {
				const before = read().usedJSHeapSize;
				const one = read();
				try {
					one.usedJSHeapSize = 1;
				} catch (error) {
					return `threw ${error.name}`;
				}
				return one.usedJSHeapSize === 1
					? 'kept'
					: one.usedJSHeapSize === before
						? 'ignored'
						: 'changed';
			})(),
			frames: {
				// a frame of the page's site reads the page's figure; a frame of
				// another site has a process, and a heap, of its own
				sameReachedEqual: sameNow,
				blankEqual: blankNow,
				sameReportedNear:
					Math.abs(frames.same.used - mine.usedJSHeapSize) < 3 * 1024 * 1024,
				crossDiffers: frames.cross.used !== mine.usedJSHeapSize,
				crossSmaller:
					frames.cross.used < mine.usedJSHeapSize - 12 * 1024 * 1024,
				crossLimitEqual: frames.cross.limit === mine.jsHeapSizeLimit,
				sameLimitEqual: frames.same.limit === mine.jsHeapSizeLimit,
			},
			// (read, not compared)
			raw: { first, later, cross: frames.cross.used, same: frames.same.used },
		};
	});

	// performance.measureUserAgentSpecificMemory()
	record.measure = await attempt(async () => {
		const out = {
			type: typeof performance.measureUserAgentSpecificMemory,
			onPrototype: 'measureUserAgentSpecificMemory' in Performance.prototype,
		};
		if (out.type !== 'function') return out;
		const pending = performance.measureUserAgentSpecificMemory();
		out.promise = Object.prototype.toString.call(pending);
		// the browser measures at its next collection
		const timer = setInterval(() => typeof gc === 'function' && gc(), 200);
		const result = await Promise.race([pending, sleep(25000).then(() => null)]);
		clearInterval(timer);
		if (!result) return { ...out, result: 'none in 25 s' };
		out.keys = Object.keys(result).join(',');
		out.bytes = [
			typeof result.bytes,
			Number.isInteger(result.bytes),
			result.bytes > 0,
		].join(',');
		out.sums =
			result.breakdown.reduce((sum, part) => sum + part.bytes, 0) ===
			result.bytes;
		out.breakdownKeys = [
			...new Set(result.breakdown.map((part) => Object.keys(part).join(','))),
		].join(' | ');
		out.types = [...new Set(result.breakdown.flatMap((part) => part.types))]
			.sort()
			.join(',');
		out.attribution = [
			...new Set(
				result.breakdown.flatMap((part) =>
					part.attribution.map((where) =>
						tidy(
							JSON.stringify({
								keys: Object.keys(where).join(','),
								url: where.url,
								scope: where.scope,
								container: where.container ?? null,
							}),
						),
					),
				),
			),
		].sort();
		out.frozen = Object.isFrozen(result);
		return out;
	});

	window.__perf.done = true;
})();
