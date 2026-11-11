// The cross-origin isolation battery (cross-origin-isolation suite). The
// fixture serves this script in a document whose headers the URL names
// (test/coi-server.mjs, /coi/doc), on site A (127.0.0.1) or site B
// (localhost). A top-level document runs every case of the parts its URL
// names and leaves the report in `window.__coi`; a frame's document
// (`role=frame`) reports what it sees to its parent. The suite loads the same
// URLs natively and through the proxy and compares each case.
//
//   parts=self,workers,frames,coep   which parts a top-level document runs
//   b=<origin>                       site B
//   c=<origin>                       another origin of this site (another
//                                    port of the fixture)
//   k=<key>                          the run's key for the fixture's logs
(() => {
	const params = new URLSearchParams(location.search);
	const role = params.get('role') ?? 'top';
	const A = location.origin;
	const B = params.get('b') ?? '';
	const C = params.get('c') ?? '';
	const key = params.get('k') ?? 'k';
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// ---- what a context reads, in a page and in a worker ----

	// the coarsest of Chrome's two clock resolutions every value is a
	// multiple of: 100 microseconds without isolation, 5 with it
	const gran = (values) => {
		const distinct = [...new Set(values)].filter(
			(value) => typeof value === 'number',
		);
		if (distinct.length < 3) return 'too few values';
		for (const step of [100, 5])
			if (
				distinct.every(
					(value) =>
						Math.abs(
							(value * 1000) / step - Math.round((value * 1000) / step),
						) < 1e-3,
				)
			)
				return `${step} us`;
		return 'finer than 5 us';
	};
	// `ms` of readings, and on until they changed a few times (up to a
	// second): a thread a busy machine deschedules may get none in `ms`
	const spin = (read, ms = 12) => {
		const values = [];
		const start = Date.now();
		let changes = 0;
		for (;;) {
			const elapsed = Date.now() - start;
			if (elapsed >= 1000 || (elapsed >= ms && changes >= 8)) break;
			const value = read();
			if (value !== values[values.length - 1]) changes++;
			values.push(value);
		}
		return values;
	};
	const shared = () =>
		new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer;
	const attempt = async (run) => {
		try {
			return await run();
		} catch (error) {
			return `${error.name}: ${error.message}`;
		}
	};
	const basics = () => ({
		crossOriginIsolated: self.crossOriginIsolated,
		SharedArrayBuffer: typeof self.SharedArrayBuffer,
		clock: gran(spin(() => performance.now())),
	});
	// the same in a worker's source
	const WORKER_BASICS = `const gran = ${gran}; const spin = ${spin}; const basics = ${basics};`;

	/** what the worker at `url` (or of `source`, a blob: worker) says, or how it failed */
	const workerSays = (make, timeout = 4000) =>
		new Promise((resolve) => {
			let worker;
			try {
				worker = make();
			} catch (error) {
				resolve(`${error.name}: ${error.message}`);
				return;
			}
			const port = worker.port ?? worker;
			port.onmessage = (event) => resolve(event.data);
			worker.onerror = () => resolve('error event');
			setTimeout(() => resolve('nothing'), timeout);
		});
	const blobURL = (source) =>
		URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	const resource = (origin, headers, extra = {}) =>
		`${origin}/coi/r?k=${key}${headers
			.map((header) => `&h=${encodeURIComponent(header)}`)
			.join('')}${Object.entries(extra)
			.map(([name, value]) => `&${name}=${encodeURIComponent(value)}`)
			.join('')}`;
	/** a 302 of `origin`, answered with `headers`, to `url` */
	const redirect = (origin, headers, url) =>
		`${origin}/coi/to?u=${encodeURIComponent(url)}${headers
			.map((header) => `&h=${encodeURIComponent(header)}`)
			.join('')}`;
	const COEP = 'cross-origin-embedder-policy:require-corp';
	const CREDENTIALLESS = 'cross-origin-embedder-policy:credentialless';
	const COOP = 'cross-origin-opener-policy:same-origin';
	const CORP = 'cross-origin-resource-policy:cross-origin';
	const PP_NONE = 'permissions-policy:cross-origin-isolated=()';
	const DIP = 'document-isolation-policy:isolate-and-require-corp';

	// ---- a frame's document: what it sees, to its parent ----

	const frameReport = async () => ({
		...basics(),
		policy: await attempt(() =>
			document.featurePolicy.allowsFeature('cross-origin-isolated'),
		),
		worker: await workerSays(
			() => new Worker(blobURL(`${WORKER_BASICS} postMessage(basics());`)),
		),
	});
	if (role === 'frame') {
		(async () => {
			// it loaded: the parent waits for the report however long it takes
			parent.postMessage({ coiFrame: params.get('name'), started: true }, '*');
			const report = await frameReport();
			// a frame of its own, when asked: a document of site A with an
			// embedder policy (and what a frame of another origin needs)
			if (params.get('inner'))
				report.inner = await frameSays({
					origin: params.get('inner') === 'a' ? params.get('a') : A,
					headers: [COEP, CORP],
					allow: params.get('innerallow') ?? '',
				});
			parent.postMessage({ coiFrame: params.get('name'), report }, '*');
		})();
		return;
	}

	/** what the document in a new frame reports, and what its parent sees of it */
	function frameSays({
		origin,
		headers = [],
		allow,
		credentialless,
		url,
		srcdoc,
		extra = '',
		through,
	}) {
		return new Promise((resolve) => {
			const name = `f${Math.random().toString(36).slice(2)}`;
			const frame = document.createElement('iframe');
			if (allow) frame.allow = allow;
			if (credentialless) frame.setAttribute('credentialless', '');
			let loads = 0;
			let started = false;
			// a document that loaded says so before its load event and
			// reports once it is done; one that was refused never does
			frame.addEventListener('load', () => {
				loads++;
				setTimeout(() => started || finish(null), 2500);
			});
			let finished = false;
			const finish = (report) => {
				if (finished) return;
				finished = true;
				removeEventListener('message', onMessage);
				let reach;
				try {
					reach = frame.contentDocument ? 'document' : 'no document';
				} catch (error) {
					reach = error.name;
				}
				frame.remove();
				resolve(
					report ?? { blocked: true, loadEvents: loads > 0, parentSees: reach },
				);
			};
			const onMessage = (event) => {
				if (event.data?.coiFrame !== name) return;
				if (!event.data.started) finish(event.data.report);
				else if (!started) {
					started = true;
					clearTimeout(timer);
					timer = setTimeout(() => finish(null), 60000);
				}
			};
			addEventListener('message', onMessage);
			let timer = setTimeout(() => finish(null), 8000);
			if (srcdoc !== undefined) frame.srcdoc = srcdoc(name);
			else {
				const to =
					url?.(name) ??
					`${origin}/coi/doc?role=frame&name=${name}&k=${key}&a=${encodeURIComponent(A)}${headers
						.map((header) => `&h=${encodeURIComponent(header)}`)
						.join('')}${extra}`;
				// `through`: a redirect of that origin, with those headers, first
				frame.src = through ? redirect(through[0], through[1], to) : to;
			}
			document.body.append(frame);
		});
	}

	// ---- the cases ----

	const cases = {};
	const pending = [];
	const add = (name, run) => pending.push([name, run]);
	const parts = (params.get('parts') ?? 'self').split(',');

	if (parts.includes('self')) {
		add('self/crossOriginIsolated', () => self.crossOriginIsolated);
		add('self/the crossOriginIsolated accessor', () => {
			const descriptor = Object.getOwnPropertyDescriptor(
				self,
				'crossOriginIsolated',
			);
			return [
				typeof descriptor.get,
				typeof descriptor.set,
				descriptor.enumerable,
				descriptor.configurable,
				descriptor.get.name,
				Function.prototype.toString.call(descriptor.get),
			];
		});
		add('self/the SharedArrayBuffer global', () => {
			const descriptor = Object.getOwnPropertyDescriptor(
				self,
				'SharedArrayBuffer',
			);
			return {
				typeof: typeof self.SharedArrayBuffer,
				in: 'SharedArrayBuffer' in self,
				named: Object.getOwnPropertyNames(self).includes('SharedArrayBuffer'),
				descriptor: descriptor && [
					typeof descriptor.value,
					descriptor.writable,
					descriptor.enumerable,
					descriptor.configurable,
				],
			};
		});
		add('self/SharedArrayBuffer through a shared WebAssembly.Memory', () => {
			const buffer = shared();
			const Constructor = buffer.constructor;
			return {
				name: Constructor.name,
				tag: Object.prototype.toString.call(buffer),
				constructs: new Constructor(8).byteLength,
				isTheGlobal: Constructor === self.SharedArrayBuffer,
			};
		});
		add('self/structuredClone of a SharedArrayBuffer', () =>
			attempt(() => structuredClone(shared()).byteLength),
		);
		add('self/structuredClone of a typed array on a SharedArrayBuffer', () =>
			attempt(
				() =>
					structuredClone({ deep: [new Int32Array(shared())] }).deep[0].length,
			),
		);
		add('self/window.postMessage of a SharedArrayBuffer', () =>
			attempt(
				() =>
					new Promise((resolve) => {
						const onMessage = (event) => {
							if (event.data?.coiSelf === undefined) return;
							removeEventListener('message', onMessage);
							resolve(Object.prototype.toString.call(event.data.coiSelf));
						};
						addEventListener('message', onMessage);
						setTimeout(() => resolve('no message'), 1500);
						postMessage({ coiSelf: shared() }, '*');
					}),
			),
		);
		add('self/MessagePort.postMessage of a SharedArrayBuffer', () =>
			attempt(
				() =>
					new Promise((resolve) => {
						const channel = new MessageChannel();
						channel.port2.onmessage = (event) =>
							resolve(Object.prototype.toString.call(event.data));
						channel.port2.onmessageerror = () => resolve('messageerror');
						setTimeout(() => resolve('no message'), 1500);
						channel.port1.postMessage(shared());
					}),
			),
		);
		add('self/BroadcastChannel.postMessage of a SharedArrayBuffer', () =>
			attempt(() => {
				const channel = new BroadcastChannel('coi');
				try {
					channel.postMessage(shared());
					return 'posted';
				} finally {
					channel.close();
				}
			}),
		);
		add('self/a SharedArrayBuffer posted to a worker is shared with it', () =>
			attempt(async () => {
				const buffer = shared();
				const said = await workerSays(() => {
					const worker = new Worker(
						blobURL(
							`onmessage = (event) => { new Int32Array(event.data)[0] = 7; postMessage(Object.prototype.toString.call(event.data)); };`,
						),
					);
					worker.postMessage(buffer);
					return worker;
				});
				return [said, new Int32Array(buffer)[0]];
			}),
		);
		add('self/a SharedArrayBuffer as history state and in IndexedDB', () =>
			attempt(async () => [
				await attempt(() => history.replaceState(shared(), '')),
				await new Promise((resolve) => {
					const open = indexedDB.open(`coi-${key}-${Math.random()}`);
					open.onupgradeneeded = () => open.result.createObjectStore('s');
					open.onsuccess = () => {
						try {
							open.result
								.transaction('s', 'readwrite')
								.objectStore('s')
								.put(shared(), 1);
							resolve('stored');
						} catch (error) {
							resolve(`${error.name}: ${error.message}`);
						}
					};
					open.onerror = () => resolve('open failed');
				}),
			]),
		);
		add('self/Atomics on the main thread', async () => [
			await attempt(() => Atomics.wait(new Int32Array(shared()), 0, 0, 0)),
			await attempt(
				() => typeof Atomics.waitAsync(new Int32Array(shared()), 0, 0, 0).value,
			),
		]);
		add('self/performance.measureUserAgentSpecificMemory', () =>
			attempt(async () => [
				typeof performance.measureUserAgentSpecificMemory,
				'measureUserAgentSpecificMemory' in Performance.prototype,
				typeof performance.measureUserAgentSpecificMemory === 'function'
					? Object.keys(
							await Promise.race([
								performance.measureUserAgentSpecificMemory(),
								sleep(100).then(() => ({ pending: true })),
							]),
						).length > 0
					: null,
			]),
		);
		add('self/the permission by document.featurePolicy', () =>
			attempt(() => [
				document.featurePolicy.allowsFeature('cross-origin-isolated'),
				document.featurePolicy
					.allowedFeatures()
					.includes('cross-origin-isolated'),
				document.featurePolicy.getAllowlistForFeature('cross-origin-isolated'),
			]),
		);
		add('self/clock: performance.now', () =>
			gran(spin(() => performance.now())),
		);
		add('self/clock: Event.timeStamp', () =>
			gran(spin(() => new Event('x').timeStamp)),
		);
		add('self/clock: a dispatched message event', async () => {
			// until the stamps have changed a few times: on a quick machine
			// two dozen messages can share fewer than three 100 microsecond
			// values
			const values = [];
			for (let i = 0; i < 2000 && (i < 24 || new Set(values).size < 8); i++)
				values.push(
					await new Promise((resolve) => {
						const channel = new MessageChannel();
						channel.port1.onmessage = (event) => resolve(event.timeStamp);
						channel.port2.postMessage(1);
					}),
				);
			return gran(values);
		});
		add('self/clock: performance.mark and measure', () => [
			gran(spin(() => performance.mark('coi').startTime, 8)),
			gran(spin(() => performance.measure('coi-m', 'coi').duration, 8)),
		]);
		add(
			'self/clock: requestAnimationFrame and the document timeline',
			async () => {
				const frames = [];
				const timeline = [];
				for (let i = 0; i < 10; i++) {
					frames.push(await new Promise(requestAnimationFrame));
					timeline.push(document.timeline.currentTime);
				}
				return [gran(frames), gran(timeline)];
			},
		);
		add('self/clock: the navigation and resource timing entries', async () => {
			// enough entries for the values to tell the clock, each waited for
			// (an entry may come after its fetch has settled, seconds after on
			// a busy machine). A fetch's entry is made once its body has been
			// read to the end: one left unread makes none, natively and
			// through the proxy, and the page's script alone gave too few
			// values now and then.
			const entries = () => performance.getEntriesByType('resource').length;
			const before = entries();
			for (let n = 1; n <= 6; n++)
				await (await fetch(resource(A, [], { n }))).text();
			for (let i = 0; i < 300 && entries() < before + 6; i++) await sleep(50);
			const numbers = (entry) =>
				Object.values(entry.toJSON()).filter(
					(value) => typeof value === 'number' && value % 1 !== 0,
				);
			// judged together: one clock coarsens both, and the navigation
			// entry of a quick load holds too few values of its own (its
			// times fall together)
			return gran([
				...numbers(performance.getEntriesByType('navigation')[0]),
				...performance.getEntriesByType('resource').flatMap(numbers),
			]);
		});
	}

	if (parts.includes('workers')) {
		const report = `${WORKER_BASICS} postMessage(basics());`;
		const routed = (headers, extra = {}) =>
			resource(A, headers, { type: 'js', js: report, ...extra });
		add('workers/a blob: worker', () =>
			workerSays(() => new Worker(blobURL(report))),
		);
		add('workers/a worker whose script has no embedder policy', () =>
			workerSays(() => new Worker(routed([]))),
		);
		add('workers/a worker whose script has an embedder policy', () =>
			workerSays(() => new Worker(routed([COEP]))),
		);
		add(
			'workers/a worker whose script has an embedder policy, through a redirect without one',
			() => workerSays(() => new Worker(redirect(A, [], routed([COEP])))),
		);
		add(
			'workers/a worker whose script has no embedder policy, through a redirect with one',
			() => workerSays(() => new Worker(redirect(A, [COEP], routed([])))),
		);
		add('workers/a worker whose script is credentialless', () =>
			workerSays(() => new Worker(routed([CREDENTIALLESS]))),
		);
		add('workers/a module worker whose script has an embedder policy', () =>
			workerSays(
				() => new Worker(routed([COEP], { m: 1 }), { type: 'module' }),
			),
		);
		add('workers/a shared worker whose script has an embedder policy', () =>
			workerSays(
				() =>
					new SharedWorker(
						resource(A, [COEP], {
							type: 'js',
							js: `${WORKER_BASICS} onconnect = (event) => event.ports[0].postMessage(basics());`,
							s: key,
						}),
					),
			),
		);
		add('workers/a shared worker whose script has no embedder policy', () =>
			workerSays(
				() =>
					new SharedWorker(
						resource(A, [], {
							type: 'js',
							js: `${WORKER_BASICS} onconnect = (event) => event.ports[0].postMessage(basics());`,
							s: `${key}n`,
						}),
					),
			),
		);
		add('workers/a worker of a worker', () =>
			workerSays(
				() =>
					new Worker(
						blobURL(
							`const inner = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(report)}]))); inner.onmessage = (event) => postMessage(event.data); inner.onerror = () => postMessage('error event');`,
						),
					),
			),
		);
		add('workers/a worker makes a SharedArrayBuffer and posts it', () =>
			workerSays(
				() =>
					new Worker(
						blobURL(
							`try { const buffer = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer; postMessage(buffer); } catch (error) { postMessage(error.name + ': ' + error.message); }`,
						),
					),
			).then((data) =>
				typeof data === 'string' ? data : Object.prototype.toString.call(data),
			),
		);
		add(
			'workers/a worker reads the clock and the timestamps of its events',
			() =>
				workerSays(
					() =>
						new Worker(
							blobURL(
								`${WORKER_BASICS} postMessage([gran(spin(() => performance.now())), gran(spin(() => new Event('x').timeStamp)), typeof performance.measureUserAgentSpecificMemory]);`,
							),
						),
				),
		);
	}

	if (parts.includes('frames')) {
		const frame = (name, spec) => add(`frames/${name}`, () => frameSays(spec));
		frame('same origin, no headers', { origin: A });
		frame('same origin, an embedder policy', { origin: A, headers: [COEP] });
		frame('same origin, credentialless', {
			origin: A,
			headers: [CREDENTIALLESS],
		});
		frame('same origin, COOP and an embedder policy', {
			origin: A,
			headers: [COOP, COEP],
		});
		frame('same origin, an embedder policy and a permissions policy of none', {
			origin: A,
			headers: [COEP, PP_NONE],
		});
		frame("same origin, an embedder policy, allow 'none'", {
			origin: A,
			headers: [COEP],
			allow: "cross-origin-isolated 'none'",
		});
		frame('another origin, no headers', { origin: B });
		frame('another origin, an embedder policy', { origin: B, headers: [COEP] });
		frame('another origin, an embedder and a resource policy', {
			origin: B,
			headers: [COEP, CORP],
		});
		frame('another origin, an embedder and a resource policy, allowed', {
			origin: B,
			headers: [COEP, CORP],
			allow: 'cross-origin-isolated',
		});
		frame('another origin, an embedder and a resource policy, allowed *', {
			origin: B,
			headers: [COEP, CORP],
			allow: 'cross-origin-isolated *',
		});
		frame('another origin, a resource policy only, allowed', {
			origin: B,
			headers: [CORP],
			allow: 'cross-origin-isolated',
		});
		frame('another origin, credentialless and a resource policy, allowed', {
			origin: B,
			headers: [CREDENTIALLESS, CORP],
			allow: 'cross-origin-isolated',
		});
		frame('another origin, a same-origin resource policy, allowed', {
			origin: B,
			headers: [COEP, 'cross-origin-resource-policy:same-origin'],
			allow: 'cross-origin-isolated',
		});
		// a redirect on the way needs no embedder policy, and from another
		// origin than this document's the resource policy
		frame('same origin, through a redirect of this origin without headers', {
			origin: A,
			headers: [COEP],
			through: [A, []],
		});
		frame('same origin, through a redirect of another origin without headers', {
			origin: A,
			headers: [COEP],
			through: [B, []],
		});
		frame(
			'same origin, through a redirect of another origin with a resource policy',
			{ origin: A, headers: [COEP], through: [B, [CORP]] },
		);
		frame('another origin, allowed, through its own redirect without headers', {
			origin: B,
			headers: [COEP, CORP],
			allow: 'cross-origin-isolated',
			through: [B, []],
		});
		frame(
			'another origin, allowed, through its own redirect with an embedder policy only',
			{
				origin: B,
				headers: [COEP, CORP],
				allow: 'cross-origin-isolated',
				through: [B, [COEP]],
			},
		);
		frame(
			'another origin, allowed, through its own redirect with a resource policy',
			{
				origin: B,
				headers: [COEP, CORP],
				allow: 'cross-origin-isolated',
				through: [B, [CORP]],
			},
		);
		// the permission is delegated to the origin the element names
		frame(
			'another origin, allowed, through a redirect of this origin without headers',
			{
				origin: B,
				headers: [COEP, CORP],
				allow: 'cross-origin-isolated',
				through: [A, []],
			},
		);
		frame('a credentialless frame of this origin, no headers', {
			origin: A,
			credentialless: true,
		});
		frame('a credentialless frame of another origin, no headers', {
			origin: B,
			credentialless: true,
		});
		frame('a credentialless frame of another origin, no headers, allowed', {
			origin: B,
			credentialless: true,
			allow: 'cross-origin-isolated',
		});
		frame('about:srcdoc', {
			srcdoc: (name) =>
				`<script>parent.postMessage({ coiFrame: ${JSON.stringify(name)}, report: { crossOriginIsolated: self.crossOriginIsolated, SharedArrayBuffer: typeof self.SharedArrayBuffer } }, '*')</script>`,
		});
		add('frames/about:blank', () => {
			const blank = document.createElement('iframe');
			document.body.append(blank);
			const seen = {
				crossOriginIsolated: blank.contentWindow.crossOriginIsolated,
				SharedArrayBuffer: typeof blank.contentWindow.SharedArrayBuffer,
			};
			blank.remove();
			return seen;
		});
		frame('a blob: document', {
			url: (name) =>
				URL.createObjectURL(
					new Blob(
						[
							`<script>parent.postMessage({ coiFrame: ${JSON.stringify(name)}, report: { crossOriginIsolated: self.crossOriginIsolated, SharedArrayBuffer: typeof self.SharedArrayBuffer } }, '*')</script>`,
						],
						{ type: 'text/html' },
					),
				),
		});
		frame(
			'same origin with an embedder policy, and its own frame of this origin',
			{
				origin: A,
				headers: [COEP],
				extra: '&inner=self',
			},
		);
		frame(
			'another origin, allowed, and its own frame of this origin, allowed',
			{
				origin: B,
				headers: [COEP, CORP],
				allow: 'cross-origin-isolated',
				extra: '&inner=a&innerallow=cross-origin-isolated',
			},
		);
		frame('another origin, allowed, and its own frame of this origin', {
			origin: B,
			headers: [COEP, CORP],
			allow: 'cross-origin-isolated',
			extra: '&inner=a',
		});
		frame('same origin, a Document-Isolation-Policy', {
			origin: A,
			headers: [COEP, DIP],
		});
	}

	if (parts.includes('coep')) {
		const element = (tag, attributes) =>
			new Promise((resolve) => {
				const node = document.createElement(tag);
				node.onload = () => resolve('load');
				node.onerror = () => resolve('error');
				setTimeout(() => resolve('nothing'), 4000);
				Object.assign(node, attributes);
				document.head.append(node);
			});
		const image = (name, origin, headers, attributes = {}) =>
			add(`coep/an image of ${name}`, () =>
				element('img', {
					...attributes,
					src: resource(origin, headers, { type: 'png', c: name }),
				}),
			);
		image('this origin without a resource policy', A, []);
		image('another origin without a resource policy', B, []);
		image('another origin with Cross-Origin-Resource-Policy cross-origin', B, [
			CORP,
		]);
		image('another origin with Cross-Origin-Resource-Policy same-site', B, [
			'cross-origin-resource-policy:same-site',
		]);
		image('another origin under CORS', B, ['access-control-allow-origin:*'], {
			crossOrigin: 'anonymous',
		});
		// every hop of another origin is judged
		const redirected = (name, origin, headers, to) =>
			add(`coep/an image ${name}`, () =>
				element('img', { src: redirect(origin, headers, to) }),
			);
		redirected(
			'of another origin with a resource policy, through its redirect without one',
			B,
			[],
			resource(B, [CORP], { type: 'png', c: 'r1' }),
		);
		redirected(
			'of another origin with a resource policy, through its redirect with one',
			B,
			[CORP],
			resource(B, [CORP], { type: 'png', c: 'r2' }),
		);
		redirected(
			'of another origin with a resource policy, through a redirect of this origin',
			A,
			[],
			resource(B, [CORP], { type: 'png', c: 'r3' }),
		);
		redirected(
			'of this origin, through a redirect of another origin without a resource policy',
			B,
			[],
			resource(A, [], { type: 'png', c: 'r4' }),
		);
		add('coep/a script of another origin without a resource policy', () =>
			element('script', {
				src: resource(B, [], { type: 'js', js: 'self.__coiScript = 1;' }),
			}),
		);
		add('coep/a script of another origin with a resource policy', () =>
			element('script', {
				src: resource(B, [CORP], { type: 'js', js: 'self.__coiScript = 2;' }),
			}),
		);
		add('coep/a stylesheet of another origin without a resource policy', () =>
			element('link', {
				rel: 'stylesheet',
				href: resource(B, [], { type: 'css' }),
			}),
		);
		add(
			'coep/a no-cors fetch of another origin without a resource policy',
			() =>
				attempt(
					async () =>
						(await fetch(resource(B, [], { f: 1 }), { mode: 'no-cors' })).type,
				),
		);
		add('coep/a no-cors fetch of another origin with a resource policy', () =>
			attempt(
				async () =>
					(await fetch(resource(B, [CORP], { f: 2 }), { mode: 'no-cors' }))
						.type,
			),
		);
		add('coep/a cors fetch of another origin', () =>
			attempt(
				async () =>
					(
						await fetch(
							resource(B, ['access-control-allow-origin:*'], { f: 3 }),
						)
					).type,
			),
		);
		image(
			'another origin of this site with Cross-Origin-Resource-Policy same-site',
			C,
			['cross-origin-resource-policy:same-site'],
		);
		image('another origin of this site without a resource policy', C, []);
		add(
			'coep/the cookies a load of another origin of this site carries',
			async () => {
				// a cookie of this host goes to its other port too; a credentialless
				// document's no-cors load of another origin goes without it
				document.cookie = 'coi=1; path=/';
				const sent = async (name, attributes, extra = {}) => {
					const k2 = `${key}-${name}`;
					await element('img', {
						...attributes,
						src: `${C}/coi/r?k=${k2}&type=png${Object.entries(extra)
							.map(
								([header, value]) =>
									`&h=${encodeURIComponent(`${header}:${value}`)}`,
							)
							.join('')}`,
					});
					const log = await (await fetch(`${C}/coi/log?k=${k2}`)).json();
					return log.requests.map((request) => request.cookie);
				};
				return {
					'no-cors': await sent(
						'nocors',
						{},
						{
							'cross-origin-resource-policy': 'cross-origin',
						},
					),
					'cors with credentials': await sent(
						'cors',
						{ crossOrigin: 'use-credentials' },
						{
							'access-control-allow-origin': A,
							'access-control-allow-credentials': 'true',
						},
					),
					'same origin': await (async () => {
						await fetch(`${A}/coi/r?k=${key}-same`);
						const log = await (
							await fetch(`${A}/coi/log?k=${key}-same`)
						).json();
						return log.requests.map((request) => request.cookie);
					})(),
				};
			},
		);
	}

	(async () => {
		window.__coi = { done: false, cases };
		for (const [name, run] of pending) {
			try {
				cases[name] = await run();
			} catch (error) {
				cases[name] = `threw ${error?.name}: ${error?.message}`;
			}
			if (cases[name] === undefined) cases[name] = 'undefined';
		}
		window.__coi.done = true;
	})();
})();
