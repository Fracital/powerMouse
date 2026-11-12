// What the inject's WebRTC module (modules/WebRTC.ts) hands the WebRTC
// stand-in library (rtcStack.ts, the asset `rtcStack`) when a document first
// uses WebRTC: the library is loaded then, not with the bundle, so a
// document that never makes a connection carries none of it.
import type ProxyModule from '../modules/Proxy';
import type WorkerModule from '../modules/Worker';
import type DocumentClient from './Client';

/** a class's members as the document that made an object implements them */
export type Members = Record<PropertyKey, PropertyDescriptor | undefined>;

/**
 * The tables from each object to the members of the document that made it,
 * shared by documents that can reach each other (a frame and its parent, a
 * popup and its opener). The inject module makes the ones its prototypes
 * dispatch on; the library adds the rest when it is installed.
 */
export interface SharedTables {
	peers: WeakMap<object, Members>;
	channels: WeakMap<object, Members>;
	channelEvents: WeakMap<object, Members>;
	reports: WeakMap<object, Members>;
	/** the library's text, once a document of these has loaded it */
	text?: string;
	/** each document's install, run for all once one of them installs */
	installs: Set<WeakRef<() => void>>;
	[table: string]: unknown;
}

/** the classes the page sees, by global name */
export interface StandIns {
	RTCPeerConnection: Function;
	RTCDataChannel: Function;
	RTCDataChannelEvent: Function;
	RTCStatsReport: Function;
}

export interface RtcContext {
	client: DocumentClient;
	shared: SharedTables;
	proxyModule: ProxyModule;
	workerModule: WorkerModule | undefined;
	withStack: <T extends object>(error: T, skip?: number) => T;
	/** the browser's own classes, which the stand-ins replaced */
	natives: StandIns;
	/** the stand-ins, whose prototypes the library's objects are made on */
	standIns: StandIns;
	/** taken when the inject bundle loaded, before any page script */
	captures: {
		mapEntries: typeof Map.prototype.entries;
		mapNext: () => IteratorResult<[string, unknown]>;
		objectCreate: typeof Object.create;
		weakDeref: typeof WeakRef.prototype.deref;
		stringIndexOf: typeof String.prototype.indexOf;
		stringSlice: typeof String.prototype.slice;
	};
	workerURL: () => string;
	moduleURL: () => string;
}

/** what the library makes for one document: the classes behind its stand-ins */
export interface Installed {
	RTCPeerConnection: Function;
	RTCDataChannelEvent: Function;
}

/** the library's text, evaluated: one per bundle */
export interface StackApi {
	build: string;
	install(ctx: RtcContext): Installed;
}
