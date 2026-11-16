// The resource timing buffer of the performance fixture (performance-buffer
// suite, test/pages/perf-buffer.html), in a document, a frame (`inner`) or
// a dedicated worker: what a page sees of its buffer's size, of the event
// that says it is full and of an observer's dropped entries, with loads made
// one at a time, and that nothing the page did not load itself is in it.
// `case=small` drives a buffer of a few entries, `case=default` fills the
// browser's own 250 after many synchronous storage and cookie operations,
// `case=frame` does the latter in a frame of the page.
(async () => {
	const { r, run, attempt, sleep, until, nameOf, tidy, self, cross } = perfLib;
	const inWorker = typeof document === 'undefined';
	const params = new URLSearchParams(location.search);
	const which = params.get('case') ?? 'small';
	const inner = params.has('inner');
	const record = {};
	if (!inWorker && !inner)
		window.__perf = { page: 'buffer', ready: false, done: false, record };

	const entries = () => performance.getEntriesByType('resource');
	const count = () => entries().length;
	const names = () => entries().map((entry) => nameOf(entry.name));

	// an observer hears of every load, whatever the buffer holds: a load's
	// entry (or its refusal by a full buffer) is settled once it has
	const heard = [];
	const calls = [];
	new PerformanceObserver((list) => {
		const got = list.getEntries();
		calls.push(got.length);
		for (const entry of got) heard.push(nameOf(entry.name));
	}).observe({ type: 'resource' });
	const load = async (name) => {
		await attempt(() =>
			fetch(r(`t=json&n=${name}`)).then((response) => response.text()),
		);
		await until(() => heard.includes(name), 3000);
		// the event that says the buffer is full is a task of its own
		await sleep(0);
		await sleep(0);
	};

	/** every http URL in what the entries serialise to that is not the fixture's */
	// (a long animation frame's entry is the performance-entries suite's)
	const timeline = () =>
		performance
			.getEntries()
			.filter((entry) => entry.entryType !== 'long-animation-frame');
	/** every URL in what the entries serialise to that is not the fixture's */
	const foreign = () =>
		[
			...new Set(
				tidy(JSON.stringify(timeline())).match(
					/\b(?:https?|wss?|blob):[^"\\ ]+/g,
				) ?? [],
			),
		].filter((url) => !/^https?:\/\/example\.test/.test(url));

	const watch = () => {
		const events = [];
		const listener = (event) =>
			events.push({
				type: event.type,
				constructor: Object.prototype.toString.call(event),
				isTrusted: event.isTrusted,
				target: event.target === performance,
				currentTarget: event.currentTarget === performance,
				bubbles: event.bubbles,
				cancelable: event.cancelable,
				composed: event.composed,
				eventPhase: event.eventPhase,
				countThen: count(),
			});
		performance.addEventListener('resourcetimingbufferfull', listener);
		return {
			events,
			stop: () =>
				performance.removeEventListener('resourcetimingbufferfull', listener),
		};
	};
	/** what a new buffered observer is told was dropped */
	const dropped = () =>
		new Promise((resolve) => {
			const observer = new PerformanceObserver((list, self, options) => {
				observer.disconnect();
				resolve({
					dropped: options && options.droppedEntriesCount,
					listed: list.getEntries().length,
					optionKeys: options ? Object.keys(options).join(',') : 'none',
				});
			});
			observer.observe({ type: 'resource', buffered: true });
			setTimeout(() => resolve('no callback'), 1500);
		});
	/** the page's own synchronous storage and cookie work, between loads */
	const busy = (n) => {
		if (inWorker) return 'worker';
		try {
			for (let i = 0; i < n; i++) {
				localStorage.setItem(`perf-buffer-${i % 7}`, `value ${i}`);
				sessionStorage.setItem(`perf-buffer-${i % 5}`, `value ${i}`);
				document.cookie = `perfbuffer${i % 4}=${i}; path=/`;
			}
			return [
				localStorage.getItem('perf-buffer-0') !== null,
				sessionStorage.length > 0,
				/perfbuffer0=/.test(document.cookie),
			].join(',');
		} catch (error) {
			return `threw ${error.name}`;
		}
	};

	const small = async () => {
		const out = {};
		out.members = [
			typeof performance.setResourceTimingBufferSize,
			typeof performance.clearResourceTimings,
			typeof performance.onresourcetimingbufferfull,
			'onresourcetimingbufferfull' in performance,
		].join(',');
		out.returns = [
			String(performance.setResourceTimingBufferSize(250)),
			String(performance.clearResourceTimings()),
		].join(',');
		out.afterClear = count();
		out.errors = {};
		for (const [name, call] of [
			['none', () => performance.setResourceTimingBufferSize()],
			['symbol', () => performance.setResourceTimingBufferSize(Symbol())],
			['detached', () => (0, performance.setResourceTimingBufferSize)(1)],
			['clearDetached', () => (0, performance.clearResourceTimings)()],
		])
			try {
				call();
				out.errors[name] = 'no error';
			} catch (error) {
				out.errors[name] = `${error.name}: ${error.message}`;
			}
		performance.setResourceTimingBufferSize(250);

		// a buffer of three: the fourth load says it is full, once
		{
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(3);
			const watched = watch();
			const trace = [];
			for (let i = 0; i < 6; i++) {
				if (i === 2) out.busy = busy(12);
				await load(`three-${i}`);
				trace.push(`${count()}/${watched.events.length}`);
			}
			// the page's own storage work while its buffer is full is no load
			// of its: no event, and no observer hears of anything
			const callsBefore = calls.length;
			busy(10);
			await sleep(400);
			const quiet = `${watched.events.length}/${calls.length - callsBefore}`;
			watched.stop();
			out.three = {
				quiet,
				trace: trace.join(' '),
				events: watched.events,
				names: names().join(' '),
				dropped: await dropped(),
			};
		}
		// the handler makes room: what waited is taken in
		{
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(2);
			const watched = watch();
			const raise = () => performance.setResourceTimingBufferSize(4);
			performance.addEventListener('resourcetimingbufferfull', raise);
			const trace = [];
			for (let i = 0; i < 7; i++) {
				await load(`raise-${i}`);
				trace.push(`${count()}/${watched.events.length}`);
			}
			performance.removeEventListener('resourcetimingbufferfull', raise);
			watched.stop();
			out.raise = {
				trace: trace.join(' '),
				counts: watched.events.map((event) => event.countThen).join(','),
				names: names().join(' '),
			};
		}
		// the handler clears
		{
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(2);
			const watched = watch();
			const clear = () => performance.clearResourceTimings();
			performance.addEventListener('resourcetimingbufferfull', clear);
			const trace = [];
			for (let i = 0; i < 7; i++) {
				await load(`clear-${i}`);
				trace.push(`${count()}/${watched.events.length}`);
			}
			performance.removeEventListener('resourcetimingbufferfull', clear);
			watched.stop();
			out.clear = {
				trace: trace.join(' '),
				counts: watched.events.map((event) => event.countThen).join(','),
				names: names().join(' '),
			};
		}
		// the handler attribute, and a size below what the buffer holds
		{
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(10);
			let attribute = 0;
			performance.onresourcetimingbufferfull = () => attribute++;
			const trace = [];
			for (let i = 0; i < 3; i++) await load(`shrink-${i}`);
			performance.setResourceTimingBufferSize(1);
			trace.push(`${count()}/${attribute}`);
			for (let i = 3; i < 5; i++) {
				await load(`shrink-${i}`);
				trace.push(`${count()}/${attribute}`);
			}
			out.shrink = {
				trace: trace.join(' '),
				handler: typeof performance.onresourcetimingbufferfull,
				names: names().join(' '),
			};
			performance.onresourcetimingbufferfull = null;
		}
		// a size of none
		{
			performance.clearResourceTimings();
			performance.setResourceTimingBufferSize(0);
			const watched = watch();
			for (let i = 0; i < 2; i++) await load(`zero-${i}`);
			watched.stop();
			out.zero = `${count()}/${watched.events.length}`;
		}
		performance.clearResourceTimings();
		performance.setResourceTimingBufferSize(250);
		await load('after');
		out.after = names().join(' ');
		return out;
	};

	/** the browser's own size, never set: 250 of the page's entries */
	const whole = async () => {
		const out = {};
		const initial = count();
		out.busy = busy(40);
		const watched = watch();
		let fullAt = null;
		// fourteen loads more than the buffer has room for
		const loads = 250 - initial + 14;
		for (let i = 0; i < loads; i++) {
			if (i === 100) busy(20);
			await load(`d-${i}`);
			if (fullAt === null && watched.events.length) fullAt = i;
		}
		watched.stop();
		out.events = watched.events.length;
		out.countAtEvent = watched.events.map((event) => event.countThen).join(',');
		// (the entries the document's own markup made count toward the 250)
		out.entriesAtFull = fullAt === null ? null : initial + fullAt;
		out.final = count();
		out.lastIsTheLastThatFit = names().at(-1) === `d-${250 - initial - 1}`;
		out.heardEveryLoad =
			heard.filter((name) => /^d-\d+$/.test(name)).length === loads;
		out.dropped = await dropped();
		// (read, not compared: how many the markup made, and which load filled it)
		out.raw = { initial, fullAt };
		return out;
	};

	const machinery = () => ({
		foreign: foreign(),
		types: timeline()
			.map((entry) => entry.entryType)
			.filter((type, index, all) => all.indexOf(type) === index)
			.sort()
			.join(','),
		everyReadAgrees:
			count() ===
			performance.getEntries().filter((entry) => entry.entryType === 'resource')
				.length,
		// (read, not compared: the entries the page's own markup made)
		raw: { names: names().slice(0, 12) },
		emptyCalls: calls.filter((length) => length === 0).length,
		heardAll: entries().every((entry) => heard.includes(nameOf(entry.name))),
		marks: performance.getEntriesByType('mark').length,
		measures: performance.getEntriesByType('measure').length,
	});

	const work = async () => {
		if (which === 'small') {
			record.small = await attempt(small);
			if (!inWorker && !inner) {
				record.worker = await attempt(
					() =>
						new Promise((resolve) => {
							const worker = new Worker(
								`/pages/perf-buffer-worker.js?case=small&run=${run}`,
							);
							worker.onmessage = (event) => resolve(event.data);
							worker.onerror = (event) => resolve(`error ${event.message}`);
							setTimeout(() => resolve('no report'), 20000);
						}),
				);
			}
		} else if (which === 'default') record.whole = await attempt(whole);
		else if (which === 'frame') {
			record.frame = await attempt(
				() =>
					new Promise((resolve) => {
						addEventListener('message', (event) => {
							if (event.data && event.data.perfBuffer)
								resolve(event.data.perfBuffer);
						});
						const frame = document.createElement('iframe');
						frame.src = `/perf/page/buffer?case=default&inner=1&run=${run}`;
						document.body.append(frame);
						setTimeout(() => resolve('no report'), 50000);
					}),
			);
		}
		await sleep(100);
		record.machinery = machinery();
	};
	await work();
	if (inWorker) postMessage(record);
	else if (inner) parent.postMessage({ perfBuffer: record }, '*');
	else {
		window.__perf.ready = true;
		// the suite asks by the names the browser has (routed, through the
		// proxy): nothing answers to them
		await until(() => window.__perfDriven, 4000);
		record.byBrowserName = window.__perfDriven ?? 'not driven';
		window.__perf.done = true;
	}
})();
