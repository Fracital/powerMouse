// A frame of the entry-type fixture on a site of its own (a.zone.localhost)
// with a frame of that site and another origin in it (b.zone.localhost): the
// two share a process natively, so the outer one hears of the inner one's
// long task, as a cross-origin frame's. It tells the page above what it
// heard and what the inner frame did.
(() => {
	const { tidy } = perfLib;
	const plain = (text) => tidy(text).replace(/:\d+/g, ':PORT');
	const tasks = [];
	new PerformanceObserver((list) => tasks.push(...list.getEntries())).observe({
		type: 'longtask',
		buffered: true,
	});
	const describe = (entry) => ({
		name: entry.name,
		jsonName: entry.toJSON().name,
		attribution: entry.attribution.map((culprit) => ({
			name: culprit.name,
			containerType: culprit.containerType,
			containerSrc: plain(culprit.containerSrc),
			containerId: culprit.containerId,
			containerName: culprit.containerName,
			jsonSrc: plain(culprit.toJSON().containerSrc),
		})),
	});
	let start = 0;
	addEventListener('message', (event) => {
		if (!event.data) return;
		if (event.data.perfChildReady === 'site')
			parent.postMessage({ perfChildReady: 'site-frame' }, '*');
		if (event.data.perfSite) {
			start = performance.now();
			document
				.getElementById('site-child')
				.contentWindow.postMessage({ perfBusy: 'site' }, '*');
		}
		if (event.data.perfBusyDone === 'site')
			parent.postMessage(
				{
					perfSiteDone: {
						heard: tasks
							.filter((entry) => entry.startTime >= start - 1)
							.map(describe),
						inner: event.data.tasks,
					},
				},
				'*',
			);
	});
})();
