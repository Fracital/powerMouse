// A frame of the entry-type fixture (performance-entries suite): when its
// parent says so it keeps its thread for 80 ms, then tells the parent what
// long tasks its own observer heard of.
(() => {
	const { tidy } = perfLib;
	const name = new URLSearchParams(location.search).get('n') ?? 'child';
	const tasks = [];
	new PerformanceObserver((list) => tasks.push(...list.getEntries())).observe({
		type: 'longtask',
		buffered: true,
	});
	const describe = (entry) => ({
		name: entry.name,
		attribution: entry.attribution.map((culprit) => ({
			name: culprit.name,
			containerType: culprit.containerType,
			containerSrc: tidy(culprit.containerSrc),
			containerId: culprit.containerId,
			containerName: culprit.containerName,
		})),
	});
	addEventListener('message', (event) => {
		if (!event.data || event.data.perfBusy !== name) return;
		const start = performance.now();
		setTimeout(function perfChildTask() {
			const until = performance.now() + 80;
			while (performance.now() < until);
			// the observer hears of the task after it
			setTimeout(() => {
				parent.postMessage(
					{
						perfBusyDone: name,
						tasks: tasks
							.filter((entry) => entry.startTime >= start - 1)
							.map(describe),
					},
					'*',
				);
			}, 300);
		}, 0);
	});
	addEventListener('load', () =>
		parent.postMessage({ perfChildReady: name }, '*'),
	);
})();
