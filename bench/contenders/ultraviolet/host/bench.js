// Ultraviolet-App's public/register-sw.js and public/index.js without the UI:
// register the stock service worker, point bare-mux at epoxy over the wisp
// server, then set the frame's src to the encoded URL. The paths and the
// transport options come from bench/configs/ultraviolet.json through
// /bench-config.js (and __uv$config from the uv.config.js generated from it).
'use strict';
(() => {
	const CFG = window.BENCH_CONFIG;
	const element = document.getElementById('bench-frame');
	const connection = new BareMux.BareMuxConnection(CFG.mux);
	const info = {
		contender: 'ultraviolet',
		wisp: CFG.wisp,
		prefix: __uv$config.prefix,
	};

	async function activeWorker(registration) {
		const worker =
			registration.active || registration.waiting || registration.installing;
		if (worker.state === 'activated') return;
		await new Promise((resolve) => {
			const check = () => {
				if (worker.state === 'activated') {
					worker.removeEventListener('statechange', check);
					resolve();
				}
			};
			worker.addEventListener('statechange', check);
		});
	}

	const ready = (async () => {
		const registration = await navigator.serviceWorker.register(
			CFG.serviceWorker,
		);
		await activeWorker(registration);
		if ((await connection.getTransport()) !== CFG.transport)
			await connection.setTransport(CFG.transport, CFG.transportOptions);
		info.transport = await connection.getTransport();
		info.scope = registration.scope;
	})();

	window.__bench = {
		ready,
		frame: element,
		info,
		async go(url) {
			await ready;
			element.src = __uv$config.prefix + __uv$config.encodeUrl(url);
		},
	};
})();
