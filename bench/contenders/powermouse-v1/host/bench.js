// powerMouseV1 has no client-side setup: a user opens its home page (which
// sets its session cookie) and submits a URL, which its server redirects to
// <origin>/<url>. The frame does the same, minus the form.
(function () {
	// from bench/configs/powermouse-v1.json through /bench-config.js
	const { proxyOrigin, home } = window.BENCH_CONFIG;
	const element = document.getElementById('bench-frame');

	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('powerMouseV1 home page did not load')),
			30000,
		);
		element.addEventListener(
			'load',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		element.src = `${proxyOrigin}${home}`;
	});

	window.__bench = {
		ready,
		frame: element,
		info: { contender: 'powermouse-v1', proxyOrigin },
		async go(url) {
			await ready;
			element.src = `${proxyOrigin}/${url}`;
		},
	};
})();
