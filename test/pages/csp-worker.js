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
			lineNumber: event.lineNumber,
			columnNumber: event.columnNumber,
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
	/** what an XMLHttpRequest fired, in order, and its status at the end */
	const xhr = (url, sync) =>
		new Promise((resolve) => {
			let request;
			try {
				request = new XMLHttpRequest();
			} catch (e) {
				return resolve(`threw ${error(e)}`);
			}
			const seen = [];
			for (const type of ['loadstart', 'load', 'error', 'abort', 'loadend'])
				request.addEventListener(type, () =>
					seen.push(`${type} ${request.readyState} ${request.status}`),
				);
			const end = () => resolve(seen.join(', ') || 'nothing');
			if (!sync) request.addEventListener('loadend', () => setTimeout(end));
			try {
				request.open('GET', url, !sync);
				request.send();
			} catch (e) {
				seen.push(`threw ${error(e)}`);
				return end();
			}
			if (sync) end();
			else setTimeout(end, 3000);
		});
	/** what an EventSource fired in its first 1.5 s */
	const eventSource = (url) =>
		new Promise((resolve) => {
			let source;
			try {
				source = new EventSource(url);
			} catch (e) {
				return resolve(`threw ${error(e)}`);
			}
			const seen = [];
			source.onopen = () => seen.push('open');
			source.onmessage = (event) => seen.push(`message ${event.data}`);
			source.onerror = () => {
				seen.push(`error ${source.readyState}`);
				// (an open one reconnects: once is enough)
				source.close();
			};
			setTimeout(() => {
				source.close();
				resolve(seen.join(', ') || 'nothing');
			}, 1500);
		});
	/** a nested worker of `url` (or of this worker's text, for `blob`) told `message` */
	const nested = (url, message, text) =>
		new Promise((resolve) => {
			let worker;
			try {
				worker = new Worker(
					url === 'blob'
						? URL.createObjectURL(
								new Blob([text ?? ''], { type: 'text/javascript' }),
							)
						: url,
				);
			} catch (e) {
				return resolve(`threw ${error(e)}`);
			}
			worker.onmessage = (event) => {
				const answer = event.data;
				resolve(
					JSON.stringify({
						results: answer?.results,
						requests: answer?.requests,
						events: (answer?.events ?? [])
							.map((seen) => JSON.stringify(seen))
							.sort(),
					}),
				);
				worker.terminate();
			};
			worker.onerror = () => resolve('nested worker error');
			worker.postMessage(message);
			setTimeout(() => resolve('nested no answer'), 9000);
		});
	/** what one request of the page's did: `[kind, url, more]` */
	const request = async ([kind, url, more]) => {
		switch (kind) {
			case 'fetch':
				return fetch(url).then(
					(response) => `ok ${response.status} ${response.type}`,
					(e) => `rejected ${error(e)}`,
				);
			case 'xhr':
				return typeof XMLHttpRequest === 'function' ? xhr(url) : 'absent';
			case 'xhr-sync':
				return typeof XMLHttpRequest === 'function' ? xhr(url, true) : 'absent';
			case 'es':
				return typeof EventSource === 'function' ? eventSource(url) : 'absent';
			case 'import-scripts': {
				const before = self.__ran ?? 0;
				try {
					importScripts(url);
				} catch (e) {
					return `threw ${error(e)}`;
				}
				return `ran ${(self.__ran ?? 0) - before}`;
			}
			case 'import':
				return import(url).then(
					() => 'imported',
					(e) => `rejected ${error(e)}`,
				);
			case 'beacon':
				return `sendBeacon ${typeof navigator.sendBeacon}`;
			case 'nested':
				return typeof Worker === 'function'
					? nested(url, more, textOf)
					: 'absent';
			default:
				return 'no such request';
		}
	};
	// a worker that makes a blob: worker of its own text is told it
	let textOf;
	const run = async (urls, requests) => {
		// side by side, each named by its host and kind
		const results = await Promise.all(
			urls.map(
				async (url) =>
					`${url.split('/')[2]} ${url.startsWith('ws') ? 'ws' : 'wt'}: ${
						url.startsWith('ws') ? await socket(url) : await transport(url)
					}`,
			),
		);
		// one after another, each named by its kind and where it went
		const made = [];
		for (const entry of requests ?? [])
			made.push(
				`${entry[0]} ${String(entry[1] ?? '').replace(/^https?:\/\/[^/]+/, (origin) => origin.split(':')[1].slice(2))}: ${await request(entry)}`,
			);
		// the events of the last connection are queued as tasks
		await wait(300);
		return requests ? { results, requests: made, events } : { results, events };
	};
	const answer = (data, reply) => {
		if (!Array.isArray(data?.urls)) return;
		if (typeof data.text === 'string') textOf = data.text;
		run(data.urls, data.requests).then(reply, (e) =>
			reply({ error: error(e) }),
		);
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
