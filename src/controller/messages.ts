import type { Config, ConfigCodec } from '../config';

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
}

export interface FrameInfo {
	url: string | null;
	title: string | null;
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
	frameCommand: [{ index: number; command: FrameCommand }];
};

/** implemented by the host, called by the controller frame */
export type HostBound = {
	ready: [];
};
