// What Stomp's service worker, the controller, the emulated workers and the
// page module say to each other about emulated service workers
// (docs/service-workers.md).

import type { JarCookie } from './server/Cookies';
import type { PortBody } from './transport/bodyPort';

export type WorkerState =
	| 'parsed'
	| 'installing'
	| 'installed'
	| 'activating'
	| 'activated'
	| 'redundant';

export type UpdateViaCache = 'imports' | 'all' | 'none';

export type WorkerType = 'classic' | 'module';

/** one version of a registration's worker, as the page sees it */
export interface WorkerSnapshot {
	id: string;
	/** the real URL */
	scriptURL: string;
	state: WorkerState;
}

export interface NavigationPreloadState {
	enabled: boolean;
	headerValue: string;
}

export interface RegistrationSnapshot {
	id: string;
	/** the real scope URL */
	scope: string;
	updateViaCache: UpdateViaCache;
	installing: WorkerSnapshot | null;
	waiting: WorkerSnapshot | null;
	active: WorkerSnapshot | null;
	navigationPreload: NavigationPreloadState;
	/** the number of the last step the snapshot includes */
	serial: number;
}

/** a change to a registration, in the order the spec makes them */
export type StateStep =
	| {
			serial: number;
			op: 'slot';
			slot: 'installing' | 'waiting' | 'active';
			worker: WorkerSnapshot | null;
	  }
	| { serial: number; op: 'state'; worker: WorkerSnapshot }
	| { serial: number; op: 'updatefound' };

/** SW -> page (SW_EVENT): of the registration of `origin` in `partition` (none: first-party) */
export type PageEvent = { partition?: string } & (
	| {
			kind: 'steps';
			origin: string;
			registration: RegistrationSnapshot;
			steps: StateStep[];
	  }
	| { kind: 'removed'; origin: string; registration: string }
	| {
			kind: 'controller';
			origin: string;
			registration: RegistrationSnapshot;
			worker: WorkerSnapshot;
	  }
	| {
			kind: 'message';
			origin: string;
			registration: RegistrationSnapshot;
			source: WorkerSnapshot;
			data: unknown;
	  }
);

/** the registration members that hold a manager (docs/service-workers.md) */
export type ManagerKind =
	'sync' | 'periodicSync' | 'backgroundFetch' | 'paymentManager' | 'cookies';

/** a background fetch, as its BackgroundFetchRegistration shows it */
export interface BackgroundFetchSnapshot {
	id: string;
	uploadTotal: number;
	uploaded: number;
	downloadTotal: number;
	downloaded: number;
	result: '' | 'success' | 'failure';
	failureReason:
		| ''
		| 'aborted'
		| 'bad-status'
		| 'fetch-error'
		| 'quota-exceeded'
		| 'download-total-exceeded';
	recordsAvailable: boolean;
}

/** one record of a background fetch, on its way to a realm */
export interface BackgroundFetchRecordWire {
	request: { url: string; method: string; headers: [string, string][] };
	response: {
		status: number;
		statusText: string;
		headers: [string, string][];
		body: Blob;
	} | null;
}

/** what the HTML shell tells a new document about its controller (SW_CONTROL) */
export interface ControlInfo {
	registration: RegistrationSnapshot;
	worker: WorkerSnapshot;
}

export interface ErrorInfo {
	name: string;
	message: string;
}

/** a client as an emulated worker's `clients` describes it */
export interface ClientInfo {
	id: string;
	/** the real URL */
	url: string;
	type: 'window' | 'worker' | 'sharedworker';
	frameType: 'auxiliary' | 'top-level' | 'nested' | 'none';
	focused: boolean;
	visibilityState: DocumentVisibilityState;
}

/** what an emulated worker needs before its script runs (the `sw:` route's preamble) */
export interface EmulateInfo {
	version: WorkerSnapshot;
	registration: RegistrationSnapshot;
	type: WorkerType;
	/** its registration's storage partition (src/partition.ts), none for a first-party one */
	partition?: string;
}

/** a request as the emulated worker's FetchEvent shows it */
export interface FetchInit {
	id: string;
	request: {
		url: string;
		method: string;
		headers: [string, string][];
		body: Blob | null;
		mode: RequestMode;
		credentials: RequestCredentials;
		cache: RequestCache;
		redirect: RequestRedirect;
		referrer: string;
		referrerPolicy: ReferrerPolicy;
		integrity: string;
		keepalive: boolean;
		destination: RequestDestination;
	};
	clientId: string;
	resultingClientId: string;
	isReload: boolean;
	/**
	 * a navigation whose registration has navigation preload on: its
	 * preload request went out with it, and `preloadResponse` asks for the
	 * answer (FromEmulated.preloadResponse)
	 */
	preload?: boolean;
}

/** a Response on its way from the emulated worker */
export interface WireServiceWorkerResponse {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: PortBody | null;
	/** the real URL */
	url: string;
	redirected: boolean;
	/**
	 * the response's type as the worker's page-facing Response reads it:
	 * every route is same-origin to the browser, so the proxy says when it is
	 * another origin's (`cors`) or opaque, and the page shows it so
	 */
	type?: 'basic' | 'cors' | 'opaque';
}

export type FetchAnswer =
	| { kind: 'response'; response: WireServiceWorkerResponse }
	/** the page gets a network error */
	| { kind: 'error'; message: string }
	/** an opaque or opaque-redirect response: the network answers instead */
	| { kind: 'network' }
	/**
	 * the event's preload response itself, unread: the network's answer
	 * reaches the page as Stomp's service worker has it, never through the
	 * worker
	 */
	| { kind: 'preload' };

export interface MessageInit {
	data: unknown;
	origin: string;
	/** the client that sent it, or a version of this registration */
	source: { client: ClientInfo } | { worker: WorkerSnapshot };
	ports: MessagePort[];
}

/** implemented by the emulated worker, called by Stomp's service worker */
export type ToEmulated = {
	install: [null, boolean];
	activate: [null];
	/** whether respondWith was called; the answer follows as `respond` */
	fetch: [FetchInit, boolean];
	message: [MessageInit];
	/** the registration changed: the worker's objects follow it */
	steps: [{ registration: RegistrationSnapshot; steps: StateStep[] }];
	/** an ExtendableCookieChangeEvent for one cookie a subscription covers */
	cookieChange: [{ changed: JarCookie[]; deleted: JarCookie[] }, boolean];
	/** a SyncEvent for `tag`; whether its extend lifetime promises fulfilled */
	sync: [{ tag: string; lastChance: boolean }, boolean];
	/** a background fetch ended: backgroundfetchsuccess, backgroundfetchfail or backgroundfetchabort */
	backgroundFetch: [
		{
			type:
				| 'backgroundfetchsuccess'
				| 'backgroundfetchfail'
				| 'backgroundfetchabort';
			fetch: BackgroundFetchSnapshot;
		},
		boolean,
	];
};

/** implemented by Stomp's service worker, called by an emulated worker */
export type FromEmulated = {
	/** the port arrived; whether the script's top level ran to its end */
	hello: [{ evaluated: boolean; error?: string }];
	respond: [{ event: string; answer: FetchAnswer }];
	/** a fetch event's navigation preload answer; null when it failed */
	preloadResponse: [{ event: string }, WireServiceWorkerResponse | null];
	/** its body, once the worker reads it; null when it is gone */
	preloadBody: [{ event: string }, PortBody | null];
	skipWaiting: [];
	claim: [null, ErrorInfo | null];
	matchAll: [{ includeUncontrolled: boolean; type: string }, ClientInfo[]];
	getClient: [string, ClientInfo | null];
	postToClient: [{ id: string; data: unknown; ports: MessagePort[] }];
	postToWorker: [{ worker: string; data: unknown; ports: MessagePort[] }];
	navigate: [{ id: string; url: string }, ClientInfo | null | ErrorInfo];
	update: [null, ErrorInfo | null];
	unregister: [null, boolean];
	preload: [{ op: string; value?: unknown }, unknown];
	/** a call of one of the registration's managers */
	manager: [
		{ kind: ManagerKind; op: string; args: Record<string, unknown> },
		{ value: unknown } | { error: ErrorInfo },
	];
};

/** a page API call's reply */
export type ApiReply = { value: unknown } | { error: ErrorInfo };

/** the route kinds of an emulated worker's scripts */
export const SW_ROUTE = 'sw';
export const SW_IMPORT_ROUTE = 'swimport';
