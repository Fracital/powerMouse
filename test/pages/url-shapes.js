// The url-shapes battery (test/suites/url-shapes.mjs, served by
// test/shapes-server.mjs). In the page (/shape/top) it reads, for every
// shape of address (an empty query, an empty fragment, both, an empty query
// with a fragment, a query with an empty fragment), each surface a page
// reads a URL from, and leaves the cases in `window.__shapes`. In a frame's
// document (/shape/frame/<id><shape>) it reports what the document reads of
// its own address to its parent.
(() => {
	const SHAPES = {
		'empty-query': '?',
		'empty-fragment': '#',
		'empty-both': '?#',
		'empty-query-fragment': '?#f',
		'query-empty-fragment': '?a=1#',
	};
	const attempt = async (run) => {
		try {
			return await run();
		} catch (error) {
			return `threw ${error?.name}: ${error?.message}`;
		}
	};

	const own = window.__shape;
	// a document that navigates its frame on: by a link (`c-`), by the
	// Navigation API (`n-`), by a form without fields (`g-`); the document it
	// leads to reports (`k-`, `m-`, `h-`)
	const lead = own && /^([cng])-([\w-]+)$/.exec(own.id);
	if (lead) {
		const [, how, name] = lead;
		const shape = SHAPES[name] ?? '';
		addEventListener('load', () =>
			setTimeout(() => {
				if (how === 'c') {
					const link = document.createElement('a');
					link.href = `/shape/frame/k-${name}${shape}`;
					document.body.append(link);
					link.click();
				} else if (how === 'n')
					self.navigation.navigate(`/shape/frame/m-${name}${shape}`);
				else {
					const form = document.createElement('form');
					form.action = `/shape/frame/h-${name}`;
					document.body.append(form);
					form.submit();
				}
			}),
		);
		return;
	}
	if (own) {
		(async () => {
			const link = document.createElement('a');
			link.setAttribute('href', '');
			const report = {
				'the request target the server saw': own.target,
				'location.href': location.href,
				'location.search': location.search,
				'location.hash': location.hash,
				'String(location)': String(location),
				'document.URL': document.URL,
				'document.documentURI': document.documentURI,
				'document.baseURI': document.baseURI,
				'the navigation entry':
					performance.getEntriesByType('navigation')[0]?.name,
				'navigation.currentEntry.url': self.navigation?.currentEntry?.url,
				'document.referrer': document.referrer,
				"a form's default action": document.createElement('form').action,
				'a link to ""': link.href,
				'the Referer of its fetch': await attempt(
					async () => (await (await fetch('/shape/echo')).json()).referer,
				),
			};
			parent.postMessage({ shapeFrame: own.id, report }, '*');
		})();
		return;
	}

	const cases = {};
	const pending = [];
	const add = (name, run) => pending.push([name, run]);

	const frameSays = (src, reporter) =>
		new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const id = reporter ?? /\/(?:frame|to)\/([\w-]+)/.exec(src)[1];
			const onMessage = (event) => {
				if (event.data?.shapeFrame !== id) return;
				removeEventListener('message', onMessage);
				let seen;
				try {
					seen = frame.contentWindow.location.href;
				} catch (error) {
					seen = error.name;
				}
				const result = {
					...event.data.report,
					"the parent's contentWindow.location.href": seen,
					"the element's src": frame.src,
				};
				frame.remove();
				resolve(result);
			};
			addEventListener('message', onMessage);
			setTimeout(() => resolve('no report'), 20000);
			frame.src = src;
			document.body.append(frame);
		});

	for (const [name, shape] of Object.entries(SHAPES)) {
		add(`${name}: a frame`, () => frameSays(`/shape/frame/f-${name}${shape}`));
		add(`${name}: a frame through a redirect`, () =>
			frameSays(`/shape/to/r-${name}/${name}`),
		);
		add(`${name}: a frame a link of a document of that shape leads to`, () =>
			frameSays(`/shape/frame/c-${name}${shape}`, `k-${name}`),
		);
		add(`${name}: a frame navigation.navigate leads to`, () =>
			frameSays(`/shape/frame/n-${name}`, `m-${name}`),
		);
		add(`${name}: fetch`, () =>
			attempt(async () => {
				const response = await fetch(`/shape/echo${shape}`);
				const { target } = await response.json();
				return { 'Response.url': response.url, 'the server saw': target };
			}),
		);
		add(`${name}: fetch through a redirect`, () =>
			attempt(async () => {
				const response = await fetch(
					`/shape/go?u=${encodeURIComponent(`/shape/echo${shape}`)}`,
				);
				const { target } = await response.json();
				return {
					'Response.url': response.url,
					redirected: response.redirected,
					'the server saw': target,
				};
			}),
		);
		add(`${name}: Request.url`, () =>
			attempt(() => new Request(`/shape/echo${shape}`).url),
		);
		add(`${name}: a link`, () => {
			const link = document.createElement('a');
			link.href = `/shape/x${shape}`;
			return {
				href: link.href,
				search: link.search,
				hash: link.hash,
				string: String(link),
				'the attribute': link.getAttribute('href'),
			};
		});
		add(`${name}: new URL`, () => new URL(`/shape/x${shape}`, location).href);
		add(`${name}: a worker's location`, () =>
			attempt(
				() =>
					new Promise((resolve) => {
						const worker = new Worker(`/shape/w.js${shape}`);
						worker.onmessage = (event) => {
							resolve(event.data);
							worker.terminate();
						};
						worker.onerror = () => resolve('error event');
						setTimeout(() => resolve('nothing'), 10000);
					}),
			),
		);
		add(`${name}: a module's import.meta.url`, () =>
			attempt(async () => (await import(`/shape/m.js${shape}`)).url),
		);
		add(`${name}: a stylesheet's url(), computed`, () => {
			const style = document.createElement('style');
			style.textContent = `.shape-${name} { background-image: url("/shape/echo${shape}"); }`;
			document.head.append(style);
			const element = document.createElement('div');
			element.className = `shape-${name}`;
			document.body.append(element);
			const value = getComputedStyle(element).backgroundImage;
			element.remove();
			style.remove();
			return value;
		});
		add(`${name}: history.pushState`, () =>
			attempt(() => {
				history.pushState(null, '', `/shape/pushed${shape}`);
				return {
					'location.href': location.href,
					'document.URL': document.URL,
					'navigation.currentEntry.url': self.navigation?.currentEntry?.url,
				};
			}),
		);
	}
	add('a frame a form without fields leads to', () =>
		frameSays('/shape/frame/g-form', 'h-form'),
	);
	add('the resource entries of the fetches', () =>
		performance
			.getEntriesByType('resource')
			.map((entry) => entry.name)
			.filter((name) => name.includes('/shape/echo')),
	);
	add('location.hash set to ""', () =>
		attempt(() => {
			history.replaceState(null, '', '/shape/hashed');
			location.hash = '';
			return location.href;
		}),
	);

	(async () => {
		window.__shapes = { done: false, cases };
		const start = location.href;
		for (const [name, run] of pending) {
			try {
				cases[name] = await run();
			} catch (error) {
				cases[name] = `threw ${error?.name}: ${error?.message}`;
			}
			if (cases[name] === undefined) cases[name] = 'undefined';
		}
		history.replaceState(null, '', start);
		window.__shapes.done = true;
	})();
})();
