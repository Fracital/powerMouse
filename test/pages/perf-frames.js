// Frames a page makes itself (performance-frames suite,
// test/pages/perf-frames.html): what the page reads of a frame's
// Performance and Reporting APIs in the very task that made it (before
// anything could have loaded in it), a little later, after the page wrote a
// document into it, and after the page took it out of the document.
(async () => {
	const { r, run, attempt, sleep, until, tidy, nameOf } = perfLib;
	const record = {};
	window.__perf = { page: 'frames', ready: false, done: false, record };
	if (document.readyState !== 'complete')
		await new Promise((resolve) => addEventListener('load', resolve));

	const native = (fn) =>
		typeof fn === 'function' &&
		Function.prototype.toString.call(fn) ===
			`function ${fn.name}() { [native code] }`;
	/** what a window's performance object shows, read from this page */
	const read = (w) => {
		const performance = w.performance;
		const entries = performance.getEntries();
		const descriptor = (target, key) =>
			Reflect.getOwnPropertyDescriptor(target, key);
		return {
			resources: performance
				.getEntriesByType('resource')
				.map((entry) => nameOf(entry.name))
				.join(' '),
			navigation: performance
				.getEntriesByType('navigation')
				.map((entry) => `${tidy(entry.name)} ${entry.type}`)
				.join(),
			types: [...new Set(entries.map((entry) => entry.entryType))]
				.sort()
				.join(','),
			names: entries
				.filter((entry) => /^https?:/.test(entry.name))
				.map((entry) => tidy(entry.name).replace(/^(SELF|CROSS).*$/, '$1'))
				.filter((name, index, all) => all.indexOf(name) === index)
				.join(' '),
			json: tidy(JSON.stringify(entries)).match(/https?:\/\/[^"\\]+/g) ?? [],
			supported: w.PerformanceObserver.supportedEntryTypes.join(','),
			natives: [
				native(w.Performance.prototype.getEntries),
				native(w.Performance.prototype.getEntriesByType),
				native(w.Performance.prototype.getEntriesByName),
				native(w.Performance.prototype.now),
				native(descriptor(w.PerformanceEntry.prototype, 'name').get),
				native(
					descriptor(w.PerformanceResourceTiming.prototype, 'transferSize').get,
				),
				native(w.PerformanceObserver),
				native(w.PerformanceObserver.prototype.observe),
				native(w.PerformanceObserver.prototype.takeRecords),
				native(w.ReportingObserver),
				native(w.ReportingObserver.prototype.takeRecords),
				native(descriptor(w, 'performance').get),
			].join(','),
			realm: [
				performance instanceof w.Performance,
				performance instanceof Performance,
				w.performance === performance,
				Object.getPrototypeOf(performance.getEntries()) === w.Array.prototype,
			].join(','),
			memory: w.performance.memory
				? Object.prototype.toString.call(w.performance.memory)
				: 'absent',
			origin: typeof performance.timeOrigin,
		};
	};
	/** a load the frame makes itself, as its own observer and buffer show it */
	const loadIn = async (w, name) => {
		const heard = [];
		const calls = [];
		const observer = new w.PerformanceObserver((list, self) => {
			calls.push(
				[
					list instanceof w.PerformanceObserverEntryList,
					self === observer,
					list.getEntries().length,
				].join(','),
			);
			for (const entry of list.getEntries())
				heard.push(
					`${tidy(entry.name)} ${entry.initiatorType} ${entry instanceof w.PerformanceResourceTiming}`,
				);
		});
		observer.observe({ type: 'resource', buffered: true });
		const url = new URL(r(`t=json&n=${name}`), location.href).href;
		const response = await w.fetch(url);
		await response.text();
		await until(() => heard.some((line) => line.includes(`n=${name}`)), 2000);
		const taken = observer.takeRecords().length;
		observer.disconnect();
		return {
			status: response.status,
			type: response.type,
			url: tidy(response.url),
			heard: heard.filter((line) => line.includes(`n=${name}`)).join(' | '),
			others: heard.filter((line) => !line.includes(`n=${name}`)).length,
			calls: [...new Set(calls)].join(' | '),
			taken,
			byName: w.performance.getEntriesByName(url).length,
			byNameType: w.performance.getEntriesByName(url, 'resource').length,
			inParent: performance.getEntriesByName(url).length,
			after: read(w),
		};
	};
	/** a deprecation report, as the frame's own observers hear of it */
	const reportIn = async (w) => {
		const seen = [];
		const describe = (report) => ({
			type: report.type,
			url: tidy(report.url),
			body: Object.prototype.toString.call(report.body),
			id: report.body.id,
			source: tidy(String(report.body.sourceFile)),
			line: typeof report.body.lineNumber,
			message: tidy(String(report.body.message)).slice(0, 80),
			json: tidy(JSON.stringify(report)).replace(
				/"(lineNumber|columnNumber)":\d+/g,
				'"$1":N',
			),
			tag: Object.prototype.toString.call(report),
		});
		const observer = new w.ReportingObserver(
			(reports, self) => {
				for (const report of reports) seen.push(describe(report));
			},
			{ types: ['deprecation'], buffered: true },
		);
		observer.observe();
		// a synchronous request on the main thread is deprecated
		const request = new w.XMLHttpRequest();
		request.open('GET', r('t=text&n=report'), false);
		try {
			request.send();
		} catch (error) {
			return `send threw ${error.name}`;
		}
		const taken = observer.takeRecords().map(describe);
		await sleep(150);
		// a later observer that asks for what was buffered
		const late = [];
		const second = new w.ReportingObserver(
			(reports) => {
				for (const report of reports) late.push(describe(report));
			},
			{ types: ['deprecation'], buffered: true },
		);
		second.observe();
		await sleep(150);
		observer.disconnect();
		second.disconnect();
		return { status: request.status, taken, seen, late };
	};

	const cases = {
		// read in the task that made the frame
		sync: async () => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const w = frame.contentWindow;
			const first = read(w);
			const observerNow = new w.PerformanceObserver(() => {});
			observerNow.observe({ entryTypes: ['resource', 'navigation', 'mark'] });
			const records = observerNow.takeRecords().length;
			observerNow.disconnect();
			const load = await loadIn(w, 'sync');
			// (read, not compared: the browser reports a synchronous request
			// once a page, and through the proxy the inject may have made one
			// of its own in the page's document before)
			return { first, records, load, raw: { report: await reportIn(w) } };
		},
		// its natives taken in that task, called later
		kept: async () => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const w = frame.contentWindow;
			const getEntriesByType = w.Performance.prototype.getEntriesByType;
			const getEntries = w.Performance.prototype.getEntries;
			const name = Reflect.getOwnPropertyDescriptor(
				w.PerformanceEntry.prototype,
				'name',
			).get;
			const Observer = w.PerformanceObserver;
			const heard = [];
			const observer = new Observer((list) => {
				for (const entry of list.getEntries())
					heard.push(tidy(name.call(entry)));
			});
			observer.observe({ type: 'resource' });
			await sleep(50);
			const url = new URL(r('t=json&n=kept'), location.href).href;
			await (await w.fetch(url)).text();
			await until(() => heard.length > 0, 2000);
			return {
				heard: heard.join(' | '),
				byType: getEntriesByType
					.call(w.performance, 'resource')
					.map((entry) => tidy(name.call(entry)))
					.join(' | '),
				all: getEntries
					.call(w.performance)
					.map((entry) => tidy(name.call(entry)))
					.join(' | '),
				// the page's own performance, read with the frame's natives
				parents: getEntriesByType
					.call(performance, 'resource')
					.map((entry) =>
						tidy(name.call(entry)).replace(/^(SELF|CROSS).*$/, '$1'),
					)
					.filter((value, index, all) => all.indexOf(value) === index)
					.join(' '),
			};
		},
		// an about:blank frame, a task later
		later: async () => {
			const frame = document.createElement('iframe');
			frame.src = 'about:blank';
			// (its load event comes while it is appended)
			document.body.append(frame);
			await sleep(100);
			const w = frame.contentWindow;
			return { first: read(w), load: await loadIn(w, 'later') };
		},
		// a document the page writes into the frame
		opened: async () => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const w = frame.contentWindow;
			const d = frame.contentDocument;
			d.open();
			d.write(
				'<!doctype html><title>written</title><script>window.wrote = performance.getEntriesByType("resource").length + " " + performance.getEntriesByType("navigation").length + " " + typeof performance.timeOrigin;</' +
					'script>',
			);
			d.close();
			await sleep(50);
			return {
				sameWindow: frame.contentWindow === w,
				wrote: w.wrote,
				first: read(frame.contentWindow),
				load: await loadIn(frame.contentWindow, 'opened'),
			};
		},
		// a frame the page took out: its realm still answers
		removed: async () => {
			const frame = document.createElement('iframe');
			document.body.append(frame);
			const w = frame.contentWindow;
			const its = w.performance;
			const Observer = w.PerformanceObserver;
			await loadIn(w, 'removed');
			const before = its
				.getEntriesByType('resource')
				.map((entry) => nameOf(entry.name))
				.join(' ');
			frame.remove();
			const out = { before };
			for (const [name, call] of [
				[
					'resources',
					() =>
						its
							.getEntriesByType('resource')
							.map((entry) => nameOf(entry.name))
							.join(' '),
				],
				['all', () => its.getEntries().length],
				[
					'byName',
					() =>
						its.getEntriesByName(
							new URL(r('t=json&n=removed'), location.href).href,
						).length,
				],
				['now', () => typeof its.now()],
				['origin', () => typeof its.timeOrigin],
				['mark', () => Object.prototype.toString.call(its.mark('gone'))],
				['marks', () => its.getEntriesByType('mark').length],
				[
					'observer',
					() => {
						const observer = new Observer(() => {});
						observer.observe({ type: 'resource', buffered: true });
						return observer.takeRecords().length;
					},
				],
				['supported', () => Observer.supportedEntryTypes.length > 0],
				[
					'memory',
					() => (its.memory ? typeof its.memory.usedJSHeapSize : 'absent'),
				],
				['json', () => Object.keys(its.toJSON()).join(',')],
				['clear', () => String(its.clearResourceTimings())],
				['size', () => String(its.setResourceTimingBufferSize(10))],
			])
				try {
					out[name] = call();
				} catch (error) {
					out[name] = `threw ${error.name}: ${tidy(error.message)}`;
				}
			return out;
		},
	};
	// `own=1`: the page's own synchronous request first (the browser
	// reports the deprecation once a page, wherever it is first made)
	if (new URLSearchParams(location.search).has('own'))
		record.own = await attempt(() => reportIn(window));
	for (const [name, work] of Object.entries(cases))
		record[name] = await attempt(work);
	// nothing of the frames' loads is the page's
	record.parent = performance
		.getEntriesByType('resource')
		.map((entry) => nameOf(entry.name))
		.filter((name) => Object.keys(cases).includes(name))
		.join(' ');
	window.__perf.done = true;
})();
