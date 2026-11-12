// What the page's RTCPeerConnection stand-in and the document's WebRTC
// worker say to each other (docs/webrtc-over-wisp.md, section 9). The
// worker is started by the inject with a transport port and the module's
// URL; each connection then gets a MessagePort of its own: the page sends
// requests (`seq`), the worker answers them and pushes events.

/** the worker's first message: where everything comes from */
export interface RtcWorkerInit {
	kind: 'init';
	/** the document's transport port (a RemoteTransport is built on it) */
	transport: MessagePort;
	/** the stack's wasm module: its URL, or the compiled module when the host handed one over */
	module: string | WebAssembly.Module;
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
	| { ev: 'channelClose'; channel: number }
	| { ev: 'channelLow'; channel: number }
	| { ev: 'buffered'; channel: number; amount: number }
	| { ev: 'error'; message: string };

export type WorkerMessage = Reply | WorkerEvent;

export const isReply = (message: WorkerMessage): message is Reply =>
	'seq' in message;
