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
/**
 * a proxied page asking the host application to open a URL in a new tab
 * (`window.open`, `target="_blank"`); posted to the real top window, only
 * when the host opted in with `onOpen` (config `openTab`)
 */
export const OPEN_TAB = '$stomp$open';
/**
 * the service worker telling every window that a proxied origin's storage
 * changed, so the other documents of that origin can fire `storage` events
 */
export const STORAGE_EVENT = '$stomp$storageEvent';
/**
 * a proxied page telling the host application where it is now (on load,
 * pushState / replaceState, hashchange, popstate and title changes); posted
 * to the real top window, the host matches the source to one of its frames
 */
export const NAVIGATE = '$stomp$navigate';

export interface NavigateInfo {
	/** the real URL the page shows */
	url: string;
	title: string;
	/** whether the frame's own history has an entry in that direction; null without the Navigation API */
	canGoBack: boolean | null;
	canGoForward: boolean | null;
}
/**
 * global set by the bootstrap of a worker started from a blob: URL: the
 * URL of the page that made it, which is what its relative URLs mean
 */
export const WORKER_BASE = '$stomp$workerBase';

export interface StorageChange {
	store: string;
	origin: string;
	/** null when the store was cleared */
	key: string | null;
	oldValue: string | null;
	newValue: string | null;
	/** the document that made the change, which must not hear about it */
	sender?: string;
	/** that document's URL, for StorageEvent.url */
	url?: string;
}

export interface ControllerInitMessage {
	directory: string;
	config: Config;
	/** the controller bundle's build id (src/version.ts); optional until every bundle sends it */
	build?: string;
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
	ready: [{ build?: string } | undefined];
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
