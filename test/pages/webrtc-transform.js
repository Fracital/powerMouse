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
		onrtctransform = (event) => {
			const { readable, writable, options } = event.transformer;
			const list = (seen[options.operation + ' ' + options.kind] = []);
			readable.pipeThrough(new TransformStream({
				transform(frame, controller) {
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
						});
					}
					controller.enqueue(frame);
				},
			})).pipeTo(writable);
		};
		setInterval(() => postMessage(seen), 250);`;

	function open(name, config) {
		const pc = new RTCPeerConnection(config);
		const entry = { pc, tracks: [], players: [], stops: [] };
		entry.worker = new Worker(
			URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })),
		);
		entry.worker.onmessage = (event) => (entry.seen = event.data);
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
		 * `codec` (a video mimeType) the only one it takes
		 */
		media(name, kind, { width = 320, height = 180, codec = null } = {}) {
			const entry = peer(name);
			const track = source(entry, kind, width, height);
			// (addTrack: the offer's section takes the far end's transceiver)
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
				if (++n !== 6) { c.enqueue(frame); return; }
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
	window.__transformReady = true;
})();
