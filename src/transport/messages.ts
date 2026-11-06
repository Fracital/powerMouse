import type {
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import type { Config } from '../config';

// postMessage keys (controller <-> service worker <-> proxied contexts)

/** controller -> SW, with [port]: register a controller for `directory` */
export const CONTROLLER_INIT = '$stomp$controllerInit';
/** proxied page -> SW, with [port]: ask the controller for `directory` to serve a transport on this port */
export const INIT_REMOTE_TRANSPORT = '$stomp$initRemoteTransport';
/** SW -> every client: SW (re)started, controllers must re-send CONTROLLER_INIT */
export const SW_REVIVE = '$stomp$swRevive';
/** proxied page -> dedicated worker, with [port]: the worker's transport port */
export const TRANSPORT_INIT = '$stomp$transportInit';

export interface ControllerInitMessage {
	directory: string;
	config: Config;
}

export interface InitRemoteTransportMessage {
	directory: string;
}

// RPC descriptions. Each is [args, return] or [args].

/** rpc id shared by the controller<->SW port */
export const CONTROLLER_RPC = 'stomp';
/** rpc id shared by every transport port */
export const TRANSPORT_RPC = 'transport';

/** implemented by the SW, called by the controller */
export type SWbound = {
	/** resolve a URL against the controller's config into a routed (proxied) URL */
	route: [string, string];
};

/** implemented by the controller, called by the SW */
export type Controllerbound = {
	ready: [];
	initRemoteTransport: [MessagePort];
};

/** implemented by the transport host, called by RemoteTransport */
export type TransportToHost = {
	request: [
		{
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
		},
		TransferrableResponse,
	];
	connect: [
		{
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
		},
		(
			| { result: 'success'; protocol: string; extensions: string }
			| { result: 'failure'; error: string }
		),
	];
};

/** implemented by RemoteTransport, called by the host */
export type HostToTransport = {
	ready: [];
};

export type WebSocketMessage =
	| { type: 'data'; data: WebSocketDataType }
	| { type: 'close'; code: number; reason: string };

const portPostMessage = MessagePort.prototype.postMessage as (
	this: MessagePort,
	message: unknown,
	transfer: Transferable[],
) => void;

/** postMessage on a port using the pristine prototype method (pages may hook postMessage) */
export function postToPort(
	port: MessagePort,
	message: unknown,
	transfer: Transferable[] = [],
) {
	portPostMessage.call(port, message, transfer);
}

export function transferablesOf(value: unknown): Transferable[] {
	if (value instanceof ArrayBuffer || value instanceof ReadableStream)
		return [value];
	return [];
}
