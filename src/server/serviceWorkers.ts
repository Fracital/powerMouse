// Emulated service workers, the part that runs in Stomp's own service worker
// (docs/service-workers.md): the registrations of every proxied site, their
// job queue and lifecycle, the instances the controllers host, and the
// dispatch of the requests they answer. Nothing here ever registers a real
// service worker.

import { IDBPDatabase, openDB } from 'idb';
import { partitionSite } from '../partition';
import type {
	BackgroundFetchRecordWire,
	BackgroundFetchSnapshot,
	ClientInfo,
	ControlInfo,
	ErrorInfo,
	FetchAnswer,
	FetchInit,
	FromEmulated,
	MessageInit,
	NavigationPreloadState,
	PageEvent,
	RegistrationSnapshot,
	StateStep,
	ToEmulated,
	UpdateViaCache,
	WorkerSnapshot,
	WorkerState,
	WorkerType,
} from '../serviceWorkerTypes';
import { receiveBody, sendBody } from '../transport/bodyPort';
import {
	postToPort,
	RESPONSE_TYPE_HEADER,
	SW_EVENT,
	SW_RPC,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import type { JarCookie } from './Cookies';

declare const self: ServiceWorkerGlobalScope;

interface VersionRecord {
	id: string;
	scriptURL: string;
	type: WorkerType;
	state: WorkerState;
	skipWaiting?: boolean;
}

interface RegistrationRecord {
	id: string;
	scope: string;
	origin: string;
	/**
	 * the partition it was registered in (src/partition.ts): a site framed
	 * by another has registrations of its own there, which control its
	 * clients in that partition only. None for a first-party one, which is
	 * every registration an earlier Stomp made
	 */
	partition?: string;
	updateViaCache: UpdateViaCache;
	installing: VersionRecord | null;
	waiting: VersionRecord | null;
	active: VersionRecord | null;
	navigationPreload: NavigationPreloadState;
	serial: number;
	uninstalling?: boolean;
	/** sync tags whose event has not run to success yet */
	syncTags?: string[];
	/** cookie change subscriptions (registration.cookies) */
	cookieSubscriptions?: { name?: string; url: string }[];
	/** paymentManager.userHint */
	userHint?: string;
}

/** a background fetch and what it downloaded */
interface BackgroundFetch {
	snapshot: BackgroundFetchSnapshot;
	records: BackgroundFetchRecordWire[];
	aborted: boolean;
}

interface ScriptRecord {
	script: string;
	/** what the version imported while it installed, by real URL */
	imports: Record<string, string>;
}

/** the controller that can host a worker, and fetch for one */
export interface WorkerHost {
	/** the controller's address */
	directory: string;
	start(id: string, url: string, type: WorkerType): Promise<MessagePort>;
	stop(id: string): void;
	/** the routed URL of a version's main script at this address */
	scriptRoute(version: string, scriptURL: string): string;
	/** a script fetched through the proxy as the browser fetches a worker's: the raw response */
	fetchScript(
		url: string,
		clientId: string | undefined,
		bypassCache: boolean,
	): Promise<Response>;
	/** a document's routed URL at this address (WindowClient.navigate) */
	routeDocument(url: string): string;
	/** the jar's cookies script at `url` may see (no HttpOnly ones), in a partition (CookieRequestContext.partitionKey) */
	jarCookies(url: string, partitionKey?: string): Promise<JarCookie[]>;
	/** a resource fetched through the proxy for a page's background fetch: the raw response */
	fetchResource(
		url: string,
		init: { method: string; headers: [string, string][] },
		clientId: string | undefined,
	): Promise<Response>;
	/** ms an emulated worker may take to say whether it answers (config.serviceWorkerTimeout) */
	timeout?: number;
}

/** what Stomp's service worker knows of one of its clients */
export interface ClientDescription {
	/** the real URL */
	url: string;
	origin: string;
	/** its storage partition, from its route (src/partition.ts) */
	partition: string;
	/** the route kind (`html`, `js:worker`, `sw:<version>`) */
	resource: string;
	directory: string;
}

export interface Environment {
	/** a client of a live controller, by its routed URL; null for any other (the host page, about:blank) */
	describe(url: string): ClientDescription | null;
	/** a live controller that can host a worker, `directory`'s when it can */
	host(directory?: string): WorkerHost | undefined;
}

/** the sender of a page API call, as the worker decided it from its routed URL */
export interface Sender {
	clientId: string;
	url: string;
	origin: string;
	/** its storage partition, from its route (src/partition.ts) */
	partition: string;
	directory: string;
}

export class ApiError extends Error {
	constructor(
		readonly errorName: string,
		message: string,
	) {
		super(message);
	}
	get info(): ErrorInfo {
		return { name: this.errorName, message: this.message };
	}
}

const JS_MIMES = new Set([
	'text/javascript',
	'application/javascript',
	'application/x-javascript',
	'application/ecmascript',
	'application/x-ecmascript',
	'text/ecmascript',
	'text/x-ecmascript',
	'text/x-javascript',
	'text/jscript',
	'text/livescript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
]);

/** how long an instance with nothing to do lives, as a browser keeps an idle worker */
const IDLE_MS = 30_000;
/** what the timeouts are when the controller sets none (docs/service-workers.md) */
const DEFAULT_TIMEOUT_MS = 5_000;
/** the steps a page may have missed are not worth keeping past this many controlled-client records */
const CONTROLLED_KEPT = 4096;

/**
 * The key a registration is kept under: its scope, and its partition after a
 * space (no serialized URL has one), so a first-party registration keeps the
 * key every earlier Stomp gave it
 */
function keyOf(scope: string, partition = ''): string {
	return partition ? `${scope} ${partition}` : scope;
}
/** a page event's partition member (none for a first-party registration) */
const partitionOf = (record: RegistrationRecord) =>
	record.partition ? { partition: record.partition } : {};
const recordKey = (record: RegistrationRecord) =>
	keyOf(record.scope, record.partition);
/** the storage key a registration, client or sender belongs to */
const ownerOf = (of: { origin: string; partition?: string }) =>
	`${of.origin}${of.partition ?? ''}`;

const uid = () => {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
		}),
	]);
}

interface Instance {
	id: string;
	version: string;
	/** its registration's key (recordKey) */
	scope: string;
	host: WorkerHost;
	rpc: RpcHelper<FromEmulated, ToEmulated>;
	port?: MessagePort;
	started: Promise<void>;
	inflight: number;
	idle?: ReturnType<typeof setTimeout>;
	dead: boolean;
	hello?: (result: { evaluated: boolean; error?: string }) => void;
}

/** one change to a registration, made in order by #commit */
type Change =
	| ['slot', 'installing' | 'waiting' | 'active', VersionRecord | null]
	| ['state', VersionRecord, WorkerState]
	| ['updatefound'];

/** a fetch event in flight, waiting for the emulated worker's answer */
interface PendingFetch {
	resolve: (answer: FetchAnswer) => void;
}

/**
 * A navigation's preload request (navigation preload): it goes out with the
 * navigation, in parallel with the worker's start, and its answer is the
 * fetch event's `preloadResponse`. Its body stays here until the worker
 * reads it; a worker that passes it on unread hands the page the network's
 * answer as it is, without the body crossing to the worker and back (a
 * worker that answers nothing leaves it unused: the browser sends the
 * navigation again, as Chrome does)
 */
interface Preload {
	response: Promise<Response | null>;
	/** the real URL */
	url: string;
	/** the worker took the body */
	taken: boolean;
}

/** how long an answered event's unread preload body is kept for the worker (it may read it after it answered) */
const PRELOAD_KEEP_MS = 30_000;
const USE_PRELOAD = Symbol('preload');

export class ServiceWorkers {
	#env?: Environment;
	#db?: Promise<IDBPDatabase>;
	#loaded?: Promise<void>;
	readonly #registrations = new Map<string, RegistrationRecord>();
	/** which registration (scope) controls each client */
	readonly #controlled = new Map<string, string>();
	/** the clients that are emulated workers, by their version */
	readonly #emulated = new Map<string, string>();
	readonly #instances = new Map<string, Instance>();
	readonly #jobs = new Map<string, Promise<unknown>>();
	readonly #fetches = new Map<string, PendingFetch>();
	readonly #preloads = new Map<string, Preload>();
	/** registrations with an update check running or queued (one at a time) */
	readonly #updating = new Set<string>();
	#serial = 0;

	setEnvironment(env: Environment) {
		this.#env = env;
	}

	#open(): Promise<IDBPDatabase> {
		this.#db ??= openDB('stompServiceWorkers', 1, {
			upgrade: (db) => {
				db.createObjectStore('registrations');
				db.createObjectStore('scripts');
				db.createObjectStore('controlled');
			},
		});
		return this.#db;
	}

	/** every registration and controlled client, once per worker start */
	#load(): Promise<void> {
		this.#loaded ??= (async () => {
			const db = await this.#open();
			const records = (await db.getAll(
				'registrations',
			)) as RegistrationRecord[];
			const keys = (await db.getAllKeys('controlled')) as string[];
			const scopes = (await db.getAll('controlled')) as {
				scope: string;
			}[];
			for (const [index, key] of keys.entries())
				this.#controlled.set(key, scopes[index].scope);
			for (const record of records) {
				// an install or activation the last worker did not finish: an
				// installing version is gone (the spec's discard on restart), an
				// activating one went on to be active
				if (record.installing) {
					await db.delete('scripts', record.installing.id);
					record.installing = null;
				}
				if (record.active?.state === 'activating')
					record.active.state = 'activated';
				this.#registrations.set(recordKey(record), record);
				await db.put('registrations', record, recordKey(record));
			}
		})();
		this.#loaded.catch(() => (this.#loaded = undefined));
		return this.#loaded;
	}

	/** a live controller to host a worker, `directory`'s when it can */
	host(directory?: string): WorkerHost | undefined {
		return this.#env?.host(directory);
	}

	/** whether any site has a registration (the cheap test before any request is looked at) */
	async any(): Promise<boolean> {
		await this.#load();
		return this.#registrations.size > 0;
	}

	// ---- snapshots and steps

	#worker(version: VersionRecord | null): WorkerSnapshot | null {
		return version
			? { id: version.id, scriptURL: version.scriptURL, state: version.state }
			: null;
	}

	snapshot(record: RegistrationRecord): RegistrationSnapshot {
		return {
			id: record.id,
			scope: record.scope,
			updateViaCache: record.updateViaCache,
			installing: this.#worker(record.installing),
			waiting: this.#worker(record.waiting),
			active: this.#worker(record.active),
			navigationPreload: { ...record.navigationPreload },
			serial: record.serial,
		};
	}

	/**
	 * Make `changes` (slot moves, state changes, updatefound), persist the
	 * registration and tell every document of its site and every running
	 * version of it, in order
	 */
	async #commit(record: RegistrationRecord, changes: Change[]) {
		const steps: StateStep[] = [];
		for (const change of changes) {
			const serial = ++record.serial;
			if (change[0] === 'slot') {
				record[change[1]] = change[2];
				steps.push({
					serial,
					op: 'slot',
					slot: change[1],
					worker: this.#worker(change[2]),
				});
			} else if (change[0] === 'state') {
				change[1].state = change[2];
				steps.push({ serial, op: 'state', worker: this.#worker(change[1])! });
			} else steps.push({ serial, op: 'updatefound' });
		}
		if (this.#registrations.get(recordKey(record)) === record)
			await (
				await this.#open()
			).put('registrations', record, recordKey(record));
		const snapshot = this.snapshot(record);
		await this.#broadcast(ownerOf(record), {
			kind: 'steps',
			origin: record.origin,
			...partitionOf(record),
			registration: snapshot,
			steps,
		});
		for (const instance of this.#instances.values())
			if (instance.scope === recordKey(record) && !instance.dead)
				instance.rpc
					.call('steps', { registration: snapshot, steps })
					.catch(() => {});
	}

	/** @internal ms every page-bound event waits before it goes (config.serviceWorkerEventDelay, tests) */
	#eventDelay = 0;
	/** the events on their way, in the order they were sent */
	#outbox: Promise<void> = Promise.resolve();
	setEventDelay(ms: number) {
		this.#eventDelay = Math.max(0, ms);
	}
	/**
	 * Every event for a page goes through here, in order. With a delay (the
	 * suites' way of making the events trail the answers to the page's
	 * calls, which travel on ports of their own) each waits that long
	 */
	#send(client: Client, event: PageEvent, ports: MessagePort[] = []) {
		const go = () => client.postMessage({ [SW_EVENT]: event }, ports);
		if (!this.#eventDelay) {
			go();
			return;
		}
		const delay = this.#eventDelay;
		this.#outbox = this.#outbox
			.then(() => new Promise((resolve) => setTimeout(resolve, delay)))
			.then(go, go)
			.catch(() => {});
	}

	/** every window client of storage key `owner` (and those whose URL names no site, which drop it themselves) */
	async #broadcast(owner: string, event: PageEvent) {
		for (const client of await self.clients.matchAll({
			type: 'window',
			includeUncontrolled: true,
		})) {
			const described = this.#env?.describe(client.url);
			if (described && ownerOf(described) !== owner) continue;
			if (!described && !/^about:(blank|srcdoc)/.test(client.url)) continue;
			this.#send(client, event);
		}
	}

	async #post(clientId: string, event: PageEvent, ports: MessagePort[] = []) {
		const client = await self.clients.get(clientId);
		if (client) this.#send(client, event, ports);
	}

	// ---- matching

	/** the registration whose scope is the longest prefix of `url`, of its origin and `partition` */
	match(url: string, partition = ''): RegistrationRecord | null {
		let found: RegistrationRecord | null = null;
		let origin: string;
		try {
			origin = new URL(url).origin;
		} catch (error) {
			return null;
		}
		for (const record of this.#registrations.values())
			if (
				record.origin === origin &&
				(record.partition ?? '') === partition &&
				!record.uninstalling &&
				url.startsWith(record.scope) &&
				(!found || record.scope.length > found.scope.length)
			)
				found = record;
		return found;
	}

	/** the registration that controls a client, while it has an active version */
	async controllerOf(clientId: string): Promise<RegistrationRecord | null> {
		await this.#load();
		const scope = this.#controlled.get(clientId);
		const record = scope ? this.#registrations.get(scope) : undefined;
		return record?.active ? record : null;
	}

	async #setControlled(clientId: string, record: RegistrationRecord) {
		if (this.#controlled.get(clientId) === recordKey(record)) return;
		this.#controlled.set(clientId, recordKey(record));
		const db = await this.#open();
		await db.put(
			'controlled',
			{ scope: recordKey(record), at: Date.now() },
			clientId,
		);
		if (this.#controlled.size > CONTROLLED_KEPT) this.#prune();
	}

	/** forget the clients that are gone */
	async #prune() {
		const live = new Set(
			(
				await self.clients.matchAll({ includeUncontrolled: true, type: 'all' })
			).map((client) => client.id),
		);
		const db = await this.#open();
		for (const id of [...this.#controlled.keys()])
			if (!live.has(id)) {
				this.#controlled.delete(id);
				await db.delete('controlled', id);
			}
	}

	/** the live clients (windows and workers) a registration controls */
	async #liveControlled(record: RegistrationRecord): Promise<Client[]> {
		const all = await self.clients.matchAll({
			includeUncontrolled: true,
			type: 'all',
		});
		return all.filter(
			(client) =>
				this.#controlled.get(client.id) === recordKey(record) &&
				!this.#emulated.has(client.id),
		);
	}

	/** a client this worker can say is of a site: windows and workers of live controllers, never an emulated worker */
	#describeClient(client: Client): ClientDescription | null {
		if (this.#emulated.has(client.id)) return null;
		const described = this.#env?.describe(client.url);
		if (!described || described.resource.startsWith('sw:')) return null;
		return described;
	}

	/**
	 * A client as the site's worker sees it. A proxied page the host shows
	 * is an iframe to the browser: it reads as the top-level page it stands
	 * for (its route is not a nested one), focused while the host page is
	 */
	#clientInfo(
		client: Client,
		described: ClientDescription,
		hostFocused: boolean,
	): ClientInfo {
		const window = client as WindowClient;
		const isWindow = client.type === 'window';
		const top =
			isWindow &&
			client.frameType === 'nested' &&
			!described.resource.startsWith('html:nested');
		return {
			id: client.id,
			url: described.url,
			type: client.type as ClientInfo['type'],
			frameType: (top
				? 'top-level'
				: isWindow
					? client.frameType
					: 'none') as ClientInfo['frameType'],
			focused: isWindow
				? window.focused ||
					(top && hostFocused && window.visibilityState === 'visible')
				: false,
			visibilityState: isWindow ? window.visibilityState : 'hidden',
		};
	}

	/** whether a window that is no proxied page (the host's) has focus */
	async #hostFocused(): Promise<boolean> {
		for (const client of await self.clients.matchAll({
			type: 'window',
			includeUncontrolled: true,
		}))
			if (!this.#env?.describe(client.url) && (client as WindowClient).focused)
				return true;
		return false;
	}

	// ---- the job queue

	/**
	 * Run `job` after the jobs of `scope` before it; it answers with a value
	 * at once and may go on (an install): the next job waits for that too
	 */
	#enqueue<T>(
		scope: string,
		job: () => Promise<{ value: T; rest?: Promise<unknown> }>,
	): Promise<T> {
		const previous = this.#jobs.get(scope) ?? Promise.resolve();
		const run = previous.then(job);
		const tail = run
			.then((result) => result.rest)
			.catch(() => {})
			.finally(() => {
				if (this.#jobs.get(scope) === tail) this.#jobs.delete(scope);
			});
		this.#jobs.set(scope, tail);
		return run.then((result) => result.value);
	}

	// ---- the page's calls

	async api(
		sender: Sender,
		method: string,
		args: Record<string, unknown>,
		ports: MessagePort[],
		waitUntil: (promise: Promise<unknown>) => void,
	): Promise<unknown> {
		await this.#load();
		const host = this.#env?.host(sender.directory);
		switch (method) {
			case 'register':
				return this.#register(sender, args, host, waitUntil);
			case 'getRegistration': {
				const url = String(args.url);
				if (!url.startsWith(`${sender.origin}/`)) return null;
				const record = this.match(url, sender.partition);
				return record ? this.snapshot(record) : null;
			}
			case 'getRegistrations':
				return [...this.#registrations.values()]
					.filter(
						(record) =>
							ownerOf(record) === ownerOf(sender) && !record.uninstalling,
					)
					.map((record) => this.snapshot(record));
			case 'update': {
				const record = this.#own(sender, args.scope);
				if (!host)
					throw new ApiError(
						'InvalidStateError',
						'Failed to update a ServiceWorker: The document is in an invalid state.',
					);
				const done = this.update(record, host, sender.clientId, true);
				waitUntil(done.catch(() => {}));
				await done;
				// the page's registration object catches up to this before the
				// update() promise resolves (its installing, natively set by then)
				return this.snapshot(record);
			}
			case 'unregister': {
				const record = this.#registrations.get(
					keyOf(String(args.scope), sender.partition),
				);
				if (!record || ownerOf(record) !== ownerOf(sender)) return false;
				return this.#enqueue(recordKey(record), async () => ({
					value: await this.#unregister(record),
				}));
			}
			case 'postMessage': {
				const record = this.#own(sender, args.scope);
				const version = [record.installing, record.waiting, record.active].find(
					(candidate) => candidate?.id === args.worker,
				);
				if (!version || !host) return null;
				const window = await self.clients.get(sender.clientId);
				const described = window ? this.#describeClient(window) : null;
				if (!window || !described) return null;
				const deliver = this.#message(record, version, host, {
					data: args.data,
					origin: sender.origin,
					source: {
						client: this.#clientInfo(
							window,
							described,
							await this.#hostFocused(),
						),
					},
					ports,
				});
				waitUntil(deliver.catch(() => {}));
				return null;
			}
			case 'preload': {
				const record = this.#own(sender, args.scope);
				return this.#preload(record, String(args.op), args.value);
			}
			case 'manager': {
				const record = this.#own(sender, args.scope);
				return this.manager(
					record,
					String(args.kind),
					String(args.op),
					(args.args ?? {}) as Record<string, unknown>,
					{ host, clientId: sender.clientId, waitUntil },
				);
			}
		}
		throw new ApiError('NotSupportedError', `Unknown call ${method}`);
	}

	/** a registration of the sender's own origin */
	#own(sender: Sender, scope: unknown): RegistrationRecord {
		const record = this.#registrations.get(
			keyOf(String(scope), sender.partition),
		);
		if (!record || ownerOf(record) !== ownerOf(sender) || record.uninstalling)
			throw new ApiError(
				'InvalidStateError',
				'Failed to update a ServiceWorker: The registration is no longer active.',
			);
		return record;
	}

	async #preload(
		record: RegistrationRecord,
		op: string,
		value: unknown,
	): Promise<unknown> {
		if (op === 'getState') return { ...record.navigationPreload };
		if ((op === 'enable' || op === 'disable') && !record.active)
			throw new ApiError(
				'InvalidStateError',
				`Failed to execute '${op}' on 'NavigationPreloadManager': The registration does not have an active worker.`,
			);
		if (op === 'enable') record.navigationPreload.enabled = true;
		else if (op === 'disable') record.navigationPreload.enabled = false;
		else if (op === 'setHeaderValue')
			record.navigationPreload.headerValue = String(value);
		await (await this.#open()).put('registrations', record, recordKey(record));
		return { ...record.navigationPreload };
	}

	async #register(
		sender: Sender,
		args: Record<string, unknown>,
		host: WorkerHost | undefined,
		waitUntil: (promise: Promise<unknown>) => void,
	): Promise<RegistrationSnapshot> {
		const scriptURL = String(args.scriptURL);
		const scope = String(args.scope);
		const type: WorkerType = args.type === 'module' ? 'module' : 'classic';
		const updateViaCache = (
			['imports', 'all', 'none'].includes(String(args.updateViaCache))
				? args.updateViaCache
				: 'imports'
		) as UpdateViaCache;
		const failed = (reason: string) =>
			`Failed to register a ServiceWorker for scope ('${scope}') with script ('${scriptURL}'): ${reason}`;
		// a plain http site has no service workers (the page has no API)
		const { protocol, hostname } = new URL(sender.url);
		if (
			protocol !== 'https:' &&
			!/^(localhost|.*\.localhost|\[::1\]|127(\.\d{1,3}){3})$/.test(hostname)
		)
			throw new ApiError(
				'SecurityError',
				'Failed to register a ServiceWorker: The document is not a secure context.',
			);
		// the page checked these; the worker never takes another origin's word
		if (
			!scriptURL.startsWith(`${sender.origin}/`) ||
			!scope.startsWith(`${sender.origin}/`)
		)
			throw new ApiError(
				'SecurityError',
				`Failed to register a ServiceWorker: The origin of the provided scriptURL ('${new URL(scriptURL).origin}') does not match the current origin ('${sender.origin}').`,
			);
		if (!host)
			throw new ApiError(
				'InvalidStateError',
				failed('The document is in an invalid state.'),
			);
		const key = keyOf(scope, sender.partition);
		return this.#enqueue(key, async () => {
			let record = this.#registrations.get(key);
			if (record && !record.uninstalling) {
				const newest = record.installing ?? record.waiting ?? record.active;
				if (
					newest &&
					newest.scriptURL === scriptURL &&
					newest.type === type &&
					record.updateViaCache === updateViaCache
				)
					return { value: this.snapshot(record) };
			}
			if (record) {
				record.uninstalling = false;
				record.updateViaCache = updateViaCache;
			} else {
				record = {
					id: uid(),
					scope,
					origin: sender.origin,
					...(sender.partition ? { partition: sender.partition } : {}),
					updateViaCache,
					installing: null,
					waiting: null,
					active: null,
					navigationPreload: { enabled: false, headerValue: 'true' },
					serial: ++this.#serial,
				};
				this.#registrations.set(key, record);
			}
			const result = await this.#update(
				record,
				scriptURL,
				type,
				host,
				sender.clientId,
				failed,
			);
			if (result.rest) waitUntil(result.rest.catch(() => {}));
			return result;
		});
	}

	/**
	 * An update check (a page's update(), a navigation's): the newest
	 * version's script again, a new version when its bytes changed. One at a
	 * time per registration; a soft one (`force` false) is dropped while one
	 * is already queued
	 */
	update(
		record: RegistrationRecord,
		host: WorkerHost,
		clientId: string | undefined,
		force: boolean,
	): Promise<void> {
		if (!force && this.#updating.has(recordKey(record)))
			return Promise.resolve();
		this.#updating.add(recordKey(record));
		return this.#enqueue(recordKey(record), async () => {
			this.#updating.delete(recordKey(record));
			const newest = record.installing ?? record.waiting ?? record.active;
			if (this.#registrations.get(recordKey(record)) !== record || !newest)
				throw new ApiError(
					'InvalidStateError',
					'Failed to update a ServiceWorker: The registration is no longer active.',
				);
			const result = await this.#update(
				record,
				newest.scriptURL,
				newest.type,
				host,
				clientId,
				(reason) =>
					`Failed to update a ServiceWorker for scope ('${record.scope}') with script ('${newest.scriptURL}'): ${reason}`,
			);
			return { value: undefined, rest: result.rest };
		});
	}

	/** the spec's Update: fetch, compare, start, then install in the background */
	async #update(
		record: RegistrationRecord,
		scriptURL: string,
		type: WorkerType,
		host: WorkerHost,
		clientId: string | undefined,
		failed: (reason: string) => string,
	): Promise<{ value: RegistrationSnapshot; rest?: Promise<void> }> {
		const empty = () => !record.installing && !record.waiting && !record.active;
		const fail = (name: string, reason: string): never => {
			// a registration that never got a version is gone again
			if (empty()) this.#registrations.delete(recordKey(record));
			throw new ApiError(name, failed(reason));
		};
		let response: Response;
		try {
			response = await host.fetchScript(
				scriptURL,
				clientId,
				record.updateViaCache !== 'all',
			);
		} catch (error) {
			return fail(
				'TypeError',
				'An unknown error occurred when fetching the script.',
			);
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			return fail(
				'SecurityError',
				'The script resource is behind a redirect, which is disallowed.',
			);
		}
		if (!response.ok) {
			await response.body?.cancel();
			return fail(
				'TypeError',
				`A bad HTTP response code (${response.status}) was received when fetching the script.`,
			);
		}
		const mime = (response.headers.get('content-type') ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		if (!mime) {
			await response.body?.cancel();
			return fail('SecurityError', 'The script does not have a MIME type.');
		}
		if (!JS_MIMES.has(mime)) {
			await response.body?.cancel();
			return fail(
				'SecurityError',
				`The script has an unsupported MIME type ('${mime}').`,
			);
		}
		const allowed = response.headers.get('service-worker-allowed');
		let maxScope: URL;
		try {
			maxScope = allowed
				? new URL(allowed, scriptURL)
				: new URL('./', scriptURL);
		} catch (error) {
			return fail(
				'SecurityError',
				`The provided value ('${allowed}') of the 'Service-Worker-Allowed' header is not a valid URL.`,
			);
		}
		const scopePath = new URL(record.scope).pathname;
		if (
			maxScope.origin !== record.origin ||
			!scopePath.startsWith(maxScope.pathname)
		)
			return fail(
				'SecurityError',
				`The path of the provided scope ('${scopePath}') is not under the max scope allowed ('${maxScope.pathname}'). Adjust the scope, move the Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the scope.`,
			);
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			return fail(
				'TypeError',
				'An unknown error occurred when fetching the script.',
			);
		}
		const db = await this.#open();
		const newest = record.installing ?? record.waiting ?? record.active;
		if (newest && newest.scriptURL === scriptURL && newest.type === type) {
			const stored = (await db.get('scripts', newest.id)) as
				ScriptRecord | undefined;
			if (stored?.script === text) return { value: this.snapshot(record) };
		}

		const version: VersionRecord = {
			id: uid(),
			scriptURL,
			type,
			state: 'parsed',
		};
		await db.put('scripts', { script: text, imports: {} }, version.id);
		// the version's script runs now: one that throws at its top level is
		// an evaluation failure
		let instance: Instance;
		this.#evaluating.set(version.id, { record, version });
		try {
			instance = await this.#instance(record, version, host, true);
		} catch (error) {
			await db.delete('scripts', version.id);
			return fail('TypeError', 'ServiceWorker script evaluation failed');
		} finally {
			this.#evaluating.delete(version.id);
		}
		this.#registrations.set(recordKey(record), record);
		const changes: Change[] = [];
		if (record.installing) {
			this.#stop(record.installing.id);
			changes.push(['state', record.installing, 'redundant']);
		}
		changes.push(['slot', 'installing', version]);
		changes.push(['state', version, 'installing']);
		await this.#commit(record, changes);
		const rest = this.#install(record, version, instance);
		return { value: this.snapshot(record), rest };
	}

	async #install(
		record: RegistrationRecord,
		version: VersionRecord,
		instance: Instance,
	) {
		// after the register call's answer: a page hears updatefound once the
		// registration is in its hands
		await new Promise((resolve) => setTimeout(resolve, 0));
		await this.#commit(record, [['updatefound']]);
		const ok = await this.#event(instance, () =>
			instance.rpc.call('install', null),
		).catch(() => false);
		if (record.installing?.id !== version.id) return;
		if (!ok) {
			await this.#commit(record, [
				['slot', 'installing', null],
				['state', version, 'redundant'],
			]);
			this.#stop(version.id);
			await (await this.#open()).delete('scripts', version.id);
			if (!record.waiting && !record.active) await this.#clear(record);
			return;
		}
		const changes: Change[] = [];
		if (record.waiting) {
			this.#stop(record.waiting.id);
			changes.push(['state', record.waiting, 'redundant']);
		}
		changes.push(['slot', 'waiting', version]);
		changes.push(['slot', 'installing', null]);
		changes.push(['state', version, 'installed']);
		await this.#commit(record, changes);
		await this.#tryActivate(record);
	}

	/** the spec's Try Activate: a waiting version goes active when nothing holds the old one */
	async #tryActivate(record: RegistrationRecord) {
		const waiting = record.waiting;
		if (!waiting || this.#registrations.get(recordKey(record)) !== record)
			return;
		if (
			record.active &&
			!waiting.skipWaiting &&
			(await this.#liveControlled(record)).length
		)
			return;
		await this.#activate(record);
	}

	async #activate(record: RegistrationRecord) {
		const next = record.waiting!;
		const old = record.active;
		const changes: Change[] = [];
		if (old) changes.push(['state', old, 'redundant']);
		changes.push(['slot', 'active', next]);
		changes.push(['slot', 'waiting', null]);
		changes.push(['state', next, 'activating']);
		await this.#commit(record, changes);
		if (old) {
			this.#stop(old.id);
			await (await this.#open()).delete('scripts', old.id);
		}
		// the clients the old version controlled have the new one now
		const snapshot = this.snapshot(record);
		for (const client of await this.#liveControlled(record))
			if (client.type === 'window')
				await this.#post(client.id, {
					kind: 'controller',
					origin: record.origin,
					...partitionOf(record),
					registration: snapshot,
					worker: this.#worker(next)!,
				});
		const host = this.#env?.host();
		if (host)
			try {
				const instance = await this.#instance(record, next, host);
				await this.#event(instance, () => instance.rpc.call('activate', null));
			} catch (error) {
				// activation goes on whether the event handler did or not
			}
		if (record.active?.id === next.id && next.state === 'activating')
			await this.#commit(record, [['state', next, 'activated']]);
	}

	async #unregister(record: RegistrationRecord): Promise<boolean> {
		if (this.#registrations.get(recordKey(record)) !== record) return false;
		record.uninstalling = true;
		await (await this.#open()).put('registrations', record, recordKey(record));
		if (!(await this.#liveControlled(record)).length) await this.#clear(record);
		return true;
	}

	/** the spec's Clear Registration: every version redundant, the registration gone */
	async #clear(record: RegistrationRecord) {
		const changes: Change[] = [];
		for (const slot of ['installing', 'waiting', 'active'] as const) {
			const version = record[slot];
			if (!version) continue;
			this.#stop(version.id);
			changes.push(['slot', slot, null]);
			changes.push(['state', version, 'redundant']);
		}
		if (changes.length) await this.#commit(record, changes);
		const db = await this.#open();
		for (const version of [record.installing, record.waiting, record.active])
			if (version) await db.delete('scripts', version.id);
		if (this.#registrations.get(recordKey(record)) === record) {
			this.#registrations.delete(recordKey(record));
			await db.delete('registrations', recordKey(record));
		}
		for (const [id, scope] of [...this.#controlled])
			if (scope === recordKey(record)) {
				this.#controlled.delete(id);
				await db.delete('controlled', id);
			}
		await this.#broadcast(ownerOf(record), {
			kind: 'removed',
			origin: record.origin,
			...partitionOf(record),
			registration: record.id,
		});
	}

	/**
	 * What waits on clients going away: a waiting version whose old one
	 * controls nothing now, an unregistered registration with no clients
	 * left. Run on the page's calls and on navigations
	 */
	sweep() {
		this.#resumeSyncs();
		for (const record of this.#registrations.values()) {
			if (record.uninstalling)
				this.#enqueue(recordKey(record), async () => {
					if (!(await this.#liveControlled(record)).length)
						await this.#clear(record);
					return { value: undefined };
				}).catch(() => {});
			else if (record.waiting && record.active)
				this.#enqueue(recordKey(record), async () => {
					await this.#tryActivate(record);
					return { value: undefined };
				}).catch(() => {});
		}
	}

	// ---- cookie change subscriptions (registration.cookies)

	/** what each registration has seen of the jar, by subscription URL, cookie id */
	readonly #cookiesSeen = new Map<
		string,
		Map<string, Map<string, JarCookie>>
	>();
	/** registrations whose subscriptions are being compared with the jar */
	readonly #cookieChecks = new Map<string, Promise<void>>();

	/**
	 * The jar changed (Stomp's cookie module tells): every registration with
	 * cookie change subscriptions compares what its URLs show now with what
	 * they showed, and its worker gets one ExtendableCookieChangeEvent per
	 * cookie a subscription covers, as Chrome sends them
	 */
	cookiesChanged() {
		for (const record of this.#registrations.values())
			if (record.cookieSubscriptions?.length && record.active)
				this.#checkCookies(record).catch(() => {});
	}

	#checkCookies(record: RegistrationRecord): Promise<void> {
		// one comparison at a time; a change during it compares again after
		const running = this.#cookieChecks.get(recordKey(record));
		const next = (running ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.#compareCookies(record));
		this.#cookieChecks.set(recordKey(record), next);
		next.finally(() => {
			if (this.#cookieChecks.get(recordKey(record)) === next)
				this.#cookieChecks.delete(recordKey(record));
		});
		return next;
	}

	/** what each subscription URL shows now; `report` false records it without events */
	async #compareCookies(record: RegistrationRecord, report = true) {
		const host = this.#env?.host();
		const subscriptions = record.cookieSubscriptions ?? [];
		if (!host || !subscriptions.length) return;
		let seen = this.#cookiesSeen.get(recordKey(record));
		// a registration this worker has not looked at yet (a restart):
		// what the jar shows now is where its changes start
		if (!seen) {
			seen = new Map();
			this.#cookiesSeen.set(recordKey(record), seen);
			report = false;
		}
		const changed = new Map<string, JarCookie>();
		const deleted = new Map<string, JarCookie>();
		const covers = (subscription: { name?: string }, cookie: JarCookie) =>
			subscription.name === undefined || subscription.name === cookie.name;
		const differs = (a: JarCookie, b: JarCookie) =>
			a.value !== b.value ||
			a.expires !== b.expires ||
			a.secure !== b.secure ||
			a.sameSite !== b.sameSite ||
			a.hostOnly !== b.hostOnly;
		for (const url of new Set(subscriptions.map((item) => item.url))) {
			const now = new Map(
				(
					await host.jarCookies(
						url,
						partitionSite(record.partition ?? '') ?? undefined,
					)
				).map((cookie) => [cookie.id, cookie]),
			);
			const before = seen.get(url);
			seen.set(url, now);
			if (!before || !report) continue;
			const wanted = subscriptions.filter((item) => item.url === url);
			for (const [id, cookie] of before)
				if (!now.has(id) && wanted.some((item) => covers(item, cookie)))
					deleted.set(id, cookie);
			for (const [id, cookie] of now) {
				const old = before.get(id);
				if (
					(!old || differs(old, cookie)) &&
					wanted.some((item) => covers(item, cookie))
				)
					changed.set(id, cookie);
			}
		}
		for (const url of [...seen.keys()])
			if (!subscriptions.some((item) => item.url === url)) seen.delete(url);
		const version = record.active;
		if (!version || (!changed.size && !deleted.size)) return;
		const instance = await this.#instance(record, version, host);
		for (const cookie of deleted.values())
			await this.#event(instance, () =>
				instance.rpc.call('cookieChange', { changed: [], deleted: [cookie] }),
			);
		for (const cookie of changed.values())
			await this.#event(instance, () =>
				instance.rpc.call('cookieChange', { changed: [cookie], deleted: [] }),
			);
	}

	// ---- the registration's managers (docs/service-workers.md)

	/** background fetches, by scope and id; kept while this worker runs */
	readonly #backgroundFetches = new Map<string, Map<string, BackgroundFetch>>();
	/** sync tags whose event is running or waiting for its retry */
	readonly #syncing = new Set<string>();

	/**
	 * A call of one of a registration's managers, from a page of its site or
	 * from its own worker (`inWorker`). Sync runs; periodic sync is refused as
	 * Chrome refuses it without the permission; background fetch downloads
	 * through the proxy and tells the worker; the payment manager and cookie
	 * change subscriptions keep what they are given
	 */
	async manager(
		record: RegistrationRecord,
		kind: string,
		op: string,
		args: Record<string, unknown>,
		from: {
			host?: WorkerHost;
			clientId?: string;
			inWorker?: boolean;
			waitUntil?: (promise: Promise<unknown>) => void;
		},
	): Promise<unknown> {
		const persist = async () => {
			if (this.#registrations.get(recordKey(record)) === record)
				await (
					await this.#open()
				).put('registrations', record, recordKey(record));
		};
		const failed = (on: string, method: string, message: string) =>
			`Failed to execute '${method}' on '${on}': ${message}`;
		if (kind === 'sync') {
			record.syncTags ??= [];
			if (op === 'getTags') return [...record.syncTags];
			if (op !== 'register') return undefined;
			if (!record.active)
				throw new ApiError(
					'InvalidStateError',
					'Registration failed - no active Service Worker',
				);
			const tag = String(args.tag);
			if (!record.syncTags.includes(tag)) record.syncTags.push(tag);
			await persist();
			const run = this.#runSync(record, tag, 0, from.host);
			from.waitUntil?.(run);
			return undefined;
		}
		if (kind === 'periodicSync') {
			if (op === 'register')
				throw new ApiError('NotAllowedError', 'Permission denied.');
			if (op === 'getTags') return [];
			return undefined;
		}
		if (kind === 'paymentManager') {
			if (op === 'userHint') {
				record.userHint = String(args.value);
				await persist();
				return undefined;
			}
			if (op === 'enableDelegations') return true;
			return undefined;
		}
		if (kind === 'cookies') {
			record.cookieSubscriptions ??= [];
			const list = (
				(args.subscriptions as { name?: string; url?: string }[]) ?? []
			).map((item) => {
				let url: string;
				try {
					url = new URL(item.url ?? '', record.scope).href;
				} catch (error) {
					throw new ApiError(
						'TypeError',
						failed('CookieStoreManager', op, 'Invalid URL.'),
					);
				}
				if (!url.startsWith(record.scope))
					throw new ApiError(
						'TypeError',
						failed(
							'CookieStoreManager',
							op,
							'URL must be within ServiceWorker scope',
						),
					);
				return { ...(item.name !== undefined ? { name: item.name } : {}), url };
			});
			const same = (
				a: { name?: string; url: string },
				b: { name?: string; url: string },
			) => a.name === b.name && a.url === b.url;
			if (op === 'getSubscriptions')
				return record.cookieSubscriptions.map((item) => ({ ...item }));
			if (op === 'subscribe')
				for (const item of list)
					if (!record.cookieSubscriptions.some((kept) => same(kept, item)))
						record.cookieSubscriptions.push(item);
			if (op === 'unsubscribe')
				record.cookieSubscriptions = record.cookieSubscriptions.filter(
					(kept) => !list.some((item) => same(kept, item)),
				);
			await persist();
			// a new URL's cookies are where its changes start
			await this.#checkCookies(record).catch(() => {});
			return undefined;
		}
		if (kind === 'backgroundFetch')
			return this.#backgroundFetch(record, op, args, from);
		throw new ApiError('NotSupportedError', `Unknown manager ${kind}`);
	}

	/**
	 * A SyncEvent for `tag` in the registration's active worker; done, the
	 * tag goes. One that fails is tried again as Chrome does it, after 5 and
	 * then 15 minutes, the last with lastChance
	 */
	async #runSync(
		record: RegistrationRecord,
		tag: string,
		attempt: number,
		preferred?: WorkerHost,
	) {
		const key = `${recordKey(record)} ${tag}`;
		if (this.#syncing.has(key) && attempt === 0) return;
		this.#syncing.add(key);
		const version = record.active;
		const host = preferred ?? this.#env?.host();
		let ok = false;
		if (version && host)
			try {
				const instance = await this.#instance(record, version, host);
				ok = await this.#event(instance, () =>
					instance.rpc.call('sync', { tag, lastChance: attempt >= 2 }),
				);
			} catch (error) {
				ok = false;
			}
		if (ok || attempt >= 2) {
			this.#syncing.delete(key);
			record.syncTags = (record.syncTags ?? []).filter((kept) => kept !== tag);
			if (this.#registrations.get(recordKey(record)) === record)
				await (
					await this.#open()
				).put('registrations', record, recordKey(record));
			return;
		}
		setTimeout(
			() => {
				this.#runSync(record, tag, attempt + 1).catch(() => {});
			},
			attempt === 0 ? 5 * 60_000 : 15 * 60_000,
		);
	}

	/** pending sync tags this worker is not running (after a restart) */
	#resumeSyncs() {
		for (const record of this.#registrations.values())
			for (const tag of record.syncTags ?? [])
				if (!this.#syncing.has(`${recordKey(record)} ${tag}`))
					this.#runSync(record, tag, 0).catch(() => {});
	}

	async #backgroundFetch(
		record: RegistrationRecord,
		op: string,
		args: Record<string, unknown>,
		from: {
			host?: WorkerHost;
			clientId?: string;
			waitUntil?: (promise: Promise<unknown>) => void;
		},
	): Promise<unknown> {
		let fetches = this.#backgroundFetches.get(recordKey(record));
		if (!fetches)
			this.#backgroundFetches.set(recordKey(record), (fetches = new Map()));
		const id = String(args.id ?? '');
		const failed = (message: string) =>
			`Failed to execute '${op}' on 'BackgroundFetchManager': ${message}`;
		if (op === 'getIds') return [...fetches.keys()];
		if (op === 'get') return fetches.get(id)?.snapshot ?? null;
		const entry = fetches.get(id);
		if (op === 'abort') {
			if (!entry || entry.snapshot.result) return false;
			entry.aborted = true;
			entry.snapshot.result = 'failure';
			entry.snapshot.failureReason = 'aborted';
			const ended = this.#endFetch(
				record,
				entry,
				'backgroundfetchabort',
				from.host,
			);
			from.waitUntil?.(ended);
			return true;
		}
		if (op === 'records') {
			if (!entry) return [];
			const url = args.url === undefined ? undefined : String(args.url);
			return entry.records.filter(
				(item) => url === undefined || item.request.url === url,
			);
		}
		if (op !== 'fetch') return undefined;
		const requests =
			(args.requests as BackgroundFetchRecordWire['request'][]) ?? [];
		if (!id)
			throw new ApiError('TypeError', failed('The provided id is empty.'));
		if (!requests.length)
			throw new ApiError(
				'TypeError',
				failed('At least one request must be given.'),
			);
		if (!record.active)
			throw new ApiError(
				'TypeError',
				failed(
					'No active registration available on the ServiceWorkerRegistration.',
				),
			);
		if (entry)
			throw new ApiError(
				'TypeError',
				failed('There already is a registration for the given id.'),
			);
		const created: BackgroundFetch = {
			snapshot: {
				id,
				uploadTotal: 0,
				uploaded: 0,
				downloadTotal: Number(args.downloadTotal) || 0,
				downloaded: 0,
				result: '',
				failureReason: '',
				recordsAvailable: true,
			},
			records: requests.map((request) => ({ request, response: null })),
			aborted: false,
		};
		fetches.set(id, created);
		const download = this.#download(record, created, from);
		from.waitUntil?.(download);
		return { ...created.snapshot };
	}

	/** a background fetch's requests through the proxy, then its event in the worker */
	async #download(
		record: RegistrationRecord,
		entry: BackgroundFetch,
		from: { host?: WorkerHost; clientId?: string },
	) {
		const host = from.host ?? this.#env?.host();
		let failure: BackgroundFetchSnapshot['failureReason'] = '';
		for (const item of entry.records) {
			if (entry.aborted) return;
			try {
				if (!host) throw new Error('no controller');
				const response = await host.fetchResource(
					item.request.url,
					{ method: item.request.method, headers: item.request.headers },
					from.clientId,
				);
				// refused (CORS, CORP, mixed content) or unreachable
				if (response.type === 'error') throw new Error('network error');
				const body = await response.blob();
				item.response = {
					status: response.status,
					statusText: response.statusText,
					headers: [...response.headers],
					body,
				};
				entry.snapshot.downloaded += body.size;
				if (!response.ok && !failure) failure = 'bad-status';
			} catch (error) {
				if (!failure) failure = 'fetch-error';
			}
			if (
				entry.snapshot.downloadTotal &&
				entry.snapshot.downloaded > entry.snapshot.downloadTotal
			) {
				failure = 'download-total-exceeded';
				break;
			}
		}
		if (entry.aborted) return;
		entry.snapshot.result = failure ? 'failure' : 'success';
		entry.snapshot.failureReason = failure;
		await this.#endFetch(
			record,
			entry,
			failure ? 'backgroundfetchfail' : 'backgroundfetchsuccess',
			host,
		);
	}

	/** the fetch's event in the worker; once it is done the fetch and its records go */
	async #endFetch(
		record: RegistrationRecord,
		entry: BackgroundFetch,
		type:
			'backgroundfetchsuccess' | 'backgroundfetchfail' | 'backgroundfetchabort',
		preferred?: WorkerHost,
	) {
		const version = record.active;
		const host = preferred ?? this.#env?.host();
		if (version && host)
			try {
				const instance = await this.#instance(record, version, host);
				await this.#event(instance, () =>
					instance.rpc.call('backgroundFetch', {
						type,
						fetch: { ...entry.snapshot },
					}),
				);
			} catch (error) {
				// the fetch ends whether its handler ran or not
			}
		entry.snapshot.recordsAvailable = false;
		this.#backgroundFetches.get(recordKey(record))?.delete(entry.snapshot.id);
	}

	// ---- instances

	#timeouts(host: WorkerHost) {
		const base = host.timeout ?? DEFAULT_TIMEOUT_MS;
		return { start: base * 2, ack: base, response: base * 6 };
	}

	/** the running instance of a version, started in `host` when there is none */
	async #instance(
		record: RegistrationRecord,
		version: VersionRecord,
		host: WorkerHost,
		evaluating = false,
	): Promise<Instance> {
		const existing = this.#instances.get(version.id);
		if (existing && !existing.dead) {
			await existing.started;
			if (!existing.dead) return existing;
		}
		const id = `${version.id}.${uid()}`;
		const instance: Instance = {
			id,
			version: version.id,
			scope: recordKey(record),
			host,
			rpc: undefined as unknown as Instance['rpc'],
			started: undefined as unknown as Promise<void>,
			inflight: 0,
			dead: false,
		};
		instance.rpc = new RpcHelper<FromEmulated, ToEmulated>(
			this.#handlers(instance, version),
			SW_RPC,
			(data, transfer) => {
				if (instance.port) postToPort(instance.port, data, transfer);
			},
		);
		const helloed = new Promise<{ evaluated: boolean; error?: string }>(
			(resolve) => {
				instance.hello = resolve;
			},
		);
		const { start } = this.#timeouts(host);
		instance.started = (async () => {
			const port = await withTimeout(
				host.start(
					id,
					host.scriptRoute(version.id, version.scriptURL),
					version.type,
				),
				start,
				'starting the worker',
			);
			instance.port = port;
			port.addEventListener('message', (event) =>
				instance.rpc.receive(event.data),
			);
			port.start();
			const result = await withTimeout(helloed, start, 'the worker');
			if (!result.evaluated)
				throw new Error(
					`the worker's script failed${result.error ? `: ${result.error}` : ''}`,
				);
		})();
		this.#instances.set(version.id, instance);
		try {
			await instance.started;
		} catch (error) {
			this.#kill(instance);
			if (!evaluating)
				console.warn('Stomp: an emulated service worker did not start', error);
			throw error;
		}
		this.#idle(instance);
		return instance;
	}

	/** run an event on an instance, keeping it from going idle meanwhile */
	async #event<T>(instance: Instance, run: () => Promise<T>): Promise<T> {
		instance.inflight++;
		if (instance.idle) clearTimeout(instance.idle);
		try {
			return await run();
		} finally {
			instance.inflight--;
			this.#idle(instance);
		}
	}

	#idle(instance: Instance) {
		if (instance.idle) clearTimeout(instance.idle);
		if (instance.inflight || instance.dead) return;
		instance.idle = setTimeout(() => {
			if (!instance.inflight) this.#kill(instance);
		}, IDLE_MS);
	}

	#kill(instance: Instance) {
		if (instance.dead) return;
		instance.dead = true;
		if (instance.idle) clearTimeout(instance.idle);
		instance.rpc.abort('The worker stopped');
		instance.port?.close();
		instance.host.stop(instance.id);
		if (this.#instances.get(instance.version) === instance)
			this.#instances.delete(instance.version);
	}

	#stop(version: string) {
		const instance = this.#instances.get(version);
		if (instance) this.#kill(instance);
	}

	/** a controller went away: the instances it hosted are gone with it */
	dropHost(directory: string) {
		for (const instance of [...this.#instances.values()])
			if (instance.host.directory === directory) this.#kill(instance);
	}

	/** the handlers of what an instance calls */
	#handlers(
		instance: Instance,
		version: VersionRecord,
	): ConstructorParameters<typeof RpcHelper<FromEmulated, ToEmulated>>[0] {
		const record = () => {
			const found = this.#registrations.get(instance.scope);
			if (!found) throw new Error('The registration is gone');
			return found;
		};
		return {
			hello: async (result) => {
				instance.hello?.(result);
			},
			preloadResponse: async ({ event }) => {
				const preload = this.#preloads.get(event);
				const response = await preload?.response;
				if (!preload || !response) return [null, []];
				return [
					{
						status: response.status,
						statusText: response.statusText,
						headers: [...response.headers],
						body: null,
						url: preload.url,
						redirected: false,
						type: 'basic',
					},
					[],
				];
			},
			preloadBody: async ({ event }) => {
				const preload = this.#preloads.get(event);
				const response = await preload?.response;
				if (!preload || !response?.body || preload.taken) return [null, []];
				preload.taken = true;
				this.#preloads.delete(event);
				const body = sendBody(response.body);
				return [body, [body.$stompBodyPort]];
			},
			respond: async ({ event, answer }) => {
				const pending = this.#fetches.get(event);
				if (!pending) {
					if (answer.kind === 'response' && answer.response.body)
						answer.response.body.$stompBodyPort.close();
					return;
				}
				pending.resolve(answer);
			},
			skipWaiting: async () => {
				version.skipWaiting = true;
				const own = record();
				// not awaited: an install that waits on skipWaiting() would
				// otherwise wait on itself
				this.#enqueue(recordKey(own), async () => {
					await this.#tryActivate(own);
					return { value: undefined };
				}).catch(() => {});
			},
			claim: async () => [await this.#claim(record(), version), []],
			matchAll: async (options) => [
				await this.#matchAll(record(), options),
				[],
			],
			getClient: async (id) => [await this.#getClient(record(), id), []],
			postToClient: async ({ id, data, ports }) => {
				const own = record();
				const client = await self.clients.get(id);
				const described = client ? this.#describeClient(client) : null;
				// another site's client never hears this worker
				if (!client || !described || ownerOf(described) !== ownerOf(own))
					return;
				if (client.type !== 'window') return;
				this.#send(
					client,
					{
						kind: 'message',
						origin: own.origin,
						...partitionOf(own),
						registration: this.snapshot(own),
						source: this.#worker(version)!,
						data,
					},
					ports,
				);
			},
			postToWorker: async ({ worker, data, ports }) => {
				const own = record();
				const target = [own.installing, own.waiting, own.active].find(
					(candidate) => candidate?.id === worker,
				);
				if (!target) return;
				this.#message(own, target, instance.host, {
					data,
					origin: own.origin,
					source: { worker: this.#worker(version)! },
					ports,
				}).catch(() => {});
			},
			navigate: async ({ id, url }) => [
				await this.#navigate(record(), version, id, url),
				[],
			],
			update: async () => {
				try {
					await this.update(record(), instance.host, undefined, true);
					return [null, []];
				} catch (error) {
					return [
						error instanceof ApiError
							? error.info
							: { name: 'TypeError', message: String(error) },
						[],
					];
				}
			},
			unregister: async () => {
				const own = record();
				return [
					await this.#enqueue(recordKey(own), async () => ({
						value: await this.#unregister(own),
					})),
					[],
				];
			},
			preload: async ({ op, value }) => {
				try {
					return [await this.#preload(record(), op, value), []];
				} catch (error) {
					return [{ ...record().navigationPreload }, []];
				}
			},
			manager: async ({ kind, op, args }) => {
				try {
					return [
						{
							value: await this.manager(record(), kind, op, args ?? {}, {
								host: instance.host,
								inWorker: true,
							}),
						},
						[],
					];
				} catch (error) {
					return [
						{
							error:
								error instanceof ApiError
									? error.info
									: { name: 'TypeError', message: String(error) },
						},
						[],
					];
				}
			},
		};
	}

	/** clients.claim(): every client of the site within scope is this registration's */
	async #claim(
		record: RegistrationRecord,
		version: VersionRecord,
	): Promise<ErrorInfo | null> {
		if (record.active?.id !== version.id)
			return {
				name: 'InvalidStateError',
				message: 'Only the active worker can claim clients.',
			};
		const snapshot = this.snapshot(record);
		for (const client of await self.clients.matchAll({
			includeUncontrolled: true,
			type: 'all',
		})) {
			const described = this.#describeClient(client);
			if (!described || ownerOf(described) !== ownerOf(record)) continue;
			if (this.match(described.url, described.partition) !== record) continue;
			if (this.#controlled.get(client.id) === recordKey(record)) continue;
			await this.#setControlled(client.id, record);
			if (client.type === 'window')
				this.#send(client, {
					kind: 'controller',
					origin: record.origin,
					...partitionOf(record),
					registration: snapshot,
					worker: this.#worker(version)!,
				});
		}
		return null;
	}

	async #matchAll(
		record: RegistrationRecord,
		options: { includeUncontrolled: boolean; type: string },
	): Promise<ClientInfo[]> {
		const found: ClientInfo[] = [];
		const hostFocused = await this.#hostFocused();
		for (const client of await self.clients.matchAll({
			includeUncontrolled: true,
			type: 'all',
		})) {
			if (options.type !== 'all' && client.type !== options.type) continue;
			const described = this.#describeClient(client);
			if (!described || ownerOf(described) !== ownerOf(record)) continue;
			if (
				!options.includeUncontrolled &&
				this.#controlled.get(client.id) !== recordKey(record)
			)
				continue;
			found.push(this.#clientInfo(client, described, hostFocused));
		}
		return found;
	}

	async #getClient(
		record: RegistrationRecord,
		id: string,
	): Promise<ClientInfo | null> {
		const client = await self.clients.get(id);
		const described = client ? this.#describeClient(client) : null;
		if (!client || !described || ownerOf(described) !== ownerOf(record))
			return null;
		return this.#clientInfo(client, described, await this.#hostFocused());
	}

	async #navigate(
		record: RegistrationRecord,
		version: VersionRecord,
		id: string,
		url: string,
	): Promise<ClientInfo | null | ErrorInfo> {
		const client = await self.clients.get(id);
		const described = client ? this.#describeClient(client) : null;
		if (
			!client ||
			!described ||
			client.type !== 'window' ||
			ownerOf(described) !== ownerOf(record) ||
			this.#controlled.get(id) !== recordKey(record) ||
			record.active?.id !== version.id
		)
			return {
				name: 'TypeError',
				message:
					"Failed to execute 'navigate' on 'WindowClient': This service worker is not the client's active service worker.",
			};
		const host = this.#env?.host(described.directory);
		if (!host) return null;
		const navigated = await (client as WindowClient).navigate(
			host.routeDocument(url),
		);
		if (!navigated) return null;
		const again = this.#describeClient(navigated);
		return again && ownerOf(again) === ownerOf(record)
			? this.#clientInfo(navigated, again, await this.#hostFocused())
			: null;
	}

	/** an ExtendableMessageEvent for a version, started when it is not running */
	async #message(
		record: RegistrationRecord,
		version: VersionRecord,
		host: WorkerHost,
		init: MessageInit,
	) {
		const instance = await this.#instance(record, version, host);
		await this.#event(instance, () =>
			instance.rpc.call('message', init, init.ports),
		);
	}

	// ---- the emulated workers' own scripts

	/** a version's main script and type, for the `sw:` route */
	async script(versionId: string): Promise<{
		script: string;
		info: {
			version: WorkerSnapshot;
			registration: RegistrationSnapshot;
			type: WorkerType;
		};
	} | null> {
		await this.#load();
		for (const record of this.#registrations.values())
			for (const version of [record.installing, record.waiting, record.active])
				if (version?.id === versionId) {
					const stored = (await (
						await this.#open()
					).get('scripts', versionId)) as ScriptRecord | undefined;
					if (!stored) return null;
					return {
						script: stored.script,
						info: {
							version: this.#worker(version)!,
							registration: this.snapshot(record),
							type: version.type,
							...(record.partition ? { partition: record.partition } : {}),
						},
					};
				}
		// a version still being evaluated is not in a slot yet
		const pending = this.#evaluating.get(versionId);
		if (!pending) return null;
		const stored = (await (await this.#open()).get('scripts', versionId)) as
			ScriptRecord | undefined;
		if (!stored) return null;
		return {
			script: stored.script,
			info: {
				version: this.#worker(pending.version)!,
				registration: this.snapshot(pending.record),
				type: pending.version.type,
				...(pending.record.partition
					? { partition: pending.record.partition }
					: {}),
			},
		};
	}
	/** versions whose script runs for the first time (state `parsed`) */
	readonly #evaluating = new Map<
		string,
		{ record: RegistrationRecord; version: VersionRecord }
	>();

	/** whether a client is a proxied page or worker (never the one that may start an emulated worker) */
	async isProxiedClient(clientId: string | undefined): Promise<boolean> {
		if (!clientId) return false;
		const client = await self.clients.get(clientId);
		return !!client && !!this.#env?.describe(client.url);
	}

	/** an emulated worker's client id, from the request for its script */
	markEmulated(clientId: string | undefined, version: string) {
		if (clientId) this.#emulated.set(clientId, version);
	}

	/** whether a client is an emulated worker (of `version`, when given) */
	isEmulated(clientId: string | undefined, url?: string, version?: string) {
		if (!clientId) return false;
		const own = this.#emulated.get(clientId);
		if (own !== undefined) return version === undefined || own === version;
		// after a restart the map is empty: the client's route says it
		const described = url ? this.#env?.describe(url) : null;
		if (!described?.resource.startsWith('sw:')) return false;
		const of = described.resource.slice(3);
		this.#emulated.set(clientId, of);
		return version === undefined || of === version;
	}

	/** the partition of a version's registration ('' when there is none) */
	versionPartition(versionId: string): string {
		for (const record of this.#registrations.values())
			for (const version of [record.installing, record.waiting, record.active])
				if (version?.id === versionId) return record.partition ?? '';
		return this.#evaluating.get(versionId)?.record.partition ?? '';
	}

	/** the state of a version, for the `swimport:` route */
	versionState(versionId: string): WorkerState | null {
		for (const record of this.#registrations.values())
			for (const version of [record.installing, record.waiting, record.active])
				if (version?.id === versionId) return version.state;
		return this.#evaluating.has(versionId) ? 'parsed' : null;
	}

	async storedImport(versionId: string, url: string): Promise<string | null> {
		const stored = (await (await this.#open()).get('scripts', versionId)) as
			ScriptRecord | undefined;
		return stored?.imports[url] ?? null;
	}

	async storeImport(versionId: string, url: string, text: string) {
		const db = await this.#open();
		const stored = (await db.get('scripts', versionId)) as
			ScriptRecord | undefined;
		if (!stored) return;
		stored.imports[url] = text;
		await db.put('scripts', stored, versionId);
	}

	// ---- fetch interception

	/**
	 * The registration a request goes to, if any: for a navigation or a
	 * worker script the one whose scope prefixes the URL (the new client is
	 * then controlled by it), else the one that controls the client
	 */
	async route(request: {
		url: string;
		nonSubresource: boolean;
		clientId?: string;
		clientURL?: string;
		resultingClientId?: string;
		/** the partition of the document or worker a navigation or worker script makes */
		partition?: string;
	}): Promise<{ record: RegistrationRecord; control?: ControlInfo } | null> {
		if (!(await this.any())) return null;
		// an emulated worker's own requests are never its own (it is never a
		// controlled client either)
		if (request.clientId && this.#emulated.has(request.clientId)) return null;
		if (request.nonSubresource) {
			const record = this.match(request.url, request.partition ?? '');
			if (!record?.active) return null;
			if (request.resultingClientId)
				await this.#setControlled(request.resultingClientId, record);
			return {
				record,
				control: {
					registration: this.snapshot(record),
					worker: this.#worker(record.active)!,
					...partitionOf(record),
				},
			};
		}
		if (!request.clientId) return null;
		const record = await this.controllerOf(request.clientId);
		return record ? { record } : null;
	}

	/**
	 * Dispatch a FetchEvent to a registration's active version: its answer,
	 * or null for the network (no respondWith, a worker that would not start
	 * or answer in time, an opaque answer)
	 */
	async dispatch<N extends Response>(
		record: RegistrationRecord,
		host: WorkerHost,
		init: Omit<FetchInit, 'id' | 'preload'>,
		preload?: Promise<N>,
	): Promise<Response | { network: N } | null> {
		const id = uid();
		if (!preload) {
			const answer = await this.#dispatch(id, record, host, init);
			return answer === USE_PRELOAD ? null : answer;
		}
		const state: Preload = {
			response: preload.catch(() => null),
			url: init.request.url,
			taken: false,
		};
		this.#preloads.set(id, state);
		const answer = await this.#dispatch(id, record, host, {
			...init,
			preload: true,
		});
		const drop = () => {
			if (this.#preloads.get(id) !== state) return;
			this.#preloads.delete(id);
			state.response.then((response) =>
				response?.body?.cancel().catch(() => {}),
			);
		};
		// no answer: the page's request goes to the network on its own, and the
		// preload's answer is dropped (Chrome 152 sends the navigation again)
		if (answer === null) {
			drop();
			return null;
		}
		if (answer === USE_PRELOAD) {
			// the network's answer, unread by the worker: the page gets it
			const response = state.taken ? null : await state.response;
			this.#preloads.delete(id);
			if (response && !state.taken) return { network: response as N };
			return null;
		}
		// the worker answered with its own response, which may still read the
		// preload's body as it streams
		if (answer.type === 'error') drop();
		else setTimeout(drop, PRELOAD_KEEP_MS);
		return answer;
	}

	async #dispatch(
		id: string,
		record: RegistrationRecord,
		host: WorkerHost,
		init: Omit<FetchInit, 'id'>,
	): Promise<Response | typeof USE_PRELOAD | null> {
		const version = record.active;
		if (!version) return null;
		const { ack, response: answerWait } = this.#timeouts(host);
		let instance: Instance;
		try {
			instance = await this.#instance(record, version, host);
		} catch (error) {
			return null;
		}
		let resolve!: (answer: FetchAnswer) => void;
		const answered = new Promise<FetchAnswer>((done) => (resolve = done));
		this.#fetches.set(id, { resolve });
		try {
			return await this.#event(instance, async () => {
				const responded = await withTimeout(
					instance.rpc.call('fetch', { ...init, id }),
					ack,
					'the fetch event',
				).catch((error) => {
					// a worker that cannot even say whether it answers is stuck:
					// the next event starts a new one
					this.#kill(instance);
					throw error;
				});
				if (!responded) return null;
				const answer = await withTimeout(answered, answerWait, 'respondWith');
				if (answer.kind === 'network') return null;
				if (answer.kind === 'preload') return USE_PRELOAD;
				if (answer.kind === 'error') return Response.error();
				const wire = answer.response;
				const body = wire.body ? receiveBody(wire.body) : null;
				const nullBody = [101, 103, 204, 205, 304].includes(wire.status);
				if (nullBody) body?.cancel().catch(() => {});
				const headers = new Headers(wire.headers);
				// its type and URL, for the page (the inject reads them)
				headers.set(
					RESPONSE_TYPE_HEADER,
					`${wire.type ?? 'basic'} ${wire.url}`,
				);
				return new Response(nullBody ? null : body, {
					status: wire.status < 200 || wire.status > 599 ? 200 : wire.status,
					statusText: wire.statusText,
					headers,
				});
			});
		} catch (error) {
			console.warn(
				`Stomp: the emulated service worker for ${record.scope} did not answer ${init.request.url} in time; the network answers`,
				error,
			);
			return null;
		} finally {
			this.#fetches.delete(id);
		}
	}

	/** an update check after a navigation the registration took */
	softUpdate(record: RegistrationRecord, host: WorkerHost): Promise<void> {
		return this.update(record, host, undefined, false).catch(() => {});
	}
}

/** the one instance of Stomp's service worker */
export const serviceWorkers = new ServiceWorkers();
