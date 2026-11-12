// A document's WebRTC connections as the worker runs them
// (docs/webrtc-over-wisp.md): the stack (rust/rtc, str0m in wasm, sans-IO)
// driven with records in, records out and a timer, the streams every packet
// travels on, and the page's RTCPeerConnection stand-in answered over a
// port per connection. Nothing here opens a socket: the only network is
// the opener the worker hands in, which carries wisp streams.
import { WEBRTC_CHANNEL } from '../transport/messages';
import { compileModule, type ModuleSource } from '../wasm/module';
import { AudioReceiver, AudioSender } from './audio';
import { hex, type Certificate } from './certificate';
import { parseParameters, parsePayloads, type Formats } from './formats';
import type {
	CandidateInit,
	ChannelOptions,
	ConnectionConfig,
	Direction,
	MediaSection,
	Negotiated,
	Request,
	WorkerEvent,
	WorkerMessage,
} from './protocol';
import {
	decodeChannelData,
	decodeMediaData,
	decodeText,
	decodeTransmit,
	encodeChannelSend,
	encodeDatagram,
	encodeFrame,
	encodeText,
	IN_CHANNEL_SEND,
	IN_CONTROL,
	IN_DATAGRAM,
	IN_MEDIA_WRITE,
	OUT_CHANNEL_DATA,
	OUT_EVENT,
	OUT_MEDIA_DATA,
	OUT_RESULT,
	OUT_TIMEOUT,
	OUT_TRANSMIT,
	text,
	type Frame,
	type StackExports,
} from './records';
import {
	all,
	candidateFields,
	candidateLine,
	first,
	isAddress,
	MidNames,
	parseSdp,
	renderChrome,
	stripCandidates,
	type Media,
	type ParsedSdp,
} from './sdp';
import {
	bindingRequest,
	isAnswerTo,
	joinAddress,
	reflexiveOf,
	splitAddress,
	STUN_GIVE_UP_MS,
	STUN_SCHEDULE_MS,
} from './stun';
import { TurnAllocation } from './turn';
import { wasiImports } from './wasi';

/** what opens a wisp stream: the document's transport (StreamTransport.stream) */
export interface StreamOpener {
	stream(
		kind: 'udp' | 'tcp',
		host: string,
		port: number,
		tls?: boolean,
	): Promise<MessagePort>;
}

/** the stack's module, instantiated with the worker's clock and randomness */
export async function loadStack(
	source: ModuleSource,
	base?: string,
): Promise<Stack> {
	const module = await compileModule(source, base);
	let exports: StackExports | null = null;
	const instance = await WebAssembly.instantiate(
		module,
		wasiImports(() => exports!.memory),
	);
	exports = instance.exports as unknown as StackExports;
	return new Stack(instance);
}

/** how long after the peer closed the connection reads disconnected (Chrome: about 5 s) */
const PEER_GONE_MS = 5000;
/** how long a closed connection's stack is driven on, to say goodbye */
const CLOSE_LINGER_MS = 500;
/** how many datagrams wait for a stream that is opening */
const OPENING_QUEUE = 64;
/** the address family the stack sees its own socket at (TEST-NET-2: never routed, never a page's) */
const LOCAL_NET = '198.51.100.';
/** the addresses that stand for other documents' .local names (TEST-NET-3) */
const BRIDGE_NET = '203.0.113.';
const HEX = '0123456789abcdef';

function uuid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let out = '';
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
		out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
	}
	return out;
}

/** a bridge message between two documents' workers (BroadcastChannel, same proxy origin) */
interface BridgeMessage {
	to: string;
	from: string;
	fromPort: number;
	data: ArrayBuffer;
}

// --- the stack ---

export class Stack {
	#exports: StackExports;
	constructor(instance: WebAssembly.Instance) {
		this.#exports = instance.exports as unknown as StackExports;
		this.#exports._initialize?.();
	}
	#give(bytes: Uint8Array): [number, number] {
		const ptr = this.#exports.a(bytes.length);
		new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
		return [ptr, bytes.length];
	}
	create(config: Record<string, string | number>): number {
		const [ptr, len] = this.#give(encodeText(config));
		return this.#exports.c(ptr, len);
	}
	input(id: number, kind: number, bytes: Uint8Array): number {
		const [ptr, len] = this.#give(bytes);
		return this.#exports.i(id, kind, ptr, len);
	}
	tick(id: number): number {
		return this.#exports.t(id);
	}
	/** the next output record, copied out; null when there is none */
	output(id: number): Uint8Array | null {
		const len = this.#exports.o(id);
		if (!len) return null;
		const ptr = this.#exports.p();
		return new Uint8Array(this.#exports.memory.buffer, ptr, len).slice();
	}
	destroy(id: number) {
		this.#exports.d(id);
	}
}

// --- streams ---

interface Stream {
	send(bytes: Uint8Array): void;
	close(): void;
}

/** a wisp stream on a transport port, with a queue while it opens */
class WispStream implements Stream {
	#port: MessagePort | null = null;
	#queue: Uint8Array[] = [];
	#closed = false;
	constructor(
		opening: Promise<MessagePort>,
		onData: (bytes: Uint8Array) => void,
		onClose: (reason?: string) => void,
	) {
		opening.then(
			(port) => {
				if (this.#closed) {
					port.postMessage({ type: 'close' });
					port.close();
					return;
				}
				this.#port = port;
				port.onmessage = ({ data }) => {
					if (data?.type === 'data') onData(new Uint8Array(data.data));
					else if (data?.type === 'close') {
						this.#closed = true;
						onClose(data.reason);
					}
				};
				port.start();
				for (const bytes of this.#queue.splice(0)) this.send(bytes);
			},
			(error) => {
				this.#closed = true;
				onClose(String((error as Error)?.message || error));
			},
		);
	}
	send(bytes: Uint8Array) {
		if (this.#closed) return;
		if (!this.#port) {
			if (this.#queue.length < OPENING_QUEUE) this.#queue.push(bytes.slice());
			return;
		}
		const copy = bytes.slice();
		this.#port.postMessage({ type: 'data', data: copy.buffer }, [copy.buffer]);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#port) {
			this.#port.postMessage({ type: 'close' });
			this.#port.close();
		}
	}
}

// --- a connection ---

interface Channel {
	options: ChannelOptions;
	open: boolean;
	/** the page has sent on it: its buffered amount is the page's own */
	sent?: boolean;
}

/** a media section: the page's transceiver, the stack's section and what carries its frames */
interface MediaState {
	/** the page's number for it (protocol.ts, MediaSection) */
	handle: number;
	/** the stack's */
	index: number;
	kind: 'audio' | 'video';
	/** as the page reads it */
	mid: string | null;
	/** what the page's transceiver wants: every offer of this side states it */
	wanted: Direction;
	/** what the section negotiated; null before it has */
	direction: Direction | null;
	sender: AudioSender | null;
	receiver: AudioReceiver | null;
}

const DIRECTIONS: Direction[] = [
	'sendrecv',
	'sendonly',
	'recvonly',
	'inactive',
];

/** what a description says of a section's direction and of what it sends */
function remoteOf(media: Media): NonNullable<MediaSection['remote']> {
	let direction: Direction = 'sendrecv';
	for (const [name] of media.attributes)
		if ((DIRECTIONS as string[]).includes(name)) direction = name as Direction;
	const streams: string[] = [];
	let track: string | null = null;
	// `a=msid:<stream> <track>`, one line a stream; an older peer says it
	// on its `a=ssrc` lines
	const ids = all(media.attributes, 'msid');
	for (const value of all(media.attributes, 'ssrc')) {
		const at = value.indexOf(' msid:');
		if (!ids.length && at !== -1) ids.push(value.slice(at + 6));
	}
	for (const value of ids) {
		const [stream, id] = value.split(' ');
		if (stream && stream !== '-' && !streams.includes(stream))
			streams.push(stream);
		if (id) track = id;
	}
	return { direction, streams, track };
}

/** something that gathers a candidate: a Binding request, a TURN allocation */
interface Gatherer {
	done: boolean;
	stop(): void;
}

/** an ICE server URL of the page's, as the worker asks it */
interface Server {
	url: string;
	relay: boolean;
	transport: 'udp' | 'tcp';
	tls: boolean;
	host: string;
	port: number;
	username: string;
	credential: string;
}

function parseServers(config: ConnectionConfig): Server[] {
	const servers: Server[] = [];
	for (const server of config.iceServers)
		for (const url of server.urls) {
			const parsed = /^(stuns?|turns?):([^?]+)(?:\?(.*))?$/.exec(url);
			if (!parsed) continue;
			const scheme = parsed[1];
			const tls = scheme === 'turns' || scheme === 'stuns';
			let host = parsed[2];
			let port = tls ? 5349 : 3478;
			const at = host.lastIndexOf(':');
			if (at !== -1 && !host.endsWith(']')) {
				port = Number(host.slice(at + 1)) || port;
				host = host.slice(0, at);
			}
			if (host.startsWith('[')) host = host.slice(1, -1);
			const relay = scheme.startsWith('turn');
			servers.push({
				url,
				relay,
				transport:
					tls || (relay && /(?:^|&)transport=tcp(?:&|$)/.test(parsed[3] ?? ''))
						? 'tcp'
						: 'udp',
				tls,
				host,
				port,
				username: server.username ?? '',
				credential: server.credential ?? '',
			});
		}
	return servers;
}

/** Chrome's candidate priorities: type preference 126, 100 and 2 (a UDP relay) */
const CANDIDATE_PRIORITY = {
	host: '2113937151',
	srflx: '1677729535',
	relay: '41885695',
};

/** how long a remote whose stream was refused or lost is left alone */
const REFUSED_MS = 10000;

export class Connection {
	#stack: Stack;
	#id: number;
	#port: MessagePort;
	#opener: StreamOpener;
	#config: ConnectionConfig;
	#certificate: Certificate;
	/** the stack's own address: every stream is a pair of this and a remote */
	#local: string;
	#localPort: number;
	/** the mDNS-style name the page sees for the host candidate */
	#name: string;
	#streams = new Map<string, Stream>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#channels = new Map<number, Channel>();
	/** the media sections, by the stack's index and by the page's handle */
	#medias = new Map<number, MediaState>();
	#handles = new Map<number, MediaState>();
	/** the handle of the next section the peer offers first */
	#nextHandle = -1;
	/** sections whose negotiated state the stack changed, to be read again */
	#stale = new Set<number>();
	/** the peer's description, as the page set it last */
	#remote: ParsedSdp | null = null;
	#draining = 0;
	#ufrag = '';
	#pwd = '';
	#fingerprint: string;
	#sessionId: string;
	#version = 1;
	#mids = new MidNames();
	#lastLocal: ParsedSdp | null = null;
	#pendingAnswer: ParsedSdp | null = null;
	/** `candidate:...` values shown to the page, in order */
	#shown: string[] = [];
	#gathering: RTCIceGatheringState = 'new';
	#gatherers: Gatherer[] = [];
	/** the TURN allocations, by the relayed address the stack sends from */
	#relays = new Map<string, TurnAllocation>();
	/** remotes a stream was refused to, and until when */
	#refused = new Map<string, number>();
	#iceState: RTCIceConnectionState = 'new';
	#connectionState: RTCPeerConnectionState = 'new';
	#connected = false;
	#closed = false;
	/** the stack is gone too (a moment after the close: see close()) */
	#ended = false;
	#remoteSet = false;
	/**
	 * Remote candidates the page added before any local description: the
	 * browser checks none until it has one, so they wait for it
	 */
	#localSet = false;
	#heldRemotes: string[] = [];
	#heldIce: RTCIceConnectionState | null = null;
	/** the next offer restarts ICE (restartIce, or createOffer's iceRestart) */
	#restart = false;
	/** .local names of other documents and the addresses that stand for them here */
	#bridgeNames = new Map<string, string>();
	#bridgeAddresses = new Map<string, string>();
	#bridge: BroadcastChannel | null = null;

	constructor(
		stack: Stack,
		port: MessagePort,
		opener: StreamOpener,
		config: ConnectionConfig,
		certificate: Certificate,
		formats: Formats | null = null,
	) {
		this.#stack = stack;
		this.#port = port;
		this.#opener = opener;
		this.#config = config;
		this.#certificate = certificate;
		this.#fingerprint = certificate.fingerprint;
		const octets = crypto.getRandomValues(new Uint8Array(2));
		this.#localPort = 49152 + (octets[1] << 6) + (octets[0] & 63);
		this.#local = `${LOCAL_NET}${1 + (octets[0] % 250)}:${this.#localPort}`;
		this.#name = `${uuid()}.local`;
		this.#sessionId = String(
			BigInt.asUintN(63, crypto.getRandomValues(new BigUint64Array(1))[0]),
		);
		const base = {
			// relay only: the stack has no socket of its own to send from
			...(config.iceTransportPolicy === 'relay' ? {} : { local: this.#local }),
			cert: hex(certificate.certificate),
			key: hex(certificate.privateKey),
		};
		// with the browser's own codecs and header extensions; a list the
		// stack cannot read leaves it with its own
		this.#id = stack.create({ ...base, ...formats });
		if (this.#id < 0 && formats) this.#id = stack.create(base);
		if (this.#id < 0)
			throw new Error('the WebRTC stack refused the connection');
		const creds = this.#control({ op: 'creds' });
		this.#ufrag = creds.ufrag ?? '';
		this.#pwd = creds.pass ?? '';
		this.#fingerprint = creds.fingerprint ?? certificate.fingerprint;
		port.onmessage = ({ data }: MessageEvent<Request>) => this.#request(data);
		port.start();
	}

	#post(message: WorkerMessage, transfer: Transferable[] = []) {
		this.#port.postMessage(message, transfer);
	}
	#event(event: WorkerEvent, transfer: Transferable[] = []) {
		if (!this.#closed) this.#post(event, transfer);
	}

	/** a control call: the stack answers with a result record at once */
	#control(fields: Record<string, string | number>): Record<string, string> {
		this.#stack.input(this.#id, IN_CONTROL, encodeText(fields));
		return this.#drain(true) ?? {};
	}

	/**
	 * Move every output record of the stack where it goes; with
	 * `wantResult`, the result record is returned instead of dropped.
	 */
	#drain(wantResult = false): Record<string, string> | null {
		let result: Record<string, string> | null = null;
		this.#draining++;
		for (;;) {
			const record = this.#stack.output(this.#id);
			if (!record) break;
			const tag = record[0];
			const payload = record.subarray(1);
			if (tag === OUT_TRANSMIT) this.#transmit(payload);
			else if (tag === OUT_EVENT) this.#stackEvent(decodeText(payload));
			else if (tag === OUT_CHANNEL_DATA) {
				const { channel, binary, payload: bytes } = decodeChannelData(payload);
				if (binary) {
					const copy = bytes.slice();
					this.#event(
						{ ev: 'channelMessage', channel, data: copy.buffer, binary: true },
						[copy.buffer],
					);
				} else
					this.#event({
						ev: 'channelMessage',
						channel,
						data: text.decode(bytes),
						binary: false,
					});
			} else if (tag === OUT_TIMEOUT) {
				this.#schedule(
					new DataView(
						payload.buffer,
						payload.byteOffset,
						payload.byteLength,
					).getUint32(0),
				);
			} else if (tag === OUT_MEDIA_DATA) {
				const frame = decodeMediaData(payload);
				this.#medias.get(frame.media)?.receiver?.frame(frame);
			} else if (tag === OUT_RESULT && wantResult) result = decodeText(payload);
		}
		// what a section negotiated is asked of the stack once its records
		// are all read: a control call in the middle would take the result
		// another is waiting for
		if (!--this.#draining && this.#stale.size) {
			const stale = [...this.#stale];
			this.#stale.clear();
			for (const index of stale) this.#negotiated(index);
		}
		return result;
	}

	// --- media ---

	#addMedia(
		index: number,
		kind: 'audio' | 'video',
		handle: number,
		wanted: Direction,
	) {
		const state: MediaState = {
			handle,
			index,
			kind,
			mid: null,
			wanted,
			direction: null,
			sender: null,
			receiver: null,
		};
		if (kind === 'audio') {
			state.sender = new AudioSender(index, this.#writeFrame);
			state.receiver = new AudioReceiver();
			state.receiver.onStart = () => this.#event({ ev: 'unmute', handle });
		}
		this.#medias.set(index, state);
		this.#handles.set(handle, state);
		return state;
	}

	/** an encoded frame for the stack to packetize and send */
	#writeFrame = (frame: Frame, age: number) => {
		if (this.#closed) return;
		this.#stack.input(this.#id, IN_MEDIA_WRITE, encodeFrame(frame, age));
		this.#drain();
	};

	/** what a section negotiated, as the stack has it now: its direction, and the payload to send */
	#negotiated(index: number) {
		const state = this.#medias.get(index);
		if (!state || this.#ended) return;
		const result = this.#control({ op: 'payloads', index });
		// a section no description has settled yet
		if (result.error) return;
		state.direction = (result.dir as Direction) ?? null;
		const payloads = parsePayloads(result.codecs ?? '');
		// the stack keeps its own parameters for a payload; what the peer
		// asked for (stereo, a bitrate, silence left out) is in its
		// description
		const described = this.#remote?.medias.find(
			(media) => first(media.attributes, 'mid') === state.mid,
		);
		if (described)
			for (const payload of payloads) {
				const line = all(described.attributes, 'fmtp').find((value) =>
					value.startsWith(`${payload.pt} `),
				);
				if (line !== undefined)
					payload.parameters = parseParameters(
						line.slice(line.indexOf(' ') + 1),
					);
			}
		state.sender?.configure(payloads);
		this.#activate(state);
	}

	/** a section sends when its direction says so and the connection is up */
	#activate(state: MediaState) {
		state.sender?.setActive(
			this.#connected &&
				!this.#closed &&
				(state.direction === 'sendrecv' || state.direction === 'sendonly'),
		);
	}

	/** the sections as they are, for the page's transceivers; `remote` is the peer's description */
	#sections(remote?: ParsedSdp): Negotiated {
		const medias: MediaSection[] = [];
		for (const state of this.#medias.values()) {
			const section: MediaSection = {
				handle: state.handle,
				kind: state.kind,
				mid: state.mid,
				direction: state.direction,
			};
			const described =
				state.mid === null
					? undefined
					: remote?.medias.find(
							(media) => first(media.attributes, 'mid') === state.mid,
						);
			if (described) section.remote = remoteOf(described);
			medias.push(section);
		}
		return { medias };
	}

	/**
	 * A section the peer offered first. The transceiver a browser makes for
	 * one receives only, until the page gives it something to send: that
	 * is what a later offer of this side says of it.
	 */
	#newFromPeer(index: number, kind: 'audio' | 'video'): MediaState {
		this.#control({ op: 'direction', index, dir: 'recvonly' });
		return this.#addMedia(index, kind, this.#nextHandle--, 'recvonly');
	}

	/**
	 * The stack's `index:mid` list: the names its sections have now. With
	 * the peer's offer, a section in it that is new here is one the peer
	 * offered first: the page gets a transceiver for it.
	 */
	#takeMids(list: string | undefined, offer?: ParsedSdp) {
		for (const entry of (list ?? '').split(',')) {
			const at = entry.indexOf(':');
			if (at === -1) continue;
			const index = Number(entry.slice(0, at));
			const mid = this.#mids.shown(entry.slice(at + 1));
			let state = this.#medias.get(index);
			if (!state) {
				const kind = offer?.medias.find(
					(media) => first(media.attributes, 'mid') === mid,
				)?.kind;
				if (kind !== 'audio' && kind !== 'video') continue;
				state = this.#newFromPeer(index, kind);
			}
			state.mid = mid;
			this.#negotiated(index);
		}
	}

	#schedule(ms: number) {
		if (this.#timer !== null) clearTimeout(this.#timer);
		if (this.#ended) return;
		this.#timer = setTimeout(
			() => {
				this.#timer = null;
				if (this.#ended) return;
				this.#stack.tick(this.#id);
				this.#drain();
			},
			Math.min(ms, 60000),
		);
	}

	#transmit(payload: Uint8Array) {
		const transmit = decodeTransmit(payload);
		// from a relayed address: through that allocation's TURN server
		const relay = this.#relays.get(transmit.source);
		if (relay) {
			relay.send(transmit.destination, transmit.payload);
			return;
		}
		const key = `${transmit.proto}/${transmit.destination}`;
		let stream = this.#streams.get(key);
		if (!stream) {
			const until = this.#refused.get(key);
			if (until !== undefined) {
				if (until > Date.now()) return;
				this.#refused.delete(key);
			}
			stream = this.#open(transmit.proto, transmit.destination);
			this.#streams.set(key, stream);
		}
		stream.send(transmit.payload);
	}

	/** a stream to `remote` (`host:port`), a wisp one or the bridge to another document */
	#open(proto: 'udp' | 'tcp', remote: string): Stream {
		const { host, port } = splitAddress(remote);
		const name = this.#bridgeNames.get(host);
		if (name) {
			const bridge = this.#openBridge();
			return {
				send: (bytes) => {
					const copy = bytes.slice();
					bridge.postMessage({
						to: name,
						from: this.#name,
						fromPort: this.#localPort,
						data: copy.buffer,
					} satisfies BridgeMessage);
				},
				close: () => {},
			};
		}
		return new WispStream(
			this.#opener.stream(proto, host, port),
			(bytes) => this.#receive(proto, remote, bytes),
			() => {
				// a stream the server refused or closed: the stack's checks to
				// this remote time out as to an unreachable one, and it is not
				// asked again for every retransmission
				this.#streams.delete(`${proto}/${remote}`);
				this.#refused.set(`${proto}/${remote}`, Date.now() + REFUSED_MS);
			},
		);
	}

	/** a datagram from `remote`, received at `local` (the stack's own address, or a relayed one) */
	#receive(
		proto: 'udp' | 'tcp',
		remote: string,
		bytes: Uint8Array,
		local = this.#local,
	) {
		if (this.#ended) return;
		this.#stack.input(
			this.#id,
			IN_DATAGRAM,
			encodeDatagram(proto, remote, local, bytes),
		);
		this.#drain();
	}

	#openBridge(): BroadcastChannel {
		if (this.#bridge) return this.#bridge;
		const bridge = new BroadcastChannel(WEBRTC_CHANNEL);
		bridge.onmessage = ({ data }: MessageEvent<BridgeMessage>) => {
			if (!data || data.to !== this.#name) return;
			const address = this.#bridgeAddress(data.from);
			this.#receive(
				'udp',
				joinAddress(address, data.fromPort),
				new Uint8Array(data.data),
			);
		};
		this.#bridge = bridge;
		return bridge;
	}

	/** the address standing for another document's name here */
	#bridgeAddress(name: string): string {
		let address = this.#bridgeAddresses.get(name);
		if (!address) {
			address = `${BRIDGE_NET}${1 + this.#bridgeAddresses.size}`;
			this.#bridgeAddresses.set(name, address);
			this.#bridgeNames.set(address, name);
			this.#openBridge();
		}
		return address;
	}

	#stackEvent(fields: Record<string, string>) {
		switch (fields.ev) {
			case 'ice':
				// the stack's agent starts at once; a browser's connection is
				// "new" until it has a remote description to check against
				if (this.#remoteSet)
					this.#stackIce(fields.state as RTCIceConnectionState);
				else this.#heldIce = fields.state as RTCIceConnectionState;
				break;
			case 'connected':
				this.#connected = true;
				this.#setConnection('connected');
				for (const state of this.#medias.values()) this.#activate(state);
				break;
			// a section the stack has now: one of the page's that an answer
			// confirmed, or one the peer offered
			case 'media': {
				const index = Number(fields.index);
				const state =
					this.#medias.get(index) ??
					this.#addMedia(
						index,
						fields.kind === 'video' ? 'video' : 'audio',
						this.#nextHandle--,
						'recvonly',
					);
				state.mid = this.#mids.shown(fields.mid ?? '');
				this.#stale.add(index);
				break;
			}
			case 'media_changed':
				this.#stale.add(Number(fields.index));
				break;
			case 'channel_open': {
				const channel = Number(fields.index);
				const id = fields.stream === undefined ? null : Number(fields.stream);
				const known = this.#channels.get(channel);
				if (known) {
					known.open = true;
					this.#event({ ev: 'channelOpen', channel, id });
				} else {
					const options: ChannelOptions = {
						label: fields.label ?? '',
						ordered: fields.ordered !== '0',
						maxPacketLifeTime:
							fields.maxPacketLifeTime === undefined
								? null
								: Number(fields.maxPacketLifeTime),
						maxRetransmits:
							fields.maxRetransmits === undefined
								? null
								: Number(fields.maxRetransmits),
						protocol: fields.protocol ?? '',
						negotiated: fields.negotiated !== undefined,
						id,
					};
					this.#channels.set(channel, { options, open: true });
					this.#event({ ev: 'datachannel', channel, options, id });
				}
				break;
			}
			case 'channel_close':
				this.#event({ ev: 'channelClose', channel: Number(fields.index) });
				this.#channels.delete(Number(fields.index));
				break;
			// the stack counts a channel's own open handshake as buffered
			// bytes; a page sees only what it sent
			case 'buffered':
				if (this.#channels.get(Number(fields.index))?.sent)
					this.#event({
						ev: 'buffered',
						channel: Number(fields.index),
						amount: Number(fields.amount),
					});
				break;
			case 'buffered_low':
				if (this.#channels.get(Number(fields.index))?.sent)
					this.#event({ ev: 'channelLow', channel: Number(fields.index) });
				break;
			// the peer closed its end (a DTLS close_notify, an SCTP abort):
			// every channel closes at once, and the connection reads
			// disconnected when the browser's would, once its checks have
			// gone unanswered for a while
			case 'closed':
				for (const channel of this.#channels.keys())
					this.#event({ ev: 'channelClose', channel });
				this.#channels.clear();
				for (const state of this.#medias.values())
					state.sender?.setActive(false);
				if (!this.#connected) {
					this.#setIce('failed');
					this.#setConnection('failed');
				} else
					setTimeout(() => {
						if (this.#closed) return;
						this.#setIce('disconnected');
						this.#setConnection('disconnected');
					}, PEER_GONE_MS);
				break;
			case 'error':
				this.#event({ ev: 'error', message: fields.message ?? '' });
				break;
		}
	}

	/** the agent's state as the page's two state machines show it */
	#stackIce(state: RTCIceConnectionState) {
		// the agent has no "failed": it is disconnected without ever
		// having connected
		if (state === 'disconnected' && !this.#connected) {
			this.#setIce('failed');
			this.#setConnection('failed');
			return;
		}
		// Chrome's agent is connected before it is completed
		if (state === 'completed' && this.#iceState !== 'connected')
			this.#setIce('connected');
		this.#setIce(state);
		if (state === 'checking' && this.#connectionState === 'new')
			this.#setConnection('connecting');
		else if (state === 'disconnected') this.#setConnection('disconnected');
		else if (
			(state === 'connected' || state === 'completed') &&
			this.#connected
		)
			this.#setConnection('connected');
	}
	#setIce(state: RTCIceConnectionState) {
		if (this.#iceState === state || this.#closed) return;
		this.#iceState = state;
		this.#event({ ev: 'ice', state });
	}
	#setConnection(state: RTCPeerConnectionState) {
		if (this.#connectionState === state || this.#closed) return;
		this.#connectionState = state;
		this.#event({ ev: 'connection', state });
	}
	#setGathering(state: RTCIceGatheringState) {
		if (this.#gathering === state) return;
		this.#gathering = state;
		this.#event({ ev: 'gathering', state });
	}

	// --- the local description and its candidates ---

	/**
	 * A candidate as Chrome writes one. What the page signals is not what
	 * the stack pairs with (the peer learns this side from its checks, as a
	 * peer-reflexive candidate), so the foundation and the priority are
	 * Chrome's for the type: a decimal foundation, and the priorities of a
	 * host, a server-reflexive and a UDP relay candidate on one network.
	 */
	#candidate(
		type: 'host' | 'srflx' | 'relay',
		address: string,
		port: number | string,
		related: [string, number | string] | null,
		server = '',
	): string {
		// FNV-1a of what Chrome's foundation covers: the type, the base and
		// the server
		let hash = 0x811c9dc5;
		for (const char of `${type}/${this.#name}/${server}`)
			hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
		return [
			`candidate:${hash}`,
			'1',
			'udp',
			CANDIDATE_PRIORITY[type],
			address,
			port,
			'typ',
			type,
			...(related ? ['raddr', related[0], 'rport', related[1]] : []),
			...this.#trailer(),
		].join(' ');
	}

	/**
	 * The ICE credentials the stack's description carries: new ones after
	 * an ICE restart, which also starts gathering over
	 */
	#takeCredentials() {
		const media = this.#lastLocal?.medias[0];
		if (!media) return;
		const own = (name: string) =>
			first(media.attributes, name) ?? first(this.#lastLocal!.session, name);
		const ufrag = own('ice-ufrag');
		const pwd = own('ice-pwd');
		if (ufrag && ufrag !== this.#ufrag) {
			this.#ufrag = ufrag;
			this.#resetGathering();
		}
		if (pwd) this.#pwd = pwd;
	}

	#render(parsed: ParsedSdp): string {
		return renderChrome(parsed, {
			sessionId: this.#sessionId,
			version: this.#version,
			candidates: this.#shown,
			ufrag: this.#ufrag,
			pwd: this.#pwd,
			fingerprint: this.#fingerprint,
		});
	}

	#pushLocal() {
		if (this.#lastLocal)
			this.#event({ ev: 'local', sdp: this.#render(this.#lastLocal) });
	}

	#show(candidate: string) {
		this.#shown.push(candidate);
		const mid = this.#lastLocal?.medias[0]
			? (first(this.#lastLocal.medias[0].attributes, 'mid') ?? '0')
			: '0';
		const init: CandidateInit = {
			candidate,
			sdpMid: mid,
			sdpMLineIndex: 0,
			usernameFragment: this.#ufrag,
		};
		this.#pushLocal();
		this.#event({ ev: 'icecandidate', candidate: init });
	}

	/** the trailing fields Chrome writes on a candidate it shows */
	#trailer(): string[] {
		return ['generation', '0', 'ufrag', this.#ufrag, 'network-cost', '999'];
	}

	/** gathering, as Chrome runs it after setLocalDescription: the host candidate, then each server */
	#gather() {
		if (this.#gathering !== 'new' || this.#closed) return;
		this.#setGathering('gathering');
		const relayOnly = this.#config.iceTransportPolicy === 'relay';
		// the host candidate: this document's name, which resolves nowhere
		// but in the bridge between two documents of this browser
		if (!relayOnly)
			this.#show(this.#candidate('host', this.#name, this.#localPort, null));
		// one Binding request per server address, as Chrome asks it once; a
		// TURN server is asked as a STUN server too
		const asked = new Set<string>();
		for (const server of parseServers(this.#config)) {
			const address = joinAddress(server.host, server.port);
			if (!relayOnly && server.transport === 'udp' && !asked.has(address)) {
				asked.add(address);
				this.#query(server);
			}
			// as Chrome, which allocates on no system port but 53, 80 and 443
			if (
				server.relay &&
				(server.port >= 1024 || [53, 80, 443].includes(server.port))
			)
				this.#allocate(server);
		}
		this.#gathered();
	}

	/** gathering is complete once every gatherer is */
	#gathered() {
		if (this.#gathering !== 'gathering') return;
		if (!this.#gatherers.every((gatherer) => gatherer.done)) return;
		this.#event({ ev: 'icecandidate', candidate: null });
		this.#setGathering('complete');
	}

	/**
	 * An icecandidateerror as Chrome words one: `url` is the server as it
	 * asked it (stun:host:port for a Binding request, whatever the page's
	 * URL said, turn:host:port?transport= for an allocation), and a
	 * connection that never came up (`local` false) has no local address
	 */
	#candidateError(
		url: string,
		errorCode: number,
		errorText: string,
		local = true,
	) {
		this.#event({
			ev: 'icecandidateerror',
			error: {
				address: local ? '0.0.0.x' : null,
				port: local ? this.#localPort : null,
				url,
				errorCode,
				errorText,
				hostCandidate: local ? `0.0.0.x:${this.#localPort}` : ':0',
			},
		});
	}

	/** a Binding request to a server, for a srflx candidate */
	#query(server: Server) {
		const { bytes, id } = bindingRequest();
		const timers: ReturnType<typeof setTimeout>[] = [];
		let stream: Stream | null = null;
		const gatherer: Gatherer = {
			done: false,
			stop: () => {
				gatherer.done = true;
				for (const timer of timers) clearTimeout(timer);
				stream?.close();
			},
		};
		this.#gatherers.push(gatherer);
		const finish = (error?: boolean) => {
			if (gatherer.done) return;
			gatherer.stop();
			if (error)
				this.#candidateError(
					`stun:${joinAddress(server.host, server.port)}`,
					701,
					'STUN binding request timed out.',
				);
			this.#gathered();
		};
		stream = new WispStream(
			this.#opener.stream('udp', server.host, server.port),
			(answer) => {
				if (gatherer.done || !isAnswerTo(answer, id)) return;
				const reflexive = reflexiveOf(answer);
				if (!reflexive || 'error' in reflexive) {
					finish(true);
					return;
				}
				// the related address is the host's, which Chrome hides
				this.#show(
					this.#candidate(
						'srflx',
						reflexive.address,
						reflexive.port,
						['0.0.0.0', 0],
						joinAddress(server.host, server.port),
					),
				);
				finish();
			},
			() => {
				// refused by the wisp server (no UDP, a private address): as a
				// server that never answers
			},
		);
		for (const ms of STUN_SCHEDULE_MS)
			timers.push(setTimeout(() => stream?.send(bytes), ms));
		timers.push(setTimeout(() => finish(true), STUN_GIVE_UP_MS));
	}

	/** an allocation on a TURN server, for a relay candidate */
	#allocate(server: Server) {
		const gatherer: Gatherer = { done: false, stop: () => {} };
		this.#gatherers.push(gatherer);
		const url = `${server.tls ? 'turns' : 'turn'}:${joinAddress(server.host, server.port)}?transport=${server.transport}`;
		if (server.transport !== 'udp') {
			// TURN over TCP and TLS is not carried yet: as a server that
			// refuses the connection
			gatherer.done = true;
			this.#candidateError(url, 701, 'Failed to establish connection', false);
			return;
		}
		let relayed: string | null = null;
		let allocation: TurnAllocation | null = null;
		const stream = new WispStream(
			this.#opener.stream('udp', server.host, server.port),
			(bytes) => allocation?.receive(bytes),
			() => {},
		);
		allocation = new TurnAllocation({
			username: server.username,
			credential: server.credential,
			stream,
			onAllocated: (address, mapped) => {
				relayed = joinAddress(address.address, address.port);
				const result = this.#control({
					op: 'relay_candidate',
					addr: relayed,
					local: this.#local,
				});
				if (result.candidate) {
					this.#relays.set(relayed, allocation!);
					// the related address is this side's as the server saw it:
					// the edge's, as in the srflx candidate
					this.#show(
						this.#candidate(
							'relay',
							address.address,
							address.port,
							[mapped?.address ?? '0.0.0.0', mapped?.port ?? 0],
							joinAddress(server.host, server.port),
						),
					);
				}
				gatherer.done = true;
				this.#gathered();
			},
			onFailed: (reason) => {
				if (relayed) this.#relays.delete(relayed);
				if (gatherer.done) return;
				gatherer.done = true;
				if (reason === 'timeout')
					this.#candidateError(url, 701, 'TURN allocate request timed out.');
				else this.#candidateError(url, 401, 'Unauthorized');
				this.#gathered();
			},
			onData: (peer, bytes) => {
				if (relayed) this.#receive('udp', peer, bytes, relayed);
			},
		});
		gatherer.stop = () => {
			gatherer.done = true;
			if (relayed) this.#relays.delete(relayed);
			allocation?.close();
		};
	}

	#resetGathering() {
		for (const gatherer of this.#gatherers) gatherer.stop();
		this.#gatherers = [];
		this.#shown = [];
		this.#gathering = 'new';
	}

	// --- the page's requests ---

	#request(request: Request) {
		const reply = (value: unknown) =>
			this.#post({ seq: request.seq, ok: true, value });
		const fail = (name: string, message: string) =>
			this.#post({ seq: request.seq, ok: false, name, message });
		try {
			switch (request.op) {
				case 'createOffer': {
					if (request.iceRestart || this.#restart) {
						const restarted = this.#control({ op: 'ice_restart' });
						if (restarted.error) throw restarted.error;
						this.#restart = false;
					}
					const result = this.#control({ op: 'offer' });
					if (result.error) throw result.error;
					this.#lastLocal = parseSdp(this.#mids.toShown(result.sdp ?? ''));
					this.#takeMids(result.mids);
					this.#takeCredentials();
					this.#version++;
					reply(this.#render(this.#lastLocal));
					break;
				}
				case 'createAnswer': {
					if (!this.#pendingAnswer) throw 'no remote offer to answer';
					this.#lastLocal = this.#pendingAnswer;
					this.#takeCredentials();
					this.#version++;
					reply(this.#render(this.#lastLocal));
					break;
				}
				case 'setLocal': {
					if (request.type === 'rollback') {
						this.#control({ op: 'rollback' });
						reply(null);
						break;
					}
					reply(this.#sections());
					this.#localSet = true;
					for (const candidate of this.#heldRemotes.splice(0))
						try {
							this.#addRemote(candidate);
						} catch (error) {
							// one the stack refuses: dropped, as it would drop it
						}
					this.#gather();
					break;
				}
				case 'setRemote': {
					if (request.type === 'rollback') {
						this.#control({ op: 'rollback' });
						reply(null);
						break;
					}
					const { sdp, candidates } = stripCandidates(
						this.#mids.toStack(request.sdp),
					);
					const described = parseSdp(request.sdp);
					const before = this.#remote;
					this.#remote = described;
					let result: Record<string, string>;
					if (request.type === 'offer') {
						// What this side wants of each section: a transceiver's
						// direction for one it has, and all of what is offered
						// for a new one. The stack tells of a new section only
						// once its media flows; with a direction named for it,
						// it numbers the section now.
						const fields: Record<string, string> = { op: 'remote_offer', sdp };
						described.medias.forEach((media, at) => {
							if (media.kind !== 'audio' && media.kind !== 'video') return;
							const mid = first(media.attributes, 'mid');
							let wanted: Direction = 'sendrecv';
							for (const state of this.#medias.values())
								if (state.mid !== null && state.mid === mid)
									wanted = state.wanted;
							fields[`dir${at}`] = wanted;
						});
						result = this.#control(fields);
					} else result = this.#control({ op: 'answer', sdp });
					if (result.error) {
						this.#remote = before;
						throw result.error;
					}
					// what the peer asks of a section it already had may have
					// changed with this description
					for (const index of this.#medias.keys()) this.#negotiated(index);
					if (request.type === 'offer') {
						this.#pendingAnswer = parseSdp(
							this.#mids.toShown(result.sdp ?? ''),
						);
						this.#takeMids(result.mids, described);
					}
					// the description's candidates, as if each had been added
					for (const candidate of candidates)
						if (this.#localSet)
							try {
								this.#addRemote(candidate);
							} catch (error) {
								// one the stack refuses: dropped, as it would drop it
							}
						else this.#heldRemotes.push(candidate);
					this.#remoteSet = true;
					reply(this.#sections(described));
					if (this.#heldIce) {
						const held = this.#heldIce;
						this.#heldIce = null;
						this.#stackIce(held);
					}
					break;
				}
				case 'addCandidate': {
					if (!candidateFields(request.candidate))
						throw 'Expect line: candidate:<candidate-str>';
					if (this.#localSet) this.#addRemote(request.candidate);
					else this.#heldRemotes.push(request.candidate);
					reply(null);
					break;
				}
				case 'createChannel': {
					const { options } = request;
					const fields: Record<string, string | number> = {
						op: 'channel',
						label: options.label,
						ordered: options.ordered ? 1 : 0,
						protocol: options.protocol,
					};
					if (options.maxRetransmits !== null)
						fields.maxRetransmits = options.maxRetransmits;
					else if (options.maxPacketLifeTime !== null)
						fields.maxPacketLifeTime = options.maxPacketLifeTime;
					if (options.negotiated && options.id !== null)
						fields.negotiated = options.id;
					const result = this.#control(fields);
					if (result.error) throw result.error;
					const channel = Number(result.index);
					this.#channels.set(channel, { options, open: false });
					reply(channel);
					break;
				}
				case 'send': {
					const sending = this.#channels.get(request.channel);
					if (sending) sending.sent = true;
					const bytes =
						typeof request.data === 'string'
							? text.encode(request.data)
							: new Uint8Array(request.data);
					const status = this.#stack.input(
						this.#id,
						IN_CHANNEL_SEND,
						encodeChannelSend(request.channel, request.binary, bytes),
					);
					const result = this.#drain(true);
					if (status !== 0) throw result?.error ?? 'send failed';
					reply(null);
					break;
				}
				case 'closeChannel': {
					this.#event({ ev: 'channelClosing', channel: request.channel });
					this.#control({ op: 'channel_close', index: request.channel });
					reply(null);
					break;
				}
				case 'lowThreshold': {
					this.#control({
						op: 'low_threshold',
						index: request.channel,
						value: request.value,
					});
					reply(null);
					break;
				}
				case 'addMedia': {
					const result = this.#control({
						op: 'media',
						kind: request.kind,
						dir: request.direction,
						// what the section's `a=msid` names: the track's first
						// stream, or none ("-")
						stream: request.streams[0] ?? '-',
						...(request.track === null ? {} : { track: request.track }),
					});
					if (result.error) throw result.error;
					this.#addMedia(
						Number(result.index),
						request.kind,
						request.handle,
						request.direction,
					);
					reply(null);
					break;
				}
				case 'mediaDirection': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					const result = this.#control({
						op: 'direction',
						index: state.index,
						dir: request.direction,
					});
					if (result.error) throw result.error;
					state.wanted = request.direction;
					reply(null);
					break;
				}
				case 'stopMedia': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					this.#control({ op: 'stop', index: state.index });
					state.sender?.close();
					state.receiver?.close();
					reply(null);
					break;
				}
				case 'sendTrack': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.sender?.setTrack(request.readable);
					reply(null);
					break;
				}
				case 'receiveTrack': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.receiver?.setTrack(request.writable);
					reply(null);
					break;
				}
				case 'setConfiguration':
					this.#config = request.config;
					reply(null);
					break;
				case 'restartIce':
					this.#restart = true;
					reply(null);
					break;
				case 'stats':
					reply({
						ice: this.#iceState,
						connection: this.#connectionState,
						local: this.#shown,
						media: [...this.#medias.values()].map((state) => ({
							handle: state.handle,
							mid: state.mid,
							direction: state.direction,
							sent: state.sender?.stats ?? null,
							received: state.receiver?.stats ?? null,
						})),
					});
					break;
				case 'close':
					reply(null);
					this.close();
					break;
			}
		} catch (error) {
			fail('OperationError', String((error as Error)?.message ?? error));
		}
	}

	/** a remote candidate the page added: at an address, or at a name */
	#addRemote(candidate: string) {
		const fields = candidateFields(candidate);
		if (!fields) return;
		if (!isAddress(fields.address)) {
			this.#addNamed(candidate);
			return;
		}
		const result = this.#control({
			op: 'remote_candidate',
			candidate: candidateLine(fields),
		});
		if (result.error) throw result.error;
	}

	/** a remote candidate at a name: another document's, reached over the bridge */
	#addNamed(candidate: string) {
		const fields = candidateFields(candidate);
		if (!fields) return;
		if (!fields.address.endsWith('.local')) return;
		fields.address = this.#bridgeAddress(fields.address);
		this.#control({ op: 'remote_candidate', candidate: candidateLine(fields) });
	}

	/**
	 * Closed for the page at once. The stack says goodbye first (the SCTP
	 * shutdown, the DTLS close_notify), so that the peer's channels close
	 * now and not when its checks time out: it is driven a moment longer,
	 * on the streams it has, and then everything goes.
	 */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#port.close();
		for (const state of this.#medias.values()) {
			state.sender?.close();
			state.receiver?.close();
		}
		this.#control({ op: 'close' });
		setTimeout(() => this.#end(), CLOSE_LINGER_MS);
	}

	#end() {
		if (this.#ended) return;
		this.#ended = true;
		this.#resetGathering();
		if (this.#timer !== null) clearTimeout(this.#timer);
		for (const stream of this.#streams.values()) stream.close();
		this.#streams.clear();
		this.#bridge?.close();
		this.#stack.destroy(this.#id);
	}
}
