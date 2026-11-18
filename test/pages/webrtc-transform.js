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
	window.__transformReady = true;
})();
