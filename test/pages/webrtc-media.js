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
		const source = { track: generator, level: 0.5 };
		source.timer = setInterval(() => {
			const target = Math.floor((performance.now() - started) / 10);
			while (frames < target) {
				const data = new Float32Array(size);
				for (let i = 0; i < size; i++)
					data[i] =
						source.level *
						Math.sin((2 * Math.PI * hz * (frames * size + i)) / rate);
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
		};
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
		tone(name, hz, { streams = 1, direction } = {}) {
			const entry = peer(name);
			const source = tone(hz);
			entry.sources.push(source);
			const made = [];
			for (let i = 0; i < streams; i++) made.push(new MediaStream());
			if (direction)
				entry.pc.addTransceiver(source.track, { direction, streams: made });
			else entry.pc.addTrack(source.track, ...made);
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
		async remote(name, type, sdp) {
			await peer(name).pc.setRemoteDescription({ type, sdp });
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
		stop(name, at) {
			transceiver(name, at).stop();
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
			};
			other.close();
			clearInterval(source.timer);
			return out;
		},
	};
	window.__mediaReady = true;
})();
