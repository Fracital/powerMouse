// The shapes of the Performance interfaces (performance-shapes suite,
// test/pages/perf-shapes.html), in a document and, imported there, in a
// dedicated worker: for every interface of the Performance APIs and the
// Reporting API, its constructor and every member of its prototype as a page
// can inspect them (descriptor, name, length, source text, what a call on
// the wrong receiver throws and from where), and the same for the objects a
// page reaches without a constructor (performance.memory).
(async () => {
	const { tidy, attempt, run } = perfLib;
	const inWorker = typeof document === 'undefined';
	const record = {};
	if (!inWorker)
		window.__perf = { page: 'shapes', ready: false, done: false, record };

	const INTERFACES = [
		'Performance',
		'PerformanceEntry',
		'PerformanceResourceTiming',
		'PerformanceNavigationTiming',
		'PerformanceServerTiming',
		'PerformanceObserver',
		'PerformanceObserverEntryList',
		'PerformanceTiming',
		'PerformanceNavigation',
		'PerformanceMark',
		'PerformanceMeasure',
		'PerformancePaintTiming',
		'PerformanceLongTaskTiming',
		'PerformanceEventTiming',
		'PerformanceElementTiming',
		'PerformanceLongAnimationFrameTiming',
		'PerformanceScriptTiming',
		'LargestContentfulPaint',
		'LayoutShift',
		'LayoutShiftAttribution',
		'TaskAttributionTiming',
		'VisibilityStateEntry',
		'EventCounts',
		'ReportingObserver',
		'Report',
		'ReportBody',
		'DeprecationReportBody',
		'InterventionReportBody',
		'CSPViolationReportBody',
		'EventTarget',
	];

	/** an error as a page sees it: its class, realm, message and where it says it came from */
	const thrown = (call) => {
		try {
			const value = call();
			return `returned ${typeof value}`;
		} catch (error) {
			if (!error || typeof error !== 'object') return `threw ${String(error)}`;
			const stack = tidy(String(error.stack))
				.split('\n')
				.map((line) =>
					line
						.trim()
						.replace(/:\d+:\d+\)?$/, (end) =>
							end.endsWith(')') ? ':L:C)' : ':L:C',
						),
				);
			return {
				is: `${error.name}: ${tidy(error.message)}`,
				ownRealm:
					Object.getPrototypeOf(error) === globalThis[error.name]?.prototype,
				// the frames above the probe's own are the caller's
				stack: stack.slice(
					0,
					stack.findIndex((line) => /at thrown\b/.test(line)) + 1,
				),
			};
		}
	};
	const func = (fn) => {
		if (typeof fn !== 'function') return typeof fn;
		const text = Function.prototype.toString.call(fn);
		return {
			name: fn.name,
			length: fn.length,
			native:
				text === `function ${fn.name}() { [native code] }`
					? true
					: tidy(text).slice(0, 200),
			same: String(fn) === text && `${fn}` === text && fn.toString() === text,
			own: Reflect.ownKeys(fn).map(String).join(','),
			nameDescriptor: JSON.stringify(
				Reflect.getOwnPropertyDescriptor(fn, 'name'),
			),
			lengthDescriptor: JSON.stringify(
				Reflect.getOwnPropertyDescriptor(fn, 'length'),
			),
			prototype: Object.getPrototypeOf(fn) === Function.prototype,
			constructs: thrown(() => new fn()).is ?? 'constructed',
		};
	};
	const flags = (descriptor) =>
		[
			descriptor.enumerable ? 'e' : '-',
			descriptor.configurable ? 'c' : '-',
			'writable' in descriptor ? (descriptor.writable ? 'w' : '-') : 'a',
		].join('');
	const WRONG = [
		['object', {}],
		['undefined', undefined],
		['number', 1],
	];
	/** every own member of `target`, as a page can inspect it */
	const members = (target, wrong = WRONG) => {
		const out = {};
		for (const key of Reflect.ownKeys(target)) {
			const name = String(key);
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			const member = { flags: flags(descriptor) };
			if ('value' in descriptor) {
				if (typeof descriptor.value === 'function') {
					member.value = func(descriptor.value);
					if (name !== 'constructor')
						member.wrong = Object.fromEntries(
							wrong.map(([label, receiver]) => [
								label,
								thrown(() => descriptor.value.call(receiver)),
							]),
						);
				} else
					member.value =
						typeof descriptor.value === 'object'
							? Object.prototype.toString.call(descriptor.value)
							: String(descriptor.value);
			} else {
				member.get = func(descriptor.get);
				member.set = func(descriptor.set);
				if (descriptor.get)
					member.wrong = Object.fromEntries(
						[...wrong, ['prototype', target]].map(([label, receiver]) => [
							label,
							thrown(() => descriptor.get.call(receiver)),
						]),
					);
				if (descriptor.set)
					member.wrongSet = thrown(() => descriptor.set.call({}, 1));
			}
			out[name] = member;
		}
		return out;
	};
	const shape = (name) => {
		const constructor = globalThis[name];
		if (typeof constructor !== 'function') return typeof constructor;
		const prototype = constructor.prototype;
		return {
			global: flags(Reflect.getOwnPropertyDescriptor(globalThis, name)),
			constructor: func(constructor),
			called: thrown(() => constructor()),
			statics: members(constructor, []),
			parent: Object.getPrototypeOf(constructor).name || 'Function.prototype',
			prototypeParent: Object.prototype.toString.call(
				Object.getPrototypeOf(prototype) ?? 0,
			),
			tag: String(prototype[Symbol.toStringTag]),
			order: Reflect.ownKeys(prototype).map(String).join(','),
			members: members(prototype),
			constructorIsGlobal: prototype.constructor === constructor,
		};
	};
	for (const name of INTERFACES)
		record[name] = await attempt(() => shape(name));

	// what has no constructor to name it
	const anonymous = (object) => {
		const prototype = Object.getPrototypeOf(object);
		return {
			tag: Object.prototype.toString.call(object),
			own: Reflect.ownKeys(object).map(String).join(','),
			order: Reflect.ownKeys(prototype).map(String).join(','),
			members: members(prototype),
			constructor: func(prototype.constructor),
			constructorGlobal:
				prototype.constructor === globalThis[prototype.constructor?.name],
			parent: Object.prototype.toString.call(
				Object.getPrototypeOf(prototype) ?? 0,
			),
		};
	};
	record.memory = await attempt(() =>
		performance.memory ? anonymous(performance.memory) : 'absent',
	);

	// the objects themselves
	record.instances = await attempt(async () => {
		await fetch(
			`/perf/r?t=json&n=shape&st=${encodeURIComponent('a;dur=1')}&run=${run}`,
		).then((response) => response.text());
		await perfLib.until(() =>
			performance
				.getEntriesByType('resource')
				.some((entry) => entry.name.includes('n=shape')),
		);
		const resource = performance
			.getEntriesByType('resource')
			.find((entry) => entry.name.includes('n=shape'));
		const navigation = performance.getEntriesByType('navigation')[0];
		const forIn = (object) => {
			const keys = [];
			for (const key in object) keys.push(key);
			return keys.join(',');
		};
		const of = (object) =>
			object
				? {
						tag: Object.prototype.toString.call(object),
						own: Reflect.ownKeys(object).map(String).join(','),
						forIn: forIn(object),
						extensible: Object.isExtensible(object),
						chain: (() => {
							const names = [];
							for (
								let proto = Object.getPrototypeOf(object);
								proto;
								proto = Object.getPrototypeOf(proto)
							)
								names.push(proto.constructor?.name ?? '?');
							return names.join('>');
						})(),
					}
				: 'absent';
		const list = performance.getEntriesByType('resource');
		return {
			performance: of(performance),
			performanceGlobal: (() => {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					globalThis,
					'performance',
				);
				return {
					flags: flags(descriptor),
					get: func(descriptor.get),
					set: func(descriptor.set),
				};
			})(),
			sameObject: performance === globalThis.performance,
			resource: of(resource),
			serverTiming: of(resource?.serverTiming[0]),
			serverTimingList: [
				Array.isArray(resource?.serverTiming),
				Object.isFrozen(resource?.serverTiming),
				resource?.serverTiming === resource?.serverTiming,
				JSON.stringify(resource?.serverTiming),
			].join(' '),
			navigation: of(navigation),
			timing: of(performance.timing),
			legacyNavigation: of(performance.navigation),
			eventCounts: of(performance.eventCounts),
			entryLists: [
				Array.isArray(list),
				Object.isFrozen(list),
				list === performance.getEntriesByType('resource'),
				list[0] === performance.getEntriesByType('resource')[0],
				Object.getPrototypeOf(list) === Array.prototype,
			].join(','),
			supported: (() => {
				const types = PerformanceObserver.supportedEntryTypes;
				return [
					types.join(','),
					Object.isFrozen(types),
					types === PerformanceObserver.supportedEntryTypes,
					Object.getPrototypeOf(types) === Array.prototype,
				].join(' ');
			})(),
			observer: (() => {
				const observer = new PerformanceObserver(() => {});
				return {
					...of(observer),
					errors: {
						noArguments: thrown(() => observer.observe()),
						empty: thrown(() => observer.observe({})),
						both: thrown(() =>
							observer.observe({ entryTypes: ['resource'], type: 'resource' }),
						),
						unknown: thrown(() => observer.observe({ type: 'no-such-type' })),
						bufferedEntryTypes: thrown(() =>
							observer.observe({ entryTypes: ['resource'], buffered: true }),
						),
						notCallable: thrown(() => new PerformanceObserver(1)),
						noCallback: thrown(() => new PerformanceObserver()),
						records: thrown(() => observer.takeRecords().length),
					},
				};
			})(),
			calls: {
				byTypeNone: thrown(() => performance.getEntriesByType()),
				byNameNone: thrown(() => performance.getEntriesByName()),
				byTypeUnknown: thrown(
					() => performance.getEntriesByType('no-such-type').length,
				),
				byTypeNumber: thrown(() => performance.getEntriesByType(1).length),
				byNameSymbol: thrown(() => performance.getEntriesByName(Symbol())),
				byNameObject: thrown(
					() =>
						performance.getEntriesByName({
							toString() {
								throw new RangeError('asked');
							},
						}).length,
				),
				byNameType: thrown(
					() => performance.getEntriesByName('x', 'no-such-type').length,
				),
				entryJSON: thrown(() => typeof resource.toJSON.call({})),
				structuredClone: thrown(() => structuredClone(resource)),
				structuredCloneMemory: performance.memory
					? thrown(() => JSON.stringify(structuredClone(performance.memory)))
					: 'absent',
			},
		};
	});

	if (inWorker) postMessage(record);
	else {
		record.worker = await attempt(
			() =>
				new Promise((resolve) => {
					const worker = new Worker(`/pages/perf-shapes-worker.js?run=${run}`);
					worker.onmessage = (event) => resolve(event.data);
					worker.onerror = (event) => resolve(`error ${event.message}`);
					setTimeout(() => resolve('no report'), 20000);
				}),
		);
		window.__perf.done = true;
	}
})();
