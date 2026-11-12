// One end of a real WebRTC connection for the webrtc-peer suite, run
// natively (the browser's own stack, as the far end) and through the proxy
// (STomp's stack over wisp). The suite carries the signalling between the
// ends: window.__peer.<step>(name, ...) acts on the connection of that name
// and resolves with what the page could read.
(() => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const peers = new Map();
	const peer = (name) => {
		const found = peers.get(name);
		if (!found) throw new Error(`no connection ${name}`);
		return found;
	};
	// a message as the suite compares it: text whole, bytes by size and sum
	const sum = (bytes) => {
		let hash = 0x811c9dc5;
		for (let i = 0; i < bytes.length; i++)
			hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
		return hash;
	};
	const pattern = (size, seed) => {
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 255;
		return bytes;
	};
	async function view(data) {
		if (typeof data === 'string') return { text: data };
		const kind = data instanceof Blob ? 'Blob' : data.constructor.name;
		const bytes = new Uint8Array(
			data instanceof Blob ? await data.arrayBuffer() : data,
		);
		return { kind, size: bytes.length, sum: sum(bytes) };
	}
	function track(entry, channel) {
		const state = { channel, messages: [], events: [], pending: [] };
		entry.channels.set(channel.label, state);
		for (const type of [
			'open',
			'closing',
			'close',
			'error',
			'bufferedamountlow',
		])
			channel.addEventListener(type, (event) => {
				state.events.push(type);
				// what an error event says, and the channel's state as it says it
				if (type === 'error')
					state.error = {
						event: event.constructor.name,
						state: channel.readyState,
						error: event.error && {
							class: event.error.constructor.name,
							name: event.error.name,
							message: event.error.message,
							errorDetail: event.error.errorDetail,
							sctpCauseCode: event.error.sctpCauseCode,
						},
					};
			});
		channel.addEventListener('message', (event) => {
			// in arrival order, whatever a Blob takes to read
			const slot = { done: false };
			state.pending.push(slot);
			view(event.data).then((message) => {
				slot.message = message;
				slot.done = true;
				while (state.pending[0]?.done)
					state.messages.push(state.pending.shift().message);
			});
		});
		return state;
	}
	const channelOf = (name, label) => {
		const state = peer(name).channels.get(label);
		if (!state) throw new Error(`no channel ${label} on ${name}`);
		return state;
	};
	async function until(test, ms, what) {
		const end = Date.now() + ms;
		while (!test()) {
			if (Date.now() > end) throw new Error(`timed out: ${what}`);
			await wait(25);
		}
	}
	// A description just set gathers from the next task on, so "complete"
	// may still be the last description's: it counts once gathering has
	// begun again since, or has had the time to and did not (a description
	// that changes nothing gathers nothing)
	const described = (entry) => {
		entry.describedAt = Date.now();
		entry.gatheringsThen = entry.gatherings;
	};
	const complete = (entry) =>
		entry.pc.iceGatheringState === 'complete' &&
		(entry.gatherings > entry.gatheringsThen ||
			Date.now() - entry.describedAt > 1000);
	const gathered = (entry) => until(() => complete(entry), 60000, 'gathering');

	window.__peer = {
		sum: (size, seed) => sum(pattern(size, seed)),
		open(name, config) {
			const pc = new RTCPeerConnection(config);
			const entry = {
				pc,
				log: [],
				candidates: [],
				channels: new Map(),
				gatherings: 0,
				gatheringsThen: 0,
				describedAt: 0,
			};
			peers.set(name, entry);
			pc.addEventListener('iceconnectionstatechange', () =>
				entry.log.push(`ice:${pc.iceConnectionState}`),
			);
			pc.addEventListener('connectionstatechange', () =>
				entry.log.push(`connection:${pc.connectionState}`),
			);
			pc.addEventListener('icegatheringstatechange', () => {
				entry.log.push(`gathering:${pc.iceGatheringState}`);
				if (pc.iceGatheringState === 'gathering') entry.gatherings++;
			});
			pc.addEventListener('signalingstatechange', () =>
				entry.log.push(`signaling:${pc.signalingState}`),
			);
			pc.addEventListener('negotiationneeded', () =>
				entry.log.push('negotiationneeded'),
			);
			pc.addEventListener('icecandidate', (event) => {
				if (event.candidate) entry.candidates.push(event.candidate.toJSON());
			});
			pc.addEventListener('icecandidateerror', (event) =>
				entry.log.push(`error:${event.errorCode}`),
			);
			pc.addEventListener('datachannel', (event) =>
				track(entry, event.channel),
			);
		},
		/** channels: [[label, options]] */
		channels(name, channels) {
			const entry = peer(name);
			for (const [label, options] of channels)
				track(entry, entry.pc.createDataChannel(label, options));
		},
		/** an offer as createOffer writes it, not set */
		async draft(name) {
			return (await peer(name).pc.createOffer()).sdp;
		},
		async offer(name, { trickle = false, iceRestart = false } = {}) {
			const entry = peer(name);
			const { pc } = entry;
			await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
			described(entry);
			if (!trickle) await gathered(entry);
			return pc.localDescription.sdp;
		},
		/** an offer set and rolled back: the state it leaves */
		async rolledBack(name) {
			const { pc } = peer(name);
			await pc.setLocalDescription(await pc.createOffer());
			await pc.setLocalDescription({ type: 'rollback' });
			return pc.signalingState;
		},
		async answer(name, sdp, { trickle = false } = {}) {
			const entry = peer(name);
			const { pc } = entry;
			await pc.setRemoteDescription({ type: 'offer', sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			described(entry);
			if (!trickle) await gathered(entry);
			return pc.localDescription.sdp;
		},
		async accept(name, sdp) {
			await peer(name).pc.setRemoteDescription({ type: 'answer', sdp });
		},
		/** the candidates gathered since the last call, and whether that is all */
		candidates(name) {
			const entry = peer(name);
			return {
				candidates: entry.candidates.splice(0),
				complete: complete(entry),
			};
		},
		async add(name, candidate) {
			await peer(name).pc.addIceCandidate(candidate);
		},
		async opened(name, label, ms = 30000) {
			await until(
				() => peer(name).channels.get(label)?.channel.readyState === 'open',
				ms,
				`${label} open on ${name}`,
			);
			const { channel } = channelOf(name, label);
			return {
				label: channel.label,
				ordered: channel.ordered,
				maxRetransmits: channel.maxRetransmits,
				maxPacketLifeTime: channel.maxPacketLifeTime,
				protocol: channel.protocol,
				negotiated: channel.negotiated,
				id: channel.id,
				binaryType: channel.binaryType,
			};
		},
		binaryType(name, label, type) {
			channelOf(name, label).channel.binaryType = type;
		},
		/** what: { text } | { bytes: size, seed, as: 'ArrayBuffer' | 'view' | 'Blob' } */
		send(name, label, what) {
			const { channel } = channelOf(name, label);
			try {
				if ('text' in what) channel.send(what.text);
				else {
					const bytes = pattern(what.bytes, what.seed ?? 0);
					if (what.as === 'Blob') channel.send(new Blob([bytes]));
					else if (what.as === 'view') channel.send(bytes);
					else channel.send(bytes.buffer);
				}
				return null;
			} catch (error) {
				return `${error.name}: ${error.message}`;
			}
		},
		/** the first `count` messages the channel got, once it has that many */
		async received(name, label, count, ms = 30000) {
			const state = channelOf(name, label);
			await until(
				() => state.messages.length >= count,
				ms,
				`${count} messages on ${label} of ${name} (${state.messages.length})`,
			).catch((error) => {
				state.messages.push({ error: error.message });
			});
			return state.messages.slice(0, count);
		},
		/**
		 * `count` messages of `size` bytes in one task: the most the channel
		 * said it had buffered, and whether it told when that drained to
		 * `threshold`
		 */
		async burst(name, label, count, size, threshold) {
			const state = channelOf(name, label);
			const { channel } = state;
			channel.bufferedAmountLowThreshold = threshold;
			const before = state.events.filter(
				(e) => e === 'bufferedamountlow',
			).length;
			const bytes = pattern(size, 7);
			const amounts = [channel.bufferedAmount];
			for (let i = 0; i < count; i++) {
				channel.send(bytes);
				amounts.push(channel.bufferedAmount);
			}
			let low = true;
			await until(
				() =>
					state.events.filter((e) => e === 'bufferedamountlow').length > before,
				30000,
				'bufferedamountlow',
			).catch(() => {
				low = false;
			});
			const atLow = channel.bufferedAmount;
			await until(() => channel.bufferedAmount === 0, 30000, 'drained').catch(
				() => {},
			);
			return {
				first: amounts[0],
				afterOne: amounts[1],
				most: Math.max(...amounts),
				low,
				atLow,
				end: channel.bufferedAmount,
				threshold: channel.bufferedAmountLowThreshold,
			};
		},
		/**
		 * An empty string and an empty binary message: what the channel says
		 * it has buffered after them, at once and a little later, and how
		 * often it said that was low
		 */
		async empties(name, label) {
			const state = channelOf(name, label);
			const { channel } = state;
			const lows = () =>
				state.events.filter((e) => e === 'bufferedamountlow').length;
			const before = lows();
			channel.send('');
			channel.send(new ArrayBuffer(0));
			const amounts = [channel.bufferedAmount];
			for (const ms of [5, 50]) {
				await wait(ms);
				amounts.push(channel.bufferedAmount);
			}
			return [...amounts, lows() - before];
		},
		closeChannel(name, label) {
			channelOf(name, label).channel.close();
		},
		async channelState(name, label, state, ms = 30000) {
			const found = channelOf(name, label);
			await until(
				() => found.channel.readyState === state,
				ms,
				`${label} ${state} on ${name}`,
			).catch(() => {});
			return {
				state: found.channel.readyState,
				events: found.events,
				error: found.error ?? null,
			};
		},
		async state(name, state, ms = 30000) {
			const { pc } = peer(name);
			await until(() => pc.connectionState === state, ms, state).catch(
				() => {},
			);
			return pc.connectionState;
		},
		restart(name) {
			peer(name).pc.restartIce();
		},
		async read(name) {
			const { pc, log, channels } = peer(name);
			const stats = [];
			(await pc.getStats()).forEach((entry) => stats.push(entry));
			const selected = stats.find(
				(entry) => entry.type === 'transport',
			)?.selectedCandidatePairId;
			const pair = stats.find(
				(entry) => entry.type === 'candidate-pair' && entry.id === selected,
			);
			const end = (id) => {
				const found = stats.find((entry) => entry.id === id);
				return (
					found && {
						address: found.address,
						port: found.port,
						type: found.candidateType,
						protocol: found.protocol,
					}
				);
			};
			return {
				log,
				signaling: pc.signalingState,
				ice: pc.iceConnectionState,
				connection: pc.connectionState,
				gathering: pc.iceGatheringState,
				local: pc.localDescription?.sdp ?? null,
				remote: pc.remoteDescription?.sdp ?? null,
				currentLocal: pc.currentLocalDescription?.sdp ?? null,
				pair: pair && {
					local: end(pair.localCandidateId),
					remote: end(pair.remoteCandidateId),
				},
				channels: [...channels.keys()],
				sctp: pc.sctp && {
					state: pc.sctp.state,
					maxMessageSize: pc.sctp.maxMessageSize,
				},
			};
		},
		close(name) {
			peer(name).pc.close();
		},
	};
	window.__peerReady = true;
})();
