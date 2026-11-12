// One end of a real WebRTC connection with sound on it, for the
// webrtc-media suite, run natively (the browser's own stack: the far end,
// and the oracle for everything a page can read) and through the proxy
// (STomp's stack over wisp). The suite carries the signalling between ends:
// window.__media.<step>(name, ...) acts on the connection of that name and
// resolves with what the page could read. The only sound sources are tones
// the page writes itself, sample for sample, and the browser's fake
// capture device: no real device is ever opened.
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

	// --- sound ---

	/** a tone as a track: frames of 10 ms written on a timer, with exact times */
	function tone(hz, rate = 48000) {
		const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
		const writer = generator.writable.getWriter();
		const size = rate / 100;
		let frames = 0;
		const started = performance.now();
		const source = { track: generator, level: 0.5, noise: 0 };
		source.timer = setInterval(() => {
			const target = Math.floor((performance.now() - started) / 10);
			while (frames < target) {
				const data = new Float32Array(size);
				for (let i = 0; i < size; i++)
					data[i] =
						source.level *
							Math.sin((2 * Math.PI * hz * (frames * size + i)) / rate) +
						source.noise * (Math.random() * 2 - 1);
				writer
					.write(
						new AudioData({
							format: 'f32-planar',
							sampleRate: rate,
							numberOfFrames: size,
							numberOfChannels: 1,
							timestamp: frames * 10000,
							data,
						}),
					)
					.catch(() => {});
				frames++;
			}
		}, 5);
		return source;
	}
	/** what a track carries for `ms`, sample for sample */
	async function samples(track, ms) {
		const reader = new MediaStreamTrackProcessor({
			track,
		}).readable.getReader();
		const blocks = [];
		let rate = 48000;
		const end = performance.now() + ms;
		while (performance.now() < end) {
			const result = await Promise.race([reader.read(), wait(500)]);
			if (!result) continue;
			if (result.done) break;
			const frame = result.value;
			const block = new Float32Array(frame.numberOfFrames);
			frame.copyTo(block, { planeIndex: 0, format: 'f32-planar' });
			rate = frame.sampleRate;
			frame.close();
			blocks.push(block);
		}
		reader.cancel().catch(() => {});
		let length = 0;
		for (const block of blocks) length += block.length;
		const all = new Float32Array(length);
		let at = 0;
		for (const block of blocks) {
			all.set(block, at);
			at += block.length;
		}
		return { all, rate };
	}
	/**
	 * How much of a sound is a tone of `hz`, and how steady: its amplitude
	 * and phase in windows of 5 ms against a steady tone's. A jump in the
	 * phase is where samples were lost, added or replaced; a dip is where
	 * the tone was missing.
	 */
	function judge({ all, rate }, hz) {
		let start = 0;
		while (start < all.length && Math.abs(all[start]) < 0.02) start++;
		const turn = (2 * Math.PI * hz) / rate;
		const size = Math.round(rate / 200);
		const phases = [];
		const levels = [];
		// windows where what is not the tone is more than a tenth of the
		// sound: a packet concealed rather than decoded (or rebuilt from
		// its FEC copy) reads as one or more
		let distorted = 0;
		let power = 0;
		for (let i = start; i < all.length; i++) power += all[i] * all[i];
		for (let i = start; i + size <= all.length; i += size) {
			let re = 0;
			let im = 0;
			for (let k = 0; k < size; k++) {
				re += all[i + k] * Math.cos(turn * (i + k));
				im += all[i + k] * Math.sin(turn * (i + k));
			}
			phases.push(Math.atan2(im, re));
			levels.push((2 * Math.hypot(re, im)) / size);
			let rest = 0;
			let all2 = 0;
			for (let k = 0; k < size; k++) {
				const fit =
					((2 * re) / size) * Math.cos(turn * (i + k)) +
					((2 * im) / size) * Math.sin(turn * (i + k));
				rest += (all[i + k] - fit) ** 2;
				all2 += all[i + k] ** 2;
			}
			if (all2 > 0 && rest > all2 / 10) distorted++;
		}
		const sorted = [...levels].sort((a, b) => a - b);
		const level = sorted[sorted.length >> 1] || 0;
		let jumps = 0;
		let dips = 0;
		for (let i = 1; i < phases.length; i++) {
			const step = phases[i] - phases[i - 1];
			if (Math.abs(Math.atan2(Math.sin(step), Math.cos(step))) > 0.3) jumps++;
			if (levels[i] < level * 0.5) dips++;
		}
		const heard = all.length - start;
		let crossings = 0;
		for (let i = start + 1; i < all.length; i++)
			if (all[i - 1] < 0 !== all[i] < 0) crossings++;
		return {
			// what it is if it is not the tone: how loud, and at what pitch
			rms: heard ? +Math.sqrt(power / heard).toFixed(3) : 0,
			pitch: heard ? Math.round((crossings * rate) / (2 * heard)) : 0,
			seconds: +(heard / rate).toFixed(2),
			silentMs: Math.round((start / rate) * 1000),
			level: +level.toFixed(3),
			// the share of the sound's power that is the tone
			purity: heard
				? +((level * level) / 2 / (power / heard || 1)).toFixed(3)
				: 0,
			jumps,
			dips,
			distorted,
		};
	}

	const ROWS = [697, 770, 852, 941];
	const COLUMNS = [1209, 1336, 1477, 1633];
	const KEYS = ['123A', '456B', '789C', '*0#D'];
	/** the DTMF digits in a sound, in order, and how many 20 ms windows each held */
	function digits({ all, rate }) {
		const size = Math.round(rate / 50);
		const strength = (from, hz) => {
			let re = 0;
			let im = 0;
			for (let k = 0; k < size; k++) {
				re += all[from + k] * Math.cos((2 * Math.PI * hz * k) / rate);
				im += all[from + k] * Math.sin((2 * Math.PI * hz * k) / rate);
			}
			return (2 * Math.hypot(re, im)) / size;
		};
		const out = [];
		let quiet = 0;
		for (let from = 0; from + size <= all.length; from += size) {
			const best = (list) =>
				list
					.map((hz, i) => [strength(from, hz), i])
					.sort((a, b) => b[0] - a[0])[0];
			const [row, r] = best(ROWS);
			const [column, c] = best(COLUMNS);
			if (row < 0.03 || column < 0.03) {
				quiet++;
				continue;
			}
			const key = KEYS[r][c];
			// a tone broken by less than 100 ms is one tone
			if (out.length && out.at(-1)[0] === key && quiet < 5) out.at(-1)[1]++;
			else out.push([key, 1]);
			quiet = 0;
		}
		return out;
	}

	// --- what a page can read ---

	const trackView = (track) =>
		track && {
			id: track.id,
			kind: track.kind,
			label: track.label,
			muted: track.muted,
			state: track.readyState,
			enabled: track.enabled,
		};
	const transceiverView = (transceiver) => ({
		mid: transceiver.mid,
		direction: transceiver.direction,
		currentDirection: transceiver.currentDirection,
		stopped: transceiver.stopped,
		sending: transceiver.sender.track && transceiver.sender.track.id,
		receiving: trackView(transceiver.receiver.track),
	});
	const view = (pc) => ({
		signaling: pc.signalingState,
		transceivers: pc.getTransceivers().map(transceiverView),
		senders: pc.getSenders().length,
		receivers: pc.getReceivers().length,
		consistent: pc
			.getTransceivers()
			.every(
				(transceiver, i) =>
					transceiver.sender === pc.getSenders()[i] &&
					transceiver.receiver === pc.getReceivers()[i] &&
					transceiver === pc.getTransceivers()[i],
			),
	});
	const attempt = async (run) => {
		try {
			const value = await run();
			return ['ok', value === undefined ? 'undefined' : JSON.stringify(value)];
		} catch (error) {
			return [error.name, error.message];
		}
	};
	const members = (Class) =>
		Object.getOwnPropertyNames(Class.prototype).map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, key);
			const of = (fn) =>
				fn
					? `${fn.name}/${fn.length}/${/\[native code\]/.test(String(fn))}`
					: '';
			return `${key}:${of(descriptor.get)}:${of(descriptor.set)}:${typeof descriptor.value === 'function' ? of(descriptor.value) : ''}:${descriptor.enumerable}${descriptor.configurable}`;
		});

	function open(name, config) {
		const pc = new RTCPeerConnection(config);
		const entry = {
			pc,
			log: [],
			candidates: [],
			sources: [],
			tracks: [],
			players: new Map(),
			gatherings: 0,
			gatheringsThen: 0,
			describedAt: 0,
		};
		peers.set(name, entry);
		const note = (line) => entry.log.push(line);
		pc.addEventListener('signalingstatechange', () =>
			note(`signaling:${pc.signalingState}`),
		);
		pc.addEventListener('negotiationneeded', () => note('negotiationneeded'));
		pc.addEventListener('icegatheringstatechange', () => {
			if (pc.iceGatheringState === 'gathering') entry.gatherings++;
		});
		pc.addEventListener('icecandidate', (event) => {
			if (event.candidate) entry.candidates.push(event.candidate.toJSON());
		});
		pc.addEventListener('track', (event) => {
			const { track, streams, transceiver, receiver } = event;
			entry.tracks.push({ track, streams });
			// The browser's own stack decodes a track only while something
			// plays it, so each one is played, as a page does
			const player = new Audio();
			player.srcObject = new MediaStream([track]);
			player.play().catch(() => {});
			entry.players.set(track, player);
			const at = pc.getTransceivers().indexOf(transceiver);
			note(
				`track:${at}:${track.kind}:${track.label}:muted=${track.muted}:streams=${streams.length}:${[
					event instanceof RTCTrackEvent,
					Object.prototype.toString.call(event),
					receiver === transceiver.receiver,
					track === receiver.track,
					streams.every((stream) => stream.getTracks().includes(track)),
					Object.isFrozen(streams),
					event.streams === streams,
					transceiver.currentDirection,
					pc.signalingState,
				]}`,
			);
			for (const type of ['mute', 'unmute', 'ended'])
				track.addEventListener(type, () =>
					note(`${type}:${pc.getTransceivers().indexOf(transceiver)}`),
				);
			for (const stream of streams)
				if (!stream.__watched) {
					stream.__watched = true;
					for (const type of ['addtrack', 'removetrack'])
						stream.addEventListener(type, (change) =>
							note(
								`${type}:${change.track.kind}:${change instanceof MediaStreamTrackEvent}`,
							),
						);
				}
		});
		return entry;
	}
	// A description just set gathers from the next task on, so "complete"
	// may still be the last description's (as in webrtc-peer.js)
	const described = (entry) => {
		entry.describedAt = Date.now();
		entry.gatheringsThen = entry.gatherings;
	};
	const gathered = (entry) =>
		until(
			() =>
				entry.pc.iceGatheringState === 'complete' &&
				(entry.gatherings > entry.gatheringsThen ||
					Date.now() - entry.describedAt > 1000),
			60000,
			'gathering',
		);
	const transceiver = (name, at) => peer(name).pc.getTransceivers()[at];

	window.__media = {
		open(name, config) {
			open(name, config);
		},
		/**
		 * A tone the connection sends: added with addTrack in `streams`
		 * streams, or with addTransceiver (`direction` given). Resolves with
		 * the ids a peer will read.
		 */
		tone(name, hz, { streams = 1, direction, watchFec } = {}) {
			const entry = peer(name);
			const source = tone(hz);
			entry.sources.push(source);
			const made = [];
			for (let i = 0; i < streams; i++) made.push(new MediaStream());
			if (direction)
				entry.pc.addTransceiver(source.track, { direction, streams: made });
			else entry.pc.addTrack(source.track, ...made);
			// in the same task, as a receiver's transform must be
			if (watchFec)
				window.__media.watchFec(name, entry.pc.getTransceivers().length - 1);
			return { track: source.track.id, streams: made.map((s) => s.id) };
		},
		/** the browser's fake capture device, which gives the origin media access too */
		async capture(name) {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const [track] = stream.getAudioTracks();
			if (name) peer(name).pc.addTrack(track, stream);
			return { track: track.id, label: track.label };
		},
		receive(name, kind, direction = 'recvonly') {
			peer(name).pc.addTransceiver(kind, { direction });
		},
		async draft(name, options) {
			return (await peer(name).pc.createOffer(options)).sdp;
		},
		/** createOffer or createAnswer, set, and gathered: the description a peer is sent */
		async local(name, type) {
			const entry = peer(name);
			const { pc } = entry;
			const description =
				type === 'offer' ? await pc.createOffer() : await pc.createAnswer();
			await pc.setLocalDescription(description);
			described(entry);
			await gathered(entry);
			return { created: description.sdp, sdp: pc.localDescription.sdp };
		},
		/**
		 * setRemoteDescription; with `listen`, the receiver of that
		 * transceiver is listened to from then on (window.__media.listen)
		 */
		async remote(name, type, sdp, listen) {
			await peer(name).pc.setRemoteDescription({ type, sdp });
			// in the same task: a transform given later is never handed a
			// frame (Chrome 152 and 156)
			if (listen !== undefined) window.__media.listen(name, listen);
		},
		async connected(name, ms = 30000) {
			const { pc } = peer(name);
			await until(
				() => pc.connectionState === 'connected',
				ms,
				`connection (${pc.connectionState}, ice ${pc.iceConnectionState})`,
			);
		},
		async stats(name) {
			const out = [];
			for (const report of (await peer(name).pc.getStats()).values())
				if (['inbound-rtp', 'outbound-rtp', 'codec'].includes(report.type))
					out.push(JSON.stringify(report));
			return out;
		},
		view: (name) => view(peer(name).pc),
		log: (name) => peer(name).log.splice(0),
		channel(name, label) {
			peer(name).pc.createDataChannel(label);
		},
		/** everything the page read of its own end's addresses */
		own(name) {
			const { pc, candidates } = peer(name);
			return {
				candidates,
				local: pc.localDescription && pc.localDescription.sdp,
				current: pc.currentLocalDescription && pc.currentLocalDescription.sdp,
			};
		},
		/** where the browser's own stack sees its peer, and what it has heard */
		async far(name) {
			const { pc } = peer(name);
			const out = { remote: null, packets: 0 };
			const stats = await pc.getStats();
			for (const report of stats.values()) {
				if (report.type === 'inbound-rtp')
					out.packets += report.packetsReceived || 0;
				if (report.type !== 'transport') continue;
				const pair = stats.get(report.selectedCandidatePairId);
				const remote = pair && stats.get(pair.remoteCandidateId);
				if (remote)
					out.remote = {
						address: remote.address,
						port: remote.port,
						type: remote.candidateType,
					};
			}
			return out;
		},
		/** what the receiver of transceiver `at` plays for `ms`, judged as a tone of `hz` */
		async hear(name, at, hz, ms = 2000) {
			const track = transceiver(name, at).receiver.track;
			return judge(await samples(track, ms), hz);
		},
		/** the DTMF digits the receiver of transceiver `at` plays in `ms` */
		async keys(name, at, ms) {
			const track = transceiver(name, at).receiver.track;
			return digits(await samples(track, ms));
		},
		/** the sound's level in dBFS the receiver of transceiver `at` plays for `ms` */
		async loudness(name, at, ms) {
			const { all } = await samples(transceiver(name, at).receiver.track, ms);
			let squares = 0;
			for (const value of all) squares += value * value;
			return all.length
				? +(10 * Math.log10(squares / all.length || 1e-20)).toFixed(1)
				: null;
		},
		noise(name, at, level) {
			peer(name).sources[at].noise = level;
		},
		/** how far the element playing the track gets in `ms` */
		async plays(name, at, ms = 1500) {
			const audio = peer(name).players.get(
				transceiver(name, at).receiver.track,
			);
			const before = audio.currentTime;
			await wait(ms);
			return audio.currentTime - before;
		},
		async muted(name, at, muted, ms = 15000) {
			const track = transceiver(name, at).receiver.track;
			await until(() => track.muted === muted, ms, `muted=${muted}`);
		},
		level(name, at, level) {
			peer(name).sources[at].level = level;
		},
		remove(name, at) {
			const { pc } = peer(name);
			pc.removeTrack(pc.getSenders()[at]);
		},
		async replace(name, at, hz) {
			const entry = peer(name);
			let track = null;
			if (hz) {
				const source = tone(hz);
				entry.sources.push(source);
				({ track } = source);
			}
			await transceiver(name, at).sender.replaceTrack(track);
		},
		direction(name, at, direction) {
			transceiver(name, at).direction = direction;
		},
		/** transceiver `at` lists `mime` first among the browser's own codecs */
		prefer(name, at, mime) {
			const { codecs } = RTCRtpReceiver.getCapabilities('audio');
			transceiver(name, at).setCodecPreferences([
				...codecs.filter((codec) => codec.mimeType === mime),
				...codecs.filter((codec) => codec.mimeType !== mime),
			]);
		},
		/** the sender of transceiver `at` sends with `mime` (an encoding's codec) */
		async sendWith(name, at, mime) {
			const { sender } = transceiver(name, at);
			const parameters = sender.getParameters();
			parameters.encodings[0].codec = parameters.codecs.find(
				(codec) => codec.mimeType === mime,
			);
			await sender.setParameters(parameters);
		},
		/** the codec each RTP stream of the connection sends or receives with */
		async codecs(name) {
			const stats = await peer(name).pc.getStats();
			const out = {};
			for (const report of stats.values())
				if (report.type === 'inbound-rtp' || report.type === 'outbound-rtp')
					out[report.type] = stats.get(report.codecId)?.mimeType ?? null;
			return out;
		},
		stop(name, at) {
			transceiver(name, at).stop();
		},
		/**
		 * The receiver of transceiver `at` passes what it gets through an
		 * encoded transform that notes each telephone-event frame (natively
		 * only: the far end is the browser's own stack). Called by `remote`.
		 */
		listen(name, at) {
			const entry = peer(name);
			const source = `addEventListener('rtctransform', (event) => {
				const { readable, writable } = event.transformer;
				readable.pipeThrough(new TransformStream({
					transform(frame, controller) {
						const meta = frame.getMetadata();
						if (meta.mimeType === 'audio/telephone-event' ||
							meta.mimeType === 'audio/CN')
							postMessage([meta.payloadType, meta.rtpTimestamp,
								[...new Uint8Array(frame.data)], meta.mimeType]);
						else postMessage([meta.payloadType, meta.rtpTimestamp, null,
							meta.mimeType]);
						controller.enqueue(frame);
					},
				})).pipeTo(writable);
			});`;
			const worker = new Worker(
				URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
			);
			entry.events = [];
			// kept: a worker nobody holds is collected with its handler
			entry.worker = worker;
			worker.onmessage = (event) => entry.events.push(event.data);
			transceiver(name, at).receiver.transform = new RTCRtpScriptTransform(
				worker,
				{},
			);
		},
		/**
		 * The sender of transceiver `at` passes what it encodes through an
		 * encoded transform that counts the Opus frames carrying an FEC copy
		 * of the frame before (an LBRR frame, RFC 6716 4.2.4: the second
		 * bit of a mono 20 ms SILK or hybrid frame), which libopus makes
		 * only once the peer reports loss (natively only)
		 */
		watchFec(name, at) {
			const entry = peer(name);
			const source = `const seen = { frames: 0, copies: 0 };
			addEventListener('rtctransform', (event) => {
				const { readable, writable } = event.transformer;
				readable.pipeThrough(new TransformStream({
					transform(frame, controller) {
						const bytes = new Uint8Array(frame.data);
						const config = bytes[0] >> 3;
						if (bytes.length > 1 && (bytes[0] & 7) === 0 &&
							(config < 12 ? (config & 3) === 1 : config < 16 && config & 1)) {
							// libopus's range decoder (celt/entdec.c), two bits in
							let at = 1;
							const next = () => (at < bytes.length ? bytes[at++] : 0);
							let range = 128;
							let rest = next();
							let value = range - 1 - (rest >> 1);
							const normalize = () => {
								while (range <= 2 ** 23) {
									range *= 256;
									const last = rest;
									rest = next();
									value = (value * 256 + (255 & ~(((last << 8) | rest) >> 1))) % 2 ** 31;
								}
							};
							normalize();
							let one = false;
							for (let bit = 0; bit < 2; bit++) {
								const half = Math.floor(range / 2);
								one = value < half;
								if (!one) value -= half;
								range = one ? half : range - half;
								normalize();
							}
							if (one) seen.copies++;
						}
						seen.frames++;
						postMessage(seen);
						controller.enqueue(frame);
					},
				})).pipeTo(writable);
			});`;
			const worker = new Worker(
				URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
			);
			entry.fec = { frames: 0, copies: 0 };
			entry.fecWorker = worker;
			worker.onmessage = (event) => (entry.fec = event.data);
			transceiver(name, at).sender.transform = new RTCRtpScriptTransform(
				worker,
				{},
			);
		},
		/** what the transform of `watchFec` counted */
		sentFec(name) {
			return peer(name).fec;
		},
		/** what the peer's receiver reports says of the loss (remote-inbound-rtp) */
		async reportedLoss(name) {
			for (const report of (await peer(name).pc.getStats()).values())
				if (report.type === 'remote-inbound-rtp')
					return {
						lost: report.packetsLost,
						fraction: report.fractionLost,
					};
			return null;
		},
		/** the browser's own receiver's count of FEC copies and concealment */
		async lossStats(name) {
			for (const report of (await peer(name).pc.getStats()).values())
				if (report.type === 'inbound-rtp')
					return {
						lost: report.packetsLost,
						fec: report.fecPacketsReceived,
						fecDiscarded: report.fecPacketsDiscarded,
						concealmentEvents: report.concealmentEvents,
					};
			return null;
		},
		/**
		 * The telephone events heard since the last call: for each, its
		 * payload type, its RTP time less the first one's and its four bytes
		 */
		heardTones(name) {
			const events = peer(name)
				.events.splice(0)
				.filter((event) => event[3] === 'audio/telephone-event');
			const first = events[0]?.[1] ?? 0;
			return events.map(([pt, time, bytes]) => [
				pt,
				(time - first) >>> 0,
				bytes.join(' '),
			]);
		},
		/**
		 * The frames heard since the last call, in order: speech as its
		 * payload type, a comfort noise frame as its payload type, its RTP
		 * time less the first frame's and its bytes
		 */
		heardFrames(name) {
			const events = peer(name).events.splice(0);
			const first = events[0]?.[1] ?? 0;
			return events.map(([pt, time, bytes, mime]) =>
				mime === 'audio/CN'
					? [pt, (time - first) >>> 0, bytes.join(' ')]
					: [pt],
			);
		},
		/**
		 * The sender of transceiver `at` plays `tones`: what its
		 * RTCDTMFSender reads, and each tonechange event (its tone, when it
		 * came after the call, the buffer then), until the last one
		 */
		async dtmf(name, at, tones, duration, gap, ms = 15000) {
			const { dtmf } = transceiver(name, at).sender;
			const events = [];
			const started = performance.now();
			const done = new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				dtmf.ontonechange = (event) => {
					events.push([
						event.tone,
						Math.round(performance.now() - started),
						dtmf.toneBuffer,
						event instanceof RTCDTMFToneChangeEvent,
						event.bubbles,
						event.cancelable,
					]);
					if (event.tone === '') {
						clearTimeout(timer);
						resolve();
					}
				};
			});
			const can = dtmf.canInsertDTMF;
			const args = [tones, duration, gap].filter((arg) => arg !== undefined);
			const call = await attempt(() => dtmf.insertDTMF(...args));
			const buffer = dtmf.toneBuffer;
			await done;
			dtmf.ontonechange = null;
			return { can, call, buffer, events };
		},
		async active(name, at, active) {
			const { sender } = transceiver(name, at);
			const parameters = sender.getParameters();
			parameters.encodings[0].active = active;
			await sender.setParameters(parameters);
		},
		close(name) {
			const entry = peer(name);
			for (const source of entry.sources) {
				clearInterval(source.timer);
				source.track.stop();
			}
			for (const player of entry.players.values()) {
				player.pause();
				player.srcObject = null;
			}
			entry.pc.close();
			return view(entry.pc);
		},
		/**
		 * The objects as a page can tell them: where they come from, what
		 * their members read as, what they answer and what they refuse. The
		 * same lines come from the browser's own connection.
		 */
		async shapes() {
			const out = {};
			for (const Class of [
				RTCRtpTransceiver,
				RTCRtpSender,
				RTCRtpReceiver,
				RTCTrackEvent,
				RTCDTMFSender,
				RTCDTMFToneChangeEvent,
			])
				out[Class.name] = members(Class);
			const pc = new RTCPeerConnection();
			const other = new RTCPeerConnection();
			const source = tone(300);
			const stream = new MediaStream();
			const sender = pc.addTrack(source.track, stream);
			const [made] = pc.getTransceivers();
			const { receiver } = made;
			const tag = (value) => Object.prototype.toString.call(value);
			out.kinds = [
				tag(made),
				tag(sender),
				tag(receiver),
				tag(receiver.track),
				made instanceof RTCRtpTransceiver,
				sender instanceof RTCRtpSender,
				receiver instanceof RTCRtpReceiver,
				receiver.track instanceof MediaStreamTrack,
				Object.getPrototypeOf(receiver.track) === MediaStreamTrack.prototype,
				Object.getOwnPropertyNames(made).length,
				Object.getOwnPropertyNames(sender).length,
				Object.getOwnPropertyNames(receiver.track).length,
				'writable' in receiver.track,
				made.sender === sender,
				sender.track === source.track,
				typeof receiver.track.id,
				receiver.track.id.length,
				String(RTCRtpSender.prototype.replaceTrack),
				String(
					Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'id').get,
				),
				String(
					Object.getOwnPropertyDescriptor(MediaStream.prototype, 'id').get,
				),
			];
			const parameters = sender.getParameters();
			out.parameters = [
				JSON.stringify({ ...parameters, transactionId: 'X' }),
				typeof parameters.transactionId,
				JSON.stringify(receiver.getParameters()),
				JSON.stringify(receiver.getContributingSources()),
				JSON.stringify(receiver.getSynchronizationSources()),
				String(receiver.jitterBufferTarget),
				String(sender.transport),
				String(receiver.transport),
			];
			const stranger = {};
			const video = () => {
				const canvas = document.createElement('canvas');
				canvas.getContext('2d');
				return canvas.captureStream().getVideoTracks()[0];
			};
			out.refusals = {
				addTrackNone: await attempt(() => pc.addTrack()),
				addTrackStranger: await attempt(() => pc.addTrack(stranger)),
				addTrackStream: await attempt(() =>
					pc.addTrack(source.track, stranger),
				),
				addTrackTwice: await attempt(() => pc.addTrack(source.track)),
				transceiverNone: await attempt(() => pc.addTransceiver()),
				transceiverKind: await attempt(() => pc.addTransceiver('text')),
				transceiverStranger: await attempt(() => pc.addTransceiver(stranger)),
				transceiverDirection: await attempt(() =>
					pc.addTransceiver('audio', { direction: 'up' }),
				),
				transceiverInit: await attempt(() => pc.addTransceiver('audio', 5)),
				removeNone: await attempt(() => pc.removeTrack()),
				removeStranger: await attempt(() => pc.removeTrack(stranger)),
				removeOther: await attempt(() =>
					pc.removeTrack(other.addTrack(tone(300).track)),
				),
				directionWord: await attempt(() => {
					made.direction = 'up';
					return made.direction;
				}),
				directionStopped: await attempt(() => {
					made.direction = 'stopped';
				}),
				replaceKind: await attempt(() => sender.replaceTrack(video())),
				replaceStranger: await attempt(() => sender.replaceTrack(stranger)),
				replaceNone: await attempt(() => sender.replaceTrack()),
				replaceNull: await attempt(() => sender.replaceTrack(null)),
				replaceBack: await attempt(() => sender.replaceTrack(source.track)),
				parametersStale: await attempt(() =>
					sender.setParameters({ ...parameters, transactionId: 'x' }),
				),
				parametersNone: await attempt(() => sender.setParameters()),
				parametersSet: await attempt(() =>
					sender.setParameters(sender.getParameters()),
				),
				parametersTwice: await attempt(async () => {
					const read = sender.getParameters();
					await sender.setParameters(read);
					return sender.setParameters(read);
				}),
				streamsStranger: await attempt(() => sender.setStreams(stranger)),
				streamsSet: await attempt(() => sender.setStreams(stream)),
				illegalSender: await attempt(() =>
					Object.getOwnPropertyDescriptor(
						RTCRtpSender.prototype,
						'track',
					).get.call(stranger),
				),
				illegalTransceiver: await attempt(() =>
					RTCRtpTransceiver.prototype.stop.call(stranger),
				),
				illegalReceiver: await attempt(() =>
					RTCRtpReceiver.prototype.getParameters.call(stranger),
				),
				construct: await attempt(() => new RTCRtpSender()),
				trackOfStranger: await attempt(() =>
					Object.getOwnPropertyDescriptor(
						MediaStreamTrack.prototype,
						'id',
					).get.call(stranger),
				),
			};
			// the sender's RTCDTMFSender before any negotiation
			const { dtmf } = sender;
			const picture = pc.addTransceiver('video');
			out.dtmf = {
				read: [
					tag(dtmf),
					dtmf instanceof RTCDTMFSender,
					dtmf instanceof EventTarget,
					dtmf === sender.dtmf,
					Object.getOwnPropertyNames(dtmf).length,
					dtmf.canInsertDTMF,
					dtmf.toneBuffer,
					dtmf.ontonechange,
					picture.sender.dtmf,
					pc.addTransceiver('audio', { direction: 'recvonly' }).sender.dtmf
						?.canInsertDTMF,
					String(RTCDTMFSender.prototype.insertDTMF),
				],
				insert: await attempt(() => dtmf.insertDTMF('1')),
				insertNone: await attempt(() => dtmf.insertDTMF()),
				insertSymbol: await attempt(() => dtmf.insertDTMF(Symbol('1'))),
				insertBigInt: await attempt(() => dtmf.insertDTMF('1', 10n)),
				construct: await attempt(() => new RTCDTMFSender()),
				illegal: await attempt(() =>
					Object.getOwnPropertyDescriptor(
						RTCDTMFSender.prototype,
						'toneBuffer',
					).get.call(stranger),
				),
				illegalInsert: await attempt(() =>
					RTCDTMFSender.prototype.insertDTMF.call(stranger, '1'),
				),
				event: await attempt(() => {
					const event = new RTCDTMFToneChangeEvent('tonechange', {
						tone: '5',
					});
					return [
						event.tone,
						tag(event),
						event.bubbles,
						event.cancelable,
						dtmf.dispatchEvent(event),
					];
				}),
				handler: await attempt(() => {
					const seen = [];
					dtmf.ontonechange = (event) => seen.push(event.tone);
					dtmf.dispatchEvent(
						new RTCDTMFToneChangeEvent('tonechange', { tone: '#' }),
					);
					const handler = typeof dtmf.ontonechange;
					dtmf.ontonechange = null;
					return [seen, handler, dtmf.ontonechange];
				}),
			};
			picture.stop();
			made.stop();
			out.stopped = {
				view: JSON.stringify(transceiverView(made)).replace(
					/[0-9a-f-]{36}/g,
					'ID',
				),
				again: await attempt(() => made.stop()),
				direction: await attempt(() => {
					made.direction = 'sendonly';
				}),
				replace: await attempt(() => sender.replaceTrack(null)),
				parameters: await attempt(() =>
					sender.setParameters(sender.getParameters()),
				),
				read: JSON.stringify({ ...sender.getParameters(), transactionId: 'X' }),
			};
			out.dtmf.stopped = [
				sender.dtmf === dtmf,
				dtmf.canInsertDTMF,
				...(await attempt(() => dtmf.insertDTMF('1'))),
			];
			await wait(50);
			out.stopped.ended = receiver.track.readyState;
			pc.close();
			out.closed = {
				addTrack: await attempt(() => pc.addTrack(tone(300).track)),
				addTransceiver: await attempt(() => pc.addTransceiver('audio')),
				remove: await attempt(() => pc.removeTrack(sender)),
				replace: await attempt(() => sender.replaceTrack(null)),
				direction: await attempt(() => {
					made.direction = 'recvonly';
				}),
				stop: await attempt(() => made.stop()),
				transceivers: pc.getTransceivers().length,
				dtmf: [
					sender.dtmf === dtmf,
					dtmf.canInsertDTMF,
					...(await attempt(() => dtmf.insertDTMF('1'))),
				],
			};
			other.close();
			clearInterval(source.timer);
			return out;
		},
	};

	// getStats() of a call with sound both ways between two connections of
	// the page (a tone each, written sample for sample; each end plays what
	// it receives in an <audio>, which the fake output device takes): the entries of each kind, their
	// members in the browser's order, the values that do not vary and the
	// rates of the ones that count, at each stage; and what a sender's and a
	// receiver's own getStats() hold. The suite compares a proxied page's
	// with the browser's (webrtc-media suite).
	window.__mediaStats = async () => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const until = async (test, ms, what) => {
			const end = Date.now() + ms;
			while (!(await test())) {
				if (Date.now() > end) throw new Error(`timed out: ${what}`);
				await wait(200);
			}
		};
		const tone = (hz) => {
			const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
			const writer = generator.writable.getWriter();
			let frames = 0;
			const started = performance.now();
			const timer = setInterval(() => {
				const target = Math.floor((performance.now() - started) / 10);
				while (frames < target) {
					const data = new Float32Array(480);
					for (let i = 0; i < 480; i++)
						data[i] =
							0.5 * Math.sin((2 * Math.PI * hz * (frames * 480 + i)) / 48000);
					writer
						.write(
							new AudioData({
								format: 'f32-planar',
								sampleRate: 48000,
								numberOfFrames: 480,
								numberOfChannels: 1,
								timestamp: frames * 10000,
								data,
							}),
						)
						.catch(() => {});
					frames++;
				}
			}, 5);
			return { track: generator, stop: () => clearInterval(timer) };
		};
		const read = async (source, selector) => {
			const entries = [];
			(await source.getStats(selector)).forEach((value, key) =>
				entries.push([key, value]),
			);
			return entries;
		};
		const MEDIA = new Set([
			'codec',
			'inbound-rtp',
			'outbound-rtp',
			'remote-inbound-rtp',
			'remote-outbound-rtp',
			'media-source',
			'media-playout',
		]);
		/**
		 * The kinds in the report's order and each media entry's members in
		 * their order. Left out of the order: candidates and pairs (their
		 * ids are random, and which candidates there are depends on the
		 * machine) and certificates (the two ends of one page have a
		 * certificate each here, and share one on GitHub's runner)
		 */
		const kept = (type) => !/candidate|certificate/.test(type);
		const shape = (entries) => ({
			order: entries.map(([, entry]) => entry.type).filter(kept),
			members: Object.fromEntries(
				entries
					.filter(([, entry]) => MEDIA.has(entry.type))
					.map(([, entry]) => [
						entry.type,
						Object.keys(entry)
							// told once a report gave one, which varies from run to run
							.filter(
								(key) =>
									!/^remote-/.test(entry.type) || key !== 'roundTripTime',
							)
							.join(),
					]),
			),
		});
		const of = (entries, type) =>
			entries.filter(([, entry]) => entry.type === type).map(([, e]) => e);
		const out = {};
		const sources = [tone(440), tone(660)];
		const a = new RTCPeerConnection();
		const b = new RTCPeerConnection();
		a.onicecandidate = ({ candidate }) =>
			candidate && b.addIceCandidate(candidate).catch(() => {});
		b.onicecandidate = ({ candidate }) =>
			candidate && a.addIceCandidate(candidate).catch(() => {});
		const players = [];
		for (const pc of [a, b])
			pc.ontrack = ({ track }) => {
				const player = document.createElement('audio');
				player.srcObject = new MediaStream([track]);
				players.push(player);
				player.play().catch(() => {});
			};
		const sender = a.addTrack(sources[0].track, new MediaStream());
		b.addTrack(sources[1].track, new MediaStream());
		out.added = [shape(await read(a)), shape(await read(b))];
		await a.setLocalDescription();
		out.offered = shape(await read(a));
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription();
		await a.setRemoteDescription(b.localDescription);
		const reported = async (pc) => {
			const types = (await read(pc)).map(([, entry]) => entry.type);
			return (
				types.includes('remote-inbound-rtp') &&
				types.includes('remote-outbound-rtp')
			);
		};
		await until(
			async () => (await reported(a)) && (await reported(b)),
			20000,
			'the peers reports',
		);
		const first = await read(a);
		const started = performance.now();
		await wait(2000);
		const second = await read(a);
		const seconds = (performance.now() - started) / 1000;
		out.reported = [shape(second), shape(await read(b))];
		const rate = (type, key, round = 1) => {
			const [x] = of(first, type);
			const [y] = of(second, type);
			return Math.round((y?.[key] - x?.[key]) / seconds / round) * round;
		};
		const [outbound] = of(second, 'outbound-rtp');
		const [inbound] = of(second, 'inbound-rtp');
		const [source] = of(second, 'media-source');
		const [remoteIn] = of(second, 'remote-inbound-rtp');
		const [remoteOut] = of(second, 'remote-outbound-rtp');
		const [playout] = of(second, 'media-playout');
		const now = performance.timeOrigin + performance.now();
		out.values = {
			codecs: of(second, 'codec').map((entry) => ({
				...entry,
				timestamp: undefined,
			})),
			outbound: outbound && {
				id: outbound.id === `OT01A${outbound.ssrc}`,
				codec: outbound.codecId?.startsWith('COT01_'),
				kind: [outbound.kind, outbound.mediaType, outbound.mid],
				active: outbound.active,
				packets: rate('outbound-rtp', 'packetsSent', 5),
				header: Math.round(outbound.headerBytesSent / outbound.packetsSent),
				bytes:
					outbound.bytesSent / outbound.packetsSent > 40 &&
					outbound.bytesSent / outbound.packetsSent < 200,
				source: outbound.mediaSourceId === source?.id,
				remote: outbound.remoteId === remoteIn?.id,
				zero: [
					outbound.nackCount,
					outbound.packetsSentWithEct1,
					outbound.retransmittedBytesSent,
					outbound.retransmittedPacketsSent,
					outbound.totalPacketSendDelay,
				],
				target: outbound.targetBitrate,
			},
			inbound: inbound && {
				id: inbound.id === `IT01A${inbound.ssrc}`,
				codec: inbound.codecId?.startsWith('CIT01_'),
				kind: [inbound.kind, inbound.mediaType, inbound.mid, inbound.playoutId],
				packets: rate('inbound-rtp', 'packetsReceived', 5),
				header: Math.round(
					inbound.headerBytesReceived / inbound.packetsReceived,
				),
				lost: inbound.packetsLost,
				samples: rate('inbound-rtp', 'totalSamplesReceived', 4000),
				duration: rate('inbound-rtp', 'totalSamplesDuration', 0.25),
				emitted: rate('inbound-rtp', 'jitterBufferEmittedCount', 4000),
				energy: rate('inbound-rtp', 'totalAudioEnergy', 0.05),
				level: inbound.audioLevel > 0.4 && inbound.audioLevel < 0.6,
				delay:
					inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount >
						0.005 &&
					inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount < 0.25,
				track: inbound.trackIdentifier === a.getReceivers()[0].track.id,
				last: Math.abs(inbound.lastPacketReceivedTimestamp - now) < 1000,
				remote: inbound.remoteId === remoteOut?.id,
				zero: [
					inbound.packetsReceivedWithCe,
					inbound.packetsReceivedWithEct1,
					inbound.fecPacketsDiscarded,
					inbound.fecPacketsReceived,
				],
			},
			source: source && {
				id: /^SA\d+$/.test(source.id),
				kind: source.kind,
				track: source.trackIdentifier === sources[0].track.id,
				level: source.audioLevel,
				energy: rate('media-source', 'totalAudioEnergy', 0.05),
				duration: rate('media-source', 'totalSamplesDuration', 0.25),
			},
			remoteInbound: remoteIn && {
				id: remoteIn.id === `RIA${outbound?.ssrc}`,
				codec: remoteIn.codecId === outbound?.codecId,
				local: remoteIn.localId === outbound?.id,
				lost: [remoteIn.packetsLost, remoteIn.fractionLost],
				jitter: remoteIn.jitter < 0.02,
				measurements: remoteIn.roundTripTimeMeasurements >= 0,
				time: Math.abs(remoteIn.timestamp - now) < 15000,
			},
			remoteOutbound: remoteOut && {
				id: remoteOut.id === `ROA${inbound?.ssrc}`,
				codec: remoteOut.codecId === inbound?.codecId,
				local: remoteOut.localId === inbound?.id,
				reports: remoteOut.reportsSent >= 1,
				counts:
					remoteOut.packetsSent > 0 &&
					remoteOut.packetsSent <= inbound.packetsReceived + 100,
				remote:
					Math.abs(remoteOut.remoteTimestamp - remoteOut.timestamp) < 1000,
				time: Math.abs(remoteOut.timestamp - now) < 15000,
			},
			playout: playout && {
				id: playout.id,
				kind: playout.kind,
				counting: rate('media-playout', 'totalSamplesCount') > 0,
				synthesized: [
					playout.synthesizedSamplesDuration,
					playout.synthesizedSamplesEvents,
				],
			},
		};
		// a sender's and a receiver's own reports, and the connection's for a track
		// (a candidate's id is random: where it sorts among the others varies)
		const ids = (entries) =>
			entries
				.map(([, entry]) => entry.type)
				.filter((type) => type === 'candidate-pair' || kept(type));
		const sent = await read(sender);
		const received = await read(a.getReceivers()[0]);
		const certified = (entries) =>
			entries.some(([, entry]) => entry.type === 'certificate');
		out.selected = {
			sender: ids(sent),
			receiver: ids(received),
			certificates: [certified(sent), certified(received)],
			bySenderTrack:
				ids(await read(a, sources[0].track)).join() === ids(sent).join(),
			byReceiverTrack:
				ids(await read(a, a.getReceivers()[0].track)).join() ===
				ids(received).join(),
		};
		try {
			await a.getStats(sources[1].track);
			out.selected.otherTrack = 'resolved';
		} catch (error) {
			out.selected.otherTrack = `${error.name}: ${error.message}`;
		}
		await sender.replaceTrack(null);
		await wait(500);
		const replaced = await read(a);
		out.replaced = {
			shape: shape(replaced),
			source: of(replaced, 'outbound-rtp')[0]?.mediaSourceId,
			sender: ids(await read(sender)),
		};
		a.close();
		out.closed = shape(await read(a));
		b.close();
		for (const source of sources) source.stop();
		for (const player of players) player.srcObject = null;
		return out;
	};

	window.__mediaReady = true;
})();
