// Shared by the performance fixture pages and their workers (performance-*
// suites): what a context records of a timing entry. Times vary from run to
// run, so an entry is described by what does not: which of its times are
// zero, whether they are in order, which are equal, and every field that is
// not a time.
(() => {
	const TIMES = [
		'startTime',
		'redirectStart',
		'redirectEnd',
		'workerStart',
		'fetchStart',
		'domainLookupStart',
		'domainLookupEnd',
		'connectStart',
		'secureConnectionStart',
		'connectEnd',
		'requestStart',
		'firstInterimResponseStart',
		'finalResponseHeadersStart',
		'responseStart',
		'responseEnd',
	];
	// the order the specification gives the times of a fetch (workerStart
	// and secureConnectionStart are apart: no worker, no TLS)
	const ORDER = [
		'startTime',
		'redirectStart',
		'redirectEnd',
		'fetchStart',
		'domainLookupStart',
		'domainLookupEnd',
		'connectStart',
		'connectEnd',
		'requestStart',
		'responseStart',
		'responseEnd',
	];
	const NAVIGATION_TIMES = [
		'unloadEventStart',
		'unloadEventEnd',
		'domInteractive',
		'domContentLoadedEventStart',
		'domContentLoadedEventEnd',
		'domComplete',
		'loadEventStart',
		'loadEventEnd',
		'activationStart',
		'criticalCHRestart',
	];
	const self = globalThis.location ? globalThis.location.origin : '';
	const port = globalThis.location ? globalThis.location.port : '';
	const cross = self.includes('127.0.0.1')
		? `http://localhost:${port}`
		: `http://127.0.0.1:${port}`;
	const run = globalThis.location
		? (new URLSearchParams(globalThis.location.search).get('run') ?? '')
		: '';

	/** a URL (or any text with URLs) without what differs from run to run */
	const tidy = (text) => {
		let out = String(text).split(self).join('SELF').split(cross).join('CROSS');
		if (run) out = out.split(`run=${run}`).join('run=RUN');
		return out;
	};

	const show = (value) => {
		if (value === undefined) return 'undefined';
		if (typeof value === 'function') return `function ${value.name}`;
		return value;
	};

	/** the fields of `entry` named in `names`, read through its getters */
	const pick = (entry, names) => {
		const out = {};
		for (const name of names) {
			try {
				out[name] = name in entry ? show(entry[name]) : 'absent';
			} catch (error) {
				out[name] = `threw ${error.name}`;
			}
		}
		return out;
	};

	/** what of an entry's times does not change from run to run */
	const timeShape = (entry, names = TIMES, order = ORDER) => {
		const present = names.filter((name) => name in entry);
		const zero = present.filter((name) => entry[name] === 0);
		const ordered = order.filter(
			(name) =>
				name in entry && typeof entry[name] === 'number' && entry[name] !== 0,
		);
		let monotonic = true;
		for (let i = 1; i < ordered.length; i++)
			if (entry[ordered[i]] < entry[ordered[i - 1]]) monotonic = false;
		const out = {
			zero: zero.join(','),
			absent: names.filter((name) => !(name in entry)).join(','),
			monotonic,
		};
		if ('duration' in entry && 'responseEnd' in entry && names === TIMES)
			out.durationIsEndMinusStart =
				Math.abs(entry.duration - (entry.responseEnd - entry.startTime)) <
				0.001;
		if ('fetchStart' in entry)
			out.fetchAtStart = entry.fetchStart === entry.startTime;
		if ('finalResponseHeadersStart' in entry && 'responseStart' in entry)
			out.finalIsResponseStart =
				entry.finalResponseHeadersStart === entry.responseStart;
		return out;
	};

	const serverTiming = (entry) => {
		try {
			return 'serverTiming' in entry
				? entry.serverTiming.map((metric) => metric.toJSON())
				: 'absent';
		} catch (error) {
			return `threw ${error.name}`;
		}
	};

	/** a resource (or navigation) timing entry, as a record */
	const describe = (entry) => {
		const json = entry.toJSON();
		return {
			name: tidy(entry.name),
			...pick(entry, [
				'entryType',
				'initiatorType',
				'nextHopProtocol',
				'deliveryType',
				'responseStatus',
				'renderBlockingStatus',
				'contentType',
				'contentEncoding',
				'transferSize',
				'encodedBodySize',
				'decodedBodySize',
				'workerRouterEvaluationStart',
				'workerCacheLookupStart',
				'workerMatchedSourceType',
				'workerFinalSourceType',
			]),
			serverTiming: serverTiming(entry),
			times: timeShape(entry),
			jsonKeys: Object.keys(json).join(','),
			// toJSON agrees with the getters on everything that is not a time
			jsonAgrees: Object.keys(json)
				.filter((key) => {
					const mine = entry[key];
					const its = json[key];
					if (key === 'name') return tidy(its) !== tidy(mine);
					if (key === 'serverTiming')
						return JSON.stringify(its) !== JSON.stringify(serverTiming(entry));
					if (mine && typeof mine === 'object') return false;
					return its !== mine;
				})
				.join(','),
			jsonName: tidy(json.name),
			prototype: Object.prototype.toString.call(entry),
			// (never compared)
			raw: Object.fromEntries(
				TIMES.filter((name) => name in entry).map((name) => [
					name,
					entry[name],
				]),
			),
		};
	};

	const describeNavigation = (entry) => ({
		...describe(entry),
		...pick(entry, [
			'type',
			'redirectCount',
			'activationStart',
			'criticalCHRestart',
		]),
		notRestoredReasons: (() => {
			try {
				if (!('notRestoredReasons' in entry)) return 'absent';
				const reasons = entry.notRestoredReasons;
				return reasons === null ? null : tidy(JSON.stringify(reasons));
			} catch (error) {
				return `threw ${error.name}`;
			}
		})(),
		navigationTimes: timeShape(entry, NAVIGATION_TIMES, [
			'responseEnd',
			'domInteractive',
			'domContentLoadedEventStart',
			'domContentLoadedEventEnd',
			'domComplete',
			'loadEventStart',
			'loadEventEnd',
		]),
	});

	/** the last query parameter `n` of a resource's URL: its name in the mix */
	const nameOf = (url) => {
		try {
			const parsed = new URL(url);
			return (
				(parsed.origin === self ? '' : 'x:') +
				(parsed.searchParams.get('n') ??
					parsed.pathname.split('/').pop() +
						parsed.search.replace(`run=${run}`, ''))
			);
		} catch (error) {
			return String(url);
		}
	};

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const until = async (test, ms = 8000) => {
		for (let waited = 0; waited < ms; waited += 25) {
			if (test()) return true;
			await sleep(25);
		}
		return test();
	};
	/** `work`'s result, or how it failed, never a rejection */
	const attempt = async (work) => {
		try {
			return await work();
		} catch (error) {
			return `threw ${error && error.name}: ${error && tidy(error.message)}`;
		}
	};

	globalThis.perfLib = {
		TIMES,
		self,
		cross,
		run,
		tidy,
		pick,
		show,
		timeShape,
		describe,
		describeNavigation,
		nameOf,
		sleep,
		until,
		attempt,
		/** a resource URL of this run on the page's origin (or the other one) */
		r: (params, origin = '') => `${origin}/perf/r?${params}&run=${run}`,
	};
})();
