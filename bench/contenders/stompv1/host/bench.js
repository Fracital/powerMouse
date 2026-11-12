// The tomp-demo style frontend setup without its UI: the Bootstrapper with
// the config its derivatives use, and the address bar's
// boot.html(SearchBuilder.query(input)) to navigate. The config comes from
// bench/configs/stompv1.json through /bench-config.js; loglevel and codec
// there name StompBoot constants.
(function () {
	const CFG = window.BENCH_CONFIG;
	const element = document.getElementById('bench-frame');
	const config = {
		bare_server: CFG.boot.bare_server,
		directory: CFG.boot.directory,
		loglevel: StompBoot[CFG.boot.loglevel],
		codec: StompBoot[CFG.boot.codec],
	};
	if (config.loglevel === undefined || config.codec === undefined)
		throw new Error('stompV1: unknown StompBoot loglevel or codec');
	const boot = new StompBoot(config);
	const search = new StompBoot.SearchBuilder(CFG.search);

	// the scope (/stomp/) does not cover this page, so
	// navigator.serviceWorker.ready never settles here: watch the worker
	function activated(registration) {
		if (registration.active) return Promise.resolve();
		const worker = registration.installing || registration.waiting;
		return new Promise((resolve, reject) => {
			worker.addEventListener('statechange', () => {
				if (worker.state === 'activated') resolve();
				else if (worker.state === 'redundant')
					reject(new Error('stompV1 service worker became redundant'));
			});
		});
	}

	const ready = (async () => {
		await boot.ready;
		await activated(boot.worker);
	})();

	window.__bench = {
		ready,
		frame: element,
		info: { contender: 'stompv1', config },
		async go(url) {
			await ready;
			element.src = boot.html(search.query(url));
		},
	};
})();
