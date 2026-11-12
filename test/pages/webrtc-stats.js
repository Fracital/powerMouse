// getStats() of a connection with data channels, at each stage of its life:
// what kinds of entries there are, the members of each, and the values that
// are the same on every run. The suite compares a proxied page's with the
// same page's loaded natively.
/** `at` tells how far it got: its stage, its connections and channels */
const rtcStats = async (env, at) => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const out = {};
	const read = async (pc) => {
		const entries = [];
		(await pc.getStats()).forEach((value, key) => entries.push([key, value]));
		return entries;
	};
	/** the candidates `pc` signalled, as its report names them */
	const signalled = new WeakMap();
	const heard = (pc, candidate) => {
		if (!signalled.has(pc)) signalled.set(pc, new Set());
		signalled
			.get(pc)
			.add(`${candidate.protocol}:${candidate.foundation}:${candidate.port}`);
	};
	/**
	 * The members each kind of entry has, and the kinds in the report's
	 * order. A local candidate `pc` never signalled is left out: the
	 * browser's report lists every socket it opened, also ones it never
	 * signals behind mDNS names (the IPv6 "any" address, TCP active ones at
	 * port 9), and which those are depends on the machine's interfaces.
	 * The report is in the order of the ids, and a candidate's is random,
	 * so local and remote candidates are one kind in the order.
	 */
	const shape = (entries, pc) => {
		const kinds = {};
		const order = [];
		for (const [, entry] of entries) {
			let kind = entry.type;
			if (entry.candidateType) kind += `:${entry.candidateType}`;
			// a peer reflexive candidate is there or not as the first check
			// and the first candidate race
			if (entry.candidateType === 'prflx') continue;
			if (entry.type === 'candidate-pair' && !entry.nominated) continue;
			if (
				entry.type === 'local-candidate' &&
				!signalled
					.get(pc)
					?.has(`${entry.protocol}:${entry.foundation}:${entry.port}`)
			)
				continue;
			const ordered = /candidate$/.test(entry.type) ? 'candidate' : entry.type;
			if (order.at(-1) !== ordered) order.push(ordered);
			kinds[kind] = [
				...new Set([...(kinds[kind] ?? []), ...Object.keys(entry)]),
			]
				// told once a packet came in on the pair, which Chrome counts
				// on the pair it first saw the peer at
				.filter((key) => key !== 'lastPacketReceivedTimestamp')
				.sort();
		}
		const ids = entries.map(([key, entry]) => key === entry.id && key);
		return {
			// in name order: which kind comes first follows the random ids
			kinds: Object.fromEntries(Object.entries(kinds).sort()),
			order,
			sorted: ids.every((id, at) => id && (!at || ids[at - 1] < id)),
		};
	};
	const of = (entries, type) =>
		entries
			.filter(([, entry]) => entry.type === type)
			.map(([, entry]) => entry);

	const fresh = new RTCPeerConnection();
	out.fresh = shape(await read(fresh), fresh);
	const lone = fresh.createDataChannel('x');
	const withChannel = await read(fresh);
	out.withChannel = shape(withChannel, fresh);
	out.channelId = /^D\d+$/.test(of(withChannel, 'data-channel')[0]?.id);
	fresh.close();
	out.closedFresh = shape(await read(fresh), fresh);
	void lone;

	const a = new RTCPeerConnection({
		iceServers: [{ urls: `stun:127.0.0.1:${env.stun}` }],
	});
	const b = new RTCPeerConnection();
	Object.assign(at, { stage: 'offer', a, b });
	// a candidate reaches the far end once it has a remote description: one
	// added earlier is refused, and if each were, neither end would have a
	// way to the other and the channels would never open
	const pending = new Map([
		[a, []],
		[b, []],
	]);
	const pass = (to, candidate) =>
		to.remoteDescription
			? to.addIceCandidate(candidate).catch(() => {})
			: pending.get(to).push(candidate);
	at.held = () => `held ${pending.get(a).length}/${pending.get(b).length}`;
	const flush = (to) => {
		for (const candidate of pending.get(to).splice(0))
			to.addIceCandidate(candidate).catch(() => {});
	};
	const shown = [];
	a.onicecandidate = ({ candidate }) => {
		if (!candidate) return;
		heard(a, candidate);
		shown.push({
			type: candidate.type,
			url: candidate.url?.replace(String(env.stun), 'PORT'),
			relayProtocol: candidate.relayProtocol,
			ufrag: candidate.usernameFragment?.length,
			json: Object.keys(candidate.toJSON()),
		});
		pass(b, candidate);
	};
	b.onicecandidate = ({ candidate }) => candidate && pass(a, candidate);
	const one = (at.one = a.createDataChannel('one'));
	const two = (at.two = a.createDataChannel('two', {
		ordered: false,
		maxRetransmits: 0,
		protocol: 'p',
	}));
	await a.setLocalDescription();
	const midway = await read(a);
	out.midway = shape(midway, a);
	out.midwayTransport = of(midway, 'transport').map((entry) => ({
		...entry,
		id: undefined,
		timestamp: undefined,
		iceLocalUsernameFragment: entry.iceLocalUsernameFragment?.length,
		localCertificateId: /^CF([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(
			entry.localCertificateId,
		),
	}));
	at.stage = 'answer';
	await b.setRemoteDescription(a.localDescription);
	flush(b);
	await b.setLocalDescription();
	await a.setRemoteDescription(b.localDescription);
	flush(a);
	at.stage = 'opening';
	await new Promise((resolve) => (one.onopen = resolve));
	if (two.readyState !== 'open')
		await new Promise((resolve) => (two.onopen = resolve));
	one.send('hello');
	one.send(new Uint8Array(100));
	at.stage = 'connected';
	await wait(1200);
	const connected = await read(a);
	out.connected = shape(connected, a);
	out.shown = shown;
	const transport = of(connected, 'transport')[0] ?? {};
	const pairs = of(connected, 'candidate-pair');
	const selected = pairs.find(
		(pair) => pair.id === transport.selectedCandidatePairId,
	);
	const locals = of(connected, 'local-candidate');
	const remotes = of(connected, 'remote-candidate');
	const certificates = of(connected, 'certificate');
	const local = locals.find((entry) => entry.id === selected?.localCandidateId);
	const remote = remotes.find(
		(entry) => entry.id === selected?.remoteCandidateId,
	);
	const fingerprint = (sdp) => /a=fingerprint:sha-256 (.*)/.exec(sdp)?.[1];
	out.facts = {
		transport: {
			dtlsState: transport.dtlsState,
			dtlsRole: transport.dtlsRole,
			iceRole: transport.iceRole,
			iceState: transport.iceState,
			changes: transport.selectedCandidatePairChanges,
			ufrag: transport.iceLocalUsernameFragment?.length,
			sent: transport.bytesSent > 100 && transport.packetsSent > 2,
			received: transport.bytesReceived > 0 && transport.packetsReceived > 0,
			localCertificate:
				transport.localCertificateId ===
				`CF${fingerprint(a.localDescription.sdp)}`,
			remoteCertificate:
				transport.remoteCertificateId ===
				`CF${fingerprint(a.remoteDescription.sdp)}`,
		},
		// what was negotiated: Chrome's stack with itself, or the proxy's
		dtls: [transport.tlsVersion, transport.dtlsCipher, transport.srtpCipher],
		certificates: certificates.map((entry) => ({
			named: entry.id === `CF${entry.fingerprint}`,
			algorithm: entry.fingerprintAlgorithm,
			der: /^MII[A-Za-z0-9+/]+=*$/.test(entry.base64Certificate),
			known: [
				fingerprint(a.localDescription.sdp),
				fingerprint(a.remoteDescription.sdp),
			].includes(entry.fingerprint),
		})),
		selected: selected && {
			named:
				selected.id ===
				`CP${selected.localCandidateId.slice(1)}_${selected.remoteCandidateId.slice(1)}`,
			state: selected.state,
			nominated: selected.nominated,
			writable: selected.writable,
			transportId: selected.transportId,
			checks:
				selected.requestsSent > 0 &&
				selected.responsesReceived > 0 &&
				selected.requestsReceived > 0 &&
				selected.responsesSent > 0,
			roundTrip:
				selected.totalRoundTripTime >= 0 &&
				typeof selected.currentRoundTripTime === 'number',
			discarded: [
				selected.bytesDiscardedOnSend,
				selected.packetsDiscardedOnSend,
			],
			priority:
				typeof selected.priority === 'number' && selected.priority > 2 ** 32,
			bytes: selected.bytesSent === transport.bytesSent,
		},
		local: local && {
			...local,
			id: /^I[A-Za-z0-9+/]{8}$/.test(local.id),
			timestamp: undefined,
			foundation: /^\d+$/.test(local.foundation),
			port: local.port > 0,
			usernameFragment: local.usernameFragment.length,
		},
		remote: remote && {
			...remote,
			id: /^I[A-Za-z0-9+/]{8}$/.test(remote.id),
			timestamp: undefined,
			foundation: /^\d+$/.test(remote.foundation),
			port: remote.port > 0,
			usernameFragment: remote.usernameFragment.length,
		},
		reflexive: locals
			.filter((entry) => entry.candidateType === 'srflx')
			.map((entry) => ({
				...entry,
				id: undefined,
				timestamp: undefined,
				foundation: undefined,
				port: entry.port > 0,
				usernameFragment: entry.usernameFragment.length,
				url: entry.url?.replace(String(env.stun), 'PORT'),
			})),
		channels: of(connected, 'data-channel').map((entry) => ({
			...entry,
			id: /^D\d+$/.test(entry.id),
			timestamp: undefined,
		})),
		peer: of(connected, 'peer-connection').map((entry) => ({
			...entry,
			timestamp: undefined,
		})),
		clock:
			Math.abs(
				connected[0][1].timestamp -
					(performance.timeOrigin + performance.now()),
			) < 1000,
	};
	two.close();
	await wait(300);
	const after = await read(a);
	out.afterChannelClose = {
		channels: of(after, 'data-channel').map((entry) => entry.label),
		peer: of(after, 'peer-connection').map((entry) => [
			entry.dataChannelsOpened,
			entry.dataChannelsClosed,
		]),
	};
	a.close();
	await wait(100);
	const closed = await read(a);
	out.closed = {
		shape: shape(closed, a),
		peer: of(closed, 'peer-connection').map((entry) => [
			entry.dataChannelsOpened,
			entry.dataChannelsClosed,
		]),
	};
	b.close();
	return out;
};

// a stage that never comes is told, not waited for: where it stopped and
// what each end and channel read then
window.__rtcStats = (env) => {
	const at = { stage: 'start' };
	const states = () =>
		[at.a, at.b]
			.map(
				(pc) =>
					pc &&
					[
						pc.signalingState,
						pc.iceGatheringState,
						pc.iceConnectionState,
						pc.connectionState,
						pc.remoteDescription?.sdp.match(/^a=candidate/gm)?.length ?? 0,
					].join(' '),
			)
			.concat([at.one?.readyState, at.two?.readyState, at.held?.()])
			.join('; ');
	let timer;
	return Promise.race([
		rtcStats(env, at),
		new Promise((resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`stuck at ${at.stage}: ${states()}`)),
				45000,
			);
		}),
	]).finally(() => clearTimeout(timer));
};

// pc.sctp, its RTCDtlsTransport and their RTCIceTransport over a
// connection's life: what each reads at each stage, the events each fires,
// what is the same object from one reading to the next, and the
// generation of the candidates after an ICE restart. The peer's candidates
// reach the page's connection only once it is connected (neither trickled
// nor in the answer), so the remote candidate of its selected pair is the
// peer reflexive one its first check showed.
window.__rtcTransports = async (env) => {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	// a stage that never comes is told, not waited for
	let stage = 'start';
	const until = (test, ms = 10000) =>
		new Promise((resolve, reject) => {
			const end = Date.now() + ms;
			const check = () =>
				test()
					? resolve()
					: Date.now() > end
						? reject(new Error(`stuck at ${stage}`))
						: setTimeout(check, 10);
			check();
		});
	const candidate = (c) =>
		c && {
			type: c.type,
			// a name, the STUN fixture's view of the wisp server, or hidden
			address: /\.local$/.test(c.address) ? 'name' : c.address,
			url: c.url?.replace(String(env.stun), 'PORT'),
			relayProtocol: c.relayProtocol,
			sdpMid: c.sdpMid,
			sdpMLineIndex: c.sdpMLineIndex,
			ufrag: c.usernameFragment?.length,
			generation: /generation (\d+)/.exec(c.candidate)?.[1],
		};
	const view = (pc) => {
		const sctp = pc.sctp;
		if (!sctp) return null;
		const dtls = sctp.transport;
		const ice = dtls.iceTransport;
		const pair = ice.getSelectedCandidatePair();
		return {
			sctp: [sctp.state, sctp.maxMessageSize, sctp.maxChannels],
			dtls: [
				dtls.state,
				// a DER certificate's size varies with its signature's
				dtls.getRemoteCertificates().map((der) => der.byteLength > 250),
			],
			ice: [ice.role, ice.state, ice.gatheringState],
			local: ice.getLocalCandidates().map(candidate),
			remote: ice.getRemoteCandidates().length,
			parameters: [ice.getLocalParameters(), ice.getRemoteParameters()],
			pair: pair && {
				local: candidate(pair.local),
				remote: candidate(pair.remote),
				keys: Object.keys(pair),
			},
		};
	};
	const events = {};
	const listen = (name, pc) => {
		const sctp = pc.sctp;
		if (!sctp || events[name]) return;
		const log = (events[name] = []);
		const ice = sctp.transport.iceTransport;
		sctp.onstatechange = () => log.push(`sctp ${sctp.state}`);
		sctp.transport.onstatechange = () =>
			log.push(`dtls ${sctp.transport.state}`);
		ice.onstatechange = () => log.push(`ice ${ice.state}`);
		ice.ongatheringstatechange = () =>
			log.push(`gathering ${ice.gatheringState}`);
		ice.onselectedcandidatepairchange = (event) =>
			log.push(`pair ${event.constructor.name}`);
	};
	const out = {};
	const a = new RTCPeerConnection({
		iceServers: [{ urls: `stun:127.0.0.1:${env.stun}` }],
	});
	const b = new RTCPeerConnection();
	const held = [];
	a.onicecandidate = ({ candidate }) =>
		candidate && b.addIceCandidate(candidate).catch(() => {});
	b.onicecandidate = ({ candidate }) => candidate && held.push(candidate);
	const channel = a.createDataChannel('one');
	out.beforeOffer = view(a);
	await a.setLocalDescription();
	out.offered = view(a);
	listen('a', a);
	const sctp = a.sctp;
	stage = 'gathering';
	await until(() => a.iceGatheringState === 'complete');
	out.gathered = view(a);
	await b.setRemoteDescription(a.localDescription);
	out.answering = view(b);
	listen('b', b);
	await b.setLocalDescription();
	out.answered = view(b);
	// without the candidates the answer has by then
	await a.setRemoteDescription({
		type: 'answer',
		sdp: b.localDescription.sdp.replace(/^a=candidate:.*\r\n/gm, ''),
	});
	stage = 'opening';
	await until(() => channel.readyState === 'open');
	await wait(300);
	out.connected = view(a);
	out.peer = view(b);
	const ice = a.sctp.transport.iceTransport;
	const pairs = [
		ice.getSelectedCandidatePair(),
		ice.getSelectedCandidatePair(),
	];
	out.same = [
		a.sctp === sctp,
		a.sctp.transport === a.sctp.transport,
		ice.getLocalCandidates() === ice.getLocalCandidates(),
		ice.getLocalCandidates()[0] === ice.getLocalCandidates()[0],
		pairs[0] === pairs[1],
		pairs[0].local === pairs[1].local,
		pairs[0].local === ice.getLocalCandidates()[0],
		Object.getPrototypeOf(pairs[0]) === Object.prototype,
		String(a.sctp),
		String(a.sctp.transport),
		String(ice),
	];
	// the peer's checks from the socket of the candidate it signalled (the
	// browser's other sockets, the IPv6 "any" one, check too), each of them
	// at an address of its own for each of the page's candidates it was
	// sent to natively, the page's loopback srflx one included: what is
	// compared is the kinds, not how many
	const ports = new Set(held.map((late) => late.port));
	const remotes = async () => {
		const found = [];
		(await a.getStats()).forEach(
			(entry) =>
				entry.type === 'remote-candidate' &&
				ports.has(entry.port) &&
				found.push(`${entry.candidateType} ${entry.address}`),
		);
		return [...new Set(found)].sort();
	};
	out.reflexive = await remotes();
	// the peer's own candidate takes the place of the peer reflexive one at
	// its address in the report; the selected pair the page holds stays as
	// it was
	for (const late of held) await a.addIceCandidate(late);
	await wait(300);
	out.added = [
		(await remotes()).includes('host '),
		candidate(ice.getSelectedCandidatePair().remote),
	];
	// an ICE restart: the next generation of candidates
	a.restartIce();
	await a.setLocalDescription();
	stage = 'restarting';
	await until(() => a.iceGatheringState === 'complete');
	out.restarted = [
		...new Set(
			[
				...a.localDescription.sdp.matchAll(/a=candidate:.* generation (\d+)/g),
			].map(([, generation]) => generation),
		),
	];
	b.close();
	await wait(1500);
	out.peerClosed = view(a);
	a.close();
	out.closed = view(a);
	// whether an ICE transport made as setLocalDescription resolves hears
	// gathering begin is a race of the browser's network thread (152 does
	// and does not, 156 does)
	if (events.a?.[0] === 'gathering gathering') events.a.shift();
	out.events = events;
	return out;
};
