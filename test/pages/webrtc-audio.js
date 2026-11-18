// One end of a call for the webrtc-audio suite, which measures what a call
// sounds like: run natively (the browser's own stack, the oracle) and
// through the proxy (STomp's stack over wisp). The suite carries the
// signalling; window.__audio.<step>(name, ...) acts on the connection of
// that name. The sound is the browser's fake capture device playing the
// suite's test file (--use-file-for-fake-audio-capture): no real device is
// ever opened. What an end sends and what it receives are recorded sample
// for sample with the wall-clock time each block was read, so the suite can
// line the two up and say how much of the sound arrived, how late, and how
// changed.
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
	const now = () => performance.timeOrigin + performance.now();

	/**
	 * What a track carries for `ms`, one channel, with when each block was
	 * read (wall clock, ms) and where it starts in the recording
	 */
	async function record(track, ms) {
		const reader = new MediaStreamTrackProcessor({
			track,
			maxBufferSize: 500,
		}).readable.getReader();
		const blocks = [];
		const reads = [];
		let rate = 0;
		let channels = 0;
		let at = 0;
		let gaps = 0;
		let lastTs = null;
		const end = now() + ms;
		while (now() < end) {
			const result = await Promise.race([reader.read(), wait(500)]);
			if (!result) continue;
			if (result.done) break;
			const frame = result.value;
			const block = new Float32Array(frame.numberOfFrames);
			frame.copyTo(block, { planeIndex: 0, format: 'f32-planar' });
			if (rate && frame.sampleRate !== rate) rate = -1;
			else if (!rate) rate = frame.sampleRate;
			channels = Math.max(channels, frame.numberOfChannels);
			// a hole in the track's own times
			if (
				lastTs !== null &&
				Math.abs(frame.timestamp - lastTs) > 2000 + (frame.duration ?? 0)
			)
				gaps++;
			lastTs = frame.timestamp + (frame.duration ?? 0);
			frame.close();
			reads.push([at, now()]);
			blocks.push(block);
			at += block.length;
		}
		reader.cancel().catch(() => {});
		const all = new Int16Array(at);
		let to = 0;
		for (const block of blocks) {
			for (let i = 0; i < block.length; i++) {
				const value = Math.max(-1, Math.min(1, block[i]));
				all[to++] = Math.round(value * 32767);
			}
		}
		// where sample 0 was, on the wall clock: the earliest a block could
		// have been made, given when it was read
		let anchor = Infinity;
		for (const [pos, time] of reads)
			anchor = Math.min(anchor, time - (pos / Math.abs(rate || 48000)) * 1000);
		const bytes = new Uint8Array(all.buffer);
		let text = '';
		for (let i = 0; i < bytes.length; i += 0x8000)
			text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return {
			rate,
			channels,
			blocks: blocks.length,
			sizes: [...new Set(blocks.map((block) => block.length))].slice(0, 4),
			gaps,
			anchor,
			samples: btoa(text),
		};
	}

	/**
	 * End-to-end encryption as a call service does it (Discord's DAVE, in
	 * an encoded transform's worker): each frame the sender encodes is
	 * scrambled and marked, each frame the receiver gets is unscrambled
	 * and unmarked, and a frame without the mark is dropped (an empty
	 * one, which Chrome makes for silence it leaves out, passes). The worker
	 * counts what it saw, and tells the page.
	 */
	const SCRAMBLE = `
		// per operation: frames, the ones with a stream id and of the
		// audio class, their stream ids, payload types and metadata keys,
		// the empty ones and the ones of a byte or so
		const seen = {};
		const MARK = [0xfa, 0xfa];
		const flip = (bytes, from, to) => {
			for (let i = from; i < to; i++) bytes[i] ^= (i * 31 + 7) & 255;
		};
		onrtctransform = (event) => {
			const { readable, writable, options } = event.transformer;
			const send = options.operation === 'send';
			const mine = (seen[options.operation] = {
				frames: 0, dropped: 0, audio: 0, ssrcs: [], types: [], keys: [],
				times: [], empty: 0, tiny: 0,
			});
			readable.pipeThrough(new TransformStream({
				transform(frame, controller) {
					const meta = frame.getMetadata();
					mine.frames++;
					if (frame instanceof RTCEncodedAudioFrame) mine.audio++;
					const note = (list, value) => {
						if (!list.includes(value) && list.length < 4) list.push(value);
					};
					note(mine.ssrcs, meta.synchronizationSource ?? null);
					note(mine.types, meta.mimeType + '/' + meta.payloadType);
					note(mine.keys, Object.keys(meta).join());
					// (AUDIO_KEEP: each received frame's RTP time and arrival)
					if (!send && self.keepTimes && mine.times.length < 1000)
						mine.times.push([meta.rtpTimestamp, Math.round(meta.receiveTime * 10) / 10, frame.data.byteLength]);
					const bytes = new Uint8Array(frame.data);
					// silence left out, and the packets that say so (a byte, and the mark)
					if (!bytes.length) mine.empty++;
					else if (bytes.length <= 3) mine.tiny++;
					// an empty frame (silence left out) passes as it is, as DAVE's
					// does: Chrome sends nothing for it
					if (!bytes.length) {
						controller.enqueue(frame);
						return;
					}
					if (send) {
						const out = new Uint8Array(bytes.length + 2);
						out.set(bytes);
						flip(out, 0, bytes.length);
						out.set(MARK, bytes.length);
						frame.data = out.buffer;
					} else {
						const n = bytes.length;
						if (n < 3 || bytes[n - 2] !== MARK[0] || bytes[n - 1] !== MARK[1]) {
							mine.dropped++;
							return;
						}
						const out = bytes.slice(0, n - 2);
						flip(out, 0, out.length);
						frame.data = out.buffer;
					}
					controller.enqueue(frame);
				},
			})).pipeTo(writable);
		};
		onmessage = (event) => { self.keepTimes = event.data === 'keep'; };
		setInterval(() => postMessage(seen), 250);`;
	let keepTimes = false;
	const scrambler = (entry) => {
		if (!entry.worker) {
			entry.worker = new Worker(
				URL.createObjectURL(new Blob([SCRAMBLE], { type: 'text/javascript' })),
			);
			entry.worker.onmessage = (event) => (entry.seen = event.data);
			if (keepTimes) entry.worker.postMessage('keep');
		}
		return entry.worker;
	};

	function open(name, config) {
		const pc = new RTCPeerConnection(config);
		const entry = { pc, tracks: [], players: [], contexts: [], sources: [] };
		peers.set(name, entry);
		pc.addEventListener('track', (event) => {
			entry.tracks.push(event.track);

			// played, as a page does: the browser's own stack decodes a
			// track only while something plays it
			const player = new Audio();
			player.srcObject = new MediaStream([event.track]);
			player.play().catch(() => {});
			entry.players.push(player);
		});
		return entry;
	}
	const gathered = (pc) =>
		until(() => pc.iceGatheringState === 'complete', 60000, 'gathering');

	window.__audio = {
		open(name, config) {
			open(name, config);
		},
		/**
		 * The fake capture device as the connection's track: as it is
		 * (`context` null), or through an AudioContext of that sample rate
		 * (0 for the context's own) and a MediaStreamDestination, as a page
		 * that processes its microphone sends it
		 */
		async mic(
			name,
			{ constraints = true, context = null, scramble = false } = {},
		) {
			const entry = peer(name);
			// (a second track is of the same capture: another would start
			// the fake device's file anew, at another moment)
			const stream = (entry.stream ??=
				await navigator.mediaDevices.getUserMedia({
					audio: constraints,
				}));
			let [track] = stream.getAudioTracks();
			if (!entry.sources.includes(track)) entry.sources.push(track);
			const settings = track.getSettings();
			let rate = null;
			if (context !== null) {
				const audio = new AudioContext(
					context ? { sampleRate: context } : undefined,
				);
				entry.contexts.push(audio);
				await audio.resume();
				rate = audio.sampleRate;
				const from = audio.createMediaStreamSource(stream);
				const gain = audio.createGain();
				const to = audio.createMediaStreamDestination();
				from.connect(gain).connect(to);
				[track] = to.stream.getAudioTracks();
				entry.sources.push(track);
			}
			// (a second track sent beside it is not what is recorded)
			entry.sent ??= track;
			const sender = entry.pc.addTrack(track, new MediaStream([track]));
			if (scramble) {
				// both given with the transceiver, as Discord gives them:
				// Chrome hands a receiver's transform given as late as the
				// track event no frame
				sender.transform = new RTCRtpScriptTransform(scrambler(entry), {
					operation: 'send',
				});
				const { receiver } = entry.pc
					.getTransceivers()
					.find((transceiver) => transceiver.sender === sender);
				receiver.transform = new RTCRtpScriptTransform(scrambler(entry), {
					operation: 'recv',
				});
			}
			return {
				label: stream.getAudioTracks()[0].label,
				sampleRate: settings.sampleRate ?? null,
				channelCount: settings.channelCount ?? null,
				context: rate,
			};
		},
		/** a transceiver that only receives */
		receive(name) {
			peer(name).pc.addTransceiver('audio', { direction: 'recvonly' });
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
				`connection (${pc.connectionState}, ice ${pc.iceConnectionState})`,
			);
		},
		async unmuted(name, ms = 15000) {
			const entry = peer(name);
			await until(
				() => entry.tracks.length && !entry.tracks[0].muted,
				ms,
				'an unmuted track',
			);
		},
		/**
		 * `ms` of the sound: what the connection sends (`sent`), or what it
		 * receives (the `index`th track it got), read off the track
		 * (`track`) or where a page plays it: through an AudioContext
		 * (`context`, of `rate` or its own) into a MediaStreamDestination
		 */
		async record(name, what, ms, rate = 0, index = 0) {
			const entry = peer(name);
			if (what === 'sent') return record(entry.sent, ms);
			const track = entry.tracks[index];
			if (!track) throw new Error('no track received');
			if (what === 'track') return record(track, ms);
			const audio = new AudioContext(rate ? { sampleRate: rate } : undefined);
			entry.contexts.push(audio);
			await audio.resume();
			const from = audio.createMediaStreamSource(new MediaStream([track]));
			const to = audio.createMediaStreamDestination();
			from.connect(to);
			const got = await record(to.stream.getAudioTracks()[0], ms);
			got.context = audio.sampleRate;
			return got;
		},
		/** the reports that say how the sound went, as the page reads them */
		async stats(name) {
			const stats = await peer(name).pc.getStats();
			const out = {};
			for (const report of stats.values())
				if (
					[
						'inbound-rtp',
						'outbound-rtp',
						'remote-inbound-rtp',
						'media-source',
						'codec',
						'media-playout',
					].includes(report.type) ||
					(report.type === 'candidate-pair' && report.nominated)
				)
					(out[report.type] ??= []).push(report);
			return out;
		},
		keep() {
			keepTimes = true;
		},
		/** what the encryption worker saw */
		seen: (name) => peer(name).seen ?? null,
		close(name) {
			const entry = peers.get(name);
			if (!entry) return;
			entry.pc.close();
			for (const track of entry.sources) track.stop();
			for (const player of entry.players) player.srcObject = null;
			for (const audio of entry.contexts) audio.close().catch(() => {});
			entry.worker?.terminate();
			peers.delete(name);
		},
	};
	window.__audioReady = true;
})();
