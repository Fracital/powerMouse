// One end of a call for the webrtc-transform suite: a tone and a canvas
// sent both ways, each sender and receiver given an encoded transform
// (RTCRtpScriptTransform) whose worker writes down what each frame of the
// first ones reads as (its type and getMetadata()) and passes it on. The
// suite carries the signalling; window.__transform.<step>(name, ...) acts
// on the connection of that name.
(() => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const peers = new Map();
	const peer = (name) => {
		const found = peers.get(name);
		if (!found) throw new Error(`no connection ${name}`);
		return found;
	};
	async function until(test, ms, what) {
		const end = Date.now() + ms;
		while (!test()) {
			if (Date.now() > end) throw new Error(`timed out: ${what}`);
			await wait(25);
		}
	}

	const WORKER = `
		// per operation and kind: each of the first frames
		const seen = {};
		// and the empty ones (a padding packet's), with the frame before
		const empty = {};
		onrtctransform = (event) => {
			const { readable, writable, options } = event.transformer;
			const op = options.operation + ' ' + options.kind;
			const list = (seen[op] = []);
			const blank = (empty[op] = []);
			let prev = null;
			readable.pipeThrough(new TransformStream({
				transform(frame, controller) {
					const now = frame.getMetadata();
					if (!frame.data.byteLength && blank.length < 20)
						blank.push({
							seq: now.sequenceNumber ?? null,
							rtp: now.rtpTimestamp,
							keys: Object.keys(now).join(),
							prevSeq: prev?.sequenceNumber ?? null,
							prevRtp: prev?.rtpTimestamp ?? null,
						});
					prev = now;
					if (list.length < 120) {
						const meta = frame.getMetadata();
						list.push({
							type: frame.type ?? null,
							size: frame.data.byteLength,
							keys: Object.keys(meta).join(),
							rtp: meta.rtpTimestamp,
							ssrc: meta.synchronizationSource,
							seq: meta.sequenceNumber ?? null,
							id: meta.frameId ?? null,
							deps: meta.dependencies ?? null,
							width: meta.width ?? null,
							height: meta.height ?? null,
							spatial: meta.spatialIndex ?? null,
							temporal: meta.temporalIndex ?? null,
						});
					}
					controller.enqueue(frame);
				},
			})).pipeTo(writable);
		};
		setInterval(() => postMessage({ seen, empty }), 250);`;

	function open(name, config) {
		const pc = new RTCPeerConnection(config);
		const entry = { pc, tracks: [], players: [], stops: [] };
		entry.worker = new Worker(
			URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })),
		);
		entry.worker.onmessage = (event) => {
			entry.seen = event.data.seen;
			entry.empty = event.data.empty;
		};
		peers.set(name, entry);
		pc.addEventListener('track', (event) => {
			entry.tracks.push(event.track);
			// played, as a page does
			const player = document.createElement(
				event.track.kind === 'video' ? 'video' : 'audio',
			);
			player.muted = true;
			player.srcObject = new MediaStream([event.track]);
			player.play().catch(() => {});
			entry.players.push(player);
		});
		return entry;
	}

	/** a tone, or a canvas of `width` by `height` changing every frame */
	function source(entry, kind, width, height) {
		if (kind === 'audio') {
			const audio = new AudioContext();
			const tone = audio.createOscillator();
			const to = audio.createMediaStreamDestination();
			tone.connect(to);
			tone.start();
			entry.stops.push(() => audio.close());
			return to.stream.getAudioTracks()[0];
		}
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const g = canvas.getContext('2d');
		let n = 0;
		const timer = setInterval(() => {
			g.fillStyle = `hsl(${(n++ * 37) % 360} 60% 50%)`;
			g.fillRect(0, 0, width, height);
			g.fillStyle = '#fff';
			g.fillText(String(n), 10, 20);
		}, 33);
		entry.stops.push(() => clearInterval(timer));
		return canvas.captureStream(30).getVideoTracks()[0];
	}

	const gathered = (pc) =>
		until(() => pc.iceGatheringState === 'complete', 60000, 'gathering');

	window.__transform = {
		async open(name, config) {
			const entry = open(name, config);
			// the fake microphone allowed: the browser then gives its host
			// candidates rather than mDNS names, which resolve nowhere here
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			for (const track of stream.getTracks())
				entry.stops.push(() => track.stop());
		},
		/**
		 * A track of `kind` sent and one received on a transceiver, each
		 * through the worker's transform, given with the transceiver;
		 * `codec` (a video mimeType) the only one it takes, `mode` the
		 * sender's scalabilityMode (the transceiver made with it)
		 */
		media(
			name,
			kind,
			{ width = 320, height = 180, codec = null, mode = null } = {},
		) {
			const entry = peer(name);
			const track = source(entry, kind, width, height);
			// (addTrack: the offer's section takes the far end's transceiver)
			const sender = mode
				? entry.pc.addTransceiver(track, {
						streams: [new MediaStream([track])],
						sendEncodings: [{ scalabilityMode: mode }],
					}).sender
				: entry.pc.addTrack(track, new MediaStream([track]));
			const transceiver = entry.pc
				.getTransceivers()
				.find((made) => made.sender === sender);
			if (codec)
				transceiver.setCodecPreferences(
					RTCRtpReceiver.getCapabilities(kind).codecs.filter(
						(c) => c.mimeType.toLowerCase() === codec.toLowerCase(),
					),
				);
			transceiver.sender.transform = new RTCRtpScriptTransform(entry.worker, {
				operation: 'send',
				kind,
			});
			transceiver.receiver.transform = new RTCRtpScriptTransform(entry.worker, {
				operation: 'recv',
				kind,
			});
		},
		async local(name, type) {
			const { pc } = peer(name);
			const description =
				type === 'offer' ? await pc.createOffer() : await pc.createAnswer();
			await pc.setLocalDescription(description);
			await gathered(pc);
			return pc.localDescription.sdp;
		},
		async remote(name, type, sdp) {
			await peer(name).pc.setRemoteDescription({ type, sdp });
		},
		async connected(name, ms = 30000) {
			const { pc } = peer(name);
			await until(
				() => pc.connectionState === 'connected',
				ms,
				`connection (${pc.connectionState})`,
			);
		},
		/** what the transforms saw, once each has `count` frames */
		async seen(name, count, ms = 20000) {
			const entry = peer(name);
			await until(
				() =>
					entry.seen &&
					Object.keys(entry.seen).length >=
						2 * entry.pc.getTransceivers().length &&
					Object.values(entry.seen).every((list) => list.length >= count),
				ms,
				`frames (${JSON.stringify(
					Object.fromEntries(
						Object.entries(entry.seen ?? {}).map(([k, v]) => [k, v.length]),
					),
				)})`,
			).catch(() => {});
			return entry.seen ?? null;
		},
		/** the video sender's scalabilityMode set (setParameters) */
		async mode(name, mode) {
			const { pc } = peer(name);
			const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
			const parameters = sender.getParameters();
			parameters.encodings[0].scalabilityMode = mode;
			await sender.setParameters(parameters);
		},
		/** the size of the pictures each received video plays at */
		played(name) {
			return peer(name)
				.players.filter((player) => player.tagName === 'VIDEO')
				.map((player) => [player.videoWidth, player.videoHeight]);
		},
		/** the empty frames the transforms were given, `ms` from now */
		async empty(name, ms) {
			await wait(ms);
			return peer(name).empty ?? null;
		},
		close(name) {
			const entry = peers.get(name);
			if (!entry) return;
			entry.pc.close();
			for (const stop of entry.stops) stop();
			for (const player of entry.players) player.srcObject = null;
			entry.worker.terminate();
			peers.delete(name);
		},
	};
	// ---- scalabilityMode: what is taken, read back and offered ----

	/**
	 * What a page reads of scalabilityMode without a call: the modes
	 * addTransceiver takes and refuses (and in which order its errors
	 * come), what getParameters reads back before and after a description
	 * (a codec that cannot do the mode), what setParameters takes, and
	 * which offers have the layer extensions
	 */
	window.__transform.svcRules = async () => {
		const out = {};
		const err = (e) => `${e.name}: ${e.message}`;
		const encodings = (sender) =>
			JSON.stringify(sender.getParameters().encodings);
		const MODES = [
			'L1T1',
			'L1T3',
			'L2T2_KEY_SHIFT',
			'L3T3h',
			'S3T3h',
			'S2T2',
			'L1T3h',
			'L4T1',
			'S1T2',
			'foo',
			'',
			'l1t2',
			null,
			5,
		];
		for (const mode of MODES) {
			const pc = new RTCPeerConnection();
			try {
				out[`add ${mode}`] = encodings(
					pc.addTransceiver('video', {
						sendEncodings: [{ scalabilityMode: mode }],
					}).sender,
				);
			} catch (e) {
				out[`add ${mode}`] = err(e);
			}
			pc.close();
		}
		for (const [label, given] of [
			['scale first', [{ scaleResolutionDownBy: 0.5, scalabilityMode: 'foo' }]],
			['rid first', [{ rid: 'a!', scalabilityMode: 'foo' }, { rid: 'b' }]],
			[
				'layers',
				[
					{ rid: 'a', scalabilityMode: 'L1T3' },
					{ rid: 'b', scalabilityMode: 'L3T3' },
				],
			],
			['undefined', [{ scalabilityMode: undefined }]],
		]) {
			const pc = new RTCPeerConnection();
			try {
				out[label] = encodings(
					pc.addTransceiver('video', { sendEncodings: given }).sender,
				);
			} catch (e) {
				out[label] = err(e);
			}
			pc.close();
		}
		{
			const pc = new RTCPeerConnection();
			const t = pc.addTransceiver('audio', {
				sendEncodings: [{ scalabilityMode: 'foo' }],
			});
			out.audio = encodings(t.sender);
			pc.close();
		}
		// setParameters before a description: any of the modes, or none
		for (const [from, to] of [
			[null, 'L3T3'],
			['L1T2', null],
			['L1T2', 'foo'],
			[null, 'S2T1'],
		]) {
			const pc = new RTCPeerConnection();
			const t = pc.addTransceiver('video', {
				sendEncodings: [from ? { scalabilityMode: from } : {}],
			});
			const p = t.sender.getParameters();
			if (to === null) delete p.encodings[0].scalabilityMode;
			else p.encodings[0].scalabilityMode = to;
			try {
				await t.sender.setParameters(p);
				out[`set ${from}>${to}`] = encodings(t.sender);
			} catch (e) {
				out[`set ${from}>${to}`] = err(e);
			}
			pc.close();
		}
		// the offers' layer extensions; and after a description, the mode a
		// codec cannot do, and what setParameters takes of that codec
		const layerExts = (sdp) =>
			sdp
				.split('\r\n')
				.filter((l) => /dependency-descriptor|video-layers-allocation/.test(l))
				.map((l) => l.replace(/^a=extmap:\d+ /, ''))
				.join(' ');
		for (const [mime, given, later] of [
			['video/VP8', [{}]],
			['video/VP8', [{ scalabilityMode: 'L1T1' }]],
			['video/VP8', [{ scalabilityMode: 'L3T3' }], 'L1T3'],
			['video/VP9', [{ scalabilityMode: 'L3T3_KEY' }], 'S2T3'],
			['video/H264', [{ scalabilityMode: 'S2T1' }], 'L2T1'],
			['video/AV1', [{ rid: 'a' }, { rid: 'b' }]],
			['video/VP8', [{}], 'L1T2'],
		]) {
			const a = new RTCPeerConnection();
			const b = new RTCPeerConnection();
			const label = `${mime} ${JSON.stringify(given)}`;
			try {
				const t = a.addTransceiver('video', {
					direction: 'sendrecv',
					sendEncodings: given,
				});
				t.setCodecPreferences(
					RTCRtpSender.getCapabilities('video').codecs.filter(
						(c) => c.mimeType === mime,
					),
				);
				const offer = await a.createOffer();
				await a.setLocalDescription(offer);
				await b.setRemoteDescription(offer);
				const answer = await b.createAnswer();
				await b.setLocalDescription(answer);
				await a.setRemoteDescription(answer);
				out[`${label} offer`] = layerExts(offer.sdp);
				out[`${label} answer`] = layerExts(answer.sdp);
				out[`${label} after`] = encodings(t.sender);
				if (later) {
					const p = t.sender.getParameters();
					p.encodings[0].scalabilityMode = later;
					try {
						await t.sender.setParameters(p);
						out[`${label} later`] = encodings(t.sender);
					} catch (e) {
						out[`${label} later`] = err(e);
					}
					out[`${label} reoffer`] = layerExts((await a.createOffer()).sdp);
				}
			} catch (e) {
				out[label] = err(e);
			}
			a.close();
			b.close();
		}
		return out;
	};

	// ---- what a page does with frames: copies, clones, posting them on ----

	/**
	 * A transform's worker that, at its sixth frame of each operation,
	 * copies, clones and posts the frame and writes down how each went (in
	 * words that do not change from call to call), then passes every
	 * frame on, the sixth as its copy
	 */
	const COPIES = `
		const err = (f) => { try { const v = f(); return v === undefined ? 'ok' : v; } catch (e) { return e.name + ': ' + e.message; } };
		const out = {};
		let other = null;
		onmessage = (event) => { if (event.data && event.data.port) other = event.data.port; };
		const shape = (k) => [Object.prototype.toString.call(k), k.data.byteLength > 0, String(k).replace(/rtpTimestamp: \\d+, size: \\d+/, 'rtpTimestamp: N, size: N'), Object.keys(k.getMetadata()).join()].join('|');
		onrtctransform = (event) => {
			const t = event.transformer; const op = t.options.operation + ' ' + t.options.kind;
			let n = 0;
			t.readable.pipeThrough(new TransformStream({ transform(frame, c) {
				// the seventh, written as it came: emptied (its metadata kept)
				if (++n === 7 && out[op]) setTimeout(() => (out[op].writtenOriginal = [frame.data.byteLength, Object.keys(frame.getMetadata()).join()].join('|')), 300);
				if (n !== 6) { c.enqueue(frame); return; }
				const C = frame.constructor; const o = (out[op] = {});
				const base = frame.getMetadata();
				const bytes = frame.data.byteLength;
				const copy = new C(frame);
				o.copy = [copy !== frame, copy.data !== frame.data, shape(copy), JSON.stringify(copy.getMetadata()) === JSON.stringify(base), copy instanceof C].join('|');
				o.ctor = [C === (self.RTCEncodedVideoFrame || 0) || C === RTCEncodedAudioFrame, C.length, C.name].join('|');
				const change = { synchronizationSource: 5, payloadType: 100, contributingSources: [1], audioLevel: 0.5, captureTime: 1, receiveTime: 1, sequenceNumber: 1, frameId: 99, dependencies: [98], width: 10, height: 10, spatialIndex: 1, temporalIndex: 1, rtpTimestamp: 1234 };
				for (const key of Object.keys(change))
					o['change ' + key] = err(() => { const k = new C(frame, { metadata: { ...base, [key]: change[key] } }); const v = k.getMetadata()[key]; return 'ok ' + (key === 'captureTime' || key === 'audioLevel' ? typeof v : JSON.stringify(v)); });
				o.partial = err(() => new C(frame, { metadata: { rtpTimestamp: 1 } }) && 'ok');
				o.empty = err(() => new C(frame, {}) && 'ok');
				o.none = err(() => new C());
				o.stranger = err(() => new C({}));
				o.call = err(() => C(frame));
				o.clone = err(() => shape(structuredClone(frame)));
				o.cloneNested = err(() => { const k = structuredClone({ a: [frame], b: frame }); return [k.a[0] === k.b, shape(k.b)].join('|'); });
				o.cloneTransfer = err(() => { structuredClone(frame, { transfer: [frame] }); });
				postMessage({ op, frame, list: [frame, 1] });
				if (other) other.postMessage({ op, frame });
				o.afterPost = frame.data.byteLength === bytes;
				c.enqueue(copy);
				// a copy written keeps its bytes
				setTimeout(() => (o.written = [copy.data.byteLength > 0, Object.keys(copy.getMetadata()).join()].join('|')), 300);
			}})).pipeTo(t.writable);
		};
		setInterval(() => postMessage({ out }), 250);`;
	const OTHER = `
		onmessage = (event) => {
			if (!event.data.port) return;
			const seen = {};
			event.data.port.onmessage = (e) => {
				const f = e.data.frame;
				seen[e.data.op] = [Object.prototype.toString.call(f), f instanceof (self.RTCEncodedVideoFrame && e.data.op.endsWith('video') ? RTCEncodedVideoFrame : RTCEncodedAudioFrame), f.data.byteLength > 0, Object.keys(f.getMetadata()).join(), e.ports.length].join('|');
				postMessage(seen);
			};
		};`;

	/** the page's end of what COPIES posts it: each frame as it arrived */
	window.__transform.copies = async (name, kind, codec) => {
		const entry = peer(name);
		const worker = new Worker(
			URL.createObjectURL(new Blob([COPIES], { type: 'text/javascript' })),
		);
		const other = new Worker(
			URL.createObjectURL(new Blob([OTHER], { type: 'text/javascript' })),
		);
		const channel = new MessageChannel();
		worker.postMessage({ port: channel.port1 }, [channel.port1]);
		other.postMessage({ port: channel.port2 }, [channel.port2]);
		const result = { worker: null, page: {}, other: null };
		const posted = (event) => {
			if (event.data.out) return (result.worker = event.data.out);
			const { op, frame, list } = event.data;
			const Class =
				kind === 'video' ? RTCEncodedVideoFrame : RTCEncodedAudioFrame;
			result.page[op] = [
				Object.prototype.toString.call(frame),
				frame instanceof Class,
				list[0] === frame,
				frame.data.byteLength > 0,
				Object.keys(frame.getMetadata()).join(),
				event.ports.length,
				(() => {
					try {
						return new Class(frame).data.byteLength === frame.data.byteLength;
					} catch (error) {
						return error.name;
					}
				})(),
			].join('|');
		};
		worker.onmessage = (event) => {
			try {
				posted(event);
			} catch (error) {
				result.page.error = `${error.name}: ${error.message}`;
			}
		};
		other.onmessage = (event) => (result.other = event.data);
		entry.stops.push(
			() => worker.terminate(),
			() => other.terminate(),
		);
		const track = source(entry, kind, 320, 180);
		const sender = entry.pc.addTrack(track, new MediaStream([track]));
		const transceiver = entry.pc
			.getTransceivers()
			.find((made) => made.sender === sender);
		if (codec)
			transceiver.setCodecPreferences(
				RTCRtpReceiver.getCapabilities(kind).codecs.filter(
					(c) => c.mimeType.toLowerCase() === codec.toLowerCase(),
				),
			);
		sender.transform = new RTCRtpScriptTransform(worker, {
			operation: 'send',
			kind,
		});
		transceiver.receiver.transform = new RTCRtpScriptTransform(worker, {
			operation: 'recv',
			kind,
		});
		entry.copies = result;
	};
	window.__transform.copied = async (name, ms = 20000) => {
		const entry = peer(name);
		await until(
			() =>
				entry.copies.worker &&
				Object.keys(entry.copies.worker).length >= 2 &&
				Object.values(entry.copies.worker).every(
					(o) => 'written' in o && 'writtenOriginal' in o,
				) &&
				Object.keys(entry.copies.page).length >= 2 &&
				entry.copies.other &&
				Object.keys(entry.copies.other).length >= 2,
			ms,
			'copies',
		).catch(() => {});
		return entry.copies;
	};

	// ---- createEncodedStreams ----

	/**
	 * When createEncodedStreams() may be called and what it answers, on
	 * connections of the page's own (no call)
	 */
	window.__transform.streamRules = async () => {
		const err = (f) => {
			try {
				const v = f();
				return v === undefined ? 'ok' : v;
			} catch (e) {
				return `${e.name}: ${e.message}`;
			}
		};
		const out = {};
		const tone = () => {
			const audio = new AudioContext();
			const to = audio.createMediaStreamDestination();
			return to.stream.getAudioTracks()[0];
		};
		{
			const pc = new RTCPeerConnection();
			const track = tone();
			const sender = pc.addTrack(track, new MediaStream([track]));
			const streams = sender.createEncodedStreams();
			out.shape = [
				Object.prototype.toString.call(streams),
				Object.getPrototypeOf(streams) === Object.prototype,
				Object.keys(streams).join(),
				streams.readable instanceof ReadableStream,
				streams.writable instanceof WritableStream,
				streams.readable.locked,
				JSON.stringify(
					Object.getOwnPropertyDescriptor(streams, 'readable'),
					(k, v) => (k === 'value' ? typeof v : v),
				),
			].join('|');
			out.twice = err(() => sender.createEncodedStreams() && 'ok');
			const receiver = pc.addTransceiver('audio').receiver;
			await null;
			out.receiverMicrotask = err(
				() => receiver.createEncodedStreams() && 'ok',
			);
			const late = pc.addTransceiver('audio');
			await wait(0);
			out.senderTask = err(() => late.sender.createEncodedStreams() && 'ok');
			out.receiverTask = err(
				() => late.receiver.createEncodedStreams() && 'ok',
			);
			out.config = pc.getConfiguration().encodedInsertableStreams;
			out.setConfig = err(() =>
				pc.setConfiguration({ encodedInsertableStreams: true }),
			);
			pc.close();
		}
		{
			const pc = new RTCPeerConnection({ encodedInsertableStreams: 1 });
			out.flagConfig = pc.getConfiguration().encodedInsertableStreams;
			const sender = pc.addTransceiver('audio').sender;
			await wait(50);
			out.flagLate = err(() => sender.createEncodedStreams() && 'ok');
			pc.close();
		}
		return out;
	};

	/**
	 * A call whose sound goes through createEncodedStreams(), scrambled and
	 * marked as DAVE does it (each frame XORed, two bytes on the end), the
	 * sender's streams read on the page, the receiver's transferred to a
	 * worker; `transform` also gives the sender a transform (which takes
	 * the frames from the streams) and takes it away again
	 */
	const STREAMS_WORKER = `
		const MARK = [0xfa, 0xfa];
		const seen = { frames: 0, dropped: 0, audio: 0, keys: '' };
		onmessage = (event) => {
			const { readable, writable } = event.data;
			readable.pipeThrough(new TransformStream({ transform(frame, c) {
				seen.frames++;
				if (frame instanceof RTCEncodedAudioFrame) seen.audio++;
				seen.keys = Object.keys(frame.getMetadata()).join();
				const bytes = new Uint8Array(frame.data);
				if (!bytes.length) return c.enqueue(frame);
				const n = bytes.length;
				if (n < 3 || bytes[n - 2] !== MARK[0] || bytes[n - 1] !== MARK[1]) { seen.dropped++; return; }
				const out = bytes.slice(0, n - 2);
				for (let i = 0; i < out.length; i++) out[i] ^= (i * 31 + 7) & 255;
				frame.data = out.buffer;
				c.enqueue(frame);
			}})).pipeTo(writable);
		};
		setInterval(() => postMessage(seen), 250);`;
	window.__transform.streamsCall = (name, { transform = false } = {}) => {
		const entry = peer(name);
		const worker = new Worker(
			URL.createObjectURL(
				new Blob([STREAMS_WORKER], { type: 'text/javascript' }),
			),
		);
		worker.onmessage = (event) => (entry.received = event.data);
		entry.stops.push(() => worker.terminate());
		const track = source(entry, 'audio');
		const sender = entry.pc.addTrack(track, new MediaStream([track]));
		const { receiver } = entry.pc
			.getTransceivers()
			.find((made) => made.sender === sender);
		const sent = { frames: 0, audio: 0, keys: '' };
		entry.sent = sent;
		const out = sender.createEncodedStreams();
		out.readable
			.pipeThrough(
				new TransformStream({
					transform(frame, c) {
						sent.frames++;
						if (frame instanceof RTCEncodedAudioFrame) sent.audio++;
						sent.keys = Object.keys(frame.getMetadata()).join();
						const bytes = new Uint8Array(frame.data);
						if (!bytes.length) return c.enqueue(frame);
						const data = new Uint8Array(bytes.length + 2);
						data.set(bytes);
						for (let i = 0; i < bytes.length; i++)
							data[i] ^= (i * 31 + 7) & 255;
						data.set([0xfa, 0xfa], bytes.length);
						frame.data = data.buffer;
						c.enqueue(frame);
					},
				}),
			)
			.pipeTo(out.writable);
		const { readable, writable } = receiver.createEncodedStreams();
		worker.postMessage({ readable, writable }, [readable, writable]);
		entry.transferred = [readable.locked, writable.locked].join('|');
		if (transform) {
			// a transform takes the frames while it is given
			const noop = new Worker(
				URL.createObjectURL(
					new Blob(
						[
							'let n = 0; onrtctransform = (e) => { e.transformer.readable.pipeThrough(new TransformStream({ transform(f, c) { n++; c.enqueue(f); } })).pipeTo(e.transformer.writable); }; setInterval(() => postMessage(n), 100);',
						],
						{ type: 'text/javascript' },
					),
				),
			);
			noop.onmessage = (event) => (entry.byTransform = event.data);
			entry.stops.push(() => noop.terminate());
			sender.transform = new RTCRtpScriptTransform(noop, {});
			entry.untransform = () => {
				sender.transform = null;
			};
		}
	};
	window.__transform.streamsSeen = async (name, ms = 4000) => {
		const entry = peer(name);
		await wait(ms);
		return {
			sent: { ...entry.sent },
			received: entry.received ? { ...entry.received } : null,
			transferred: entry.transferred,
			byTransform: entry.byTransform ?? null,
		};
	};
	window.__transform.untransform = (name) => peer(name).untransform?.();

	/** a track of `kind` sent, nothing else done with it */
	window.__transform.plain = (name, kind) => {
		const entry = peer(name);
		const track = source(entry, kind, 320, 180);
		entry.pc.addTrack(track, new MediaStream([track]));
	};
	// ---- frames posted to windows and on a BroadcastChannel ----

	/**
	 * A send transform's worker that posts its sixth frame to the page and
	 * sends a copy of it: a frame written to the writable is emptied, and so
	 * natively is what another context makes of it later
	 */
	const POSTER = `
		onrtctransform = (event) => {
			const t = event.transformer;
			let n = 0;
			t.readable.pipeThrough(new TransformStream({ transform(frame, c) {
				if (++n !== 6) return c.enqueue(frame);
				postMessage({ frame });
				c.enqueue(new frame.constructor(frame));
			}})).pipeTo(t.writable);
		};`;
	/**
	 * The page's sound sent through POSTER's transform; at its frame, the
	 * page posts it to itself (and with it in the transfer list), to a frame
	 * of its origin and one of another site (`others`), and on a
	 * BroadcastChannel: what each made of it (entry.posts)
	 */
	window.__transform.posts = async (name, others) => {
		const entry = peer(name);
		const worker = new Worker(
			URL.createObjectURL(new Blob([POSTER], { type: 'text/javascript' })),
		);
		entry.stops.push(() => worker.terminate());
		const result = (entry.posts = { children: {} });
		// the children, each told what it heard
		const children = others.map((url) => {
			const child = document.createElement('iframe');
			child.src = url;
			document.body.append(child);
			entry.stops.push(() => child.remove());
			return child;
		});
		addEventListener('message', (event) => {
			if (!event.data?.heard) return;
			const at = children.findIndex(
				(child) => child.contentWindow === event.source,
			);
			if (at >= 0) result.children[at] = event.data.heard;
		});
		const mine = new BroadcastChannel('webrtc-transform');
		entry.stops.push(() => mine.close());
		mine.onmessage = (event) =>
			(result.broadcastHere = JSON.stringify(event.data));
		const err = (f) => {
			try {
				f();
				return 'ok';
			} catch (error) {
				return `${error.name}: ${error.message}`;
			}
		};
		worker.onmessage = async ({ data }) => {
			const { frame } = data;
			if (!frame || result.self) return;
			result.got = Object.prototype.toString.call(frame);
			const self = new Promise((resolve) => {
				const heard = (event) => {
					if (!event.data?.self) return;
					removeEventListener('message', heard);
					resolve(
						[
							Object.prototype.toString.call(event.data.frame),
							event.data.frame === frame,
							event.data.list[0] === event.data.frame,
							event.data.frame.data.byteLength === frame.data.byteLength,
						].join('|'),
					);
				};
				addEventListener('message', heard);
			});
			result.selfPost = err(() =>
				postMessage({ self: 1, frame, list: [frame] }, '*'),
			);
			result.self = await Promise.race([self, wait(2000).then(() => 'none')]);
			result.selfTransfer = err(() => postMessage({ frame }, '*', [frame]));
			for (const [i, child] of children.entries())
				result[`child ${i}`] = err(() =>
					child.contentWindow.postMessage({ frame, list: [frame] }, '*'),
				);
			const channel = new BroadcastChannel('webrtc-transform');
			result.broadcast = err(() =>
				channel.postMessage({ frame, list: [frame], from: 'page' }),
			);
			channel.close();
		};
		const track = source(entry, 'audio');
		const sender = entry.pc.addTrack(track, new MediaStream([track]));
		sender.transform = new RTCRtpScriptTransform(worker, {});
	};
	window.__transform.posted = async (name, ms = 20000) => {
		const entry = peer(name);
		await until(
			() =>
				entry.posts?.broadcast &&
				Object.keys(entry.posts.children).length >= 2 &&
				Object.values(entry.posts.children).every((heard) => heard.length > 0),
			ms,
			'posts',
		).catch(() => {});
		await wait(1500);
		return entry.posts;
	};
	/**
	 * A simulcast sender of `mime` with these modes (null for none) to a
	 * second connection of the page that takes the layers: what
	 * getParameters reads after the description, and per picture width
	 * the highest temporal layer the sender's transform saw
	 */
	window.__transform.simulcastLayers = async (name, mime, modes) => {
		const worker = new Worker(
			URL.createObjectURL(
				new Blob([
					`const out = {};
					onrtctransform = (event) => {
						const t = event.transformer;
						t.readable.pipeThrough(new TransformStream({ transform(frame, controller) {
							const meta = frame.getMetadata();
							const seen = (out[meta.width] ??= { width: meta.width, temporal: 0, frames: 0 });
							seen.frames++;
							seen.temporal = Math.max(seen.temporal, meta.temporalIndex ?? 0);
							controller.enqueue(frame);
						} })).pipeTo(t.writable);
					};
					onmessage = () => postMessage(out);`,
				]),
			),
		);
		const canvas = document.createElement('canvas');
		canvas.width = 1280;
		canvas.height = 720;
		const g = canvas.getContext('2d');
		let n = 0;
		const draw = setInterval(() => {
			g.fillStyle = `hsl(${(n += 37) % 360} 60% 50%)`;
			g.fillRect(0, 0, 1280, 720);
		}, 33);
		const track = canvas.captureStream(30).getVideoTracks()[0];
		const a = new RTCPeerConnection();
		const b = new RTCPeerConnection();
		a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
		b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
		try {
			const rids = modes.map((m, at) => `r${at}`);
			const t = a.addTransceiver(track, {
				direction: 'sendonly',
				sendEncodings: modes.map((mode, at) => ({
					rid: rids[at],
					scaleResolutionDownBy: 2 ** (modes.length - 1 - at),
					...(mode ? { scalabilityMode: mode } : {}),
				})),
			});
			t.setCodecPreferences(
				RTCRtpSender.getCapabilities('video').codecs.filter(
					(c) => c.mimeType === mime,
				),
			);
			t.sender.transform = new RTCRtpScriptTransform(worker, {});
			const offer = await a.createOffer();
			await a.setLocalDescription(offer);
			await b.setRemoteDescription(offer);
			const answer = await b.createAnswer();
			await b.setLocalDescription(answer);
			// the answer takes the layers, as an SFU's does
			const sdp = answer.sdp.replace(
				/(m=video[^]*?)(a=rtcp-mux\r\n)/,
				(all, head, mux) =>
					head +
					rids.map((rid) => `a=rid:${rid} recv\r\n`).join('') +
					`a=simulcast:recv ${rids.join(';')}\r\n` +
					mux,
			);
			await a.setRemoteDescription({ type: 'answer', sdp });
			const params = t.sender
				.getParameters()
				.encodings.map((e) => [e.rid, e.scalabilityMode ?? null]);
			// (the largest layer waits on the estimate: 9 s for 1280x720)
			await wait(9000);
			const seen = await new Promise((resolve) => {
				worker.onmessage = (e) => resolve(e.data);
				worker.postMessage(0);
			});
			const streams = Object.values(seen)
				.filter((one) => one.frames >= 10)
				.map((one) => `${one.width}:T${one.temporal + 1}`)
				.sort();
			return { params, streams };
		} catch (e) {
			return { failure: `${e.name}: ${e.message}` };
		} finally {
			clearInterval(draw);
			track.stop();
			a.close();
			b.close();
			worker.terminate();
		}
	};
	window.__transformReady = true;
})();
