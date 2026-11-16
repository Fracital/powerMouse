// The entry types of the performance fixture, first half (performance-entries
// suite, test/pages/perf-entries.html): run in the head, before the page has
// done anything, it records what the timeline holds at the start and starts
// one buffered observer for every entry type. perf-entries-run.js makes the
// entries and records them.
(() => {
	const record = {};
	const observed = {};
	const dropped = {};
	const empty = {};
	window.__perf = {
		page: 'entries',
		ready: false,
		done: false,
		record,
		observed,
		dropped,
		empty,
	};

	// what the timeline holds before the page made anything: the inject
	// leaves no mark, no measure and no entry type of its own
	record.start = {
		marks: performance.getEntriesByType('mark').map((entry) => entry.name),
		measures: performance
			.getEntriesByType('measure')
			.map((entry) => entry.name),
		// (a long frame or task this early is the time the load took, which
		// is not the same from run to run)
		types: [
			...new Set(performance.getEntries().map((entry) => entry.entryType)),
		]
			.filter((type) => !type.startsWith('long'))
			.sort()
			.join(','),
		eventCounts: [...performance.eventCounts.keys()].join(','),
		eventCountsSize: performance.eventCounts.size,
		eventCountsTotal: [...performance.eventCounts.values()].reduce(
			(sum, count) => sum + count,
			0,
		),
		interactionCount: performance.interactionCount,
	};

	const supported = PerformanceObserver.supportedEntryTypes;
	record.supported = {
		types: supported.join(','),
		frozen: Object.isFrozen(supported),
		isArray: Array.isArray(supported),
		same: PerformanceObserver.supportedEntryTypes === supported,
		descriptor: JSON.stringify(
			Object.getOwnPropertyDescriptor(
				PerformanceObserver,
				'supportedEntryTypes',
			),
			(key, value) =>
				typeof value === 'function' ? `function ${value.name}` : value,
		),
	};

	for (const type of supported) {
		observed[type] = [];
		try {
			new PerformanceObserver((list, observer, options) => {
				if (!(type in dropped))
					dropped[type] = options ? options.droppedEntriesCount : 'no options';
				const entries = list.getEntries();
				// a callback is only ever run with something to tell
				if (!entries.length) empty[type] = (empty[type] ?? 0) + 1;
				observed[type].push(...entries);
			}).observe(
				type === 'event'
					? { type, buffered: true, durationThreshold: 16 }
					: { type, buffered: true },
			);
		} catch (error) {
			dropped[type] = `threw ${error.name}`;
		}
	}
})();
