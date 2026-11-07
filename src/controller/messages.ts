import type { Config, ConfigCodec } from '../config';
import type {
	CookieCommand,
	CookieResult,
	RequestInfo,
} from '../transport/messages';

/** how a transport is described across the host/controller-frame boundary */
export interface TransportDescriptor {
	/** ES module URL on the proxy origin whose default export is a ProxyTransport class */
	module: string;
	/** constructor arguments */
	options?: unknown[];
}

export interface ControllerFrameInit {
	codec?: ConfigCodec;
	directory: string;
	transport: TransportDescriptor;
	/** the host handles `window.open` / `_blank` (RemoteControllerInit.onOpen) */
	openTab?: boolean;
	/** HTTP cache in the service worker, off when false (RemoteControllerInit.cache) */
	cache?: boolean;
	/** the host wants a RequestInfo per request (RemoteControllerInit.onRequest) */
	requestLog?: boolean;
	/** unparseable scripts fail instead of running raw (RemoteControllerInit.allowInvalidJs) */
	allowInvalidJs?: boolean;
}

export interface FrameInfo {
	url: string | null;
	title: string | null;
	/** whether the frame's own history has an entry before/after the current one; null when the browser cannot tell */
	canGoBack: boolean | null;
	canGoForward: boolean | null;
}

export type FrameCommand = 'back' | 'forward' | 'reload';

/** rpc id on the host <-> controller-frame postMessage channel */
export const REMOTE_RPC = 'stomp-remote';

/** implemented by the controller frame, called by the host */
export type FrameBound = {
	init: [ControllerFrameInit, { config: Config }];
	route: [string, string];
	setTransport: [TransportDescriptor];
	/** frames are addressed by their index in the host window's `frames` list */
	frameInfo: [number, FrameInfo];
	/** resolves to whether the command was carried out (false: nothing to go back/forward to) */
	frameCommand: [{ index: number; command: FrameCommand }, boolean];
	clearCache: [];
	cookies: [CookieCommand, CookieResult];
};

/** implemented by the host, called by the controller frame */
export type HostBound = {
	ready: [];
	/** a proxied request completed (only when the host asked for the log) */
	request: [RequestInfo];
};
