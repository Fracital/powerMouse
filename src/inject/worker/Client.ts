import { ParsedConfig } from '../../config';
import { workerKindPartition } from '../../partition';
import type { RewriterLib } from '../../rewriterLib';
import { rewriterLibJS } from '../../routeURL';
import type { EmulateInfo } from '../../serviceWorkerTypes';
import { WORKER_PARTITION } from '../../transport/messages';
import { replayOf } from '../../transport/ports';
import { LIBRARY_FACTORY, LIGHT_FACTORY } from '../../version';
import Client, { type HandedModules } from '../Client';
import { shareRewriter } from '../rewriter';
import ServiceWorkerGlobalModule from './modules/ServiceWorkerGlobal';

let transportPort: Promise<MessagePort> | undefined;

/** Called by the worker entry once it has started listening for TRANSPORT_INIT. */
export function setWorkerTransportPort(port: Promise<MessagePort>) {
	transportPort = port;
}

let workerModules: Promise<HandedModules | null> | undefined;

/**
 * Called by the entry of a dedicated worker: settles with the compiled wasm
 * modules the worker's first message brought, or that followed it (null
 * when the context that started it held none)
 */
export function setWorkerModules(modules: Promise<HandedModules | null>) {
	workerModules = modules;
}

let serviceWorkerPort: Promise<MessagePort> | undefined;

/** Called by the worker entry once it has started listening for SW_PORT (an emulated service worker's port to STomp's) */
export function setServiceWorkerPort(port: Promise<MessagePort>) {
	serviceWorkerPort = port;
}

/** the port an emulated service worker talks to STomp's service worker over */
export function getServiceWorkerPort(): Promise<MessagePort> | undefined {
	return serviceWorkerPort;
}

// taken when the bundle loads, before the page's code (or our own hooks)
// could replace them
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
const nativeSetTimeout = globalThis.setTimeout;
const NativeMessageEvent = globalThis.MessageEvent;

/** the events a held message or connect stands for */
const HELD_TYPES = ['message', 'connect'];

/**
 * Dispatch copies of events that were held from the worker's global (an
 * event that was stopped cannot be dispatched again): the same data, ports
 * and origin, in the order they came
 */
function dispatchHeld(events: readonly MessageEvent[]) {
	for (const event of events) {
		const replay = new NativeMessageEvent(event.type, {
			data: event.data,
			origin: event.origin,
			lastEventId: event.lastEventId,
			source: event.source,
			ports: [...event.ports],
		});
		// as the browser's as the event it stands for (src/transport/ports.ts)
		replayOf(event, replay);
		Reflect.apply(nativeDispatchEvent, globalThis, [replay]);
	}
}

// what the module preamble held, until it is dispatched
let preambleHeld: MessageEvent[] = [];
function releasePreambleHeld() {
	const events = preambleHeld;
	preambleHeld = [];
	dispatchHeld(events);
}

export default class WorkerClient extends Client {
	/** the version id when this worker is a page's emulated service worker (docs/service-workers.md) */
	serviceWorkerVersion?: string;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		this.isWorker = true;
		// a worker whose policy refuses code made from a string (a blob:
		// worker inherits its document's, src/csp.ts) imports the rewriter
		// library's file, which its policy lets it import by URL, instead of
		// evaluating its text
		if (!this.scriptFacts.evaluates)
			shareRewriter(() => null, {
				evaluates: () => false,
				factory: () => {
					for (const name of [LIBRARY_FACTORY, LIGHT_FACTORY])
						Reflect.defineProperty(global, name, {
							value: undefined,
							writable: true,
							configurable: true,
						});
					try {
						(
							global as unknown as { importScripts: (url: string) => void }
						).importScripts(rewriterLibJS(this.url, this.config));
						const made: unknown = Reflect.getOwnPropertyDescriptor(
							global,
							LIBRARY_FACTORY,
						)?.value;
						return typeof made === 'function'
							? (made as (realm?: Record<string, unknown>) => RewriterLib)
							: null;
					} catch (error) {
						return null;
					} finally {
						for (const name of [LIBRARY_FACTORY, LIGHT_FACTORY])
							Reflect.deleteProperty(global, name);
					}
				},
			});
		// read before the worker's own script can change what it reads from
		void this.partition;
		// the modules this worker is handed are its own workers' too; one it
		// starts before they are in waits for them with it
		if (this.wasmRewriter && workerModules) {
			this.expectModules();
			void workerModules.then((modules) => this.holdModules(modules));
		}
	}
	#partition?: string;
	/**
	 * The partition of the context that started this worker: its route
	 * names it (a blob: worker's bootstrap sets it), so it is known before
	 * the worker's own script runs. An emulated service worker takes its
	 * registration's.
	 */
	override get partition(): string {
		if (this.#partition !== undefined) return this.#partition;
		let partition = '';
		const named = (this.global as Record<string, unknown>)[WORKER_PARTITION];
		if (typeof named === 'string') {
			partition = named;
			Reflect.deleteProperty(this.global, WORKER_PARTITION);
		} else
			try {
				const { pathname } = this.global.location;
				if (pathname.startsWith(this.directory))
					partition = workerKindPartition(
						pathname.slice(this.directory.length).split('/')[0],
					);
			} catch (error) {
				// no location to read: first-party
			}
		this.#partition = partition;
		return partition;
	}
	/** an emulated service worker's partition is its registration's */
	set partition(partition: string) {
		this.#partition = partition;
	}
	/** the `sw:` route's preamble: this worker is a page's service worker */
	emulateServiceWorker(info: EmulateInfo) {
		this.serviceWorkerVersion = info.version.id;
		this.partition = info.partition ?? '';
		this.getModule(ServiceWorkerGlobalModule)!.emulate(info);
	}
	/** the `sw:` route's postamble: the script's top level ran to its end */
	serviceWorkerEvaluated() {
		this.getModule(ServiceWorkerGlobalModule)!.evaluated();
	}
	protected override ownTransportPort(): MessagePort | Promise<MessagePort> {
		if (!transportPort)
			throw new Error('Stomp: this worker was not handed a transport port');

		return transportPort;
	}
	/**
	 * Dispatch again, after the current task, the messages (a shared worker's
	 * connects) the module preamble held while it loaded this bundle: they
	 * came during its top-level await, when the page's module had not set
	 * its handlers yet, and natively its top level runs before any message
	 */
	releaseHeld(events: readonly MessageEvent[] | undefined) {
		if (!events?.length) return;
		preambleHeld.push(...events);
		Reflect.apply(nativeSetTimeout, globalThis, [releasePreambleHeld]);
	}
	/**
	 * Hold the messages and connects that arrive until `until` settles, then
	 * dispatch them again: a blob: module worker's bootstrap imports the
	 * page's module only once the client is in place, and the page's handlers
	 * exist only once that import has run. The transport's own message is
	 * taken by the entry's listener, which comes first.
	 */
	async holdEvents(until: Promise<unknown>): Promise<unknown> {
		const held: MessageEvent[] = [];
		const hold = (event: Event) => {
			event.stopImmediatePropagation();
			held.push(event as MessageEvent);
		};
		for (const type of HELD_TYPES)
			Reflect.apply(nativeAddEventListener, globalThis, [type, hold]);
		try {
			return await until;
		} finally {
			for (const type of HELD_TYPES)
				Reflect.apply(nativeRemoveEventListener, globalThis, [type, hold]);
			// the preamble's, when they are still waiting, came first
			releasePreambleHeld();
			dispatchHeld(held);
		}
	}
}
