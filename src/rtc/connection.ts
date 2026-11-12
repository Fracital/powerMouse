// A document's WebRTC connections as the worker runs them
// (docs/webrtc-over-wisp.md): the stack (rust/rtc, str0m in wasm, sans-IO)
// driven with records in, records out and a timer, the streams every packet
// travels on, and the page's RTCPeerConnection stand-in answered over a
// port per connection. Nothing here opens a socket: the only network is
// the opener the worker hands in, which carries wisp streams.
import { WEBRTC_CHANNEL } from '../transport/messages';
import { compileModule, type ModuleSource } from '../wasm/module';
import { peerAbort } from './abort';
import { AudioReceiver, AudioSender } from './audio';
import { hex, type Certificate } from './certificate';
import { parseParameters, parsePayloads, type Formats } from './formats';
import type {
	CandidateInit,
	ChannelOptions,
	CodecCapability,
	CodecStats,
	ConnectionConfig,
	Direction,
	MediaSection,
	MediaStats,
	Negotiated,
	Request,
	StatsReply,
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
	offerForStack,
	parseSdp,
	rejects,
	renderChrome,
	stripCandidates,
	withGroup,
	type Media,
	type ParsedSdp,
	type SectionStyle,
} from './sdp';
import { TransportStats } from './stats';
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
/** Chrome's gathering, its TCP step included, when no server keeps it longer */
const GATHER_STEPS_MS = 120;
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
	/** what the answer this side made says of it, until that answer is set */
	answer: Direction | null;
	/** the streams and the name of what it sends, as `a=msid` states them */
	streams: string[];
	track: string;
	/** the page made it with addTrack: a section the peer offers may take it */
	byTrack: boolean;
	/** a description of this side has had it send: its sender stays named */
	everSent: boolean;
	stopped: boolean;
	/** the page turned the sender's encoding off (setParameters) */
	paused: boolean;
	/** the header extensions it last agreed on, by URI; null before it has */
	exts: Set<string> | null;
	/** the page's codec preferences (setCodecPreferences); empty for the browser's own */
	codecs: CodecCapability[];
	legacyCodecs: boolean;
	/** the answer this side made rejects it: nothing it prefers was offered */
	rejected: boolean;
	sender: AudioSender | null;
	receiver: AudioReceiver | null;
}

const sends = (direction: Direction) =>
	direction === 'sendrecv' || direction === 'sendonly';
const receives = (direction: Direction) =>
	direction === 'sendrecv' || direction === 'recvonly';
const directionOf = (send: boolean, receive: boolean): Direction =>
	send
		? receive
			? 'sendrecv'
			: 'sendonly'
		: receive
			? 'recvonly'
			: 'inactive';
const midOf = (parsed: ParsedSdp | null | undefined, mid: string | null) =>
	mid === null
		? undefined
		: parsed?.medias.find((media) => first(media.attributes, 'mid') === mid);
/** the URIs of a section's header extensions */
const extensionsOf = (media: Media) =>
	new Set(all(media.attributes, 'extmap').map((value) => value.split(' ')[1]));
const BASE64 =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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
	/**
	 * The connection is up and gathering over: what it finds is never shown,
	 * but it runs its course on the wire, as Chrome's ports do
	 */
	quiet(): void;
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

/** a server's URL as a candidate that came from it tells it */
const serverUrl = (server: Server) =>
	`${server.relay ? (server.tls ? 'turns' : 'turn') : 'stun'}:${joinAddress(server.host, server.port)}${server.relay ? `?transport=${server.transport}` : ''}`;

function base64(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
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
	/** this browser's own offer: the shape of the media sections the page reads */
	#template: ParsedSdp | null;
	/** the name the descriptions list every source under, as Chrome makes one a connection */
	#cname = '';
	/** how the sections of the last local description are written, and the offer it answers */
	#styles = new Map<string, SectionStyle>();
	#answers: ParsedSdp | null = null;
	/** the last local description is an offer */
	#offered = false;
	/** the peer's description, as the page set it last */
	#remote: ParsedSdp | null = null;
	#draining = 0;
	#ufrag = '';
	/** ICE restarts so far: the generation of the candidates gathered now */
	#generation = 0;
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
	/** what getStats() tells of the candidates, the pairs and the handshake */
	#stats = new TransportStats(
		(pair) => this.#event({ ev: 'pair', ...pair }),
		() => {
			if (!this.#checkingHeld) return;
			this.#checkingHeld = false;
			this.#checking();
		},
	);
	/** the agent is checking, but no pair has formed yet */
	#checkingHeld = false;
	#remoteUfrag = '';

	constructor(
		stack: Stack,
		port: MessagePort,
		opener: StreamOpener,
		config: ConnectionConfig,
		certificate: Certificate,
		formats: Formats | null = null,
		template: ParsedSdp | null = null,
	) {
		this.#stack = stack;
		this.#port = port;
		this.#opener = opener;
		this.#config = config;
		this.#certificate = certificate;
		this.#fingerprint = certificate.fingerprint;
		this.#template = template;
		for (const byte of crypto.getRandomValues(new Uint8Array(16)))
			this.#cname += BASE64[byte & 63];
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
		streams: string[] = [],
		track = uuid(),
		byTrack = false,
	) {
		const state: MediaState = {
			handle,
			index,
			kind,
			mid: null,
			wanted,
			direction: null,
			answer: null,
			streams,
			track,
			byTrack,
			everSent: false,
			stopped: false,
			paused: false,
			codecs: [],
			legacyCodecs: false,
			rejected: false,
			exts: null,
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
		const described = midOf(this.#remote, state.mid);
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
		state.receiver?.configure(payloads);
		// what the wire's payload types are, for the streams' counts: G.722
		// is stamped at 8000 Hz whatever the stack counts it at
		this.#stats.payloads(
			new Map(
				payloads.map((payload) => {
					const name = payload.name.toLowerCase();
					return [
						payload.pt,
						{
							clock: name === 'g722' ? 8000 : payload.clock,
							sound: !['telephone-event', 'cn', 'red'].includes(name),
						},
					];
				}),
			),
		);
		this.#activate(state);
	}

	/** a payload of the browser's (the template's line for it), as a codec stats entry tells it */
	#codecOf(kind: string, pt: number | null): CodecStats | null {
		if (pt === null) return null;
		const model = this.#template?.medias.find((media) => media.kind === kind);
		const map = model
			? all(model.attributes, 'rtpmap').find((value) =>
					value.startsWith(`${pt} `),
				)
			: undefined;
		if (!map) return null;
		const [name, clock, channels] = map.slice(map.indexOf(' ') + 1).split('/');
		const fmtp = all(model!.attributes, 'fmtp').find((value) =>
			value.startsWith(`${pt} `),
		);
		return {
			payloadType: pt,
			mimeType: `${kind}/${name}`,
			clockRate: Number(clock),
			...(kind === 'audio' && { channels: Number(channels || 1) }),
			...(fmtp !== undefined && {
				sdpFmtpLine: fmtp.slice(fmtp.indexOf(' ') + 1),
			}),
		};
	}

	/**
	 * A section's streams for getStats(): what goes out once both
	 * descriptions are applied and the section sends, what came in once
	 * a packet has, what the peer's RTCP last said of each, and the sound
	 * as the worker measured it
	 */
	#mediaStats(state: MediaState, rtp: ReturnType<TransportStats['rtp']>) {
		const stats: MediaStats = {};
		if (state.mid === null || state.stopped || state.kind !== 'audio')
			return stats;
		const source = state.sender?.source;
		if (source) stats.source = source;
		// the streams are the stack's once a negotiation has the section
		const reports = this.#control({ op: 'rtcp', index: state.index });
		if (reports.error) return stats;
		const number = (key: string) =>
			reports[key] === undefined || reports[key] === ''
				? undefined
				: Number(reports[key]);
		const when = (key: string) => Date.now() - number(key)! / 1000;
		const seconds = (key: string) =>
			number(key) === undefined ? undefined : number(key)! / 1e6;
		const tx = number('tx');
		const sending = state.sender?.sending ?? null;
		if (
			tx !== undefined &&
			state.direction !== null &&
			sends(state.direction)
		) {
			const count = rtp.sent.find((entry) => entry.ssrc === tx);
			stats.outbound = {
				ssrc: tx,
				codec: this.#codecOf(state.kind, count?.pt ?? sending?.pt ?? null),
				packets: count?.packets ?? 0,
				bytes: count?.bytes ?? 0,
				header: count?.header ?? 0,
				bitrate: sending?.bitrate ?? 0,
				active: !state.paused,
			};
			if (number('rr_age') !== undefined)
				stats.remoteInbound = {
					at: when('rr_age'),
					fractionLost: number('rr_fraction')! / 256,
					packetsLost: number('rr_lost')!,
					jitter: number('rr_jitter')!,
					roundTripTime: seconds('rr_rtt'),
					measurements: number('rr_rtts')!,
					totalRoundTripTime: seconds('rr_rtt_total')!,
				};
		}
		const rx = number('rx');
		const heard = rtp.received.find((entry) => entry.ssrc === rx);
		if (heard) {
			stats.inbound = {
				...heard,
				codec: this.#codecOf(state.kind, heard.pt),
				played: state.receiver?.played ?? null,
			};
			if (number('sr_age') !== undefined)
				stats.remoteOutbound = {
					at: when('sr_age'),
					remoteTimestamp: number('sr_ntp')! / 1000,
					packets: number('sr_packets')!,
					bytes: number('sr_octets')!,
					reports: number('sr_count')!,
					roundTripTime: seconds('sr_rtt'),
					measurements: number('sr_rtts')!,
					totalRoundTripTime: seconds('sr_rtt_total')!,
				};
		}
		return stats;
	}

	/** a section sends when its direction says so and the connection is up */
	#activate(state: MediaState) {
		state.sender?.setActive(
			this.#connected &&
				!this.#closed &&
				!state.stopped &&
				!state.paused &&
				state.direction !== null &&
				sends(state.direction),
		);
		// what is heard after a section stopped receiving is a new start
		if (state.direction !== null && !receives(state.direction))
			state.receiver?.rearm();
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
			const described = midOf(remote, state.mid);
			if (described) {
				section.remote = remoteOf(described);
				// a section the peer stopped: its port is 0
				if (described.port === '0') this.#stopped(state);
			}
			if (state.stopped) section.stopped = true;
			if (state.sender?.canTone) section.dtmf = true;
			medias.push(section);
		}
		return { medias };
	}

	/** a stopped section sends and plays nothing more */
	#stopped(state: MediaState) {
		if (state.stopped) return;
		state.stopped = true;
		state.sender?.close();
		state.receiver?.close();
	}

	/**
	 * A section the peer offered first. The transceiver a browser makes for
	 * one receives only, until the page gives it something to send: that
	 * is what a later offer of this side says of it.
	 */
	#newFromPeer(index: number, kind: 'audio' | 'video'): MediaState {
		return this.#addMedia(index, kind, this.#nextHandle--, 'recvonly');
	}

	/**
	 * The stack's `index:mid` list: the names its sections have now. A
	 * section of ours that is not in it has no name (again: the offer that
	 * named it was rolled back). With the peer's offer, a section in the
	 * list that is new here is one the peer offered first. It goes to a
	 * transceiver the page made with addTrack and no offer has carried yet,
	 * when there is one of its kind and the peer receives on the section
	 * (as a browser pairs them: the stack's own section for that
	 * transceiver is taken back); otherwise the page gets a new
	 * transceiver for it.
	 */
	#takeMids(list: string | undefined, offer?: ParsedSdp) {
		const named = new Map<number, string>();
		for (const entry of (list ?? '').split(',')) {
			const at = entry.indexOf(':');
			if (at !== -1) named.set(Number(entry.slice(0, at)), entry.slice(at + 1));
		}
		for (const state of this.#medias.values())
			if (!named.has(state.index)) state.mid = null;
		for (const [index, mid] of named) {
			let state = this.#medias.get(index);
			if (!state) {
				const section = midOf(offer, mid);
				const kind = section?.kind;
				if (!section || (kind !== 'audio' && kind !== 'video')) continue;
				if (receives(remoteOf(section).direction))
					for (const own of this.#handles.values())
						if (
							own.byTrack &&
							own.mid === null &&
							!own.stopped &&
							own.kind === kind
						) {
							state = own;
							break;
						}
				if (state) {
					this.#control({ op: 'withdraw', index: state.index });
					this.#medias.delete(state.index);
					state.index = index;
					if (state.sender) state.sender.media = index;
					this.#medias.set(index, state);
				} else state = this.#newFromPeer(index, kind);
			}
			state.mid = mid;
			this.#negotiated(index);
		}
	}

	/**
	 * How the sections of a local description are written (sdp.ts): what
	 * each transceiver wants, or in an answer what it takes of the offer,
	 * and what its sender is called. Chrome names a sender once its
	 * transceiver wants to send or a description has had it send, with
	 * the source it sends from, whichever way the section goes now.
	 */
	#describe(local: ParsedSdp, answers: ParsedSdp | null) {
		const styles = new Map<string, SectionStyle>();
		for (const state of this.#medias.values()) {
			const section = midOf(local, state.mid);
			if (!section || state.mid === null) continue;
			const stopped = state.stopped || section.port === '0';
			let direction = state.wanted;
			state.rejected =
				!!answers &&
				!stopped &&
				rejects(
					section,
					this.#template?.medias.find((media) => media.kind === state.kind),
					state.codecs,
				);
			if (answers) {
				const offered = midOf(answers, state.mid);
				const theirs = offered ? remoteOf(offered).direction : 'inactive';
				direction = directionOf(
					sends(state.wanted) && receives(theirs),
					receives(state.wanted) && sends(theirs),
				);
				state.answer = stopped ? null : direction;
			}
			const named = !stopped && (sends(state.wanted) || state.everSent);
			const ssrcs: string[] = [];
			const groups = named ? all(section.attributes, 'ssrc-group') : [];
			if (named) {
				for (const value of all(section.attributes, 'ssrc')) {
					const ssrc = value.split(' ')[0];
					if (!ssrcs.includes(ssrc)) ssrcs.push(ssrc);
				}
				// a section that has not sent: the source it will send from
				if (!ssrcs.length && state.direction !== null) {
					const made = this.#control({ op: 'ssrc', index: state.index });
					if (made.ssrc) ssrcs.push(made.ssrc);
					if (made.ssrc && made.rtx) {
						ssrcs.push(made.rtx);
						groups.push(`FID ${made.ssrc} ${made.rtx}`);
					}
				}
			}
			styles.set(state.mid, {
				direction: stopped ? 'inactive' : direction,
				sender: named
					? { streams: [...state.streams], track: state.track }
					: null,
				ssrcs,
				groups,
				exts: state.exts,
				codecs: state.codecs,
				rejected: state.rejected,
				legacy: state.legacyCodecs,
			});
		}
		this.#styles = styles;
		this.#answers = answers;
		this.#offered = !answers;
	}

	/** an answer was applied: what the section has agreed on from here */
	#settle(state: MediaState, answer: Media | undefined) {
		if (!answer) return;
		if (state.direction !== null && sends(state.direction))
			state.everSent = true;
		state.exts = extensionsOf(answer);
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
		this.#stats.sent(transmit.source, transmit.destination, transmit.payload);
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
		this.#stats.received(local, remote, bytes);
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
			case 'connected': {
				this.#connected = true;
				// the DTLS transport's: the peer's certificate, as the page reads it
				const der = this.#remoteDer();
				this.#event(
					{ ev: 'dtls', state: 'connected', certificate: der?.buffer ?? null },
					der ? [der.buffer] : [],
				);
				this.#setConnection('connected');
				for (const state of this.#medias.values()) this.#activate(state);
				break;
			}
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
				state.mid = fields.mid ?? '';
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
			case 'closed': {
				const abort =
					fields.abort === undefined
						? undefined
						: peerAbort(Number(fields.abort), fields.reason ?? '');
				this.#event({ ev: 'dtls', state: 'closed', certificate: null });
				for (const channel of this.#channels.keys())
					this.#event({ ev: 'channelClose', channel, abort });
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
			}
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
		// Chrome's agent never says "completed" (its ICE transport has no
		// such state, measured on 152 and 156, end-of-candidates both ways
		// or not): connected is as far as it goes
		if (state === 'completed') state = 'connected';
		// Chrome's agent is checking once it has a pair to check: a remote
		// candidate added, or a check of the peer's heard
		if (state === 'checking') {
			if (this.#stats.paired) this.#checking();
			else this.#checkingHeld = true;
			return;
		}
		this.#checkingHeld = false;
		if (state === 'connected') {
			if (this.#iceState === 'new') this.#checking();
			// a pair is selected before the agent says it is connected
			this.#stats.settle();
		}
		this.#setIce(state);
		// Chrome stops gathering once a pair of the current credentials is
		// up: what a server has not answered by then is never shown
		if (state === 'connected') this.#stopGathering();
		if (state === 'disconnected') this.#setConnection('disconnected');
		else if (state === 'connected' && this.#connected)
			this.#setConnection('connected');
	}
	#checking() {
		this.#setIce('checking');
		if (this.#connectionState === 'new') this.#setConnection('connecting');
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
			// each restart's candidates are of the next generation, as Chrome numbers them
			this.#generation++;
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
			template: this.#template,
			offer: this.#offered,
			answers: this.#answers,
			cname: this.#cname,
			sections: this.#styles,
		});
	}

	#pushLocal() {
		if (this.#lastLocal)
			this.#event({ ev: 'local', sdp: this.#render(this.#lastLocal) });
	}

	/** `base`: the address the stack sends from for it; `url`: the server it came from */
	#show(
		candidate: string,
		base: string | null,
		url = '',
		relayProtocol?: string,
	) {
		this.#shown.push(candidate);
		this.#stats.local(candidate, base, url, relayProtocol);
		const mid = this.#lastLocal?.medias[0]
			? (first(this.#lastLocal.medias[0].attributes, 'mid') ?? '0')
			: '0';
		const init: CandidateInit = {
			candidate,
			sdpMid: mid,
			sdpMLineIndex: 0,
			usernameFragment: this.#ufrag,
			url,
			relayProtocol: relayProtocol ?? null,
		};
		this.#pushLocal();
		this.#event({ ev: 'icecandidate', candidate: init });
	}

	/** the trailing fields Chrome writes on a candidate it shows */
	#trailer(): string[] {
		return [
			'generation',
			String(this.#generation),
			'ufrag',
			this.#ufrag,
			'network-cost',
			'999',
		];
	}

	/** gathering, as Chrome runs it after setLocalDescription: the host candidate, then each server */
	#gather() {
		if (this.#gathering !== 'new' || this.#closed) return;
		this.#setGathering('gathering');
		const relayOnly = this.#config.iceTransportPolicy === 'relay';
		// the host candidate: this document's name, which resolves nowhere
		// but in the bridge between two documents of this browser
		if (!relayOnly) {
			this.#show(
				this.#candidate('host', this.#name, this.#localPort, null),
				this.#local,
			);
			// another document given the name checks it before this one has
			// any of its candidates: it is heard, a peer reflexive candidate
			this.#openBridge();
		}
		// Chrome's gathering runs in steps 50 ms apart, the last one for TCP
		// candidates (which it shows none of behind mDNS names): it is
		// complete no sooner than that, measured 118 to 144 ms after it began
		const timer = setTimeout(() => {
			phases.done = true;
			this.#gathered();
		}, GATHER_STEPS_MS);
		const phases: Gatherer = {
			done: false,
			stop: () => {
				phases.done = true;
				clearTimeout(timer);
			},
			quiet: () => phases.stop(),
		};
		this.#gatherers.push(phases);
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
		// Chrome tells the state before the end of candidates
		this.#setGathering('complete');
		this.#event({ ev: 'icecandidate', candidate: null });
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
		let over = false;
		let muted = false;
		const end = () => {
			over = true;
			for (const timer of timers) clearTimeout(timer);
			stream?.close();
		};
		const gatherer: Gatherer = {
			done: false,
			stop: () => {
				gatherer.done = true;
				end();
			},
			quiet: () => {
				gatherer.done = true;
				muted = true;
			},
		};
		this.#gatherers.push(gatherer);
		const finish = (error?: boolean) => {
			if (over) return;
			gatherer.done = true;
			end();
			if (muted) return;
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
				if (over || !isAnswerTo(answer, id)) return;
				if (muted) {
					finish();
					return;
				}
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
					null,
					serverUrl(server),
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
		let muted = false;
		const gatherer: Gatherer = {
			done: false,
			stop: () => {},
			quiet: () => {
				gatherer.done = true;
				muted = true;
			},
		};
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
				// gathering ended meanwhile: the relay is not shown, nor kept
				if (muted) {
					allocation?.close();
					return;
				}
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
						relayed,
						serverUrl(server),
						server.transport,
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

	/** the end of gathering once connected: the gatherers still waiting give up, unheard */
	#stopGathering() {
		if (this.#gathering !== 'gathering') return;
		for (const gatherer of this.#gatherers)
			if (!gatherer.done) gatherer.quiet();
		this.#gathered();
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
					// what the sections this offer adds are called: one name
					// for each section no offer has carried, and one for a
					// data section
					let unnamed = 1;
					for (const state of this.#medias.values())
						if (state.mid === null) unnamed++;
					const result = this.#control({
						op: 'offer',
						names: this.#mids.next(unnamed).join(),
					});
					if (result.error) throw result.error;
					this.#stats.offered(true);
					this.#mids.saw(result.sdp ?? '');
					this.#lastLocal = parseSdp(result.sdp ?? '');
					this.#takeMids(result.mids);
					// an offer leaves the DTLS role to the answer, a later one too
					for (const media of this.#lastLocal.medias)
						for (const attribute of media.attributes)
							if (attribute[0] === 'setup') attribute[1] = 'actpass';
					this.#describe(this.#lastLocal, null);
					this.#takeCredentials();
					this.#version++;
					reply(this.#render(this.#lastLocal));
					break;
				}
				case 'createAnswer': {
					if (!this.#pendingAnswer) throw 'no remote offer to answer';
					this.#lastLocal = this.#pendingAnswer;
					this.#describe(this.#lastLocal, this.#remote);
					this.#takeCredentials();
					this.#version++;
					reply(this.#render(this.#lastLocal));
					break;
				}
				case 'setLocal': {
					if (request.type === 'rollback') {
						this.#takeMids(this.#control({ op: 'rollback' }).mids);
						reply(this.#sections());
						break;
					}
					// a sender's track is measured from its first local description
					for (const state of this.#medias.values())
						if (midOf(this.#lastLocal, state.mid)) state.sender?.measure();
					// The answer takes effect: the stack answered when it read
					// the offer, with all the offer gave; what the page's
					// transceivers took of it is the sections' direction now.
					if (request.type === 'answer')
						for (const state of this.#medias.values()) {
							// rejected: the peer stops it, and so does this side
							if (state.rejected) {
								state.rejected = false;
								state.answer = null;
								this.#control({ op: 'stop', index: state.index });
								this.#stopped(state);
								continue;
							}
							if (state.answer === null) continue;
							if (state.direction !== state.answer)
								this.#control({
									op: 'direction_now',
									index: state.index,
									dir: state.answer,
								});
							state.answer = null;
							this.#negotiated(state.index);
							this.#settle(state, midOf(this.#lastLocal, state.mid));
						}
					reply(this.#sections());
					// a description of no section has no transport to gather for
					if (!this.#lastLocal?.medias.length) break;
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
						this.#takeMids(this.#control({ op: 'rollback' }).mids);
						reply(this.#sections());
						break;
					}
					const shaped =
						request.type === 'offer' ? offerForStack(request.sdp) : null;
					if (!shaped && !/^m=/m.test(request.sdp)) {
						// no section: nothing for the stack, and the answer is as bare
						if (request.type === 'offer')
							this.#pendingAnswer = {
								origin: null,
								session: [],
								medias: [],
								bare: true,
							};
						reply(this.#sections());
						break;
					}
					const { sdp, candidates } = stripCandidates(
						withGroup(shaped?.sdp ?? request.sdp),
					);
					// with the names the stack was shown for sections of none
					const described = parseSdp(shaped?.sdp ?? request.sdp);
					const before = this.#remote;
					this.#remote = described;
					let result: Record<string, string>;
					if (request.type === 'offer') {
						// All of what each section offers is taken here: what the
						// page's transceivers want of it is known when the page
						// answers, and applied when it sets that answer. The
						// stack tells of a new section only once its media
						// flows; with a direction named for it, it numbers the
						// section now.
						const fields: Record<string, string> = { op: 'remote_offer', sdp };
						described.medias.forEach((media, at) => {
							if (media.kind === 'audio' || media.kind === 'video')
								fields[`dir${at}`] = 'sendrecv';
						});
						result = this.#control(fields);
					} else result = this.#control({ op: 'answer', sdp });
					if (result.error) {
						this.#remote = before;
						throw result.error;
					}
					this.#mids.saw(shaped?.sdp ?? request.sdp);
					if (shaped) {
						this.#pendingAnswer = parseSdp(result.sdp ?? '');
						// the answer mirrors what the stack was not shown
						this.#pendingAnswer.ungrouped = !shaped.grouped;
						this.#pendingAnswer.medias.forEach((media, index) => {
							media.protocol = shaped.protocols[index] ?? media.protocol;
						});
						this.#takeMids(result.mids, described);
						// what the next offer of this side states: the
						// transceiver's own direction, not what was taken here
						for (const state of this.#medias.values())
							if (midOf(described, state.mid))
								this.#control({
									op: 'direction',
									index: state.index,
									dir: state.wanted,
								});
					}
					// what the peer asks of a section it already had may have
					// changed with this description
					for (const state of this.#medias.values()) {
						this.#negotiated(state.index);
						if (request.type === 'answer')
							this.#settle(state, midOf(described, state.mid));
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
					this.#remoteUfrag =
						/^a=ice-ufrag:(.*)$/m.exec(request.sdp)?.[1].trim() ??
						this.#remoteUfrag;
					this.#stats.offered(request.type !== 'offer');
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
						// the stack names the section's source after its track
						// (the RTCP CNAME): the connection's one name
						track: this.#cname,
					});
					if (result.error) throw result.error;
					this.#addMedia(
						Number(result.index),
						request.kind,
						request.handle,
						request.direction,
						request.streams,
						request.track,
						request.byTrack,
					);
					reply(null);
					break;
				}
				case 'mediaStreams': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.streams = request.streams;
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
					// one no offer has carried is taken back: nothing to stop
					this.#control({
						op: state.mid === null ? 'withdraw' : 'stop',
						index: state.index,
					});
					this.#stopped(state);
					reply(null);
					break;
				}
				case 'codecPreferences': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.codecs = request.codecs;
					state.legacyCodecs = request.legacy;
					reply(null);
					break;
				}
				case 'mediaEncoding': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.paused = !request.active;
					this.#activate(state);
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
				case 'dtmf': {
					const state = this.#handles.get(request.handle);
					if (!state) throw 'no such media section';
					state.sender?.tone(request.tone, request.duration);
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
				case 'stats': {
					const rtp = this.#stats.rtp();
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
							...this.#mediaStats(state, rtp),
						})),
						transport: this.#stats.report(),
						ufrag: this.#ufrag,
						certificate: base64(this.#certificate.certificate),
						fingerprint: this.#fingerprint,
						remoteCertificate: this.#remoteCertificate(),
					} satisfies StatsReply);
					break;
				}
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
		this.#stats.remote(
			candidate,
			joinAddress(fields.address, Number(fields.port)),
			this.#remoteUfrag,
		);
	}

	/** a remote candidate at a name: another document's, reached over the bridge */
	#addNamed(candidate: string) {
		const fields = candidateFields(candidate);
		if (!fields) return;
		if (!fields.address.endsWith('.local')) return;
		const address = this.#bridgeAddress(fields.address);
		this.#stats.remote(
			candidate,
			joinAddress(address, Number(fields.port)),
			this.#remoteUfrag,
		);
		fields.address = address;
		this.#control({ op: 'remote_candidate', candidate: candidateLine(fields) });
	}

	/** the peer's certificate and its fingerprint, once the handshake showed it */
	#remoteCertificate(): { base64: string; fingerprint: string } | null {
		const { fingerprint } = this.#control({ op: 'remote_cert' });
		const bytes = this.#remoteDer();
		return bytes && { base64: base64(bytes), fingerprint };
	}
	#remoteDer(): Uint8Array<ArrayBuffer> | null {
		const { der } = this.#control({ op: 'remote_cert' });
		if (!der) return null;
		const bytes = new Uint8Array(der.length >> 1);
		for (let at = 0; at < bytes.length; at++)
			bytes[at] = parseInt(der.slice(at * 2, at * 2 + 2), 16);
		return bytes;
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
