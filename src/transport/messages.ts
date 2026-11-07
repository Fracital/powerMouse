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
/** SW -> every window: the cookie jar changed for `domain` (every host when empty); pages drop their document.cookie cache */
export const COOKIES_CHANGED = '$stomp$cookiesChanged';
export interface CookiesChange {
	domain: string;
}
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
	/** the page's service worker client id, once it learned it (`whoami`) */
	client?: string;
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
	/** the controller bundle's build id (src/version.ts) */
	build: string;
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
/**
 * A request rule, run in the service worker on the real URL after the
 * worker rebuilt Referer, Origin and cookies, before the cache. `url` is a
 * URLPattern string (`https://*.example.com/ads/*`); a rule whose pattern
 * cannot be compiled is skipped with one console warning. The first matching
 * rule wins. `null` deletes a header.
 */
export interface RequestRuleMatch {
	url?: string;
	method?: string[];
	destination?: string[];
	site?: ('same-origin' | 'same-site' | 'cross-site' | 'none')[];
}
export interface RequestRuleAction {
	requestHeaders?: Record<string, string | null>;
	responseHeaders?: Record<string, string | null>;
	/** answer with a 307 to this real URL (routed) */
	redirect?: string;
	/** answer with this status and an empty body, never going upstream */
	status?: number;
}
export interface RequestRule {
	match: RequestRuleMatch;
	/** `block`: a 403 with an empty body */
	action: 'block' | RequestRuleAction;
}

export type SWbound = {
	/** replace the request rules */
	rules: [RequestRule[]];
	/** resolve a URL against the controller's config into a routed (proxied) URL */
	route: [string, string];
	/** drop every entry of the HTTP cache */
	clearCache: [];
	/** the host reading, importing or wiping the cookie jar */
	cookies: [CookieCommand, CookieResult];
};

/** a cookie as the jar stores it, for export and import by the host */
export interface CookieRecord {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** ISO date, or null for a session cookie */
	expires: string | null;
	secure: boolean;
	httpOnly: boolean;
	sameSite: 'lax' | 'strict' | 'none';
	/** set without a Domain attribute: sent to that host only */
	hostOnly: boolean;
}

export type CookieCommand =
	/** `initiator`: the origin asking (a WebSocket handshake), so SameSite applies; absent means the host, which gets everything */
	| { op: 'get'; url: string; initiator?: string }
	| { op: 'set'; url: string; setCookie: string | string[] }
	| { op: 'list'; origin?: string }
	| { op: 'clear'; origin?: string };

export type CookieResult = string | CookieRecord[] | undefined;

/** one completed (or failed) proxied request, for the host's request log */
export interface RequestInfo {
	/** the real URL */
	url: string;
	method: string;
	/** the request's destination; `fetch` for fetch, XHR and beacons (the browser's empty string) */
	destination: string;
	/** 0 when the transport failed; see `error` */
	status: number;
	/** wall time in the service worker, from routing to the response headers */
	ms: number;
	/** answered from the HTTP cache without a request */
	cached: boolean;
	/** Content-Length of the response, when known */
	bytes: number | null;
	error?: string;
	/** the service worker client that made it; the controller maps it to a frame */
	client?: string;
	/** the index, in the host's `rules`, of the rule that applied */
	rule?: number;
}

/** what the service worker knows about the client that made a request */
export interface RouteContext {
	clientId?: string;
}

/** implemented by the controller, called by the SW */
export type Controllerbound = {
	ready: [{ build: string }];
	initRemoteTransport: [MessagePort];
	/** a proxied request completed; only sent when the host asked (config.requestLog) */
	request: [RequestInfo];
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
