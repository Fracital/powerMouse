// A worker of the performance fixture (dedicated, shared, or a service
// worker): it imports a script, fetches, and reports what its own
// performance object shows.
importScripts('/pages/perf-lib.js');
const workerParams = new URLSearchParams(self.location.search);
const workerRun = workerParams.get('run') ?? '';
const workerKind = workerParams.get('kind') ?? 'dedicated';
importScripts(`/perf/r?t=js&n=${workerKind}-import&run=${workerRun}`);

async function report() {
	const { describe, attempt } = perfLib;
	await attempt(() =>
		fetch(
			`/perf/r?t=json&n=${workerKind}-fetch&size=500&run=${workerRun}`,
		).then((response) => response.text()),
	);
	await attempt(() =>
		fetch(
			`${perfLib.cross}/perf/r?t=json&n=${workerKind}-xfetch&cors=1&run=${workerRun}`,
		).then((response) => response.text()),
	);
	await perfLib.sleep(100);
	performance.mark('worker-mark');
	return {
		kind: workerKind,
		resources: Object.fromEntries(
			performance
				.getEntriesByType('resource')
				.map((entry) => [perfLib.nameOf(entry.name), describe(entry)]),
		),
		navigation: performance.getEntriesByType('navigation').length,
		marks: performance.getEntriesByType('mark').map((entry) => entry.name),
		all: performance.getEntries().map((entry) => entry.entryType),
		has: Object.fromEntries(
			[
				'memory',
				'timing',
				'navigation',
				'eventCounts',
				'interactionCount',
				'measureUserAgentSpecificMemory',
				'timeOrigin',
			].map((name) => [name, typeof performance[name]]),
		),
		keys: Object.getOwnPropertyNames(Object.getPrototypeOf(performance)).join(
			',',
		),
		supported: PerformanceObserver.supportedEntryTypes.join(','),
		// a worker's clock starts when the worker does, after its page's
		originIsNumber: typeof performance.timeOrigin === 'number',
		nowBelowAge: performance.now() <= Date.now() - performance.timeOrigin + 50,
		ran: globalThis.__perfRan,
	};
}

if (workerKind === 'dedicated')
	report().then((record) => postMessage({ perfWorker: record }));
else if (workerKind === 'shared')
	self.onconnect = (event) =>
		report().then((record) =>
			event.ports[0].postMessage({ perfWorker: record }),
		);
else
	self.onmessage = (event) =>
		report().then((record) =>
			event.ports[0].postMessage({ perfWorker: record }),
		);
