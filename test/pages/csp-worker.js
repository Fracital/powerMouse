// A worker of the csp-workers suite (test/csp-server.mjs /csp/cw.js, and
// the text of a blob: or data: worker the page makes of it): told a list
// of URLs, it opens a WebSocket (ws:) or a WebTransport session (https:)
// to each and answers with what each did and the securitypolicyviolation
// events its global saw. A dedicated or module worker is told by a
// message, a shared worker on its port, a service worker by a client's
// message (answered to its source).
(() => {
	const events = [];
	self.addEventListener('securitypolicyviolation', (event) => {
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
			target: event.target === self ? 'global' : String(event.target),
			bubbles: event.bubbles,
			composed: event.composed,
			cancelable: event.cancelable,
			isTrusted: event.isTrusted,
		});
	});
	const wait = (ms, value) =>
		new Promise((resolve) => setTimeout(() => resolve(value), ms));
	const error = (e) => `${e?.name}: ${e?.message}`;
	/** what a socket fired in its first 1.5 s, in order */
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
	/**
	 * Whether a session was refused by the policy (its `ready` rejected with
	 * the error Chrome gives a refusal): nothing listens at the URLs, so one
	 * that went out ends some other way, or not within the time
	 */
	const transport = async (url) => {
		let session;
		try {
			session = new WebTransport(url);
		} catch (e) {
			return `threw ${error(e)}`;
		}
		const ready = session.ready.then(
			() => 'ready',
			(e) =>
				/Content Security Policy/.test(e?.message)
					? `refused ${e.name}: ${e.message} (${e.source}, ${e.streamErrorCode})`
					: 'went out',
		);
		const closed = session.closed.then(
			() => 'closed',
			(e) =>
				/Content Security Policy/.test(e?.message)
					? `closed refused ${e.name}`
					: 'closed',
		);
		const outcome = await Promise.race([ready, wait(1000, 'went out')]);
		const end = await Promise.race([closed, wait(500, 'closed')]);
		try {
			session.close();
		} catch {
			// already over
		}
		return `${outcome}; ${end}`;
	};
	const run = async (urls) => {
		// side by side, each named by its host and kind
		const results = await Promise.all(
			urls.map(
				async (url) =>
					`${url.split('/')[2]} ${url.startsWith('ws') ? 'ws' : 'wt'}: ${
						url.startsWith('ws') ? await socket(url) : await transport(url)
					}`,
			),
		);
		// the events of the last connection are queued as tasks
		await wait(300);
		return { results, events };
	};
	const answer = (data, reply) => {
		if (!Array.isArray(data?.urls)) return;
		run(data.urls).then(reply, (e) => reply({ error: error(e) }));
	};
	if (typeof self.registration === 'object' && self.registration) {
		self.addEventListener('install', () => self.skipWaiting());
		self.addEventListener('activate', (event) =>
			event.waitUntil(self.clients.claim()),
		);
		self.addEventListener('message', (event) =>
			answer(event.data, (value) => event.source.postMessage(value)),
		);
	} else if ('onconnect' in self)
		self.addEventListener('connect', (event) => {
			const [port] = event.ports;
			port.onmessage = (message) =>
				answer(message.data, (value) => port.postMessage(value));
		});
	else
		self.addEventListener('message', (event) =>
			answer(event.data, (value) => postMessage(value)),
		);
})();
