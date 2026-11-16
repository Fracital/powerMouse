// What the webtransport suite measures, natively and through the proxy, in
// a page and in every kind of worker (this file is the page's script and
// the workers' own). `wtRun(name, params)` answers one case with something
// JSON can carry: no times, and logs in the order things happened.
// params: closed (a UDP port nothing listens on), silent (one that hears
// and never answers).
(() => {
	const g = self;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const tag = (value) => Object.prototype.toString.call(value);
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
						'DOMException ' + (e instanceof DOMException),
						'keys ' + Object.getOwnPropertyNames(e).join(),
						// the lines of the stack that are not the page's own frames
						'stack ' +
							String(e.stack)
								.split('\n')
								.filter((line) => !/^\s+at /.test(line))
								.join(' / '),
					].join(' | ')
				: typeof e + ' ' + String(e);
	const attempt = (f) => {
		try {
			const value = f();
			return 'ok ' + (typeof value === 'object' ? tag(value) : String(value));
		} catch (e) {
			return 'throws ' + describe(e);
		}
	};
	const settled = (promise, ms = 1500) =>
		Promise.race([
			Promise.resolve(promise).then(
				(value) =>
					'fulfilled ' +
					(value !== null && typeof value === 'object'
						? tag(value) + ' ' + JSON.stringify(value)
						: String(value)),
				(e) => 'rejected ' + describe(e),
			),
			sleep(ms).then(() => 'pending'),
		]);
	const member = (t, name) =>
		Object.getOwnPropertyDescriptor(g.WebTransport.prototype, name).get.call(t);
	const quiet = (t) => {
		member(t, 'ready').catch(() => {});
		member(t, 'closed').catch(() => {});
		return t;
	};

	/** one session to `url`, and what the page sees of it */
	async function session(WT, url, options, how) {
		const log = [];
		const born = performance.now();
		const t = options ? new WT(url, options) : new WT(url);
		const outcome = (settled) =>
			settled.status === 'fulfilled'
				? 'fulfilled ' + JSON.stringify(settled.value)
				: 'rejected ' + describe(settled.reason);
		// how the session ended and when, whatever was asked of it meanwhile
		const ended = Promise.allSettled([t.ready, t.closed]).then(
			([ready, closed]) => ({
				ready: outcome(ready),
				closed: outcome(closed),
				after: Math.round(performance.now() - born),
			}),
		);
		const waits = [];
		const watch = (name, promise, ms) =>
			waits.push(
				settled(promise, ms).then((result) => log.push(name + ': ' + result)),
			);
		t.ready.then(
			() => log.push('ready fulfilled'),
			(e) => log.push('ready rejected ' + describe(e)),
		);
		t.closed.then(
			(v) => log.push('closed fulfilled ' + JSON.stringify(v)),
			(e) => log.push('closed rejected ' + describe(e)),
		);
		const all = (when) => {
			watch(when + ' createBidirectionalStream', t.createBidirectionalStream());
			watch(
				when + ' createUnidirectionalStream',
				t.createUnidirectionalStream(),
			);
			const writer = t.datagrams.writable.getWriter();
			watch(when + ' datagram write', writer.write(new Uint8Array(3)));
			writer.releaseLock();
			const reader = t.datagrams.readable.getReader();
			watch(when + ' datagram read', reader.read());
			reader.closed.catch(() => {});
		};
		const out = {};
		if (how === 'early') all('early');
		if (how === 'close') {
			out.close = attempt(() => t.close({ closeCode: 7, reason: 'bye' }));
			// the streams' state right after, before any task
			out.desiredSize = attempt(() => {
				const writer = t.datagrams.writable.getWriter();
				const size = writer.desiredSize;
				writer.releaseLock();
				return size;
			});
			out.closeAgain = attempt(() => t.close());
		}
		await Promise.race([Promise.allSettled([t.ready, t.closed]), sleep(3000)]);
		await sleep(50);
		log.push('--- settled');
		if (how !== 'early') all('late');
		watch(
			'incoming bidirectional read',
			t.incomingBidirectionalStreams.getReader().read(),
		);
		watch(
			'incoming unidirectional read',
			t.incomingUnidirectionalStreams.getReader().read(),
		);
		await Promise.all(waits);
		out.lateClose = attempt(() => t.close());
		out.lateCloseInfo = attempt(() => t.close({ closeCode: 1, reason: 'x' }));
		out.writerDesiredSize = attempt(() => {
			const writer = t.datagrams.writable.getWriter();
			const size = writer.desiredSize;
			writer.releaseLock();
			return size;
		});
		out.protocol = t.protocol;
		out.log = log;
		out.end = await Promise.race([ended, sleep(8000).then(() => 'pending')]);
		return out;
	}

	const cases = {
		/** every way to name a server and its options, by what the constructor says */
		async construct({ closed }) {
			const WT = g.WebTransport;
			const u = 'https://127.0.0.1:' + closed + '/';
			// a session that is made is closed at once: it never starts
			const make = (...args) =>
				attempt(() => {
					const t = quiet(new WT(...args));
					t.close();
					return t;
				});
			const hash = (value, algorithm = 'sha-256') => ({ algorithm, value });
			const out = {
				call: attempt(() => WT(u)),
				noArguments: attempt(() => new WT()),
				empty: make(''),
				relative: make('foo'),
				pathOnly: make('/x'),
				http: make('http://127.0.0.1:' + closed + '/'),
				wss: make('wss://127.0.0.1/'),
				upperScheme: make('HTTPS://127.0.0.1:' + closed + '/'),
				fragment: make(u + '#x'),
				emptyFragment: make(u + '#'),
				fragmentEscaped: make(u + '#a b"<'),
				badPort: make('https://127.0.0.1:99999/'),
				spaceInHost: make('https://exa mple/'),
				noHost: make('https:///'),
				userinfo: make('https://u:p@127.0.0.1:' + closed + '/'),
				urlObject: make(new URL(u)),
				number: make(5),
				nullURL: make(null),
				undefinedURL: make(undefined),
				symbol: make(Symbol('s')),
				loneSurrogate: make('https://127.0.0.1/\ud800#\ud800'),
				toStringThrows: make({
					toString() {
						throw new RangeError('from toString');
					},
				}),
				optionsNumber: make(u, 1),
				optionsNull: make(u, null),
				optionsUndefined: make(u, undefined),
				optionsString: make(u, 'x'),
				optionsFunction: make(u, () => {}),
				optionsSymbol: make(u, Symbol('o')),
				unknownMembers: make(u, {
					allowPooling: true,
					requireUnreliable: true,
					congestionControl: 'bogus',
				}),
				hashesNumber: make(u, { serverCertificateHashes: 1 }),
				hashesNull: make(u, { serverCertificateHashes: null }),
				hashesString: make(u, { serverCertificateHashes: 'ab' }),
				hashesObject: make(u, { serverCertificateHashes: {} }),
				hashesEmpty: make(u, { serverCertificateHashes: [] }),
				hashesSet: make(u, {
					serverCertificateHashes: new Set([hash(new Uint8Array(32))]),
				}),
				hashNumber: make(u, { serverCertificateHashes: [1] }),
				hashNull: make(u, { serverCertificateHashes: [null] }),
				hashEmpty: make(u, { serverCertificateHashes: [{}] }),
				hashNoValue: make(u, {
					serverCertificateHashes: [{ algorithm: 'sha-256' }],
				}),
				hashNoAlgorithm: make(u, {
					serverCertificateHashes: [{ value: new Uint8Array(32) }],
				}),
				hashValueString: make(u, { serverCertificateHashes: [hash('abc')] }),
				hashValueNull: make(u, { serverCertificateHashes: [hash(null)] }),
				hashValueArray: make(u, { serverCertificateHashes: [hash([1, 2])] }),
				hashSha1: make(u, {
					serverCertificateHashes: [hash(new Uint8Array(20), 'sha-1')],
				}),
				hashShort: make(u, {
					serverCertificateHashes: [hash(new Uint8Array(31))],
				}),
				hashBuffer: make(u, {
					serverCertificateHashes: [hash(new ArrayBuffer(32))],
				}),
				hashView: make(u, {
					serverCertificateHashes: [hash(new DataView(new ArrayBuffer(32)))],
				}),
				protocolsString: make(u, { protocols: 'a' }),
				protocolsNumber: make(u, { protocols: 5 }),
				protocolsNull: make(u, { protocols: null }),
				protocolsList: make(u, { protocols: ['a', 'b'] }),
				protocolsNumbers: make(u, { protocols: [1, null, undefined] }),
				protocolsSymbol: make(u, { protocols: [Symbol('p')] }),
				hashSymbolAlgorithm: make(u, {
					serverCertificateHashes: [hash(new Uint8Array(32), Symbol('a'))],
				}),
				protocolsDuplicate: make(u, { protocols: ['a', 'a'] }),
				protocolsEmptyName: make(u, { protocols: [''] }),
				protocolsSpace: make(u, { protocols: ['a b'] }),
				protocolsControl: make(u, { protocols: ['a\tb'] }),
				protocolsNonASCII: make(u, { protocols: ['é'] }),
				protocols511: make(u, { protocols: ['a'.repeat(511)] }),
				protocols512: make(u, { protocols: ['a'.repeat(512)] }),
				// which refusal comes first
				badURLAndOptions: make('foo', 1),
				badURLAndProtocols: make('foo', { protocols: ['a', 'a'] }),
				httpAndFragment: make('http://127.0.0.1/#x'),
				fragmentAndProtocols: make(u + '#x', { protocols: [''] }),
				duplicateAndHashes: make(u, {
					protocols: ['a', 'a'],
					serverCertificateHashes: 1,
				}),
				emptyThenDuplicate: make(u, { protocols: ['a', 'a', ''] }),
			};
			// the order the options are read in
			const reads = [];
			const logged = (name, target) =>
				new Proxy(target, {
					get(t, key) {
						reads.push(name + '.' + String(key));
						return t[key];
					},
				});
			out.readOrder = [
				make(
					{
						toString() {
							reads.push('url');
							return u;
						},
					},
					logged('options', {
						protocols: logged('protocols', ['a']),
						serverCertificateHashes: logged('hashes', [
							logged('hash', hash(new Uint8Array(32))),
						]),
					}),
				),
				reads.filter((read) => !read.includes('Symbol(Symbol.toPrimitive)')),
			];
			return out;
		},

		/** the constructor and the prototypes, before and after a session is made */
		async shapes({ closed }) {
			const names = [
				'WebTransport',
				'WebTransportBidirectionalStream',
				'WebTransportDatagramDuplexStream',
				'WebTransportError',
			];
			const descriptor = (object, key) => {
				const d = Object.getOwnPropertyDescriptor(object, key);
				if (!d) return 'none';
				const fn = (f) =>
					typeof f === 'function'
						? [
								'function',
								f.name,
								f.length,
								Function.prototype.toString.call(f),
								'prototype' in f,
								Object.getOwnPropertyNames(f).join(),
							].join(' ')
						: typeof f === 'object' && f !== null
							? tag(f)
							: String(f);
				return Object.keys(d)
					.map((part) => part + ' ' + fn(d[part]))
					.join('; ');
			};
			const shape = () => {
				const out = {};
				out.globals = Object.getOwnPropertyNames(g)
					.filter((name) => /WebTransport/.test(name))
					.sort();
				for (const name of names) {
					const C = g[name];
					if (typeof C !== 'function') {
						out[name] = typeof C;
						continue;
					}
					out[name] = {
						global: descriptor(g, name),
						string: String(C),
						parent:
							Object.getPrototypeOf(C) === Function.prototype
								? 'Function.prototype'
								: Object.getPrototypeOf(C).name,
						own: Reflect.ownKeys(C).map(
							(key) => String(key) + ': ' + descriptor(C, key),
						),
						prototype: Reflect.ownKeys(C.prototype).map(
							(key) => String(key) + ': ' + descriptor(C.prototype, key),
						),
						constructorIsGlobal: C.prototype.constructor === C,
					};
				}
				return out;
			};
			const before = shape();
			const t = quiet(new g.WebTransport('https://127.0.0.1:' + closed + '/'));
			void t.datagrams.readable;
			t.close();
			const after = shape();
			return {
				before,
				afterIsBefore: JSON.stringify(after) === JSON.stringify(before),
				after: JSON.stringify(after) === JSON.stringify(before) ? null : after,
			};
		},

		/** what a session's members are and take, with no server needed */
		async members({ closed }) {
			const WT = g.WebTransport;
			const u = 'https://127.0.0.1:' + closed + '/';
			const out = {};
			const t = quiet(new WT(u));
			const d = t.datagrams;
			out.identity = [
				t.ready === t.ready,
				t.closed === t.closed,
				t.datagrams === d,
				d.readable === d.readable,
				d.writable === d.writable,
				t.incomingBidirectionalStreams === t.incomingBidirectionalStreams,
				t.incomingUnidirectionalStreams === t.incomingUnidirectionalStreams,
				t.incomingBidirectionalStreams !== t.incomingUnidirectionalStreams,
			];
			out.kinds = [
				tag(t),
				String(t),
				tag(d),
				tag(d.readable),
				tag(d.writable),
				t.ready instanceof Promise,
				t instanceof WT,
				d instanceof g.WebTransportDatagramDuplexStream,
				d.readable.constructor === ReadableStream,
				d.writable.constructor === WritableStream,
				Object.getPrototypeOf(t) === WT.prototype,
				Object.getOwnPropertyNames(t).length,
				Object.isExtensible(t),
				JSON.stringify(t),
				JSON.stringify(d),
				t.protocol,
			];
			out.streams = {
				byob: attempt(() => {
					const reader = d.readable.getReader({ mode: 'byob' });
					reader.releaseLock();
					return 'a byte stream';
				}),
				incomingByob: attempt(() =>
					t.incomingBidirectionalStreams.getReader({ mode: 'byob' }),
				),
				writerDesiredSize: attempt(() => {
					const writer = d.writable.getWriter();
					const size = writer.desiredSize;
					writer.releaseLock();
					return size;
				}),
				locked: [d.readable.locked, d.writable.locked],
			};
			const numbers = [
				'maxDatagramSize',
				'incomingMaxAge',
				'outgoingMaxAge',
				'incomingMaxBufferedDatagrams',
				'outgoingMaxBufferedDatagrams',
				'incomingHighWaterMark',
				'outgoingHighWaterMark',
			];
			out.defaults = numbers.map((name) => name + ' ' + d[name]);
			out.set = {};
			for (const name of numbers)
				for (const value of [
					5,
					0,
					-1,
					1.7,
					NaN,
					Infinity,
					'8',
					'x',
					null,
					undefined,
					2 ** 31,
					2 ** 32 + 3,
					{},
				]) {
					const key =
						name +
						' = ' +
						(typeof value === 'string' ? JSON.stringify(value) : String(value));
					out.set[key] =
						attempt(() => {
							d[name] = value;
							return 'set';
						}) +
						' -> ' +
						d[name];
				}
			out.close = {
				number: attempt(() => t.close(5)),
				string: attempt(() => t.close('x')),
			};
			const reads = [];
			out.closeReads = [
				attempt(() =>
					t.close(
						new Proxy(
							{},
							{
								get(target, key) {
									reads.push(String(key));
									return undefined;
								},
							},
						),
					),
				),
				reads,
			];
			const t2 = quiet(new WT(u));
			out.closeValues = {
				negative: attempt(() => t2.close({ closeCode: -1 })),
				big: attempt(() => quiet(new WT(u)).close({ closeCode: 2 ** 32 })),
				text: attempt(() => quiet(new WT(u)).close({ closeCode: 'x' })),
				longReason: attempt(() =>
					quiet(new WT(u)).close({ reason: 'x'.repeat(1025) }),
				),
				symbolReason: attempt(() =>
					quiet(new WT(u)).close({ reason: Symbol('r') }),
				),
				symbolCode: attempt(() =>
					quiet(new WT(u)).close({ closeCode: Symbol('c') }),
				),
			};
			// createBidirectionalStream's options, and what it reads of them
			const t3 = quiet(new WT(u));
			const optionReads = [];
			const options = new Proxy(
				{},
				{
					get(target, key) {
						optionReads.push(String(key));
						return undefined;
					},
				},
			);
			t3.createBidirectionalStream(options).catch(() => {});
			t3.createUnidirectionalStream(options).catch(() => {});
			out.createReads = optionReads;
			out.createNumber = await settled(t3.createBidirectionalStream(5));
			out.createString = await settled(t3.createUnidirectionalStream('x'));
			// (kept until the session has failed where the browser keeps them,
			// which takes as long as the throttle holds the session)
			out.createNull = await settled(t3.createBidirectionalStream(null), 20000);
			t3.close();

			// members called on something that is no session
			const illegal = {};
			for (const key of Reflect.ownKeys(WT.prototype)) {
				if (typeof key !== 'string' || key === 'constructor') continue;
				const own = Object.getOwnPropertyDescriptor(WT.prototype, key);
				const f = own.get || own.value;
				let value;
				try {
					value = f.call({});
				} catch (e) {
					illegal[key] = 'throws ' + describe(e);
					continue;
				}
				illegal[key] =
					value instanceof Promise ? await settled(value) : 'ok ' + tag(value);
			}
			const duplex = g.WebTransportDatagramDuplexStream.prototype;
			for (const key of Reflect.ownKeys(duplex)) {
				if (typeof key !== 'string' || key === 'constructor') continue;
				const own = Object.getOwnPropertyDescriptor(duplex, key);
				illegal['datagrams.' + key] = attempt(() => own.get.call({}));
				if (own.set)
					illegal['datagrams.' + key + ' ='] = attempt(() =>
						own.set.call({}, 1),
					);
				// a session is not its datagrams
				illegal['datagrams.' + key + ' of a session'] = attempt(() =>
					own.get.call(t),
				);
			}
			illegal.readyOfDatagrams = await settled(
				Object.getOwnPropertyDescriptor(WT.prototype, 'ready').get.call(d),
			);
			out.illegal = illegal;

			// the error interface, which a page may construct
			const E = g.WebTransportError;
			const made = (...args) =>
				attempt(() => {
					const e = new E(...args);
					return [
						e.name,
						e.message,
						e.code,
						e.source,
						e.streamErrorCode,
						Object.getOwnPropertyNames(e).join(),
						e instanceof DOMException,
						tag(e),
					].join(' | ');
				});
			out.error = {
				call: attempt(() => E()),
				none: made(),
				init: made({ message: 'm', streamErrorCode: 7 }),
				messageAndOptions: made('m', { source: 'session', streamErrorCode: 7 }),
				code256: made({ streamErrorCode: 256 }),
				illegalSource: attempt(() =>
					Object.getOwnPropertyDescriptor(E.prototype, 'source').get.call({}),
				),
				sourceOfDOMException: attempt(() =>
					Object.getOwnPropertyDescriptor(E.prototype, 'source').get.call(
						new DOMException('x'),
					),
				),
			};

			// other ways to the constructor, and what they make
			class Sub extends WT {}
			const sub = quiet(new Sub(u));
			const viaReflect = quiet(Reflect.construct(WT, [u], Object));
			const bound = quiet(new (WT.bind(null, u))());
			out.construction = [
				sub instanceof Sub,
				sub instanceof WT,
				Object.getPrototypeOf(sub) === Sub.prototype,
				tag(sub),
				Object.getPrototypeOf(viaReflect) === Object.prototype,
				tag(viaReflect),
				attempt(() =>
					Object.getOwnPropertyDescriptor(WT.prototype, 'protocol').get.call(
						viaReflect,
					),
				),
				bound instanceof WT,
				WT.prototype.constructor === WT,
				new WT.prototype.constructor(u) instanceof WT,
			];
			// (a known difference, told apart by the suite)
			out.cloned = attempt(() => structuredClone(sub)).slice(0, 40);
			for (const made of [sub, viaReflect, bound])
				WT.prototype.close.call(made);

			// a rejection nobody handles is the page's to hear of
			const unhandled = [];
			const heard = (event) => {
				unhandled.push(describe(event.reason).split(' | ')[2]);
				event.preventDefault();
			};
			g.addEventListener('unhandledrejection', heard);
			const lone = new WT(u);
			lone.close();
			const readOnly = new WT(u);
			void readOnly.ready;
			readOnly.close();
			await sleep(300);
			g.removeEventListener('unhandledrejection', heard);
			out.unhandled = unhandled;
			return out;
		},

		closed: ({ closed }) =>
			session(g.WebTransport, 'https://127.0.0.1:' + closed + '/x'),
		closedEarly: ({ closed }) =>
			session(
				g.WebTransport,
				'https://127.0.0.1:' + closed + '/x',
				null,
				'early',
			),
		closedClose: ({ closed }) =>
			session(
				g.WebTransport,
				'https://127.0.0.1:' + closed + '/x',
				null,
				'close',
			),
		unresolvable: () => session(g.WebTransport, 'https://nonexistent.test/x'),
		pinned: ({ closed }) =>
			session(g.WebTransport, 'https://127.0.0.1:' + closed + '/x', {
				serverCertificateHashes: [
					{ algorithm: 'sha-256', value: new Uint8Array(32) },
				],
			}),

		/** Chrome's throttle: 70 sessions at once to a server that cannot be reached */
		async throttle({ closed }) {
			const results = await Promise.all(
				Array.from({ length: 70 }, () => {
					const t = new g.WebTransport('https://127.0.0.1:' + closed + '/');
					t.closed.catch(() => {});
					return Promise.race([
						t.ready.then(
							() => 'ready',
							(e) => e.message,
						),
						sleep(1500).then(() => 'pending'),
					]);
				}),
			);
			const count = (what) => results.filter((r) => r === what).length;
			return {
				first: results[0],
				// the ones past the 64 a page may have pending
				last: results.slice(64).join(),
				lost: count('Connection lost.'),
				// few of the 64 had been tried by 1.5 s: each waits twice as
				// long as the one before
				fewTried:
					count('Opening handshake failed.') > 2 &&
					count('Opening handshake failed.') < 12,
			};
		},

		/** one session to the port that hears, by whatever way `how` names; the suite counts what the port heard */
		async reach({ silent, how }) {
			const u = 'https://127.0.0.1:' + silent + '/';
			const WT = g.WebTransport;
			if (typeof WT !== 'function') return 'no WebTransport here';
			const ways = {
				new: () => new WT(u),
				reflect: () => Reflect.construct(WT, [u]),
				newTarget: () => Reflect.construct(WT, [u], Object),
				prototype: () => new WT.prototype.constructor(u),
				instance: () => {
					const first = quiet(new WT('https://127.0.0.1:1/'));
					first.close();
					return new (Object.getPrototypeOf(first).constructor)(u);
				},
				subclass: () => new (class extends WT {})(u),
				bound: () => new (WT.bind(null))(u),
				functionApply: () => new (Function.prototype.bind.call(WT, null, u))(),
			};
			const t = ways[how || 'new']();
			const outcome = await settled(
				Object.getOwnPropertyDescriptor(g.WebTransport.prototype, 'ready')
					.get.call(t)
					.then(() => 'connected'),
				1200,
			);
			try {
				t.closed.catch(() => {});
				t.close();
			} catch (e) {
				// not a session of this realm's
			}
			return outcome;
		},
	};

	g.wtRun = async (name, params) => {
		try {
			return await cases[name](params);
		} catch (e) {
			return { probeError: describe(e) };
		}
	};

	// a worker runs what it is told and answers
	if (typeof document === 'undefined') {
		const answer = (port) => async (event) => {
			const { name, params, nested } = event.data;
			if (nested) {
				// a worker of this worker's
				const inner = new Worker(nested);
				inner.onmessage = (e) => port.postMessage(e.data);
				inner.postMessage({ name, params });
				return;
			}
			port.postMessage(await g.wtRun(name, params));
		};
		if ('onconnect' in g)
			g.onconnect = (event) => {
				const port = event.ports[0];
				port.onmessage = answer(port);
			};
		else if (typeof g.clients === 'object')
			g.onmessage = (event) => answer(event.source)(event);
		else g.onmessage = answer(g);
	}
})();
