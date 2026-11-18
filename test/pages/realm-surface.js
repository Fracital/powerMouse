// The page of the realm-surface suite (test/suites/realm-surface.mjs): it
// walks its own realm with realm-walker.js, then every other kind of realm a
// page can make, one after the other, and keeps each record on
// `__realmSurface`. `?set=` picks the kinds: `frames` (documents in frames,
// documents without a window, identities across realms), `popups`,
// `workers` (workers and worklets) or `worklets` (the worklets behind a
// blink feature). A window realm's record is kept as what differs from the
// top document's, a worker's as what differs from the
// first dedicated worker's: the suite compares the base in full and the
// others by their differences.
(async () => {
	const walker = globalThis.__realmWalker;
	const params = new URLSearchParams(location.search);
	const set = params.get('set') ?? 'frames';
	const only = params.get('only');
	const avoidText = params.get('avoid') ?? '[]';
	const avoid = JSON.parse(avoidText);
	const state = {
		set,
		realms: {},
		counts: {},
		bases: {},
		notes: {},
		done: false,
	};
	Reflect.defineProperty(window, '__realmSurface', {
		value: state,
		configurable: true,
		writable: true,
		enumerable: false,
	});
	const options = () => ({ skip: ['__realmSurface'], avoid });
	const here = (file) => new URL(file, location.href).href;
	// the same pages on another origin: the fixture answers on both names
	const elsewhere = (file) => {
		const url = new URL(file, location.href);
		url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
		return url.href;
	};
	const wanted = (name) => !only || only.split(',').includes(name);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// reports of the documents that walk themselves
	const reports = new Map();
	const waiting = new Map();
	addEventListener('message', (event) => {
		const name = event.data?.realmSurface;
		if (typeof name !== 'string') return;
		event.source?.postMessage({ realmSurfaceHeard: name }, '*');
		if (reports.has(name)) return;
		reports.set(name, event.data);
		waiting.get(name)?.(event.data);
	});
	const reportOf = (name, ms = 30000) =>
		reports.has(name)
			? Promise.resolve(reports.get(name))
			: Promise.race([
					new Promise((resolve) => waiting.set(name, resolve)),
					sleep(ms).then(() => ({ error: `no report in ${ms} ms` })),
				]);

	let base = null;
	let baseName = null;
	/** a realm's record kept: in full for the base, else what differs */
	const keep = (name, report, full = false) => {
		if (report.error || !report.lines) {
			state.realms[name] = { error: report.error ?? 'no record' };
			return;
		}
		state.counts[name] = report.counts;
		if (full || !base) {
			base = report.lines;
			baseName = name;
			state.realms[name] = { lines: report.lines };
		} else {
			state.realms[name] = walker.reduce(report.lines, base);
			state.bases[name] = baseName;
		}
	};
	/** a walk of another realm's global from this one */
	const outside = async (name, root) => {
		try {
			const result = await walker.walkSettled(root, options());
			keep(name, { lines: walker.lines(result), counts: result.counts });
		} catch (error) {
			keep(name, { error: String(error?.stack ?? error) });
		}
	};
	const frame = (attributes = {}) => {
		const element = document.createElement('iframe');
		for (const name in attributes) element.setAttribute(name, attributes[name]);
		document.body.append(element);
		return element;
	};
	const childMarkup = (name) =>
		`<!doctype html><title>REALM SURFACE</title><body><script src="${here('realm-walker.js')}"></scr` +
		`ipt><script src="${here('realm-surface-child.js')}?realm=${name}&avoid=${encodeURIComponent(avoidText)}"></scr` +
		`ipt></body>`;
	const childPage = (name, make = here) =>
		make(
			`realm-surface-child.html?realm=${name}&avoid=${encodeURIComponent(avoidText)}`,
		);
	const step = async (name, run) => {
		if (!wanted(name)) return;
		const started = Date.now();
		try {
			await run();
		} catch (error) {
			state.realms[name] = { error: String(error?.stack ?? error) };
		}
		state.notes[name] = Date.now() - started;
	};

	// the top document, in full: every other window realm is kept against it
	let top = null;
	if (set !== 'workers' && set !== 'worklets')
		try {
			top = await walker.walkSettled(window, options());
			keep('top', { lines: walker.lines(top), counts: top.counts }, true);
		} catch (error) {
			state.realms.top = { error: String(error?.stack ?? error) };
		}

	if (set === 'frames') {
		await step('frame-same-origin', async () => {
			const element = frame({ src: childPage('frame-same-origin') });
			keep('frame-same-origin', await reportOf('frame-same-origin'));
			// identities across the two realms, read from this one
			const w = element.contentWindow;
			const made = w.document.createElement('a');
			state.identity = {
				'frame Function is not this Function': w.Function !== Function,
				'frame Object is not this Object': w.Object !== Object,
				'frame Array instance is not an instanceof this Array': !(
					new w.Array() instanceof Array
				),
				'frame Array instance is an Array to Array.isArray': Array.isArray(
					new w.Array(),
				),
				'frame function is not an instanceof this Function': !(
					w.setTimeout instanceof Function
				),
				'frame function is an instanceof its Function':
					w.setTimeout instanceof w.Function,
				'frame document prototype is its HTMLDocument.prototype':
					Object.getPrototypeOf(w.document) === w.HTMLDocument.prototype,
				'frame document is not an instanceof this Document': !(
					w.document instanceof Document
				),
				'frame element prototype is its HTMLAnchorElement.prototype':
					Object.getPrototypeOf(made) === w.HTMLAnchorElement.prototype,
				'frame element adopted keeps its prototype':
					Object.getPrototypeOf(document.adoptNode(made)) ===
					w.HTMLAnchorElement.prototype,
				'frame location prototype is its Location.prototype':
					Object.getPrototypeOf(w.location) === w.Location.prototype,
				'frame navigator prototype is its Navigator.prototype':
					Object.getPrototypeOf(w.navigator) === w.Navigator.prototype,
				'frame window prototype is its Window.prototype':
					Object.getPrototypeOf(w) === w.Window.prototype,
				'frame error is its TypeError': (() => {
					try {
						w.document.createElement();
					} catch (error) {
						return [
							error instanceof w.TypeError,
							error instanceof TypeError,
							Object.getPrototypeOf(error) === w.TypeError.prototype,
						].join();
					}
					return 'no error';
				})(),
				'this error through a frame function is the frame TypeError': (() => {
					try {
						w.Element.prototype.getAttribute.call(document.body);
					} catch (error) {
						return [
							error instanceof w.TypeError,
							error instanceof TypeError,
							error.message,
						].join();
					}
					return 'no error';
				})(),
				'frame parent is this window': w.parent === window,
				'frame top is this window': w.top === window,
				'frame frameElement is the element': w.frameElement === element,
				'frames[0] is the frame window': window[0] === w,
				'contentDocument is the frame document':
					element.contentDocument === w.document,
				'frame toString reads this fetch as native':
					w.Function.prototype.toString.call(fetch),
				'this toString reads the frame fetch as native':
					Function.prototype.toString.call(w.fetch),
				'frame fetch is not this fetch': w.fetch !== fetch,
			};
			element.remove();
		});
		await step('frame-cross-origin', async () => {
			const element = frame({
				src: childPage('frame-cross-origin', elsewhere),
			});
			keep('frame-cross-origin', await reportOf('frame-cross-origin'));
			element.remove();
		});
		await step('frame-srcdoc', async () => {
			const element = frame({ srcdoc: childMarkup('frame-srcdoc') });
			keep('frame-srcdoc', await reportOf('frame-srcdoc'));
			element.remove();
		});
		// an about:blank frame the moment it exists, before anything could
		// have run in it, and again once it has loaded
		await step('blank-sync', async () => {
			const element = document.createElement('iframe');
			document.body.append(element);
			const w = element.contentWindow;
			// a function taken now is the browser's own, and reads as one
			state.fresh = {
				fetch: Function.prototype.toString.call(w.fetch),
				toString: w.Function.prototype.toString.call(
					w.Function.prototype.toString,
				),
				setTimeout: w.Function.prototype.toString.call(w.setTimeout),
				'own keys of fetch': Reflect.ownKeys(w.fetch).join(),
				'document.write': w.Function.prototype.toString.call(w.document.write),
				'location.href': w.location.href,
				'document.URL': w.document.URL,
				readyState: w.document.readyState,
			};
			await outside('blank-sync', w);
			await sleep(300);
			if (wanted('blank-loaded')) await outside('blank-loaded', w);
			element.remove();
		});
		await step('frame-written', async () => {
			const element = frame();
			const child = element.contentDocument;
			child.open();
			child.write(childMarkup('frame-written'));
			child.close();
			keep('frame-written', await reportOf('frame-written'));
			element.remove();
		});
		await step('frame-detached', async () => {
			const element = frame();
			const w = element.contentWindow;
			element.remove();
			await outside('frame-detached', w);
		});
		await step('object-document', async () => {
			const element = document.createElement('object');
			element.type = 'text/html';
			element.data = childPage('object-document');
			document.body.append(element);
			keep('object-document', await reportOf('object-document'));
			element.remove();
		});
		await step('embed-document', async () => {
			const element = document.createElement('embed');
			element.type = 'text/html';
			element.src = childPage('embed-document');
			document.body.append(element);
			keep('embed-document', await reportOf('embed-document'));
			element.remove();
		});
		await step('sandbox-scripts', async () => {
			const element = frame({
				sandbox: 'allow-scripts',
				src: childPage('sandbox-scripts'),
			});
			keep('sandbox-scripts', await reportOf('sandbox-scripts'));
			element.remove();
		});
		await step('sandbox-same-origin', async () => {
			const element = frame({
				sandbox: 'allow-scripts allow-same-origin',
				src: childPage('sandbox-same-origin'),
			});
			keep('sandbox-same-origin', await reportOf('sandbox-same-origin'));
			element.remove();
		});
		await step('frame-data', async () => {
			const element = frame({
				src: `data:text/html,${encodeURIComponent(childMarkup('frame-data'))}`,
			});
			keep('frame-data', await reportOf('frame-data'));
			element.remove();
		});
		await step('frame-javascript', async () => {
			const element = frame();
			element.src = `javascript:${JSON.stringify(childMarkup('frame-javascript'))}`;
			keep('frame-javascript', await reportOf('frame-javascript'));
			element.remove();
		});
		// documents with no window: what their nodes are, by the names the
		// top document's walk gave this realm's prototypes
		await step('inert-documents', async () => {
			if (!top) throw new Error('no walk of the top document');
			const markup =
				'<!doctype html><html><head><base href="/based/"><title>t</title></head><body>' +
				'<a id="a" href="rel?x=1#h">a</a><img id="img" src="img.png" srcset="a.png 1x, b.png 2x">' +
				'<form id="form" action="act"><input id="input" formaction="fa"></form>' +
				'<iframe id="iframe" src="frame.html"></iframe><script id="script" src="s.js"></scr' +
				'ipt><link id="link" rel="stylesheet" href="s.css"><div id="div" style="background: url(bg.png)">d</div>' +
				'</body></html>';
			const made = document.implementation.createHTMLDocument('made');
			made.body.innerHTML = markup.slice(
				markup.indexOf('<body>') + 6,
				markup.indexOf('</body>'),
			);
			const parsed = new DOMParser().parseFromString(markup, 'text/html');
			const xml = new DOMParser().parseFromString(
				'<r xmlns:h="http://www.w3.org/1999/xhtml"><h:a id="a" href="rel">x</h:a><plain id="plain"/></r>',
				'application/xml',
			);
			const template = document.createElement('template');
			template.innerHTML = '<a id="a" href="rel">t</a>';
			const before = new Set(Object.keys(top.record));
			const documents = { made, parsed, xml, template: template.content };
			for (const name in documents) {
				const inert = documents[name];
				await top.inspect(inert, `inert.${name}`);
				const nodes =
					name === 'template'
						? [inert.firstChild]
						: [
								inert.documentElement,
								...inert.querySelectorAll('[id]'),
								inert.doctype,
							];
				for (const node of nodes)
					if (node)
						await top.inspect(
							node,
							`inert.${name}.${node.id || node.nodeName.toLowerCase()}`,
						);
			}
			const added = { record: {} };
			for (const path in top.record)
				if (!before.has(path)) added.record[path] = top.record[path];
			state.realms['inert-documents'] = { lines: walker.lines(added) };
			state.counts['inert-documents'] = {
				objects: Object.keys(added.record).length,
			};
		});
	}

	if (set === 'popups') {
		// a popup takes a click: the suite clicks each button, and the page
		// opens one window in each click's own task
		const clicked = (id) =>
			new Promise((resolve) => {
				const button = document.createElement('button');
				button.id = id;
				button.textContent = id;
				button.addEventListener(
					'click',
					() => {
						state.waiting = null;
						resolve();
					},
					{ once: true },
				);
				document.body.append(button);
				state.waiting = id;
			});
		await step('popup-blank-sync', async () => {
			await clicked('popup-blank');
			const popup = window.open('about:blank');
			if (!popup) throw new Error('no popup');
			await outside('popup-blank-sync', popup);
			await sleep(300);
			if (wanted('popup-blank-loaded'))
				await outside('popup-blank-loaded', popup);
			popup.close();
		});
		await step('popup-url', async () => {
			await clicked('popup-url');
			const popup = window.open(childPage('popup-url'));
			if (!popup) throw new Error('no popup');
			keep('popup-url', await reportOf('popup-url'));
			popup.close();
		});
		state.waiting = null;
	}

	if (set === 'workers') {
		base = null;
		baseName = null;
		const ask = (name, worker, message = {}) =>
			new Promise((resolve) => {
				const timer = setTimeout(
					() => resolve({ error: 'no report in 60000 ms' }),
					60000,
				);
				worker.addEventListener('message', (event) => {
					if (event.data?.realmSurface !== name) return;
					clearTimeout(timer);
					resolve(event.data);
				});
				worker.addEventListener('error', (event) => {
					clearTimeout(timer);
					resolve({ error: `worker error: ${event.message}` });
				});
				worker.postMessage({ realm: name, avoid, ...message });
			});
		const blob = (text, type = 'text/javascript') =>
			URL.createObjectURL(new Blob([text], { type }));
		await step('worker-classic', async () => {
			const worker = new Worker('realm-surface-worker.js');
			keep('worker-classic', await ask('worker-classic', worker), true);
			worker.terminate();
		});
		await step('worker-module', async () => {
			const worker = new Worker('realm-surface-module-worker.js', {
				type: 'module',
			});
			keep('worker-module', await ask('worker-module', worker));
			worker.terminate();
		});
		await step('worker-blob-classic', async () => {
			const worker = new Worker(
				blob(
					`importScripts(${JSON.stringify(here('realm-walker.js'))}, ${JSON.stringify(here('realm-surface-worker-body.js'))});`,
				),
			);
			keep('worker-blob-classic', await ask('worker-blob-classic', worker));
			worker.terminate();
		});
		await step('worker-blob-module', async () => {
			const worker = new Worker(
				blob(
					`import ${JSON.stringify(here('realm-walker.js'))}; import ${JSON.stringify(here('realm-surface-worker-body.js'))};`,
				),
				{ type: 'module' },
			);
			keep('worker-blob-module', await ask('worker-blob-module', worker));
			worker.terminate();
		});
		await step('worker-nested', async () => {
			const worker = new Worker('realm-surface-worker.js');
			keep(
				'worker-nested',
				await ask('worker-nested', worker, {
					nested: here('realm-surface-worker.js'),
				}),
			);
			worker.terminate();
		});
		await step('shared-worker', async () => {
			const worker = new SharedWorker('realm-surface-worker.js');
			worker.port.start();
			keep('shared-worker', await ask('shared-worker', worker.port));
		});
		await step('service-worker', async () => {
			const registration = await navigator.serviceWorker.register(
				'realm-surface-worker.js',
				{ scope: 'realm-surface-scope/' },
			);
			const active = await new Promise((resolve, reject) => {
				const worker =
					registration.installing ??
					registration.waiting ??
					registration.active;
				if (worker.state === 'activated') resolve(worker);
				worker.addEventListener('statechange', () => {
					if (worker.state === 'activated') resolve(worker);
					if (worker.state === 'redundant') reject(new Error('redundant'));
				});
				setTimeout(() => reject(new Error('never activated')), 30000);
			});
			const answer = new Promise((resolve) => {
				const timer = setTimeout(
					() => resolve({ error: 'no report in 60000 ms' }),
					60000,
				);
				navigator.serviceWorker.addEventListener('message', (event) => {
					if (event.data?.realmSurface !== 'service-worker') return;
					clearTimeout(timer);
					resolve(event.data);
				});
				navigator.serviceWorker.startMessages?.();
			});
			active.postMessage({ realm: 'service-worker', avoid });
			keep('service-worker', await answer);
			await registration.unregister();
		});
		await step('audio-worklet', async () => {
			// no device is opened: an offline context has the same worklet
			const context = new OfflineAudioContext(1, 128, 44100);
			await context.audioWorklet.addModule('realm-surface-audio-worklet.js');
			const node = new AudioWorkletNode(context, 'realm-surface');
			const report = await new Promise((resolve) => {
				const timer = setTimeout(
					() => resolve({ error: 'no report in 20000 ms' }),
					20000,
				);
				node.port.onmessage = (event) => {
					clearTimeout(timer);
					resolve(event.data);
				};
			});
			keep('audio-worklet', report);
		});
		await step('paint-worklet', async () => {
			if (!CSS.paintWorklet) throw new Error('no paint worklet');
			await CSS.paintWorklet.addModule('realm-surface-paint-worklet.js');
			const painted = document.createElement('div');
			painted.style.cssText =
				'width: 20px; height: 20px; background-image: paint(realm-surface)';
			document.body.append(painted);
			// the record leaves through the worklet's console: the suite
			// collects it
			state.realms['paint-worklet'] = { console: true };
			await sleep(1500);
		});
	}

	// the worklets a Chrome has only with a blink feature on (CSSLayoutAPI,
	// AnimationWorklet), which the suite walks in a browser of their own;
	// each record leaves through the worklet's console
	if (set === 'worklets') {
		await step('layout-worklet', async () => {
			if (!CSS.layoutWorklet) throw new Error('no layout worklet');
			await CSS.layoutWorklet.addModule('realm-surface-layout-worklet.js');
			const laid = document.createElement('div');
			laid.style.cssText = 'display: layout(realm-surface)';
			document.body.append(laid);
			state.realms['layout-worklet'] = { console: true };
		});
		await step('animation-worklet', async () => {
			if (!CSS.animationWorklet) throw new Error('no animation worklet');
			await CSS.animationWorklet.addModule(
				'realm-surface-animation-worklet.js',
			);
			const animated = document.createElement('div');
			document.body.append(animated);
			new WorkletAnimation(
				'realm-surface',
				new KeyframeEffect(animated, [{ opacity: 0 }, { opacity: 1 }], {
					duration: 1000,
				}),
			).play();
			state.realms['animation-worklet'] = { console: true };
		});
	}
	state.done = true;
})();
