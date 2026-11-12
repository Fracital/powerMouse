// What `getStats()` says of the transport (docs/webrtc-over-wisp.md, section
// 15): the candidates, the pairs and their counters, the selected pair, the
// DTLS parameters. The worker carries every datagram of a connection, so it
// counts them itself, by the pair of addresses each one travels between:
// a STUN request or response for the checks, anything else for the bytes
// (Chrome's counters leave the checks out). The selected pair is the one
// ICE nominated: a check with USE-CANDIDATE that was answered, whichever
// side sent it, or else the pair the stack sends DTLS on. The DTLS
// version, cipher suite and SRTP profile are read off the ServerHello as
// it passes, whichever side sent it.

import { candidateFields, type CandidateFields } from './sdp';

/** a candidate as a stats entry tells it */
export interface CandidateReport {
	id: string;
	type: string;
	/** empty where Chrome shows none: a name, or a peer reflexive address */
	address: string;
	port: number;
	priority: number;
	foundation: string;
	protocol: string;
	usernameFragment: string;
	/** local, from a server: its URL as the page wrote it */
	url?: string;
	relayProtocol?: string;
	/** the candidate as the page's RTCIceCandidate for it reads */
	line: string;
}

export interface PairReport {
	local: string;
	remote: string;
	state: 'waiting' | 'in-progress' | 'succeeded';
	nominated: boolean;
	writable: boolean;
	priority: number;
	bytesSent: number;
	bytesReceived: number;
	packetsSent: number;
	packetsReceived: number;
	requestsSent: number;
	requestsReceived: number;
	responsesSent: number;
	responsesReceived: number;
	consentRequestsSent: number;
	totalRoundTripTime: number;
	currentRoundTripTime?: number;
	lastPacketSentTimestamp?: number;
	lastPacketReceivedTimestamp?: number;
}

export interface TransportReport {
	locals: CandidateReport[];
	remotes: CandidateReport[];
	pairs: PairReport[];
	/** index in `pairs` */
	selected: number | null;
	selectedChanges: number;
	iceRole: 'unknown' | 'controlling' | 'controlled';
	dtlsRole: 'unknown' | 'client' | 'server';
	tlsVersion?: string;
	dtlsCipher?: string;
	srtpCipher?: string;
}

interface Candidate extends CandidateReport {
	remote: boolean;
}

/** the selected pair as RTCIceTransport.getSelectedCandidatePair() tells it */
export interface SelectedPair {
	local: string;
	remote: string;
}

interface Pair extends Omit<PairReport, 'local' | 'remote' | 'priority'> {
	local: Candidate;
	remote: Candidate;
}

const ID_CHARS =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** an id as Chrome names a candidate's entry: `I` and eight characters */
function candidateId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	let id = 'I';
	for (const byte of bytes) id += ID_CHARS[byte & 63];
	return id;
}

const CIPHERS: Record<number, string> = {
	0x1301: 'TLS_AES_128_GCM_SHA256',
	0x1302: 'TLS_AES_256_GCM_SHA384',
	0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
	0xc02b: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
	0xc02c: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
	0xc02f: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
	0xc030: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
	0xcca8: 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
	0xcca9: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
};
const SRTP_PROFILES: Record<number, string> = {
	1: 'SRTP_AES128_CM_HMAC_SHA1_80',
	2: 'SRTP_AES128_CM_HMAC_SHA1_32',
	7: 'SRTP_AEAD_AES_128_GCM',
	8: 'SRTP_AEAD_AES_256_GCM',
};

const STUN_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;

interface Stun {
	type: number;
	transaction: string;
	priority: number | null;
	/** the sender's ufrag: the second half of USERNAME */
	ufrag: string | null;
	role: 'controlling' | 'controlled' | null;
	/** a check that nominates its pair */
	nominates: boolean;
}

function readStun(bytes: Uint8Array): Stun | null {
	if (bytes.length < 20 || bytes[0] > 1) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(4) !== STUN_COOKIE) return null;
	let transaction = '';
	for (let at = 8; at < 20; at++)
		transaction += bytes[at].toString(16).padStart(2, '0');
	const stun: Stun = {
		type: view.getUint16(0),
		transaction,
		priority: null,
		ufrag: null,
		role: null,
		nominates: false,
	};
	for (let at = 20; at + 4 <= bytes.length;) {
		const type = view.getUint16(at);
		const length = view.getUint16(at + 2);
		const value = at + 4;
		if (value + length > bytes.length) break;
		if (type === 0x0024 && length === 4) stun.priority = view.getUint32(value);
		else if (type === 0x802a) stun.role = 'controlling';
		else if (type === 0x8029) stun.role = 'controlled';
		else if (type === 0x0025) stun.nominates = true;
		else if (type === 0x0006) {
			const name = new TextDecoder().decode(
				bytes.subarray(value, value + length),
			);
			const colon = name.indexOf(':');
			if (colon >= 0) stun.ufrag = name.slice(colon + 1);
		}
		at = value + ((length + 3) & ~3);
	}
	return stun;
}

/** the ServerHello of a DTLS handshake record, if `bytes` starts with one */
function readServerHello(
	bytes: Uint8Array,
): { version: number; cipher: number; srtp: number | null } | null {
	// record: type 22, version, epoch 0, sequence, length; then the handshake
	// header (type 2, length, sequence, fragment offset and length)
	if (bytes.length < 25 + 38 || bytes[0] !== 22 || bytes[3] || bytes[4])
		return null;
	if (bytes[13] !== 2) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// a fragment that is not the message's start says nothing here
	if (view.getUint16(19) || bytes[21]) return null;
	let at = 25;
	let version = view.getUint16(at);
	at += 2 + 32;
	at += 1 + bytes[at];
	if (at + 3 > bytes.length) return null;
	const cipher = view.getUint16(at);
	at += 3;
	let srtp: number | null = null;
	if (at + 2 <= bytes.length) {
		const end = Math.min(bytes.length, at + 2 + view.getUint16(at));
		at += 2;
		while (at + 4 <= end) {
			const type = view.getUint16(at);
			const length = view.getUint16(at + 2);
			if (type === 43 && length === 2) version = view.getUint16(at + 4);
			if (type === 14 && length >= 4) srtp = view.getUint16(at + 6);
			at += 4 + length;
		}
	}
	return { version, cipher, srtp };
}

/**
 * A remote candidate as Chrome writes it back: its own words in its own
 * order, the generation always, the user name (the description's when the
 * line has none), the network's id and cost where they are not zero
 */
function remoteLine(fields: CandidateFields, ufrag: string): string {
	const value = (key: string) => {
		const at = fields.rest.indexOf(key);
		return at >= 0 && at + 1 < fields.rest.length ? fields.rest[at + 1] : null;
	};
	const parts = [
		`candidate:${fields.foundation}`,
		fields.component,
		fields.protocol.toLowerCase(),
		fields.priority,
		fields.address,
		fields.port,
		'typ',
		fields.type,
	];
	const related = value('raddr');
	if (related !== null)
		parts.push('raddr', related, 'rport', value('rport') ?? '0');
	const tcp = value('tcptype');
	if (tcp !== null) parts.push('tcptype', tcp);
	parts.push('generation', value('generation') ?? '0');
	const own = value('ufrag') ?? ufrag;
	if (own) parts.push('ufrag', own);
	for (const key of ['network-id', 'network-cost']) {
		const given = value(key);
		if (given !== null && Number(given) > 0) parts.push(key, given);
	}
	return parts.join(' ');
}

export class TransportStats {
	/** by the address the stack sends from: its own, or a relayed one */
	#bases = new Map<string, Candidate>();
	#locals: Candidate[] = [];
	/** by the address the stack sends to */
	#remoteAt = new Map<string, Candidate>();
	#remotes: Candidate[] = [];
	#pairs = new Map<string, Pair>();
	#selected: Pair | null = null;
	#selectedChanges = 0;
	#asked = new Map<string, { pair: Pair; at: number; nominates: boolean }>();
	/** checks of the peer's that nominate their pair, until answered */
	#nominating = new Map<string, Pair>();
	#onSelect: (pair: SelectedPair) => void;
	#onPair: () => void;
	#iceRole: TransportReport['iceRole'] = 'unknown';
	#dtlsRole: TransportReport['dtlsRole'] = 'unknown';
	#hello: ReturnType<typeof readServerHello> = null;

	/** `onSelect`: ICE selected another pair; `onPair`: the first pair formed */
	constructor(
		onSelect: (pair: SelectedPair) => void = () => {},
		onPair: () => void = () => {},
	) {
		this.#onSelect = onSelect;
		this.#onPair = onPair;
	}

	/** a pair has formed: a check went to one of the peer's candidates, or came from the peer */
	get paired() {
		return this.#pairs.size > 0;
	}

	/** the side that offers first controls, until a check says otherwise */
	offered(local: boolean) {
		if (this.#iceRole === 'unknown')
			this.#iceRole = local ? 'controlling' : 'controlled';
	}

	/**
	 * A candidate the page was shown. `base` is the address the stack sends
	 * from for it (a reflexive candidate has its host's, and no pair of its
	 * own); `url` the server it came from.
	 */
	local(line: string, base: string | null, url = '', relayProtocol?: string) {
		const fields = candidateFields(line);
		if (!fields) return;
		const ufrag = fields.rest[fields.rest.indexOf('ufrag') + 1] ?? '';
		const candidate: Candidate = {
			id: candidateId(),
			remote: false,
			type: fields.type,
			address: fields.address.endsWith('.local') ? '' : fields.address,
			port: Number(fields.port),
			priority: Number(fields.priority),
			foundation: fields.foundation,
			protocol: fields.protocol.toLowerCase(),
			usernameFragment: ufrag,
			...(url && { url }),
			...(relayProtocol && { relayProtocol }),
			line: line.startsWith('candidate:') ? line : `candidate:${line}`,
		};
		this.#locals.push(candidate);
		if (base !== null) this.#bases.set(base, candidate);
	}

	/**
	 * A candidate the page added: `at` is the address the stack was given
	 * for it. One at an address a check already showed takes the place of
	 * the peer reflexive candidate made for it, as in Chrome's report
	 */
	remote(line: string, at: string, ufrag: string) {
		const fields = candidateFields(line);
		if (!fields) return;
		const known = this.#remoteAt.get(at);
		if (known && known.type !== 'prflx') return;
		const own = fields.rest[fields.rest.indexOf('ufrag') + 1];
		const candidate: Candidate = known ?? ({ remote: true } as Candidate);
		Object.assign(candidate, {
			id: candidateId(),
			type: fields.type,
			address: fields.address.endsWith('.local') ? '' : fields.address,
			port: Number(fields.port),
			priority: Number(fields.priority),
			foundation: fields.foundation,
			protocol: fields.protocol.toLowerCase(),
			usernameFragment:
				fields.rest.includes('ufrag') && own !== undefined ? own : ufrag,
			line: remoteLine(fields, ufrag),
		});
		if (known) return;
		this.#remotes.push(candidate);
		this.#remoteAt.set(at, candidate);
	}

	#pair(local: string, remote: string, stun: Stun | null): Pair | null {
		const key = `${local}|${remote}`;
		let pair = this.#pairs.get(key);
		if (pair) return pair;
		const from = this.#bases.get(local);
		if (!from) return null;
		let to = this.#remoteAt.get(remote);
		if (!to) {
			// an address no candidate named: the peer's, as a check showed it
			if (!stun || stun.type !== BINDING_REQUEST) return null;
			const port = Number(remote.slice(remote.lastIndexOf(':') + 1));
			const priority = stun.priority ?? 0;
			const foundation = String(crypto.getRandomValues(new Uint32Array(1))[0]);
			const ufrag = stun.ufrag ?? '';
			to = {
				id: candidateId(),
				remote: true,
				type: 'prflx',
				address: '',
				port,
				priority,
				foundation,
				protocol: 'udp',
				usernameFragment: ufrag,
				// Chrome hides the address it saw the peer at
				line: `candidate:${foundation} 1 udp ${priority} redacted-ip.invalid ${port} typ prflx generation 0 ufrag ${ufrag} network-cost 999`,
			};
			this.#remotes.push(to);
			this.#remoteAt.set(remote, to);
		}
		pair = {
			local: from,
			remote: to,
			state: 'waiting',
			nominated: false,
			writable: false,
			bytesSent: 0,
			bytesReceived: 0,
			packetsSent: 0,
			packetsReceived: 0,
			requestsSent: 0,
			requestsReceived: 0,
			responsesSent: 0,
			responsesReceived: 0,
			consentRequestsSent: 0,
			totalRoundTripTime: 0,
		};
		this.#pairs.set(key, pair);
		if (this.#pairs.size === 1) this.#onPair();
		return pair;
	}

	/** a datagram the stack sent from `local` to `remote` */
	sent(local: string, remote: string, bytes: Uint8Array) {
		const stun = readStun(bytes);
		const pair = this.#pair(local, remote, null);
		if (!pair) return;
		if (stun) {
			if (stun.type === BINDING_REQUEST) {
				pair.requestsSent++;
				if (pair.writable) pair.consentRequestsSent++;
				else pair.state = 'in-progress';
				if (stun.role) this.#iceRole = stun.role;
				this.#asked.set(stun.transaction, {
					pair,
					at: performance.now(),
					nominates: stun.nominates,
				});
				// a check that is never answered is not kept for ever
				if (this.#asked.size > 256)
					this.#asked.delete(this.#asked.keys().next().value!);
			} else if (stun.type === BINDING_SUCCESS) {
				pair.responsesSent++;
				// the peer nominated this pair, and it is answered
				if (this.#nominating.delete(stun.transaction)) this.#select(pair);
			}
			return;
		}
		pair.packetsSent++;
		pair.bytesSent += bytes.length;
		pair.lastPacketSentTimestamp = Date.now();
		// what is not a check travels on the pair the stack chose
		this.#select(pair);
		this.#dtls(bytes, 'server');
	}

	/**
	 * The agent is connected, unless a pair is selected: the one the peer
	 * nominated last, whose answer is on its way, or else the best that
	 * has been answered
	 */
	settle() {
		if (this.#selected) return;
		const nominated = [...this.#nominating.values()].at(-1);
		if (nominated) {
			this.#select(nominated);
			return;
		}
		let best: Pair | null = null;
		for (const pair of this.#pairs.values())
			if (
				pair.writable &&
				(!best || this.#priority(pair) > this.#priority(best))
			)
				best = pair;
		if (best) this.#select(best);
	}

	/** RFC 8445 6.1.2.3, with G the controlling side's priority */
	#priority({ local, remote }: Pair): bigint {
		const controlling = this.#iceRole !== 'controlled';
		const g = BigInt(controlling ? local.priority : remote.priority);
		const d = BigInt(controlling ? remote.priority : local.priority);
		return (
			(1n << 32n) * (g < d ? g : d) + 2n * (g > d ? g : d) + (g > d ? 1n : 0n)
		);
	}

	#select(pair: Pair) {
		if (this.#selected === pair) return;
		if (this.#selected) this.#selected.nominated = false;
		this.#selected = pair;
		this.#selectedChanges++;
		pair.nominated = true;
		this.#onSelect({ local: pair.local.line, remote: pair.remote.line });
	}

	/** a datagram for the stack, from `remote` to `local` */
	received(local: string, remote: string, bytes: Uint8Array) {
		const stun = readStun(bytes);
		const pair = this.#pair(local, remote, stun);
		if (!pair) return;
		if (stun) {
			if (stun.type === BINDING_REQUEST) {
				pair.requestsReceived++;
				if (stun.nominates) {
					this.#nominating.set(stun.transaction, pair);
					if (this.#nominating.size > 256)
						this.#nominating.delete(this.#nominating.keys().next().value!);
				}
			} else if (stun.type === BINDING_SUCCESS) {
				const asked = this.#asked.get(stun.transaction);
				if (!asked) return;
				this.#asked.delete(stun.transaction);
				const seconds = (performance.now() - asked.at) / 1000;
				asked.pair.responsesReceived++;
				asked.pair.totalRoundTripTime += seconds;
				asked.pair.currentRoundTripTime = seconds;
				asked.pair.state = 'succeeded';
				asked.pair.writable = true;
				// this side nominated the pair, and the peer answered
				if (asked.nominates) this.#select(asked.pair);
			}
			return;
		}
		pair.packetsReceived++;
		pair.bytesReceived += bytes.length;
		pair.lastPacketReceivedTimestamp = Date.now();
		this.#dtls(bytes, 'client');
	}

	/** the ServerHello tells the parameters, and its sender is the server */
	#dtls(bytes: Uint8Array, role: 'client' | 'server') {
		if (bytes[0] !== 22) return;
		const hello = readServerHello(bytes);
		if (!hello) return;
		this.#hello = hello;
		this.#dtlsRole = role;
	}

	report(): TransportReport {
		const pairs = [...this.#pairs.values()];
		const hello = this.#hello;
		return {
			locals: this.#locals.map(({ remote: _, ...candidate }) => candidate),
			remotes: this.#remotes.map(({ remote: _, ...candidate }) => candidate),
			pairs: pairs.map((pair) => {
				const { local, remote, ...counters } = pair;
				return {
					...counters,
					local: local.id,
					remote: remote.id,
					priority: Number(this.#priority(pair)),
				};
			}),
			selected: this.#selected ? pairs.indexOf(this.#selected) : null,
			selectedChanges: this.#selectedChanges,
			iceRole: this.#iceRole,
			dtlsRole: this.#dtlsRole,
			...(hello && {
				tlsVersion: hello.version.toString(16).toUpperCase().padStart(4, '0'),
				dtlsCipher: CIPHERS[hello.cipher],
				...(hello.srtp !== null && { srtpCipher: SRTP_PROFILES[hello.srtp] }),
			}),
		};
	}
}
