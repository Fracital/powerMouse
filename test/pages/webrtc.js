// WebRTC probes for the webrtc suite, run natively and through the proxy:
// window.__rtc.<probe>(...) resolves with what the page could read. The
// suite searches every result for the machine's addresses and counts the
// packets its UDP fixtures received.
(() => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const candidateView = (c) =>
		c && {
			candidate: c.candidate,
			address: c.address,
			port: c.port,
			type: c.type,
			protocol: c.protocol,
			relatedAddress: c.relatedAddress,
			relatedPort: c.relatedPort,
			url: c.url,
			json: JSON.stringify(c),
		};
	const errorView = (e) => ({
		address: e.address,
		port: e.port,
		url: e.url,
		errorCode: e.errorCode,
		errorText: e.errorText,
		hostCandidate: e.hostCandidate,
	});
	async function statsOf(pc) {
		const out = [];
		const report = await pc.getStats();
		// every way to read a report
		report.forEach((s) => {
			if (/candidate/.test(s.type)) out.push(['forEach', s]);
		});
		for (const [id, s] of report)
			if (/candidate/.test(s.type)) out.push(['iterator', s, report.get(id)]);
		for (const s of report.values())
			if (/candidate/.test(s.type)) out.push(['values', s]);
		return JSON.parse(JSON.stringify(out));
	}
	function transportView(pc) {
		try {
			const t = pc.sctp && pc.sctp.transport.iceTransport;
			if (!t) return null;
			const pair = t.getSelectedCandidatePair();
			return {
				local: t.getLocalCandidates().map(candidateView),
				remote: t.getRemoteCandidates().map(candidateView),
				pair: pair && {
					local: candidateView(pair.local),
					remote: candidateView(pair.remote),
				},
			};
		} catch (error) {
			return String(error);
		}
	}
	function descriptionView(d) {
		return d && { sdp: d.sdp, json: JSON.stringify(d) };
	}

	/**
	 * one connection gathering with `config` until complete or `ms`: its
	 * events, descriptions, stats and configuration as the page reads them
	 */
	async function gather(config, { ms = 8000, Peer = RTCPeerConnection } = {}) {
		const start = performance.now();
		const at = () => Math.round(performance.now() - start);
		const log = [];
		let pc;
		try {
			pc = new Peer(config);
		} catch (error) {
			return { threw: `${error.name}: ${error.message}` };
		}
		pc.addEventListener('icecandidate', (e) =>
			log.push(['candidate', at(), candidateView(e.candidate)]),
		);
		pc.addEventListener('icecandidateerror', (e) =>
			log.push(['error', at(), errorView(e)]),
		);
		pc.addEventListener('icegatheringstatechange', () =>
			log.push(['gathering', at(), pc.iceGatheringState]),
		);
		pc.createDataChannel('probe');
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		while (pc.iceGatheringState !== 'complete' && at() < ms) await wait(50);
		const result = {
			offer: offer.sdp,
			log,
			state: pc.iceGatheringState,
			config: pc.getConfiguration(),
			local: descriptionView(pc.localDescription),
			current: descriptionView(pc.currentLocalDescription),
			stats: await statsOf(pc),
			transport: transportView(pc),
			// a second offer carries the gathered candidates
			reoffer: (await pc.createOffer()).sdp,
		};
		pc.close();
		return result;
	}

	/**
	 * two connections of this page over a data channel; `remote` candidates
	 * (strings) are added to the first as well, before it connects
	 */
	async function pair(config = {}, { remote = [], ms = 15000 } = {}) {
		const a = new RTCPeerConnection(config);
		const b = new RTCPeerConnection(config);
		a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
		b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
		const channel = a.createDataChannel('x');
		const got = new Promise((resolve) => {
			b.ondatachannel = (e) => (e.channel.onmessage = (m) => resolve(m.data));
		});
		const opened = new Promise((resolve) => (channel.onopen = resolve));
		await a.setLocalDescription();
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription();
		await a.setRemoteDescription(b.localDescription);
		const added = [];
		for (const candidate of remote)
			added.push(
				await a.addIceCandidate({ candidate, sdpMid: '0' }).then(
					() => 'ok',
					(error) => error.name,
				),
			);
		const timeout = wait(ms).then(() => 'timeout');
		const open = await Promise.race([opened.then(() => 'open'), timeout]);
		let message = null;
		if (open === 'open') {
			channel.send('hello');
			message = await Promise.race([got, timeout]);
		}
		await wait(1500);
		const out = {
			open,
			message,
			added,
			aRemote: descriptionView(a.remoteDescription),
			aLocal: descriptionView(a.localDescription),
			aStats: await statsOf(a),
			bStats: await statsOf(b),
			aTransport: transportView(a),
			bTransport: transportView(b),
		};
		a.close();
		b.close();
		return out;
	}

	/** a connection with a proxied page in a frame of its own (webrtc-child.html), signalled by postMessage */
	async function crossFrame(src, { ms = 15000 } = {}) {
		const frame = document.createElement('iframe');
		frame.src = src;
		const ready = new Promise((resolve) => {
			addEventListener('message', function listen(e) {
				if (e.data === 'rtc-child-ready') {
					removeEventListener('message', listen);
					resolve();
				}
			});
		});
		document.body.append(frame);
		await ready;
		const child = frame.contentWindow;
		const pc = new RTCPeerConnection();
		const seen = [];
		pc.onicecandidate = (e) => {
			if (!e.candidate) return;
			seen.push(e.candidate.candidate);
			child.postMessage(
				{ rtc: 'candidate', candidate: e.candidate.toJSON() },
				'*',
			);
		};
		const answered = new Promise((resolve) => {
			addEventListener('message', async (e) => {
				const data = e.data;
				if (!data || !data.rtc) return;
				if (data.rtc === 'answer') {
					await pc.setRemoteDescription(data.answer);
					resolve();
				} else if (data.rtc === 'candidate') {
					await answered;
					seen.push(data.candidate.candidate);
					await pc.addIceCandidate(data.candidate);
				}
			});
		});
		const channel = pc.createDataChannel('x');
		const reply = new Promise((resolve) => {
			channel.onmessage = (m) => resolve(m.data);
		});
		await pc.setLocalDescription();
		child.postMessage(
			{ rtc: 'offer', offer: pc.localDescription.toJSON() },
			'*',
		);
		const timeout = wait(ms).then(() => 'timeout');
		const open = await Promise.race([
			new Promise((resolve) => (channel.onopen = resolve)).then(() => 'open'),
			timeout,
		]);
		let message = null;
		if (open === 'open') {
			channel.send('ping');
			message = await Promise.race([reply, timeout]);
		}
		const out = {
			open,
			message,
			seen,
			stats: await statsOf(pc),
			transport: transportView(pc),
			remote: descriptionView(pc.remoteDescription),
		};
		pc.close();
		frame.remove();
		return out;
	}

	/** in the window `w` (another realm): a connection with `config`, gathering */
	async function realmGather(w, config) {
		const pc = new w.RTCPeerConnection(config);
		const candidates = [];
		pc.onicecandidate = (e) =>
			e.candidate && candidates.push(e.candidate.candidate);
		pc.createDataChannel('x');
		await pc.setLocalDescription();
		await wait(2000);
		const sdp = pc.localDescription.sdp;
		const source = w.Function.prototype.toString.call(w.RTCPeerConnection);
		pc.close();
		return { candidates, sdp, source };
	}

	/** what a script in a document of its own reports back (data:, sandboxed srcdoc) */
	const REPORTER = (config) => `<script>
		(async () => {
			let result;
			try {
				const pc = new RTCPeerConnection(${JSON.stringify(config)});
				const candidates = [];
				pc.onicecandidate = (e) => e.candidate && candidates.push(e.candidate.candidate);
				pc.createDataChannel('x');
				await pc.setLocalDescription();
				await new Promise((r) => setTimeout(r, 2000));
				result = { candidates, sdp: pc.localDescription.sdp };
				pc.close();
			} catch (error) {
				result = { threw: String(error) };
			}
			parent.postMessage({ rtcReport: result }, '*');
		})();
	<\/script>`;

	function reported(frame) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve({ timeout: true }), 8000);
			addEventListener('message', function listen(e) {
				if (e.source !== frame.contentWindow || !e.data || !e.data.rtcReport)
					return;
				removeEventListener('message', listen);
				clearTimeout(timer);
				resolve(e.data.rtcReport);
			});
		});
	}

	/** every realm a page can reach, each gathering with `config` */
	async function realms(config, childSrc) {
		const out = {};
		const loaded = (frame) =>
			new Promise((resolve) =>
				frame.addEventListener('load', resolve, { once: true }),
			);
		const run = async (name, fn) => {
			try {
				out[name] = await fn();
			} catch (error) {
				out[name] = { threw: String(error) };
			}
		};
		await run('blankContentWindow', async () => {
			const f = document.createElement('iframe');
			document.body.append(f);
			return realmGather(f.contentWindow, config);
		});
		await run('blankFramesIndex', async () => {
			const f = document.createElement('iframe');
			document.body.append(f);
			return realmGather(window.frames[window.frames.length - 1], config);
		});
		await run('srcdoc', async () => {
			const f = document.createElement('iframe');
			f.srcdoc = '<!doctype html><title>s</title>';
			const done = loaded(f);
			document.body.append(f);
			await done;
			return realmGather(f.contentWindow, config);
		});
		await run('nestedProxied', async () => {
			const f = document.createElement('iframe');
			f.src = childSrc;
			const done = loaded(f);
			document.body.append(f);
			await done;
			return realmGather(f.contentWindow, config);
		});
		await run('blobDocument', async () => {
			const f = document.createElement('iframe');
			f.src = URL.createObjectURL(
				new Blob(['<!doctype html><title>b</title>'], { type: 'text/html' }),
			);
			const done = loaded(f);
			document.body.append(f);
			await done;
			return realmGather(f.contentWindow, config);
		});
		await run('popup', async () => {
			const w = window.open('', '_blank', 'popup');
			if (!w) return { threw: 'no popup' };
			try {
				return await realmGather(w, config);
			} finally {
				w.close();
			}
		});
		await run('dataFrame', async () => {
			const f = document.createElement('iframe');
			f.src = `data:text/html,${encodeURIComponent(REPORTER(config))}`;
			const done = reported(f);
			document.body.append(f);
			return done;
		});
		await run('sandboxedSrcdoc', async () => {
			const f = document.createElement('iframe');
			f.sandbox = 'allow-scripts';
			f.srcdoc = REPORTER(config);
			const done = reported(f);
			document.body.append(f);
			return done;
		});
		await run('worker', async () => {
			const w = new Worker(
				URL.createObjectURL(
					new Blob([
						'postMessage([typeof RTCPeerConnection, typeof webkitRTCPeerConnection, Object.getOwnPropertyNames(self).filter((n) => /RTC/.test(n)).sort()])',
					]),
				),
			);
			return new Promise((resolve) => (w.onmessage = (e) => resolve(e.data)));
		});
		return out;
	}

	/** the shape of every RTC global, as reflection sees it */
	function surface() {
		const shape = (value) => {
			if (typeof value !== 'function') return typeof value;
			return {
				source: Function.prototype.toString.call(value),
				name: value.name,
				length: value.length,
			};
		};
		const describe = (object) =>
			Reflect.ownKeys(object).map((key) => {
				const d = Object.getOwnPropertyDescriptor(object, key);
				return [
					String(key),
					{
						enumerable: d.enumerable,
						configurable: d.configurable,
						writable: d.writable,
						value: key === 'prototype' ? 'prototype' : shape(d.value),
						get: d.get && shape(d.get),
						set: d.set && shape(d.set),
					},
				];
			});
		const names = Object.getOwnPropertyNames(window)
			.filter((name) => /RTC/.test(name))
			.sort();
		const out = { names, globals: {}, statics: {}, prototypes: {} };
		for (const name of names) {
			const d = Object.getOwnPropertyDescriptor(window, name);
			out.globals[name] = {
				enumerable: d.enumerable,
				configurable: d.configurable,
				writable: d.writable,
			};
			const value = window[name];
			if (typeof value !== 'function') continue;
			out.statics[name] = describe(value);
			if (value.prototype) out.prototypes[name] = describe(value.prototype);
		}
		const pc = new RTCPeerConnection();
		const errors = {};
		const attempt = (name, fn) => {
			try {
				fn();
				errors[name] = 'no error';
			} catch (error) {
				errors[name] =
					`${error.constructor.name} ${error.name}: ${error.message}`;
			}
		};
		attempt('call', () => RTCPeerConnection());
		attempt(
			'badUrl',
			() => new RTCPeerConnection({ iceServers: [{ urls: 'http://x' }] }),
		);
		attempt(
			'noCredential',
			() => new RTCPeerConnection({ iceServers: [{ urls: 'turn:x' }] }),
		);
		attempt(
			'badPool',
			() => new RTCPeerConnection({ iceCandidatePoolSize: 300 }),
		);
		attempt(
			'badPolicy',
			() => new RTCPeerConnection({ iceTransportPolicy: 'nope' }),
		);
		attempt('setBadUrl', () =>
			pc.setConfiguration({ iceServers: [{ urls: 'stun:' }] }),
		);
		attempt('setBundle', () =>
			pc.setConfiguration({ bundlePolicy: 'max-bundle' }),
		);
		attempt('illegalGetter', () =>
			Object.getOwnPropertyDescriptor(
				RTCSessionDescription.prototype,
				'sdp',
			).get.call({}),
		);
		class Sub extends RTCPeerConnection {}
		const sub = new Sub();
		const facts = {
			webkitSame: window.webkitRTCPeerConnection === window.RTCPeerConnection,
			constructorBack:
				RTCPeerConnection.prototype.constructor === RTCPeerConnection,
			instance: pc instanceof RTCPeerConnection,
			subclass: sub instanceof Sub && sub instanceof RTCPeerConnection,
			protoOf: Object.getPrototypeOf(pc) === RTCPeerConnection.prototype,
			ownKeys: Reflect.ownKeys(pc).map(String),
			tag: Object.prototype.toString.call(pc),
			reportIterator: null,
		};
		sub.close();
		pc.close();
		return { ...out, errors, facts };
	}

	async function iteratorShape() {
		const pc = new RTCPeerConnection();
		const report = await pc.getStats();
		const it = report.entries();
		const proto = Object.getPrototypeOf(it);
		const result = {
			tag: proto[Symbol.toStringTag],
			keys: Reflect.ownKeys(proto).map(String),
			next: Function.prototype.toString.call(proto.next),
			same:
				RTCStatsReport.prototype[Symbol.iterator] ===
				RTCStatsReport.prototype.entries,
		};
		pc.close();
		return result;
	}

	/** what the operations a page can get wrong answer, natively and proxied alike */
	async function edges(sink) {
		const out = {};
		const settle = async (name, fn) => {
			try {
				const value = await fn();
				out[name] = `ok ${JSON.stringify(value)}`;
			} catch (error) {
				out[name] = `${error.constructor.name} ${error.name}: ${error.message}`;
			}
		};
		const pc = new RTCPeerConnection();
		const remote = `candidate:7 1 udp 2122260223 127.0.0.1 ${sink} typ host generation 0`;
		await settle('beforeRemote', () =>
			pc.addIceCandidate({ candidate: remote, sdpMid: '0' }),
		);
		await settle('noMid', () => pc.addIceCandidate({ candidate: remote }));
		await settle('answerInStable', () =>
			pc.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\n' }),
		);
		await settle('badSdp', () =>
			pc.setRemoteDescription({ type: 'offer', sdp: 'nonsense' }),
		);
		await settle('noType', () => pc.setRemoteDescription({ sdp: 'v=0' }));
		const other = new RTCPeerConnection();
		other.createDataChannel('x');
		await other.setLocalDescription();
		await settle('offer', async () => {
			await pc.setRemoteDescription(other.localDescription);
			return pc.signalingState;
		});
		await settle('malformed', () =>
			pc.addIceCandidate({ candidate: 'candidate:garbage', sdpMid: '0' }),
		);
		await settle('wrongMid', () =>
			pc.addIceCandidate({ candidate: remote, sdpMid: '9' }),
		);
		await settle('fine', () =>
			pc.addIceCandidate({ candidate: remote, sdpMid: '0' }),
		);
		await settle('instance', () =>
			pc.addIceCandidate(
				new RTCIceCandidate({ candidate: remote, sdpMid: '0' }),
			),
		);
		await settle('end', () =>
			pc.addIceCandidate({ candidate: '', sdpMid: '0' }),
		);
		await settle('nullCandidate', () => pc.addIceCandidate(null));
		// a page that does not wait for setRemoteDescription before the next step
		const late = new RTCPeerConnection();
		await settle('unawaited', async () => {
			// with an mDNS name no page of this browser showed: looked up first
			const sdp = other.localDescription.sdp.replace(
				'a=ice-ufrag',
				'a=candidate:13 1 udp 2122260223 0b5a0e4a-2222-4000-8000-000000000000.local 9 typ host generation 0\r\na=ice-ufrag',
			);
			const applied = late.setRemoteDescription({ type: 'offer', sdp });
			const added = late.addIceCandidate({ candidate: remote, sdpMid: '0' });
			const answer = late.createAnswer();
			await Promise.all([applied, added]);
			return [(await answer).type, late.signalingState];
		});
		const constructed = new RTCIceCandidate({ candidate: remote, sdpMid: '0' });
		out.constructedAddress = constructed.address;
		out.constructedJSON = JSON.stringify(constructed);
		out.remoteSdp = pc.remoteDescription.sdp
			.split('\r\n')
			.filter((line) => /^a=candidate|^c=/.test(line));
		pc.close();
		other.close();
		late.close();
		return out;
	}

	/**
	 * What a hostile page tries: an event it made itself around a candidate
	 * of its choosing, and the members of another proxied document's realm
	 * (which runs an inject of its own) used on this realm's objects
	 */
	async function attacks({ sink, stun, child }) {
		const frame = document.createElement('iframe');
		frame.src = child;
		const loaded = new Promise((resolve) =>
			frame.addEventListener('load', resolve, { once: true }),
		);
		document.body.append(frame);
		await loaded;
		const other = frame.contentWindow;
		const target = `candidate:31 1 udp 2122260223 127.0.0.1 ${sink} typ host generation 0`;
		const out = {};
		const step = async (name, fn) => {
			try {
				out[name] = await fn();
			} catch (error) {
				out[name] = `threw ${error.name}: ${error.message}`;
			}
		};
		const a = new RTCPeerConnection();
		const b = new RTCPeerConnection();
		const local = [];
		a.onicecandidate = (e) => {
			if (!e.candidate) return;
			local.push(e.candidate);
			b.addIceCandidate(e.candidate);
		};
		b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
		a.createDataChannel('x');
		await a.setLocalDescription();
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription();
		await a.setRemoteDescription(b.localDescription);
		await wait(1000);
		// an event of its own, dispatched at a connection: the name it reads
		// back for an address it chose must not reach that address
		await step('forged', async () => {
			const made = new RTCIceCandidate({ candidate: target, sdpMid: '0' });
			const event = new RTCPeerConnectionIceEvent('icecandidate', {
				candidate: made,
			});
			let seen = null;
			a.addEventListener('icecandidate', (e) => (seen = e.candidate), {
				once: true,
			});
			a.dispatchEvent(event);
			const shown = seen.candidate;
			await a.addIceCandidate({ candidate: shown, sdpMid: '0' });
			return shown;
		});
		// another document's members, on this realm's objects
		const own = (proto, name) => Object.getOwnPropertyDescriptor(proto, name);
		await step('borrowedAdd', async () => {
			await other.RTCPeerConnection.prototype.addIceCandidate.call(a, {
				candidate: target,
				sdpMid: '0',
			});
			return 'added';
		});
		await step('borrowedConfiguration', async () => {
			other.RTCPeerConnection.prototype.setConfiguration.call(a, {
				iceServers: [{ urls: `stun:127.0.0.1:${stun}` }],
			});
			a.restartIce();
			await a.setLocalDescription();
			await wait(2000);
			return other.RTCPeerConnection.prototype.getConfiguration.call(a)
				.iceServers;
		});
		await step('borrowedReads', () =>
			local.map((candidate) => [
				own(other.RTCIceCandidate.prototype, 'candidate').get.call(candidate),
				own(other.RTCIceCandidate.prototype, 'address').get.call(candidate),
				other.RTCIceCandidate.prototype.toJSON.call(candidate),
			]),
		);
		await step('borrowedDescription', () => [
			own(other.RTCSessionDescription.prototype, 'sdp').get.call(
				own(other.RTCPeerConnection.prototype, 'localDescription').get.call(a),
			),
			own(other.RTCSessionDescription.prototype, 'sdp').get.call(
				a.remoteDescription,
			),
		]);
		await step('borrowedStats', async () => {
			const report = await a.getStats();
			const seen = [];
			other.RTCStatsReport.prototype.forEach.call(report, (s) => {
				if (/candidate/.test(s.type)) seen.push(s);
			});
			for (const [, s] of other.RTCStatsReport.prototype.entries.call(report))
				if (/candidate/.test(s.type)) seen.push(s);
			return JSON.parse(JSON.stringify(seen));
		});
		await step('swappedPrototype', () =>
			local.map((candidate) => {
				Object.setPrototypeOf(candidate, other.RTCIceCandidate.prototype);
				return [candidate.candidate, candidate.address];
			}),
		);
		await step('madeElsewhere', async () => {
			// a candidate made in the other realm, read here and added
			const made = new other.RTCIceCandidate({
				candidate: target,
				sdpMid: '0',
			});
			const shown = made.candidate;
			await a.addIceCandidate({ candidate: shown, sdpMid: '0' });
			return shown;
		});
		// intrinsics patched to watch every string the proxy's code handles,
		// to answer every set membership with yes, and to fill a member a
		// dictionary lacks
		await step('tampered', async () => {
			const seen = [];
			const note = (value) => {
				// (a sloppy function's this is the boxed string)
				if (value instanceof String) value = String(value);
				if (typeof value === 'string' && value.length < 4000) seen.push(value);
			};
			const saved = [];
			const patch = (object, key, make) => {
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				saved.push([object, key, descriptor]);
				Object.defineProperty(object, key, {
					...descriptor,
					...make(descriptor),
				});
			};
			const watch = (object, key) =>
				patch(object, key, (d) => ({
					value(...args) {
						note(this);
						for (const arg of args) note(arg);
						return d.value.apply(this, args);
					},
				}));
			for (const key of [
				'split',
				'indexOf',
				'slice',
				'startsWith',
				'includes',
				'replace',
				'toLowerCase',
			])
				watch(String.prototype, key);
			watch(RegExp.prototype, 'exec');
			watch(Array.prototype, 'join');
			watch(Map.prototype, 'get');
			patch(Set.prototype, 'has', () => ({ value: () => true }));
			Object.defineProperty(Object.prototype, 'candidate', {
				get: () => target,
				configurable: true,
			});
			const read = [];
			// the watch works: a page string seen through it
			'watching'.split('t');
			try {
				await a.addIceCandidate({ sdpMid: '0' });
				await a.addIceCandidate({
					candidate: `candidate:32 1 udp 2122260223 0b5a0e4a-3333-4000-8000-000000000000.local ${sink} typ host generation 0`,
					sdpMid: '0',
				});
				for (const candidate of local)
					read.push(candidate.candidate, candidate.address);
				read.push(a.localDescription.sdp, a.remoteDescription.sdp);
				const report = await a.getStats();
				report.forEach((s) => read.push(s.address, s.ip));
			} finally {
				delete Object.prototype.candidate;
				for (const [object, key, descriptor] of saved.reverse())
					Object.defineProperty(object, key, descriptor);
			}
			return { watched: seen.includes('watching'), seen, read };
		});
		await wait(2000);
		a.close();
		b.close();
		frame.remove();
		return out;
	}

	window.__rtc = {
		attacks,
		gather,
		pair,
		crossFrame,
		realms,
		surface,
		iteratorShape,
		statsOf,
		edges,
	};
	window.__rtcReady = true;
})();
