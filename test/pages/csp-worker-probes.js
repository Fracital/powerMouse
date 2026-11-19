// The probes of a /csp/doc?js=worker page (test/csp-server.mjs, the
// csp-workers suite): each starts a worker of one kind under one policy
// (test/pages/csp-worker.js) and says what the worker's WebSockets and
// WebTransport sessions did and which securitypolicyviolation events the
// worker's global saw; `ws-*` and `wt-*` connect from the document itself.
// `window.__csp` holds the outcomes and the document's own violation events,
// as test/pages/csp-probes.js does.
//
// A worker probe is `w-<kind>-<policy>`: the kind is dedicated, module,
// shared, service (registered by the page), blob, blob-module, shared-blob
// or data (made of the worker's text, which inherit the document's
// policies, or not); the policy is the worker script's own response
// header (`plain` for none).
(() => {
	const query = new URLSearchParams(location.search);
	const names = (query.get('probes') ?? '').split(',').filter(Boolean);
	const other = location.origin.includes('127.0.0.1')
		? location.origin.replace('127.0.0.1', 'localhost')
		: location.origin.replace('localhost', '127.0.0.1');
	const events = [];
	document.addEventListener('securitypolicyviolation', (event) => {
		const target = event.target;
		events.push({
			blockedURI: event.blockedURI,
			violatedDirective: event.violatedDirective,
			effectiveDirective: event.effectiveDirective,
			originalPolicy: event.originalPolicy,
			disposition: event.disposition,
			documentURI: event.documentURI,
			referrer: event.referrer,
			sourceFile: event.sourceFile,
			statusCode: event.statusCode,
			sample: event.sample,
			target:
				target === document
					? 'document'
					: target instanceof Element
						? target.localName
						: String(target),
			bubbles: event.bubbles,
			composed: event.composed,
			isTrusted: event.isTrusted,
		});
	});
	const wait = (ms, value = 'timeout') =>
		new Promise((resolve) => setTimeout(() => resolve(value), ms));
	const error = (e) => `${e?.name}: ${e?.message}`;
	const wsURL = (origin) => `${origin.replace(/^http/, 'ws')}/ws-echo`;
	// nothing listens for QUIC there: a session that goes out fails
	const wtURL = (origin) => `${origin.replace(/^http:/, 'https:')}/wt`;
	const URLS = [
		wsURL(location.origin),
		wsURL(other),
		wtURL(location.origin),
		wtURL(other),
	];
	/** the worker script's own policies, by the probe's name for them */
	const POLICIES = {
		plain: {},
		connect: { wp: "connect-src 'self'" },
		default: { wp: "default-src 'self'" },
		none: { wp: "connect-src 'none'" },
		ro: { wro: "connect-src 'self'" },
		'connect-ro': { wp: "connect-src 'self' ws:", wro: "connect-src 'none'" },
		script: { wp: "script-src 'self'" },
		'default-ro': { wro: "default-src 'self'" },
		'worker-none': { wp: "worker-src 'none'" },
		// a module worker whose script imports another origin's module
		'plain-si': { si: `${other}/csp/wrun.js` },
		'default-si': { wp: "default-src 'self'", si: `${other}/csp/wrun.js` },
		// policies that report to the fixture (a requests probe's key)
		report: { wp: "connect-src 'self'", rk: '' },
		'report-ro': { wro: "connect-src 'self'", rk: '' },
		'report-to': { wp: "connect-src 'self'", rk: '', rt: '' },
	};
	const TEXT = self.__cspWorkerText;
	const scriptURL = (policy, extra = {}) =>
		`/csp/cw.js?${new URLSearchParams({ ...POLICIES[policy], ...extra })}`;
	/** a requests probe's script: one that reports does under the probe's key */
	const reportingURL = (policy, k, extra = {}) =>
		scriptURL(policy, 'rk' in POLICIES[policy] ? { ...extra, rk: k } : extra);
	/** what a worker answered, as compared: its outcomes, and its events sorted */
	const said = (answer) => {
		if (typeof answer === 'string') return answer;
		if (answer?.error) return `worker threw ${answer.error}`;
		const seen = (answer?.events ?? []).map((event) => JSON.stringify(event));
		return JSON.stringify({
			results: answer?.results,
			...(answer?.requests ? { requests: answer.requests } : {}),
			events: seen.sort(),
		});
	};
	/** the answer of a worker that takes messages on `target` and answers on `from` */
	const ask = (target, from, message = { urls: URLS }) =>
		Promise.race([
			new Promise((resolve) => {
				from.addEventListener('message', (event) => resolve(event.data), {
					once: true,
				});
				if ('start' in from) from.start();
				target.postMessage(message);
			}),
			wait(12000, 'no answer'),
		]);
	const failed = (worker) =>
		new Promise((resolve) =>
			worker.addEventListener('error', (event) =>
				resolve(`worker error ${event.message ?? ''}`.trim()),
			),
		);
	const dedicated = async (url, options, message) => {
		let worker;
		try {
			worker = new Worker(url, options);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		const answer = await Promise.race([
			ask(worker, worker, message),
			failed(worker),
		]);
		worker.terminate();
		return said(answer);
	};
	const shared = async (url, name, message) => {
		let worker;
		try {
			worker = new SharedWorker(url, name);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		return said(
			await Promise.race([
				ask(worker.port, worker.port, message),
				failed(worker),
			]),
		);
	};
	const service = async (policy, name, message) => {
		const scope = `/csp/sw-${name}/`;
		let registration;
		try {
			registration = await navigator.serviceWorker.register(
				scriptURL(policy, { sw: name }),
				{ scope },
			);
		} catch (e) {
			return `register threw ${error(e)}`;
		}
		const worker =
			registration.active ?? registration.waiting ?? registration.installing;
		if (!worker.state.startsWith('activ'))
			await Promise.race([
				new Promise((resolve) =>
					worker.addEventListener('statechange', () => {
						if (worker.state === 'activated') resolve();
					}),
				),
				wait(8000),
			]);
		const answer = await ask(worker, navigator.serviceWorker, message);
		await registration.unregister();
		return said(answer);
	};
	const blobOf = () =>
		URL.createObjectURL(new Blob([TEXT], { type: 'text/javascript' }));
	const dataOf = () => `data:text/javascript,${encodeURIComponent(TEXT ?? '')}`;
	const socket = (url) =>
		new Promise((resolve) => {
			let ws;
			try {
				ws = new WebSocket(url);
			} catch (e) {
				return resolve(`threw ${error(e)}`);
			}
			const seen = [];
			ws.onopen = () => seen.push('open');
			ws.onerror = () => seen.push(`error ${ws.readyState}`);
			ws.onclose = (event) => seen.push(`close ${event.code}`);
			setTimeout(() => resolve(seen.join(', ') || 'nothing'), 1500);
		});
	const transport = async (url) => {
		let session;
		try {
			session = new WebTransport(url);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		const outcome = await Promise.race([
			session.ready.then(
				() => 'ready',
				(e) =>
					/Content Security Policy/.test(e?.message)
						? `refused ${e.name}: ${e.message} (${e.source}, ${e.streamErrorCode})`
						: 'went out',
			),
			wait(1000, 'went out'),
		]);
		try {
			session.close();
		} catch {
			// already over
		}
		return outcome;
	};

	const PROBES = {
		'ws-self': () => socket(URLS[0]),
		'ws-other': () => socket(URLS[1]),
		'wt-self': () => transport(URLS[2]),
		'wt-other': () => transport(URLS[3]),
	};
	for (const policy of Object.keys(POLICIES)) {
		PROBES[`w-dedicated-${policy}`] = () => dedicated(scriptURL(policy));
		PROBES[`w-module-${policy}`] = () =>
			dedicated(scriptURL(policy), { type: 'module' });
		PROBES[`w-shared-${policy}`] = () =>
			shared(scriptURL(policy, { n: `${query.get('case')}` }), policy);
		// (the scope is in the script's URL, which a violation names: the
		// same natively and proxied)
		PROBES[`w-service-${policy}`] = () =>
			service(
				policy,
				`${policy}-${(query.get('case') ?? '').replace(/[^a-z]+/gi, '-')}`,
			);
	}
	// The requests a worker makes (`r-<kind>-<policy>`): what each did, and
	// the events the worker's global saw; `k` marks those that reached the
	// fixture, which the probe reads back
	// (an `h-` probe's worker fetches a URL of its own origin that redirects
	// to another, alone)
	const requests = (name) => {
		const k = `${query.get('case')}-${name}`.replace(/[^a-z0-9-]+/gi, '-');
		const at = (origin, path) =>
			`${origin}${path}${path.includes('?') ? '&' : '?'}k=${k}`;
		if (name.startsWith('h-'))
			return {
				k,
				message: {
					urls: [],
					text: TEXT,
					requests: [
						['fetch', at(location.origin, `/csp/to?u=${other}/csp/ok`)],
					],
				},
			};
		return {
			k,
			message: {
				urls: [],
				text: TEXT,
				requests: [
					['fetch', at(location.origin, '/csp/ok')],
					['fetch', at(other, '/csp/ok')],
					['fetch', 'data:,data'],
					['xhr', at(other, '/csp/ok')],
					['xhr-sync', at(other, '/csp/ok?sync')],
					['es', at(location.origin, '/csp/sse')],
					['es', at(other, '/csp/sse')],
					['import-scripts', at(other, '/csp/wrun.js')],
					['import', at(other, '/csp/wrun.js?import')],
					['beacon'],
				],
			},
		};
	};
	/** the answer of a requests probe, and the paths of it that reached the fixture */
	const reached = async (k, answer, policy) => {
		// (a report is sent a moment after its violation)
		await wait(policy && 'rk' in POLICIES[policy] ? 2500 : 300);
		const paths = await fetch(`/csp/log?k=${k}&clear`).then(
			(response) => response.json(),
			() => ['log unread'],
		);
		return `${answer}; reached ${[...paths].sort().join(' ')}`;
	};
	for (const policy of Object.keys(POLICIES)) {
		for (const kind of ['r', 'h'])
			PROBES[`${kind}-dedicated-${policy}`] = () => {
				const { k, message } = requests(`${kind}-dedicated-${policy}`);
				return dedicated(reportingURL(policy, k), undefined, message).then(
					(a) => reached(k, a, policy),
				);
			};
		PROBES[`r-module-${policy}`] = () => {
			const { k, message } = requests(`r-module-${policy}`);
			return dedicated(
				reportingURL(policy, k),
				{ type: 'module' },
				message,
			).then((a) => reached(k, a, policy));
		};
		PROBES[`r-shared-${policy}`] = () => {
			const { k, message } = requests(`r-shared-${policy}`);
			return shared(
				reportingURL(policy, k, { n: `r-${query.get('case')}` }),
				`r-${policy}`,
				message,
			).then((a) => reached(k, a, policy));
		};
		PROBES[`r-service-${policy}`] = () => {
			const { k, message } = requests(`r-service-${policy}`);
			return service(
				policy,
				`r-${policy}-${(query.get('case') ?? '').replace(/[^a-z]+/gi, '-')}`,
				message,
			).then((a) => reached(k, a, policy));
		};
		// a worker's own worker: of a URL under `policy`, and of a blob:
		// (which has `policy` too). A worker of a worker opens its socket
		// only where one is refused (written when it had no transport
		// through the proxy)
		PROBES[`n-dedicated-${policy}`] = () => {
			const { k, message } = requests(`n-dedicated-${policy}`);
			const inner = (refused) => ({
				urls: refused ? [URLS[1], URLS[3]] : [URLS[3]],
				requests: message.requests.slice(0, 2),
			});
			return dedicated(scriptURL(policy), undefined, {
				urls: [],
				text: TEXT,
				requests: [
					['nested', scriptURL('plain'), inner(false)],
					['nested', scriptURL('connect'), inner(true)],
					['nested', 'blob', inner(policy === 'connect')],
				],
			}).then((a) => reached(k, a));
		};
	}
	PROBES['r-blob-plain'] = () => {
		const { k, message } = requests('r-blob-plain');
		return dedicated(blobOf(), undefined, message).then((a) => reached(k, a));
	};
	PROBES['r-blob-module-plain'] = () => {
		const { k, message } = requests('r-blob-module-plain');
		return dedicated(blobOf(), { type: 'module' }, message).then((a) =>
			reached(k, a),
		);
	};
	PROBES['r-shared-blob-plain'] = () => {
		const { k, message } = requests('r-shared-blob-plain');
		return shared(blobOf(), `r-blob-${query.get('case')}`, message).then((a) =>
			reached(k, a),
		);
	};
	PROBES['r-data-plain'] = () => {
		const { k, message } = requests('r-data-plain');
		return dedicated(dataOf(), undefined, message).then((a) => reached(k, a));
	};
	PROBES['w-blob-plain'] = () => dedicated(blobOf());
	PROBES['w-blob-module-plain'] = () => dedicated(blobOf(), { type: 'module' });
	PROBES['w-shared-blob-plain'] = () => shared(blobOf(), 'blob');
	PROBES['w-data-plain'] = () => dedicated(dataOf());

	(async () => {
		const results = {};
		for (const name of names) {
			try {
				results[name] = PROBES[name] ? await PROBES[name]() : 'no such probe';
			} catch (e) {
				results[name] = `probe threw ${error(e)}`;
			}
		}
		// the violation events of the last probes are queued as tasks
		await wait(500);
		window.__csp = { done: true, case: query.get('case'), results, events };
	})();
})();
