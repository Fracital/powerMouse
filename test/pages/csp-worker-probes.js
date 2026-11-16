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
	};
	const TEXT = self.__cspWorkerText;
	const scriptURL = (policy, extra = {}) =>
		`/csp/cw.js?${new URLSearchParams({ ...POLICIES[policy], ...extra })}`;
	/** what a worker answered, as compared: its outcomes, and its events sorted */
	const said = (answer) => {
		if (typeof answer === 'string') return answer;
		if (answer?.error) return `worker threw ${answer.error}`;
		const seen = (answer?.events ?? []).map((event) => JSON.stringify(event));
		return JSON.stringify({ results: answer?.results, events: seen.sort() });
	};
	/** the answer of a worker that takes messages on `target` and answers on `from` */
	const ask = (target, from) =>
		Promise.race([
			new Promise((resolve) => {
				from.addEventListener('message', (event) => resolve(event.data), {
					once: true,
				});
				if ('start' in from) from.start();
				target.postMessage({ urls: URLS });
			}),
			wait(12000, 'no answer'),
		]);
	const failed = (worker) =>
		new Promise((resolve) =>
			worker.addEventListener('error', (event) =>
				resolve(`worker error ${event.message ?? ''}`.trim()),
			),
		);
	const dedicated = async (url, options) => {
		let worker;
		try {
			worker = new Worker(url, options);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		const answer = await Promise.race([ask(worker, worker), failed(worker)]);
		worker.terminate();
		return said(answer);
	};
	const shared = async (url, name) => {
		let worker;
		try {
			worker = new SharedWorker(url, name);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		return said(
			await Promise.race([ask(worker.port, worker.port), failed(worker)]),
		);
	};
	const service = async (policy, name) => {
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
		const answer = await ask(worker, navigator.serviceWorker);
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
