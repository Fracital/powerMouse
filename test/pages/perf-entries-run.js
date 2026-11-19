// The entry types of the performance fixture, second half
// (performance-entries suite, test/pages/perf-entries.html): the page makes
// one entry of every type a page can (paints, the largest contentful paint,
// element timing, marks and measures, long tasks of its own and of its
// frames, long animation frames from each kind of script, then, once the
// suite has clicked and typed, the first input, event timing and a layout
// shift) and records what each shows.
(async () => {
	const { cross, run, tidy, pick, sleep, until, attempt } = perfLib;
	const { record, observed, dropped } = window.__perf;
	const script = document.currentScript.src;

	const keys = (entry) => Object.keys(entry.toJSON()).join(',');
	const elementOf = (node) =>
		node === null || node === undefined
			? node === null
				? null
				: 'undefined'
			: `${node.nodeName}#${node.id ?? ''}`;
	const busy = (ms) => {
		const end = performance.now() + ms;
		while (performance.now() < end);
	};
	/** `work`'s result or the error it threw, as text */
	const outcome = (work) => {
		try {
			return work();
		} catch (error) {
			return `threw ${error.constructor.name} ${error.name}: ${tidy(error.message)}`;
		}
	};

	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));
	const frames = {};
	const frameAnswers = {};
	addEventListener('message', (event) => {
		if (!event.data) return;
		if (event.data.perfChildReady) frames[event.data.perfChildReady] = true;
		if (event.data.perfBusyDone)
			frameAnswers[event.data.perfBusyDone] = event.data.tasks;
		if (event.data.perfSiteDone) frameAnswers.site = event.data.perfSiteDone;
	});
	await until(() => observed.paint.length >= 2, 3000);
	await until(
		() =>
			observed['largest-contentful-paint'].some((entry) => entry.id === 'hero'),
		3000,
	);
	await until(() => observed.element.length >= 5, 3000);

	// --- paints
	record.paint = Object.fromEntries(
		performance.getEntriesByType('paint').map((entry) => [
			entry.name,
			{
				...pick(entry, ['entryType', 'duration']),
				started: entry.startTime > 0,
				paintTime:
					'paintTime' in entry ? (entry.paintTime > 0 ? 'set' : 0) : 'absent',
				presentationTime:
					'presentationTime' in entry
						? entry.presentationTime === null
							? null
							: entry.presentationTime > 0
								? 'set'
								: 0
						: 'absent',
				jsonKeys: keys(entry),
				prototype: Object.prototype.toString.call(entry),
			},
		]),
	);
	record.paintOrder = performance
		.getEntriesByType('paint')
		.map((entry) => entry.name)
		.join(',');
	record.paintObserved = observed.paint.length;

	// --- the largest contentful paint
	const candidates = observed['largest-contentful-paint'];
	const largest = candidates.at(-1);
	record.lcp = largest
		? {
				...pick(largest, ['name', 'entryType', 'duration', 'id', 'size']),
				url: tidy(largest.url),
				jsonUrl: tidy(largest.toJSON().url),
				element: elementOf(largest.element),
				loadTimeSet: largest.loadTime > 0,
				renderTimeSet: largest.renderTime > 0,
				startIsRender:
					largest.startTime === (largest.renderTime || largest.loadTime),
				jsonKeys: keys(largest),
				prototype: Object.prototype.toString.call(largest),
				inTimeline: performance.getEntriesByType('largest-contentful-paint')
					.length,
			}
		: null;
	// (which candidates came before the largest depends on what was painted
	// first: never compared)
	record.raw = {
		lcpCandidates: candidates.map((entry) => `${entry.id}:${entry.size}`),
	};

	// --- element timing
	record.element = Object.fromEntries(
		observed.element.map((entry) => [
			entry.identifier,
			{
				...pick(entry, [
					'name',
					'entryType',
					'duration',
					'id',
					'identifier',
					'naturalWidth',
					'naturalHeight',
				]),
				url: tidy(entry.url),
				jsonUrl: tidy(entry.toJSON().url),
				element: elementOf(entry.element),
				loadTimeSet: entry.loadTime > 0,
				renderTimeSet: entry.renderTime > 0,
				startIsRender: entry.startTime === (entry.renderTime || entry.loadTime),
				rect: `${entry.intersectionRect.width}x${entry.intersectionRect.height}`,
				jsonKeys: keys(entry),
				prototype: Object.prototype.toString.call(entry),
			},
		]),
	);

	// --- visibility
	record.visibility = performance
		.getEntriesByType('visibility-state')
		.map((entry) => ({
			...pick(entry, ['name', 'entryType', 'startTime', 'duration']),
			jsonKeys: keys(entry),
		}));

	// --- marks and measures
	const describeMark = (entry) => ({
		...pick(entry, ['name', 'entryType', 'duration', 'detail']),
		jsonKeys: keys(entry),
		prototype: Object.prototype.toString.call(entry),
	});
	const first = performance.mark('perf-first');
	const detailed = performance.mark('perf-detailed', {
		detail: { nested: [1, 'two'] },
		startTime: 12.5,
	});
	const constructed = new PerformanceMark('perf-constructed', { detail: 7 });
	record.marks = {
		first: describeMark(first),
		detailed: { ...describeMark(detailed), startTime: detailed.startTime },
		detailCloned: detailed.detail === detailed.detail,
		constructed: describeMark(constructed),
		constructedInTimeline:
			performance.getEntriesByName('perf-constructed').length,
		list: performance.getEntriesByType('mark').map((entry) => entry.name),
		byName: performance.getEntriesByName('perf-first', 'mark').length,
		errors: {
			timingName: outcome(() => performance.mark('navigationStart').name),
			negative: outcome(() => performance.mark('x', { startTime: -1 }).name),
			noName: outcome(() => performance.mark().name),
			uncloneable: outcome(
				() => performance.mark('x', { detail: () => {} }).name,
			),
		},
	};
	await sleep(5);
	performance.mark('perf-second');
	const between = performance.measure(
		'perf-between',
		'perf-first',
		'perf-second',
	);
	const options = performance.measure('perf-options', {
		start: 'perf-first',
		duration: 3,
		detail: { a: 1 },
	});
	const fromTiming = performance.measure(
		'perf-timing',
		'navigationStart',
		'domInteractive',
	);
	const toNow = performance.measure('perf-to-now');
	const describeMeasure = (entry) => ({
		...pick(entry, ['name', 'entryType', 'detail']),
		jsonKeys: keys(entry),
		prototype: Object.prototype.toString.call(entry),
	});
	record.measures = {
		between: {
			...describeMeasure(between),
			startIsMark: between.startTime === first.startTime,
			positive: between.duration > 0,
		},
		options: { ...describeMeasure(options), duration: options.duration },
		fromTiming: {
			...describeMeasure(fromTiming),
			startTime: fromTiming.startTime,
			isDomInteractive:
				Math.abs(
					fromTiming.duration -
						performance.getEntriesByType('navigation')[0].domInteractive,
				) < 2,
		},
		toNow: { ...describeMeasure(toNow), startTime: toNow.startTime },
		list: performance.getEntriesByType('measure').map((entry) => entry.name),
		errors: {
			noMark: outcome(() => performance.measure('x', 'perf-missing').name),
			both: outcome(
				() => performance.measure('x', { start: 1, end: 2, duration: 3 }).name,
			),
			optionsAndEnd: outcome(
				() => performance.measure('x', { start: 1 }, 'perf-first').name,
			),
			empty: outcome(() => performance.measure('x', {}).name),
		},
	};
	performance.clearMarks('perf-first');
	record.marks.afterClearOne = performance
		.getEntriesByType('mark')
		.map((entry) => entry.name);
	performance.clearMarks();
	performance.clearMeasures();
	record.marks.afterClear =
		performance.getEntriesByType('mark').length +
		performance.getEntriesByType('measure').length;
	record.observedMarks = {
		marks: observed.mark.map((entry) => entry.name),
		measures: observed.measure.map((entry) => entry.name),
	};

	// --- observers
	record.observer = {
		noOptions: outcome(() => new PerformanceObserver(() => {}).observe()),
		empty: outcome(() => new PerformanceObserver(() => {}).observe({})),
		both: outcome(() =>
			new PerformanceObserver(() => {}).observe({
				type: 'mark',
				entryTypes: ['mark'],
			}),
		),
		mixed: outcome(() => {
			const observer = new PerformanceObserver(() => {});
			observer.observe({ type: 'mark' });
			observer.observe({ entryTypes: ['measure'] });
		}),
		bufferedList: outcome(() =>
			new PerformanceObserver(() => {}).observe({
				entryTypes: ['mark'],
				buffered: true,
			}),
		),
		unknown: outcome(() =>
			new PerformanceObserver(() => {}).observe({ type: 'perf-unknown' }),
		),
		noCallback: outcome(() => new PerformanceObserver()),
		takeRecords: outcome(() => {
			const observer = new PerformanceObserver(() => {});
			observer.observe({ type: 'mark' });
			performance.mark('perf-taken');
			const taken = observer.takeRecords().map((entry) => entry.name);
			observer.disconnect();
			performance.clearMarks('perf-taken');
			return taken.join(',');
		}),
	};

	// --- long tasks and long animation frames
	const describeTask = (entry) => ({
		...pick(entry, ['name', 'entryType']),
		long: entry.duration >= 50,
		attribution: entry.attribution.map((culprit) => ({
			...pick(culprit, [
				'name',
				'entryType',
				'startTime',
				'duration',
				'containerType',
				'containerId',
				'containerName',
			]),
			containerSrc: tidy(culprit.containerSrc),
			jsonKeys: keys(culprit),
			jsonSrc: tidy(culprit.toJSON().containerSrc),
			prototype: Object.prototype.toString.call(culprit),
		})),
		jsonKeys: keys(entry),
		jsonAttribution: tidy(JSON.stringify(entry.toJSON().attribution)),
		prototype: Object.prototype.toString.call(entry),
	});
	const describeScript = (timing) => ({
		...pick(timing, [
			'name',
			'entryType',
			'invokerType',
			'sourceFunctionName',
			'sourceCharPosition',
			'windowAttribution',
		]),
		invoker: tidy(timing.invoker),
		sourceURL: tidy(timing.sourceURL),
		window:
			timing.window === window
				? 'self'
				: timing.window === null
					? null
					: 'another',
		long: timing.duration >= 50,
		executionAfterStart: timing.executionStart >= timing.startTime,
		jsonKeys: keys(timing),
		jsonInvoker: tidy(timing.toJSON().invoker),
		jsonSourceURL: tidy(timing.toJSON().sourceURL),
		prototype: Object.prototype.toString.call(timing),
	});
	const describeFrame = (entry) => ({
		...pick(entry, ['name', 'entryType']),
		long: entry.duration >= 50,
		blocking: entry.blockingDuration > 0,
		renderStartSet: entry.renderStart > 0,
		styleAndLayoutStartSet: entry.styleAndLayoutStart > 0,
		firstUIEventSet: entry.firstUIEventTimestamp > 0,
		scripts: entry.scripts
			.filter((timing) => timing.duration >= 50)
			.map(describeScript),
		// every script a frame names is the page's own
		foreign: entry.scripts
			.map((timing) => tidy(timing.sourceURL))
			.filter((url) => url && !/^(SELF|CROSS)\//.test(url)),
		jsonKeys: keys(entry),
		jsonScripts: tidy(
			JSON.stringify(
				entry
					.toJSON()
					.scripts.filter((timing) => timing.duration >= 50)
					.map((timing) => [
						timing.invoker,
						timing.sourceURL,
						timing.sourceFunctionName,
					]),
			),
		),
		jsonPositions: entry
			.toJSON()
			.scripts.filter((timing) => timing.duration >= 50)
			.map((timing) => timing.sourceCharPosition)
			.join(','),
		sameScripts: entry.scripts === entry.scripts,
		frozenScripts: Object.isFrozen(entry.scripts),
		prototype: Object.prototype.toString.call(entry),
	});
	record.tasks = {};
	record.frames = {};
	/** a phase that keeps the thread: the long task and the long animation frame that overlap it */
	const phase = async (name, work) => {
		await sleep(150);
		const start = performance.now();
		const result = await attempt(work);
		const end = performance.now();
		const overlaps = (entry) =>
			entry.startTime < end && entry.startTime + entry.duration > start;
		await until(
			() =>
				observed.longtask.some(overlaps) &&
				observed['long-animation-frame'].some(overlaps),
			1500,
		);
		const tasks = observed.longtask.filter(overlaps);
		const longFrames = observed['long-animation-frame'].filter(overlaps);
		record.tasks[name] = {
			result: typeof result === 'string' ? result : 'ran',
			count: tasks.length,
			task: tasks[0] ? describeTask(tasks[0]) : null,
		};
		record.frames[name] = {
			count: longFrames.length,
			frame: longFrames[0] ? describeFrame(longFrames[0]) : null,
		};
		return result;
	};
	await phase(
		'timer',
		() =>
			new Promise((resolve) =>
				setTimeout(function perfTimerTask() {
					busy(80);
					resolve();
				}, 0),
			),
	);
	await phase(
		'classic',
		() =>
			new Promise((resolve) => {
				const node = document.createElement('script');
				node.onload = node.onerror = resolve;
				node.src = `/pages/perf-entries-busy.js?run=${run}`;
				document.head.append(node);
			}),
	);
	await phase(
		'module',
		() => import(`/pages/perf-entries-busy-module.js?run=${run}`),
	);
	await phase('promise', () =>
		fetch(`/perf/r?t=json&n=entries-fetch&run=${run}`).then(
			function perfResolved(response) {
				busy(80);
				return response.status;
			},
		),
	);
	await phase(
		'animation',
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(function perfAnimationTask() {
					busy(80);
					resolve();
				}),
			),
	);
	await phase(
		'message',
		() =>
			new Promise((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = function perfMessageTask() {
					busy(80);
					resolve();
				};
				channel.port2.postMessage(1);
			}),
	);
	// a handler of an element the browser names by its `src`: one in the
	// document, one that is not
	for (const [name, attached] of [
		['image', true],
		['image-detached', false],
	])
		await phase(
			name,
			() =>
				new Promise((resolve) => {
					const node = new Image();
					node.onload = function perfImageLoad() {
						busy(80);
						resolve();
					};
					node.setAttribute('src', `/perf/png?w=20&h=20&n=${name}&run=${run}`);
					// (in the head: nothing to paint, so no rendering comes into
					// the frame)
					if (attached) document.head.append(node);
				}),
		);
	// a frame's task, as its parent hears of it and as the frame does
	await until(() => frames.same && frames.cross, 4000);
	for (const [name, frame] of [
		['same', document.getElementById('child-frame')],
		['cross', document.getElementById('cross-frame')],
	]) {
		await phase(`frame-${name}`, async () => {
			frame.contentWindow.postMessage({ perfBusy: name }, '*');
			await until(() => frameAnswers[name], 3000);
		});
		record.tasks[`frame-${name}`].own = frameAnswers[name] ?? 'no answer';
	}

	// a frame of another site with a frame of its own site and another
	// origin in it: what the outer one hears of the inner one's task
	await until(() => frames['site-frame'], 4000);
	await phase('frame-site', async () => {
		document
			.getElementById('site-frame')
			.contentWindow.postMessage({ perfSite: true }, '*');
		await until(() => frameAnswers.site, 3000);
	});
	record.tasks['frame-site'].site = frameAnswers.site ?? 'no answer';

	// --- input: the suite clicks the button and types into the field
	record.beforeInput = {
		interactionCount: performance.interactionCount,
		firstInput: performance.getEntriesByType('first-input').length,
	};
	const inputs = {};
	// the first input is the click's pointerdown: held busy as the click is, so
	// its entry is long however the press and the release fall into frames
	document
		.getElementById('button')
		.addEventListener('pointerdown', function perfPointerdown() {
			busy(80);
		});
	document.getElementById('button').onclick = function perfClick() {
		busy(80);
		inputs.click = true;
	};
	document
		.getElementById('input')
		.addEventListener('keydown', function perfKeydown() {
			busy(80);
			inputs.keydown = true;
		});
	const inputStart = performance.now();
	window.__perf.ready = true;
	await until(() => inputs.click && inputs.keydown, 15000);
	const inputEnd = performance.now();
	await until(
		() =>
			observed['first-input'].length > 0 &&
			observed.event.some((entry) => entry.name === 'click') &&
			observed.event.some((entry) => entry.name === 'keydown'),
		2500,
	);
	const describeEvent = (entry) =>
		entry
			? {
					...pick(entry, ['name', 'entryType', 'cancelable']),
					target: elementOf(entry.target),
					interaction: entry.interactionId > 0,
					long: entry.duration >= 80,
					eighths: entry.duration % 8 === 0,
					processingOrdered:
						entry.startTime <= entry.processingStart &&
						entry.processingStart <= entry.processingEnd,
					jsonKeys: keys(entry),
					prototype: Object.prototype.toString.call(entry),
				}
			: null;
	const firstInput = observed['first-input'][0];
	record.firstInput = {
		...describeEvent(firstInput),
		count: observed['first-input'].length,
		inTimeline: performance.getEntriesByType('first-input').length,
	};
	record.events = {
		click: describeEvent(
			observed.event.find((entry) => entry.name === 'click'),
		),
		keydown: describeEvent(
			observed.event.find((entry) => entry.name === 'keydown'),
		),
		inputs: Object.keys(inputs).sort().join(','),
	};
	const counted = [
		'click',
		'pointerdown',
		'pointerup',
		'mousedown',
		'mouseup',
		'keydown',
		'keypress',
		'keyup',
		'input',
		'beforeinput',
		'focusin',
	];
	record.afterInput = {
		interactionCount: performance.interactionCount,
		counts: Object.fromEntries(
			counted.map((name) => [name, performance.eventCounts.get(name)]),
		),
		eventCounts: [...performance.eventCounts.keys()].join(','),
		mapLike: Object.prototype.toString.call(performance.eventCounts),
		sameMap: performance.eventCounts === performance.eventCounts,
	};
	for (const name of ['click', 'keydown']) {
		const overlaps = (entry) =>
			entry.startTime < inputEnd &&
			entry.startTime + entry.duration > inputStart &&
			entry.scripts.some((timing) =>
				timing.sourceFunctionName.toLowerCase().includes(name),
			);
		await until(() => observed['long-animation-frame'].some(overlaps), 1000);
		const longFrame = observed['long-animation-frame'].find(overlaps);
		record.frames[name] = {
			frame: longFrame ? describeFrame(longFrame) : null,
		};
	}

	// --- a layout shift, long enough after the input to be its own
	await sleep(700);
	const shiftStart = performance.now();
	const block = document.createElement('div');
	block.id = 'shifter';
	block.style.height = '100px';
	document.getElementById('tail').before(block);
	const shifted = (entry) => entry.startTime >= shiftStart - 1;
	await until(() => observed['layout-shift'].some(shifted), 2500);
	const shift = observed['layout-shift'].find(shifted);
	record.layoutShift = shift
		? {
				...pick(shift, ['name', 'entryType', 'duration', 'hadRecentInput']),
				positive: shift.value > 0,
				lastInputSet: shift.lastInputTime > 0,
				// (the elements with a name: where the rest end up depends on
				// the height of the viewport)
				sources: shift.sources
					.filter((source) => source.node && source.node.id)
					.map((source) => ({
						node: elementOf(source.node),
						moved: source.currentRect.y - source.previousRect.y,
						jsonKeys: Object.keys(source.toJSON()).join(','),
						prototype: Object.prototype.toString.call(source),
					})),
				jsonKeys: keys(shift),
				prototype: Object.prototype.toString.call(shift),
			}
		: null;

	// --- what every buffered observer was told
	await sleep(100);
	record.dropped = { ...dropped };
	record.emptyLists = { ...window.__perf.empty };
	record.buffered = {
		navigation: observed.navigation.length,
		paint: observed.paint.length,
		'visibility-state': observed['visibility-state'].length,
		'first-input': observed['first-input'].length,
		element: observed.element.length,
		back: observed['back-forward-cache-restoration']?.length ?? 'absent',
		softNavigation: observed['soft-navigation']?.length ?? 'absent',
	};
	// every script any long animation frame named, the whole load long
	record.foreignScripts = [
		...new Set(
			observed['long-animation-frame'].flatMap((entry) =>
				entry.scripts.flatMap((timing) => [
					tidy(timing.sourceURL),
					tidy(timing.invoker),
				]),
			),
		),
	]
		.filter((text) => /stomp|inject|rewriter|\/html\/|\/js\//.test(text))
		.sort();
	record.raw.scripts = observed['long-animation-frame'].flatMap((entry) =>
		entry.scripts.map(
			(timing) =>
				`${timing.invokerType} ${tidy(timing.invoker)} ${tidy(timing.sourceURL)} ${timing.sourceFunctionName} ${timing.sourceCharPosition} ${Math.round(timing.duration)}`,
		),
	);
	record.raw.tasks = observed.longtask.map(
		(entry) =>
			`${entry.name} ${Math.round(entry.startTime)} ${Math.round(entry.duration)} ${entry.attribution.map((culprit) => `${culprit.containerType}|${tidy(culprit.containerSrc)}|${culprit.containerId}|${culprit.containerName}`)}`,
	);
	record.raw.script = tidy(script);
	record.raw.cross = cross;
	window.__perf.done = true;
})();
