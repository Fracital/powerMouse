// What the page's RTCPeerConnection stand-in and the document's WebRTC
// worker say to each other (docs/webrtc-over-wisp.md, section 9). The
// worker is started by the inject with a transport port and the module's
// URL; each connection then gets a MessagePort of its own: the page sends
// requests (`seq`), the worker answers them and pushes events.

import type { PeerAbort } from './abort';
import type { ReceiverStats, SenderStats } from './audio';
import type { PlayedStats, SourceStats } from './level';
import type { RtpCount, TransportReport } from './stats';

/** the worker's first message: where everything comes from */
export interface RtcWorkerInit {
	kind: 'init';
	/** the document's transport port (a RemoteTransport is built on it) */
	transport: MessagePort;
	/** the stack's wasm module: its URL, or the compiled module when the host handed one over */
	module: string | WebAssembly.Module;
	/** an RtcWorkerTemplate follows, and connections wait for it */
	template?: boolean;
}

/**
 * What this browser's own RTCPeerConnection offers for audio and video (an
 * offer of a native connection the page's stand-in made for this and set
 * nowhere), '' when it would not make one: the codecs and the header
 * extensions the stack negotiates are read from it (formats.ts)
 */
export interface RtcWorkerTemplate {
	kind: 'template';
	sdp: string;
}

/** a new connection on `port`, with the page's configuration as the worker needs it */
export interface RtcWorkerConnection {
	kind: 'connection';
	port: MessagePort;
	config: ConnectionConfig;
}

export interface IceServer {
	urls: string[];
	username?: string;
	credential?: string;
}

export interface ConnectionConfig {
	iceServers: IceServer[];
	iceTransportPolicy: 'all' | 'relay';
	iceCandidatePoolSize: number;
	/**
	 * The errors of TURN servers over TLS are told as gathering ends, as
	 * those over TCP are (Chrome 156; 152 tells them as they come)
	 */
	tlsErrorsAtEnd?: boolean;
}

export interface ChannelOptions {
	label: string;
	ordered: boolean;
	maxPacketLifeTime: number | null;
	maxRetransmits: number | null;
	protocol: string;
	negotiated: boolean;
	id: number | null;
}

export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

/** a media section, as the page's transceiver for it needs it */
export interface MediaSection {
	/**
	 * The transceiver's number: the page's own for one it added, a negative
	 * one of the worker's for a section the peer offered first
	 */
	handle: number;
	kind: 'audio' | 'video';
	/** null until an offer carries the section */
	mid: string | null;
	/** what the section negotiated, seen from this side; null before it has */
	direction: Direction | null;
	/** what the peer's description says of the section, when it has one */
	remote?: {
		direction: Direction;
		/** the `a=msid` streams and track of what the peer sends */
		streams: string[];
		track: string | null;
	};
	/** the section is stopped: this side stopped it, or the peer's description has */
	stopped?: boolean;
	/** what the section sends with has a telephone-event payload: DTMF can go out */
	dtmf?: boolean;
}

/** a codec as RTCRtpSender.getCapabilities() names one */
export interface CodecCapability {
	mimeType: string;
	clockRate: number;
	channels?: number;
	sdpFmtpLine?: string;
}

/** the answer to setLocal and setRemote: the connection's media sections as they are now */
export interface Negotiated {
	medias: MediaSection[];
}

/** what a page sends on a channel: a string, or bytes */
export type ChannelPayload = string | ArrayBuffer;

/** page -> worker, each answered by a Reply with the same `seq` */
export type Request =
	| { seq: number; op: 'createOffer'; iceRestart: boolean }
	| { seq: number; op: 'createAnswer' }
	/** the page's local description was set: `sdp` as the page set it (munged or not), `type` */
	| { seq: number; op: 'setLocal'; type: 'offer' | 'answer' | 'rollback' }
	| {
			seq: number;
			op: 'setRemote';
			type: 'offer' | 'answer' | 'rollback';
			sdp: string;
	  }
	| {
			seq: number;
			op: 'addCandidate';
			candidate: string;
			sdpMid: string | null;
	  }
	| { seq: number; op: 'createChannel'; options: ChannelOptions }
	| {
			seq: number;
			op: 'send';
			channel: number;
			data: ChannelPayload;
			binary: boolean;
	  }
	| { seq: number; op: 'closeChannel'; channel: number }
	| { seq: number; op: 'lowThreshold'; channel: number; value: number }
	/** a transceiver the page added: a media section of the next offer */
	| {
			seq: number;
			op: 'addMedia';
			handle: number;
			kind: 'audio' | 'video';
			direction: Direction;
			/** the ids of the streams the sender is in, and the sender's own (`a=msid`) */
			streams: string[];
			track: string;
			/** made by addTrack: a section the peer offers may take the transceiver */
			byTrack: boolean;
	  }
	| { seq: number; op: 'mediaDirection'; handle: number; direction: Direction }
	| { seq: number; op: 'mediaStreams'; handle: number; streams: string[] }
	| { seq: number; op: 'stopMedia'; handle: number }
	/** setCodecPreferences: what the section's descriptions list, in this order; [] for all */
	| {
			seq: number;
			op: 'codecPreferences';
			handle: number;
			codecs: CodecCapability[];
			/** Chrome 152, which keeps redundant audio without the codec it carries */
			legacy: boolean;
	  }
	/** the sender's encoding, as setParameters left it: whether it sends at all */
	| { seq: number; op: 'mediaEncoding'; handle: number; active: boolean }
	/** what the section sends: a MediaStreamTrackProcessor's readable (transferred), or null for no track */
	| {
			seq: number;
			op: 'sendTrack';
			handle: number;
			readable: ReadableStream<AudioData> | null;
	  }
	/** where the section's received sound goes: a MediaStreamTrackGenerator's writable (transferred) */
	| {
			seq: number;
			op: 'receiveTrack';
			handle: number;
			writable: WritableStream<AudioData> | null;
	  }
	/** a tone of the sender's RTCDTMFSender, one of 0-9, A-D, * and #, for `duration` ms */
	| {
			seq: number;
			op: 'dtmf';
			handle: number;
			tone: string;
			duration: number;
	  }
	| { seq: number; op: 'setConfiguration'; config: ConnectionConfig }
	| { seq: number; op: 'restartIce' }
	| { seq: number; op: 'stats' }
	| { seq: number; op: 'close' };

export type RequestOf<O extends Request['op']> = Extract<Request, { op: O }>;
/** a request as the page builds it, before the stand-in numbers it (distributes over the union) */
export type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** worker -> page: an answer */
export type Reply =
	| { seq: number; ok: true; value: unknown }
	| { seq: number; ok: false; name: string; message: string };

/** a candidate as the page reads it */
export interface CandidateInit {
	candidate: string;
	sdpMid: string;
	sdpMLineIndex: number;
	usernameFragment: string;
	/** the STUN or TURN server the candidate came from, as Chrome names it */
	url: string;
	relayProtocol: string | null;
}

/** the worker's answer to `stats` */
export interface StatsReply {
	ice: string;
	connection: string;
	local: string[];
	transport: TransportReport;
	ufrag: string;
	/** the connection's certificate (DER, base64) and `sha-256 AA:BB...` */
	certificate: string;
	fingerprint: string;
	remoteCertificate: { base64: string; fingerprint: string } | null;
	/** each media section's sender and receiver as the worker counts them */
	media: ({
		handle: number;
		mid: string | null;
		direction: string | null;
		sent: SenderStats | null;
		received: ReceiverStats | null;
	} & MediaStats)[];
}

/** a payload as a codec stats entry tells it */
export interface CodecStats {
	payloadType: number;
	mimeType: string;
	clockRate: number;
	channels?: number;
	sdpFmtpLine?: string;
}

/** a section's RTP streams for getStats() (connection.ts: #mediaStats); times in ms since 1970 */
export interface MediaStats {
	/** what this side sends, once the section is negotiated to send */
	outbound?: {
		ssrc: number;
		codec: CodecStats | null;
		packets: number;
		bytes: number;
		header: number;
		/** what the encoder aims at, in bits a second */
		bitrate: number;
		active: boolean;
	};
	/** the peer's last reception report of it; jitter in RTP units */
	remoteInbound?: {
		at: number;
		fractionLost: number;
		packetsLost: number;
		jitter: number;
		roundTripTime?: number;
		measurements: number;
		totalRoundTripTime: number;
	};
	/** what came in, once a packet has */
	inbound?: RtpCount & {
		codec: CodecStats | null;
		played: (PlayedStats & { packetsDiscarded: number }) | null;
	};
	/** the peer's last sender report of what it sends */
	remoteOutbound?: {
		at: number;
		remoteTimestamp: number;
		packets: number;
		bytes: number;
		reports: number;
		roundTripTime?: number;
		measurements: number;
		totalRoundTripTime: number;
	};
	/** the sender's track, measured since a local description had the section */
	source?: SourceStats;
}

export interface CandidateError {
	address: string | null;
	port: number | null;
	url: string;
	errorCode: number;
	errorText: string;
	hostCandidate: string;
}

/** worker -> page: something happened */
export type WorkerEvent =
	| { ev: 'icecandidate'; candidate: CandidateInit | null }
	| { ev: 'icecandidateerror'; error: CandidateError }
	| { ev: 'gathering'; state: RTCIceGatheringState }
	| { ev: 'ice'; state: RTCIceConnectionState }
	| { ev: 'connection'; state: RTCPeerConnectionState }
	/**
	 * The DTLS transport: connected (just before the connection says so),
	 * with the peer's certificate (DER), or closed by the peer
	 */
	| {
			ev: 'dtls';
			state: 'connected' | 'closed';
			certificate: ArrayBuffer | null;
	  }
	/** the pair ICE selected now: each candidate as the page's RTCIceCandidate reads */
	| { ev: 'pair'; local: string; remote: string }
	/** the local description as the stack renders it now (candidates included) */
	| { ev: 'local'; sdp: string }
	| {
			ev: 'datachannel';
			channel: number;
			options: ChannelOptions;
			id: number | null;
	  }
	| { ev: 'channelOpen'; channel: number; id: number | null }
	| {
			ev: 'channelMessage';
			channel: number;
			data: ChannelPayload;
			binary: boolean;
	  }
	| { ev: 'channelClosing'; channel: number }
	// `abort`: the peer ended the association with an SCTP ABORT
	| { ev: 'channelClose'; channel: number; abort?: PeerAbort }
	| { ev: 'channelLow'; channel: number }
	| { ev: 'buffered'; channel: number; amount: number }
	/** the section's first frame arrived: its track has media now */
	| { ev: 'unmute'; handle: number }
	| { ev: 'error'; message: string };

export type WorkerMessage = Reply | WorkerEvent;

export const isReply = (message: WorkerMessage): message is Reply =>
	'seq' in message;
