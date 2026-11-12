// One end of a real WebRTC connection with pictures on it, for the
// webrtc-video suite, run natively (the browser's own stack: the far end,
// and the oracle for everything a page can read) and through the proxy
// (STomp's stack over wisp). The suite carries the signalling between ends:
// window.__video.<step>(name, ...) acts on the connection of that name and
// resolves with what the page could read. The only pictures are canvases
// the page draws itself: no camera is ever opened.
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

	// --- pictures ---

	/**
	 * A canvas as a track: its left half one colour and its right half
	 * another, with a small square moving across the middle so that every
	 * picture differs from the last
	 */
	function picture({ width, height, left, right, fps, noise }) {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		let count = 0;
		const grain = context.createImageData(width, height);
		const source = { noise: !!noise };
		const draw = () => {
			// noise: as many bits as an encoder is given
			if (source.noise) {
				for (let i = 0; i < grain.data.length; i += 4) {
					const value = Math.random() * 255;
					grain.data[i] = grain.data[i + 1] = grain.data[i + 2] = value;
					grain.data[i + 3] = 255;
				}
				context.putImageData(grain, 0, 0);
				return;
			}
			context.fillStyle = `rgb(${left})`;
			context.fillRect(0, 0, width >> 1, height);
			context.fillStyle = `rgb(${right})`;
			context.fillRect(width >> 1, 0, width - (width >> 1), height);
			context.fillStyle = 'rgb(128,128,128)';
			const size = height >> 3;
			context.fillRect(
				(count++ * 4) % (width - size),
				(height - size) >> 1,
				size,
				size,
			);
		};
		draw();
		const [track] = canvas.captureStream(fps).getVideoTracks();
		source.track = track;
		source.timer = setInterval(draw, 1000 / fps);
		return source;
	}
	/** a picture's mean colour over a rectangle, from a frame of the track */
	function colours(frame) {
		const width = frame.displayWidth;
		const height = frame.displayHeight;
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d', { willReadFrequently: true });
		context.drawImage(frame, 0, 0);
		const mean = (x, w) => {
			// the top quarter: away from the moving square
			const { data } = context.getImageData(x, 0, w, height >> 2);
			const sum = [0, 0, 0];
			for (let i = 0; i < data.length; i += 4)
				for (let c = 0; c < 3; c++) sum[c] += data[i + c];
			return sum.map((value) => Math.round(value / (data.length / 4)));
		};
		const quarter = width >> 2;
		return {
			left: mean(quarter >> 1, quarter),
			right: mean((width >> 1) + (quarter >> 1), quarter),
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
			// what its source is called, and what it says it can do
			source: [
				track.getSettings().deviceId === track.id,
				JSON.stringify(track.getCapabilities()).replaceAll(track.id, 'ID'),
			],
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
	});

	/** a transform worker: drops the sender's first keyframe, or asks the receiver's peer for one */
	const TRANSFORM = `
		let dropFirst = false;
		let transformer = null;
		const seen = { frames: 0, keys: 0, dropped: 0 };
		onmessage = async ({ data }) => {
			if (data === 'ask') {
				try {
					await transformer.sendKeyFrameRequest();
					postMessage('asked');
				} catch (error) {
					postMessage(error.name);
				}
			} else if (data === 'seen') postMessage(seen);
		};
		addEventListener('rtctransform', (event) => {
			transformer = event.transformer;
			dropFirst = !!transformer.options.dropFirst;
			transformer.readable
				.pipeThrough(
					new TransformStream({
						transform(frame, controller) {
							seen.frames++;
							if (frame.type === 'key') {
								seen.keys++;
								if (dropFirst) {
									dropFirst = false;
									seen.dropped++;
									return;
								}
							}
							controller.enqueue(frame);
						},
					}),
				)
				.pipeTo(transformer.writable);
		});`;
	const transform = (entry, options) => {
		const worker = new Worker(
			URL.createObjectURL(new Blob([TRANSFORM], { type: 'text/javascript' })),
		);
		// kept: a worker nobody holds is collected with its handler
		entry.workers.push(worker);
		return { worker, transform: new RTCRtpScriptTransform(worker, options) };
	};
	const ask = (worker, message) =>
		new Promise((resolve) => {
			worker.onmessage = ({ data }) => resolve(data);
			worker.postMessage(message);
		});

	function open(name, config) {
		const pc = new RTCPeerConnection(config);
		const entry = {
			pc,
			log: [],
			candidates: [],
			sources: [],
			players: new Map(),
			workers: [],
			receiveTransforms: new Map(),
			sendTransforms: new Map(),
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
			// the browser's own stack decodes a track while something
			// plays it, so each one is played, as a page does
			const player = document.createElement('video');
			player.muted = true;
			player.srcObject = new MediaStream([track]);
			player.play().catch(() => {});
			entry.players.set(track, player);
			const at = pc.getTransceivers().indexOf(transceiver);
			note(
				`track:${at}:${track.kind}:${track.label}:muted=${track.muted}:streams=${streams.length}:${[
					receiver === transceiver.receiver,
					track === receiver.track,
					transceiver.currentDirection,
					pc.signalingState,
				]}`,
			);
			for (const type of ['mute', 'unmute', 'ended'])
				track.addEventListener(type, () =>
					note(`${type}:${pc.getTransceivers().indexOf(transceiver)}`),
				);
		});
		return entry;
	}
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

	window.__video = {
		open(name, config) {
			open(name, config);
		},
		/**
		 * A canvas the connection sends, added with addTrack in a stream;
		 * with `dropFirst` (natively only) its sender lets its first
		 * keyframe go, so the peer's receiver has to ask for another
		 */
		canvas(name, options) {
			const entry = peer(name);
			const source = picture(options);
			entry.sources.push(source);
			const sender = entry.pc.addTrack(source.track, new MediaStream());
			if (options.dropFirst) {
				const made = transform(entry, { dropFirst: true });
				sender.transform = made.transform;
				entry.sendTransforms.set(sender, made.worker);
			}
			return { track: source.track.id, settings: source.track.getSettings() };
		},
		/**
		 * Whether this browser sends and receives `mime` with its own
		 * stack, and a page's WebCodecs encodes and decodes it (H.264 may
		 * be missing from a Chrome build)
		 */
		async capable(name, mime, codec) {
			const has = (list) =>
				list.codecs.some((entry) => entry.mimeType === mime);
			const config = {
				codec,
				width: 320,
				height: 180,
				bitrate: 300000,
				latencyMode: 'realtime',
				...(codec.startsWith('avc1.') ? { avc: { format: 'annexb' } } : {}),
			};
			return (
				has(RTCRtpSender.getCapabilities('video')) &&
				has(RTCRtpReceiver.getCapabilities('video')) &&
				!!(await VideoEncoder.isConfigSupported(config)).supported &&
				!!(await VideoDecoder.isConfigSupported({ codec })).supported
			);
		},
		/** the codecs a transceiver lists first (the browser's own, `mime` first) */
		prefer(name, at, mime) {
			const { codecs } = RTCRtpReceiver.getCapabilities('video');
			transceiver(name, at).setCodecPreferences([
				...codecs.filter((codec) => codec.mimeType === mime),
				...codecs.filter((codec) => codec.mimeType !== mime),
			]);
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
		 * setRemoteDescription. Natively only: with `listen`, the receiver
		 * of that transceiver goes through a transform from then on, which
		 * can ask its peer for a keyframe; with `answer`, a canvas is added
		 * (window.__video.canvas) and the codec `prefer` listed first,
		 * all in the same task: a transform given later is never handed a
		 * frame (Chrome 152 and 156)
		 */
		async remote(name, type, sdp, { listen, answer, prefer } = {}) {
			const entry = peer(name);
			await entry.pc.setRemoteDescription({ type, sdp });
			if (listen !== undefined) {
				const { receiver } = transceiver(name, listen);
				const made = transform(entry, {});
				receiver.transform = made.transform;
				entry.receiveTransforms.set(listen, made.worker);
			}
			if (answer) window.__video.canvas(name, answer);
			if (prefer) window.__video.prefer(name, 0, prefer);
		},
		async connected(name, ms = 30000) {
			const { pc } = peer(name);
			await until(
				() => pc.connectionState === 'connected',
				ms,
				`connection (${pc.connectionState}, ice ${pc.iceConnectionState})`,
			);
		},
		view: (name) => view(peer(name).pc),
		log: (name) => peer(name).log.splice(0),
		async muted(name, at, muted, ms = 15000) {
			const track = transceiver(name, at).receiver.track;
			await until(() => track.muted === muted, ms, `muted=${muted}`);
		},
		/**
		 * What the receiver of transceiver `at` gives for `ms`: how many
		 * pictures, their sizes, and the colours of the last one
		 */
		async see(name, at, ms = 2000) {
			const track = transceiver(name, at).receiver.track;
			const reader = new MediaStreamTrackProcessor({
				track,
			}).readable.getReader();
			const sizes = new Set();
			let frames = 0;
			let last = null;
			const end = performance.now() + ms;
			while (performance.now() < end) {
				const result = await Promise.race([reader.read(), wait(500)]);
				if (!result) continue;
				if (result.done) break;
				const frame = result.value;
				frames++;
				sizes.add(`${frame.displayWidth}x${frame.displayHeight}`);
				if (performance.now() > end - 600 || !last) {
					last = {
						format: frame.format,
						space: JSON.stringify(frame.colorSpace),
						...colours(frame),
					};
				}
				frame.close();
			}
			reader.cancel().catch(() => {});
			return { frames, sizes: [...sizes], last };
		},
		/** how far the element playing transceiver `at`'s track gets in `ms`, and its size */
		async plays(name, at, ms = 1000) {
			const video = peer(name).players.get(
				transceiver(name, at).receiver.track,
			);
			const before = video.currentTime;
			await wait(ms);
			return {
				seconds: +(video.currentTime - before).toFixed(1),
				width: video.videoWidth,
				height: video.videoHeight,
			};
		},
		/** what the sender's transforms saw: frames, keyframes, keyframes let go (natively only) */
		async transformed(name) {
			const out = [];
			for (const worker of peer(name).sendTransforms.values())
				out.push(await ask(worker, 'seen'));
			return out;
		},
		/** the canvas `at` draws noise, or its colours */
		noise(name, at, on) {
			peer(name).sources[at].noise = on;
		},
		/**
		 * setParameters on the sender of transceiver `at` with `changes` to
		 * its encoding (a member given as null is taken out): what
		 * getParameters lists then, or the refusal
		 */
		async encode(name, at, changes) {
			const { sender } = transceiver(name, at);
			try {
				const parameters = sender.getParameters();
				const [encoding] = parameters.encodings;
				for (const [key, value] of Object.entries(changes))
					if (value === null) delete encoding[key];
					else encoding[key] = value;
				await sender.setParameters(parameters);
				return JSON.stringify(sender.getParameters().encodings);
			} catch (error) {
				return [error.name, error.message];
			}
		},
		/** what a sender's encodings read as made each way, on a connection of its own */
		made() {
			const pc = new RTCPeerConnection();
			const canvas = document.createElement('canvas');
			canvas.getContext('2d');
			const [track] = canvas.captureStream().getVideoTracks();
			const read = (sender) => JSON.stringify(sender.getParameters().encodings);
			const attempt = (run) => {
				try {
					return read(run().sender);
				} catch (error) {
					return [error.name, error.message];
				}
			};
			const out = {
				addTrack: read(pc.addTrack(track)),
				kind: attempt(() => pc.addTransceiver('video')),
				track: attempt(() => pc.addTransceiver(track.clone())),
				given: attempt(() =>
					pc.addTransceiver('video', {
						sendEncodings: [
							{
								active: false,
								maxBitrate: 5e5,
								maxFramerate: 12,
								scaleResolutionDownBy: 4,
							},
						],
					}),
				),
				tiny: attempt(() =>
					pc.addTransceiver('video', {
						sendEncodings: [{ scaleResolutionDownBy: 0.5 }],
					}),
				),
				sound: attempt(() =>
					pc.addTransceiver('audio', {
						sendEncodings: [{ scaleResolutionDownBy: 2, maxFramerate: 3 }],
					}),
				),
			};
			pc.close();
			track.stop();
			return out;
		},
		/**
		 * What the receiver of transceiver `at` gets in `ms` (natively only:
		 * the far end's view of the page): bits and pictures a second, and
		 * the picture's size
		 */
		async rate(name, at, ms = 2000) {
			const { receiver } = transceiver(name, at);
			const read = async () => {
				for (const report of (await receiver.getStats()).values())
					if (report.type === 'inbound-rtp') return report;
				return null;
			};
			const before = await read();
			await wait(ms);
			const after = await read();
			if (!before || !after) return null;
			return {
				kbps: Math.round(
					((after.bytesReceived - before.bytesReceived) * 8) / ms,
				),
				fps: +(
					((after.framesDecoded - before.framesDecoded) * 1000) /
					ms
				).toFixed(1),
				width: after.frameWidth,
				height: after.frameHeight,
			};
		},
		/** the receiver of transceiver `at` asks its peer for a keyframe (natively only) */
		async askKeyframe(name, at) {
			return ask(peer(name).receiveTransforms.get(at), 'ask');
		},
		/**
		 * What the browser's own stack counts of each RTP stream (natively
		 * only: the far end's view of the page)
		 */
		async counts(name) {
			const stats = await peer(name).pc.getStats();
			const out = {};
			for (const report of stats.values()) {
				if (report.type === 'inbound-rtp' && report.kind === 'video')
					out.inbound = {
						codec: stats.get(report.codecId)?.mimeType ?? null,
						width: report.frameWidth,
						height: report.frameHeight,
						decoded: report.framesDecoded,
						keyframes: report.keyFramesDecoded,
						pli: report.pliCount,
						fir: report.firCount,
						packets: report.packetsReceived,
					};
				if (report.type === 'outbound-rtp' && report.kind === 'video')
					out.outbound = {
						codec: stats.get(report.codecId)?.mimeType ?? null,
						width: report.frameWidth,
						height: report.frameHeight,
						encoded: report.framesEncoded,
						keyframes: report.keyFramesEncoded,
						pli: report.pliCount,
						fir: report.firCount,
					};
			}
			return out;
		},
		/** where the browser's own stack sees its peer */
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
		/** everything the page read of its own end's addresses */
		own(name) {
			const { pc, candidates } = peer(name);
			return {
				candidates,
				local: pc.localDescription && pc.localDescription.sdp,
				current: pc.currentLocalDescription && pc.currentLocalDescription.sdp,
			};
		},
		/**
		 * A canvas the connection sends in simulcast layers: addTransceiver
		 * with `encodings` as its sendEncodings
		 */
		layered(name, options, encodings) {
			const entry = peer(name);
			const source = picture(options);
			entry.sources.push(source);
			entry.pc.addTransceiver(source.track, {
				streams: [new MediaStream()],
				sendEncodings: encodings,
			});
		},
		/**
		 * Natively only: a peer that takes each layer of a simulcast offer
		 * in a section of its own. Chrome receives no simulcast, so the
		 * layers of the offer's first video section become sections named
		 * by their rids, with the rid's header extension read as the MID's
		 * (and the MID's as the rid's): each layer's packets then name their
		 * section. `remote` gives it such an offer, `layersAnswer` turns its
		 * answer back into one section that receives the layers.
		 */
		async layersRemote(name, sdp) {
			const entry = peer(name);
			const lines = sdp.split('\r\n');
			const at = lines.findIndex((line) => line.startsWith('m=video'));
			const next = lines.findIndex(
				(line, i) => i > at && line.startsWith('m='),
			);
			const section = lines.slice(at, next === -1 ? undefined : next);
			const rids = section
				.filter((line) => line.startsWith('a=rid:'))
				.map((line) => line.slice(6).split(' ')[0]);
			const id = (uri) =>
				section
					.find(
						(line) => line.startsWith('a=extmap:') && line.endsWith(` ${uri}`),
					)
					?.slice(9)
					.split(' ')[0];
			const RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
			const MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
			const swap = { rid: id(RID), mid: id(MID) };
			const swapped = (line) =>
				line === `a=extmap:${swap.rid} ${RID}`
					? `a=extmap:${swap.rid} ${MID}`
					: line === `a=extmap:${swap.mid} ${MID}`
						? `a=extmap:${swap.mid} ${RID}`
						: line;
			const mid = section.find((line) => line.startsWith('a=mid:')).slice(6);
			entry.layers = { rids, swap, mid, RID, MID };
			const head = lines
				.slice(
					0,
					lines.findIndex((line) => line.startsWith('m=')),
				)
				.map((line) =>
					line.startsWith('a=group:BUNDLE')
						? `a=group:BUNDLE ${rids.join(' ')}`
						: line,
				);
			const body = section
				.filter(
					(line) => line && !/^a=(rid|simulcast|mid|ssrc|msid)/.test(line),
				)
				.map(swapped);
			const offer = [
				...head,
				...rids.flatMap((rid) => [...body, `a=mid:${rid}`]),
				'',
			].join('\r\n');
			await entry.pc.setRemoteDescription({ type: 'offer', sdp: offer });
			for (const transceiver of entry.pc.getTransceivers())
				transceiver.direction = 'recvonly';
			return rids;
		},
		async layersAnswer(name) {
			const entry = peer(name);
			const { pc } = entry;
			await pc.setLocalDescription(await pc.createAnswer());
			described(entry);
			await gathered(entry);
			const { rids, swap, mid, RID, MID } = entry.layers;
			const lines = pc.localDescription.sdp.split('\r\n');
			const at = lines.findIndex((line) => line.startsWith('m=video'));
			const next = lines.findIndex(
				(line, i) => i > at && line.startsWith('m='),
			);
			const back = (line) =>
				line === `a=extmap:${swap.rid} ${MID}`
					? `a=extmap:${swap.rid} ${RID}`
					: line === `a=extmap:${swap.mid} ${RID}`
						? `a=extmap:${swap.mid} ${MID}`
						: line;
			const head = lines
				.slice(0, at)
				.map((line) =>
					line.startsWith('a=group:BUNDLE') ? `a=group:BUNDLE ${mid}` : line,
				);
			const section = lines
				.slice(at, next === -1 ? undefined : next)
				.filter((line) => line && !line.startsWith('a=mid:'))
				.map(back);
			return [
				...head,
				...section,
				`a=mid:${mid}`,
				...rids.map((rid) => `a=rid:${rid} recv`),
				`a=simulcast:recv ${rids.join(';')}`,
				'',
			].join('\r\n');
		},
		/**
		 * Natively only: what each section of a layered receiver decodes in
		 * `ms`, by rid: pictures a second and their size
		 */
		async layers(name, ms = 1500) {
			const { pc, layers } = peer(name);
			const read = async () => {
				const out = {};
				for (const [at, transceiver] of pc.getTransceivers().entries())
					for (const report of (await transceiver.receiver.getStats()).values())
						if (report.type === 'inbound-rtp') out[layers.rids[at]] = report;
				return out;
			};
			const before = await read();
			await wait(ms);
			const after = await read();
			const out = {};
			for (const rid of layers.rids) {
				const a = before[rid];
				const b = after[rid];
				out[rid] = b
					? {
							fps: Math.round(
								((b.framesDecoded - (a?.framesDecoded ?? 0)) * 1000) / ms,
							),
							size: `${b.frameWidth ?? 0}x${b.frameHeight ?? 0}`,
						}
					: { fps: 0, size: 'none' };
			}
			return out;
		},
		/** setParameters on the sender of transceiver `at` with `changes` to each encoding, by index */
		async encodeLayers(name, at, changes) {
			const { sender } = transceiver(name, at);
			try {
				const parameters = sender.getParameters();
				for (const [index, change] of Object.entries(changes))
					Object.assign(parameters.encodings[index], change);
				await sender.setParameters(parameters);
				return JSON.stringify(sender.getParameters().encodings);
			} catch (error) {
				return [error.name, error.message];
			}
		},
		/** the `a=simulcast` line of the offer the connection would make now */
		async simulcastLine(name) {
			const { sdp } = await peer(name).pc.createOffer();
			return sdp.split('\r\n').find((line) => line.startsWith('a=simulcast:'));
		},
		/** a simulcast sender's encodings as made each way and as set, and what is refused */
		async layerShapes() {
			const pc = new RTCPeerConnection();
			const read = (sender) => JSON.stringify(sender.getParameters().encodings);
			const attempt = async (run) => {
				try {
					return await run();
				} catch (error) {
					return [error.name, error.message];
				}
			};
			const made = (sendEncodings, kind = 'video') =>
				attempt(() => read(pc.addTransceiver(kind, { sendEncodings }).sender));
			const out = {
				plain: await made([{ rid: 'a' }, { rid: 'b' }, { rid: 'c' }]),
				scaled: await made([
					{ rid: 'q', scaleResolutionDownBy: 4 },
					{ rid: 'h', scaleResolutionDownBy: 2 },
					{ rid: 'f' },
				]),
				two: await made([{ rid: 'lo' }, { rid: 'hi' }]),
				four: await made([
					{ rid: 'a' },
					{ rid: 'b' },
					{ rid: 'c' },
					{ rid: 'd' },
				]),
				twice: await made([{ rid: 'a' }, { rid: 'a' }]),
				missing: await made([{ rid: 'a' }, {}]),
				empty: await made([{ rid: '' }, { rid: 'c' }]),
				alone: await made([{ rid: 'a' }]),
				space: await made([{ rid: 'a b' }, { rid: 'c' }]),
				dash: await made([{ rid: 'a-b' }, { rid: 'c_d' }]),
				long: await made([{ rid: 'x'.repeat(17) }, { rid: 'c' }]),
				sixteen: await made([{ rid: 'x'.repeat(16) }, { rid: 'c' }]),
				small: await made([
					{ rid: 'a', scaleResolutionDownBy: 0.5 },
					{ rid: 'b' },
				]),
				sound: await made([{ rid: 'a' }, { rid: 'b' }], 'audio'),
			};
			const { sender } = pc.addTransceiver('video', {
				sendEncodings: [
					{ rid: 'q', scaleResolutionDownBy: 4 },
					{ rid: 'h', scaleResolutionDownBy: 2 },
					{ rid: 'f' },
				],
			});
			const set = (change) =>
				attempt(async () => {
					const parameters = sender.getParameters();
					change(parameters);
					await sender.setParameters(parameters);
					return read(sender);
				});
			out.middleOff = await set((p) => {
				p.encodings[1].active = false;
			});
			out.renamed = await set((p) => {
				p.encodings[0].rid = 'z';
			});
			out.dropped = await set((p) => {
				p.encodings.pop();
			});
			out.reversed = await set((p) => {
				p.encodings.reverse();
			});
			out.bitrates = await set((p) => {
				p.encodings[0].maxBitrate = 100000;
				p.encodings[2].maxBitrate = 900000;
			});
			out.badScale = await set((p) => {
				p.encodings[2].scaleResolutionDownBy = 0.5;
			});
			pc.close();
			return out;
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
			for (const worker of entry.workers) worker.terminate();
			entry.pc.close();
			return view(entry.pc);
		},
	};
	window.__videoReady = true;
})();
