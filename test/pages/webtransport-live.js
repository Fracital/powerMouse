// What the webtransport-live suite measures, natively and through the
// proxy, against the suite's WebTransport server (test/wtserver.mjs): this
// file is the page's script and a worker's own. `wtLive(name, params)`
// answers one case with something JSON can carry: no times, no chunk
// boundaries (they are the network's), logs in the order things happened.
// params: port (the server's), hash (its certificate's SHA-256, hex),
// run (a tag the server sees in every path).
(() => {
	const g = self;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const describe = (e) =>
		e === undefined
			? 'undefined'
			: e !== null && typeof e === 'object'
				? [
						e.constructor && e.constructor.name,
						e.name,
						e.message,
						'code ' + e.code,
						'source ' + e.source,
						'streamErrorCode ' + e.streamErrorCode,
						'WebTransportError ' + (e instanceof g.WebTransportError),
						'keys ' + Object.getOwnPropertyNames(e).join(),
					].join(' | ')
				: typeof e + ' ' + String(e);
	const settled = (promise, ms = 3000) =>
		Promise.race([
			Promise.resolve(promise).then(
				(value) =>
					'fulfilled ' +
					(value instanceof Uint8Array
						? 'bytes ' + new TextDecoder().decode(value)
						: JSON.stringify(value)),
				(e) => 'rejected ' + describe(e),
			),
			sleep(ms).then(() => 'pending'),
		]);
	const text = (s) => new TextEncoder().encode(s);
	const bytes = (hex) =>
		Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
	/** everything a readable gives until it ends, as text, and how it ended */
	async function drain(readable, limit = 1 << 24) {
		const reader = readable.getReader();
		const parts = [];
		let size = 0;
		let ending;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) {
					ending = 'done';
					break;
				}
				parts.push(value);
				size += value.byteLength;
				if (size > limit) {
					ending = 'over the limit';
					break;
				}
			}
		} catch (e) {
			ending = 'rejected ' + describe(e);
		}
		const all = new Uint8Array(size);
		let at = 0;
		for (const part of parts) {
			all.set(part, at);
			at += part.byteLength;
		}
		return { all, ending, types: [...new Set(parts.map((p) => tagOf(p)))] };
	}
	const tagOf = (chunk) =>
		chunk.constructor.name +
		(chunk.byteOffset === 0 && chunk.buffer.byteLength === chunk.byteLength
			? ''
			: ' (a view)');
	const sum = (data) => {
		let h = 0;
		for (let i = 0; i < data.length; i++) h = (h * 31 + data[i]) >>> 0;
		return h;
	};

	const open = (params, path, options = {}) => {
		const url = `https://127.0.0.1:${params.port}${path}${path.includes('?') ? '&' : '?'}run=${params.run}`;
		const pinned = options.pinned ?? true;
		const t = new WebTransport(url, {
			...(pinned && {
				serverCertificateHashes: [
					{ algorithm: 'sha-256', value: bytes(params.hash) },
				],
			}),
			...(options.protocols && { protocols: options.protocols }),
			...(options.headers && { headers: options.headers }),
			...options.more,
		});
		t.closed.catch(() => {});
		t.ready.catch(() => {});
		return t;
	};

	const cases = {
		/** a bidirectional stream echoed: small writes, a large one, what the page's streams are */
		async echo(params, options) {
			const t = open(params, '/echo', options);
			const out = { ready: await settled(t.ready) };
			const s = await t.createBidirectionalStream();
			out.shape = [
				Object.prototype.toString.call(s),
				Object.getPrototypeOf(s) === WebTransportBidirectionalStream.prototype,
				s.readable.constructor.name,
				s.writable.constructor.name,
			];
			out.byob = (() => {
				try {
					const r = s.readable.getReader({ mode: 'byob' });
					r.releaseLock();
					return r.constructor.name;
				} catch (e) {
					return 'throws ' + describe(e);
				}
			})();
			const w = s.writable.getWriter();
			out.desired = [w.desiredSize];
			const big = new Uint8Array(300000).map((_, i) => (i * 7) & 255);
			const writes = [
				w.write(text('hel')),
				w.write(new Uint16Array([0x6c6c, 0x206f])),
				w.write(new DataView(text('wo').buffer)),
				w.write(new Uint8Array(0)),
				w.write(big),
			];
			out.desired.push(w.desiredSize);
			out.writes = await Promise.all(writes.map((p) => settled(p)));
			out.desired.push(w.desiredSize);
			out.close = await settled(w.close());
			const { all, ending, types } = await drain(s.readable);
			out.read = [
				new TextDecoder().decode(all.slice(0, 9)),
				all.byteLength,
				sum(all.slice(9)) === sum(big),
				ending,
				types,
			];
			out.writerClosed = await settled(w.closed);
			out.afterClose = await settled(
				w.write(text('x')).catch((e) => Promise.reject(e)),
			);
			t.close();
			out.closed = await settled(t.closed);
			return out;
		},
		/** the server's own streams, and what its CONNECT request looked like */
		async push(params) {
			const t = open(params, '/push');
			const out = { ready: await settled(t.ready) };
			const uni = (await t.incomingUnidirectionalStreams.getReader().read())
				.value;
			const seen = JSON.parse(new TextDecoder().decode((await drain(uni)).all));
			out.request = {
				fields: Object.keys(seen.headers || {})
					.map((name) => name.toLowerCase())
					.sort(),
				origin: (seen.headers?.Origin || seen.headers?.origin || [])[0],
				path: seen.path,
				authority: seen.host,
			};
			const bidi = (await t.incomingBidirectionalStreams.getReader().read())
				.value;
			out.bidiShape = [
				Object.getPrototypeOf(bidi) ===
					WebTransportBidirectionalStream.prototype,
				bidi.readable.constructor.name,
				bidi.writable.constructor.name,
			];
			const reader = bidi.readable.getReader();
			out.first = await settled(reader.read().then((r) => r.value));
			const w = bidi.writable.getWriter();
			await w.write(text('pong'));
			const rest = [];
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				rest.push(new TextDecoder().decode(value));
			}
			out.echoed = rest.join('');
			out.writerAfterFin = [
				w.desiredSize,
				await settled(w.write(text('more'))),
			];
			out.writerClose = await settled(w.close());
			t.close({ closeCode: 1, reason: 'done' });
			out.closed = await settled(t.closed);
			return out;
		},
		/** a unidirectional stream of the page's, echoed on one of the server's */
		async uni(params) {
			const t = open(params, '/echo');
			await t.ready;
			const s = await t.createUnidirectionalStream();
			const out = { shape: [s.constructor.name, Object.keys(s)] };
			const w = s.getWriter();
			out.desired = w.desiredSize;
			await w.write(text('uni data'));
			out.close = await settled(w.close());
			const back = (await t.incomingUnidirectionalStreams.getReader().read())
				.value;
			const { all, ending } = await drain(back);
			out.back = [new TextDecoder().decode(all), ending];
			t.close();
			return out;
		},
		/** datagrams echoed, the numbers, and the oldest dropped from a queue nobody reads */
		async datagrams(params) {
			const t = open(params, '/echo');
			const d = t.datagrams;
			const out = { before: d.maxDatagramSize };
			const w = d.writable.getWriter();
			const early = w.write(text('early'));
			out.ready = await settled(t.ready);
			out.after = d.maxDatagramSize;
			out.early = await settled(early);
			const r = d.readable.getReader();
			out.echo = await settled(r.read().then((x) => x.value));
			out.huge = await settled(w.write(new Uint8Array(4000)));
			out.string = await settled(d.writable.getWriter ? w.write('nope') : null);
			t.close();
			return out;
		},
		/** the page closes with a code and a reason */
		async closeByPage(params) {
			const t = open(params, '/echo');
			await t.ready;
			const s = await t.createBidirectionalStream();
			const reader = s.readable.getReader();
			const writer = s.writable.getWriter();
			const log = [];
			const pending = [
				reader.read().then(
					() => log.push('read fulfilled'),
					(e) => log.push('read rejected ' + describe(e)),
				),
				writer.closed.then(
					() => log.push('writer closed'),
					(e) => log.push('writer rejected ' + describe(e)),
				),
				t.closed.then(
					(v) => log.push('closed ' + JSON.stringify(v)),
					(e) => log.push('closed rejected ' + describe(e)),
				),
			];
			t.close({ closeCode: 42, reason: 'bye' });
			log.push('closed');
			await Promise.race([Promise.all(pending), sleep(3000)]);
			log.push('again ' + String(t.close()));
			log.push(
				'create after: ' + (await settled(t.createBidirectionalStream(), 500)),
			);
			log.push('ready after: ' + (await settled(t.ready, 500)));
			return log;
		},
		/** the server closes with a code and a reason */
		async closeByServer(params) {
			const t = open(params, `/close?code=7&reason=srv&after=300`);
			await t.ready;
			const s = await t.createBidirectionalStream();
			const reader = s.readable.getReader();
			const writer = s.writable.getWriter();
			const log = [];
			await Promise.race([
				Promise.all([
					reader.read().then(
						(r) => log.push('read ' + JSON.stringify(r)),
						(e) => log.push('read rejected ' + describe(e)),
					),
					writer.closed.then(
						() => log.push('writer closed'),
						(e) => log.push('writer rejected ' + describe(e)),
					),
					t.closed.then(
						(v) => log.push('closed ' + JSON.stringify(v)),
						(e) => log.push('closed rejected ' + describe(e)),
					),
				]),
				sleep(4000),
			]);
			log.push(
				'datagram write after: ' +
					(await settled(
						t.datagrams.writable.getWriter().write(text('x')),
						500,
					)),
			);
			return log;
		},
		/** the server closes as webtransport-go does: its streams reset and stopped first (WEBTRANSPORT_SESSION_GONE) */
		async closeByServerGone(params) {
			const t = open(params, `/close?style=gone&code=7&reason=srv&after=300`);
			await t.ready;
			const s = await t.createBidirectionalStream();
			const reader = s.readable.getReader();
			const writer = s.writable.getWriter();
			const log = [];
			await Promise.race([
				Promise.all([
					reader.read().then(
						(r) => log.push('read ' + JSON.stringify(r)),
						(e) => log.push('read rejected ' + describe(e)),
					),
					writer.closed.then(
						() => log.push('writer closed'),
						(e) => log.push('writer rejected ' + describe(e)),
					),
					t.closed.then(
						(v) => log.push('closed ' + JSON.stringify(v)),
						(e) => log.push('closed rejected ' + describe(e)),
					),
				]),
				sleep(4000),
			]);
			log.push(
				'datagram write after: ' +
					(await settled(
						t.datagrams.writable.getWriter().write(text('x')),
						500,
					)),
			);
			return log;
		},
		/** the server resets its sending side (reset) or stops reading (stop) */
		async reset(params) {
			const t = open(params, `/reset?reset=7&stop=9`);
			await t.ready;
			const s = await t.createBidirectionalStream();
			const writer = s.writable.getWriter();
			await writer.write(text('x'));
			const out = {};
			out.read = await settled(s.readable.getReader().read());
			out.writerClosed = await settled(writer.closed);
			out.write = await settled(writer.write(text('y')));
			t.close();
			return out;
		},
		/** the page's own reset and stop: what the server hears (the suite reads its log) */
		async abort(params) {
			const t = open(params, '/echo');
			await t.ready;
			const s = await t.createBidirectionalStream();
			const writer = s.writable.getWriter();
			await writer.write(text('abc'));
			const reader = s.readable.getReader();
			await reader.read();
			await reader.cancel(new WebTransportError({ streamErrorCode: 5 }));
			await writer.abort(new WebTransportError({ streamErrorCode: 6 }));
			await sleep(300);
			t.close();
			return { aborted: true };
		},
		/** a session the server refuses */
		async refused(params) {
			const out = {};
			for (const path of ['/nope', '/refuse']) {
				const t = open(params, path);
				out[path] = [await settled(t.ready), await settled(t.closed)];
			}
			return out;
		},
		/**
		 * Chrome 158's members (each undefined before it) as a session comes
		 * up and ends: the reliability, the server's fields (none from /echo
		 * but its `:status`), draining, and the anticipated stream counts
		 */
		async later(params) {
			const A = 'anticipatedConcurrentIncomingBidirectionalStreams';
			const U = 'anticipatedConcurrentIncomingUnidirectionalStreams';
			const members = (t) => {
				const h = t.responseHeaders;
				return [
					t.reliability,
					h === null || h === undefined
						? String(h)
						: [Object.prototype.toString.call(h), ...[...h].map(String)],
					h === t.responseHeaders,
					t[A],
					t[U],
				];
			};
			const t = open(params, '/echo', { more: { [A]: 4 } });
			const out = { connecting: members(t) };
			const draining = t.draining;
			out.ready = await settled(t.ready);
			out.up = members(t);
			if (out.up[1] !== 'undefined')
				out.immutable = (() => {
					try {
						t.responseHeaders.append('x-a', 'b');
						return 'appended';
					} catch (e) {
						return e.name + ' ' + e.message;
					}
				})();
			t[A] = 9;
			t[U] = 1;
			out.set = members(t);
			t.close();
			out.closed = await settled(t.closed);
			out.over = members(t);
			out.draining = [draining === t.draining, await settled(draining, 200)];
			const refused = open(params, '/refuse');
			await settled(refused.closed);
			out.refused = members(refused);
			return out;
		},
		/** the protocol the server picks from the page's */
		async protocol(params) {
			const t = open(params, '/echo', { protocols: ['echo-v2', 'x'] });
			await t.ready;
			const out = [t.protocol];
			t.close();
			const u = open(params, '/echo');
			await u.ready;
			out.push(u.protocol);
			u.close();
			return out;
		},
		/**
		 * the page's own headers on the CONNECT (Chrome 157 on; before it
		 * there are none): which go out, in what order and how
		 */
		async headers(params) {
			const kinds = {
				record: {
					'X-Up': 'V',
					'x-a': ' \ttrimmed\t ',
					'b-first': '1',
					cookie: 'a=b',
					origin: 'https://other.example',
					'user-agent': 'x',
					'sec-x': '1',
					'proxy-x': '1',
					'x-http-method-override': 'GET, trace',
					'x-http-method': 'GET',
					'access-control-request-private-network': 'true',
					tab: 'a\tb',
					del: 'a\x7fb',
					empty: '',
					big: 'v'.repeat(20000),
				},
				pairs: [
					['x-dup', '2'],
					['x-dup', '1'],
					['a-z', 'v'],
				],
				headersObject: new Headers([
					['x-b', '2'],
					['x-a', '1'],
					['X-a', '3'],
				]),
				map: new Map([['x-m', '1']]),
			};
			const out = {};
			for (const [kind, headers] of Object.entries(kinds)) {
				const t = open(params, `/echo?kind=${kind}`, {
					headers,
					...(kind === 'map' && { protocols: ['p1', 'p2'] }),
				});
				out[kind] = await settled(t.ready);
				t.close();
			}
			return out;
		},
		/** a server that does not read: the page's writes stall on `ready`, and go on once it reads */
		async backpressure(params) {
			const t = open(params, '/slow?delay=2500');
			await t.ready;
			const s = await t.createBidirectionalStream();
			const w = s.writable.getWriter();
			const chunk = new Uint8Array(65536);
			let written = 0;
			let stalled = false;
			const start = Date.now();
			while (Date.now() - start < 6000) {
				const ready = await settled(w.ready, 800);
				if (ready === 'pending') {
					stalled = true;
					break;
				}
				w.write(chunk);
				written += chunk.byteLength;
			}
			// it stalls well before the server reads; then it reads all
			const out = { stalled, within: written < 8 * 1024 * 1024 };
			out.resumes = await settled(w.ready, 6000);
			await w.close();
			const answer = await drain(s.readable);
			out.counted = Number(new TextDecoder().decode(answer.all)) === written;
			t.close();
			return out;
		},
		/** a certificate the WebPKI takes (natively: the suite's flags; through the proxy: its root) */
		async webpki(params) {
			return cases.echo(params, { pinned: false });
		},
		/** a session to a path the content blocker's list refuses (natively the server refuses it) */
		async blocked(params) {
			const t = open(params, '/stomp-suites-ad/session');
			return [await settled(t.ready), await settled(t.closed)];
		},
		/** a pinned hash that is not the certificate's */
		async wrongHash(params) {
			const t = new WebTransport(`https://127.0.0.1:${params.port}/echo`, {
				serverCertificateHashes: [
					{ algorithm: 'sha-256', value: new Uint8Array(32) },
				],
			});
			t.closed.catch(() => {});
			return [await settled(t.ready), await settled(t.closed)];
		},
	};

	g.wtLive = async (name, params) => {
		try {
			return await cases[name](params);
		} catch (e) {
			return { probeError: describe(e) + ' ' + (e && e.stack) };
		}
	};
	// a worker answers its creator
	if (typeof g.document === 'undefined')
		g.onmessage = async (event) =>
			g.postMessage(await g.wtLive(event.data.name, event.data.params));
})();
