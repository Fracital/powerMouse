// A single-page app as Discord's is (spa-nav suite): links that the router
// takes (pushState), React's default transition indicator (a replacing
// Navigation API navigation to the current entry, intercepted until the
// transition ends), Navigation API routing, traversals, lazy chunks (import(),
// a JSONP script chunk, a stylesheet chunk, and each of them failing), and
// the page's unload listeners. Every step is told to the console as
// `SPANAV <json>`; a document load the steps did not ask for shows as a
// second `boot` whose `loads` is above 1.
(() => {
	const say = (step, value) =>
		console.log(`SPANAV ${JSON.stringify([step, value])}`);
	const loads = Number(sessionStorage.getItem('spanav-loads') || 0) + 1;
	sessionStorage.setItem('spanav-loads', String(loads));
	const during = sessionStorage.getItem('spanav-step');
	say('boot', { loads, during, path: location.pathname });
	if (loads > 1) return;
	addEventListener('beforeunload', () =>
		sessionStorage.setItem(
			'spanav-unload',
			sessionStorage.getItem('spanav-step') || 'beforeunload',
		),
	);
	const view = document.getElementById('view');
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const render = () => {
		view.textContent = location.pathname;
	};
	// the router: a link click becomes a pushState, a popstate re-renders
	document.addEventListener('click', (event) => {
		const link = event.target.closest('a');
		if (!link) return;
		event.preventDefault();
		history.pushState({ at: link.id }, '', link.getAttribute('href'));
		render();
	});
	addEventListener('popstate', render);

	// React 19.2's onDefaultTransitionIndicator (react-dom): the browser's
	// loading indicator for a transition, as a navigation to the current entry
	// that the page intercepts until the transition ends
	const indicator = () => {
		let stopped = false;
		let finish = null;
		const intercept = (event) => {
			if (event.canIntercept && event.info === 'react-transition')
				event.intercept({
					handler: () =>
						new Promise((resolve) => {
							finish = resolve;
						}),
					focusReset: 'manual',
					scroll: 'manual',
				});
		};
		const start = () => {
			if (stopped || navigation.transition) return;
			const entry = navigation.currentEntry;
			if (entry && entry.url != null)
				navigation.navigate(entry.url, {
					state: entry.getState(),
					info: 'react-transition',
					history: 'replace',
				});
		};
		const settled = () => {
			if (finish !== null) finish();
			finish = null;
			if (!stopped) setTimeout(start, 20);
		};
		navigation.addEventListener('navigate', intercept);
		navigation.addEventListener('navigatesuccess', settled);
		navigation.addEventListener('navigateerror', settled);
		setTimeout(start, 100);
		return () => {
			stopped = true;
			navigation.removeEventListener('navigate', intercept);
			navigation.removeEventListener('navigatesuccess', settled);
			navigation.removeEventListener('navigateerror', settled);
			if (finish !== null) finish();
			finish = null;
		};
	};

	// webpack's JSONP chunk loading: a script that pushes into a global array
	const chunks = (self.webpackChunkspa = self.webpackChunkspa || []);
	const loaded = new Set();
	chunks.push = (entry) => {
		for (const id of entry[0]) loaded.add(id);
	};
	const scriptChunk = (src, id) =>
		new Promise((resolve) => {
			const script = document.createElement('script');
			script.src = src;
			script.onload = script.onerror = (event) =>
				resolve(event.type === 'load' && loaded.has(id) ? 'load' : event.type);
			document.head.append(script);
		});
	const cssChunk = (href) =>
		new Promise((resolve) => {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = href;
			link.onload = link.onerror = (event) => resolve(event.type);
			document.head.append(link);
		});

	const state = () => ({
		path: location.pathname,
		state: history.state,
		length: history.length,
		view: view.textContent,
		entries: navigation.entries().length,
		index: navigation.currentEntry.index,
		entryPath: new URL(navigation.currentEntry.url).pathname,
	});
	const steps = [
		[
			'click',
			async () => {
				document.getElementById('ch1').click();
				await sleep(200);
				document.getElementById('ch2').click();
				await sleep(200);
			},
		],
		[
			'indicator',
			async () => {
				// a transition of 1.5 s: the indicator's navigations go on until it ends
				const stop = indicator();
				await sleep(1500);
				stop();
				await sleep(300);
			},
		],
		[
			'indicator-with-click',
			async () => {
				// a channel switch under a transition: the router's pushState while
				// the indicator's navigation is pending
				const stop = indicator();
				await sleep(250);
				document.getElementById('ch1').click();
				await sleep(400);
				stop();
				await sleep(300);
			},
		],
		[
			'navigate-intercept',
			async () => {
				const once = (event) => {
					navigation.removeEventListener('navigate', once);
					if (event.canIntercept) event.intercept({ handler: () => render() });
				};
				navigation.addEventListener('navigate', once);
				const result = navigation.navigate(
					'/pages/deep/channels/3/spa-nav.html',
					{
						state: { at: 'ch3' },
					},
				);
				await result.finished.catch((error) => error.name);
				await sleep(200);
			},
		],
		[
			'back',
			async () => {
				history.back();
				await sleep(500);
			},
		],
		[
			'forward',
			async () => {
				history.forward();
				await sleep(500);
			},
		],
		[
			'traverse-intercept',
			async () => {
				const once = (event) => {
					navigation.removeEventListener('navigate', once);
					if (event.canIntercept) event.intercept({ handler: () => render() });
				};
				navigation.addEventListener('navigate', once);
				await navigation.back().finished.catch((error) => error.name);
				await sleep(300);
			},
		],
		[
			'import',
			async () => {
				const module = await import('/pages/spa-nav-module.js');
				return module.value;
			},
		],
		[
			'import-missing',
			async () =>
				import('/neutral/spa-nav-missing-module.js').then(
					() => 'loaded',
					(error) => error.name,
				),
		],
		['script-chunk', () => scriptChunk('/pages/spa-nav-jsonp.js', 7)],
		[
			'script-chunk-missing',
			() => scriptChunk('/neutral/spa-nav-missing.js', 8),
		],
		[
			'css-chunk',
			async () => {
				const result = await cssChunk('/pages/spa-nav-chunk.css');
				return [result, getComputedStyle(view).outlineStyle];
			},
		],
		['css-chunk-missing', () => cssChunk('/neutral/spa-nav-missing.css')],
	];
	(async () => {
		// `?hold`: the steps wait for the suite (a service worker update first)
		if (location.search.includes('hold'))
			await new Promise((resolve) => {
				window.spanavGo = resolve;
				say('held', null);
			});
		for (const [name, run] of steps) {
			sessionStorage.setItem('spanav-step', name);
			let result;
			try {
				result = await run();
			} catch (error) {
				result = `threw ${error.name}`;
			}
			say(name, { result: result ?? null, ...state() });
		}
		sessionStorage.removeItem('spanav-step');
		say('end', { loads, unload: sessionStorage.getItem('spanav-unload') });
	})();
})();
