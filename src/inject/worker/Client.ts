import { ParsedConfig } from '../../config';
import {
	governing,
	governsConnect,
	parsePolicies,
	sourcesMatch,
	type Policy,
	type WorkerPolicies,
} from '../../csp';
import { workerKindPartition } from '../../partition';
import type { EmulateInfo } from '../../serviceWorkerTypes';
import { CSP_WORKER, WORKER_PARTITION } from '../../transport/messages';
import { replayOf } from '../../transport/ports';
import Client, { type HandedModules } from '../Client';
import ProxyModule from '../modules/Proxy';
import { trustTaggedViolations } from '../violationViews';
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
const NativeViolationEvent = globalThis.SecurityPolicyViolationEvent;

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
		// the worker bundle carries the light rewriter library itself
		// (stomp:rewriter-lib, build.js), so even a worker whose policy
		// refuses code made from a string uses it: calling the bundled factory
		// evaluates nothing, and a rewrite the module declines is handed back
		// without a parser (src/rewriterLight.ts)
		// read before the worker's own script can change what it reads from
		void this.partition;
		// a blob: worker's bootstrap names the policies it inherits
		const inherited = Reflect.getOwnPropertyDescriptor(global, CSP_WORKER);
		Reflect.deleteProperty(global, CSP_WORKER);
		if (inherited) this.judgeConnections(inherited.value);
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
						this.codec,
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
	/**
	 * The policies this worker judges its own WebSockets and WebTransport
	 * sessions by (src/csp.ts WorkerPolicies), each with what 'self' means
	 * in it, and how a report names the worker's URL; null for none
	 */
	#connect: {
		policies: { policy: Policy; self: URL }[];
		named?: 'blob' | 'data';
	} | null = null;
	/** the violations judgeConnections dispatched, which the worker's listeners read as trusted (violationViews) */
	readonly #violations = new WeakSet<object>();
	#viewsOn = false;
	/**
	 * Hands the worker the policies its connections are judged by: its
	 * script's response's (the route's preamble, an emulated service
	 * worker's), or its creator's (a blob: worker's bootstrap, a data:
	 * worker's route). The browser applies none of them to the proxy's
	 * URLs, and no service worker sees a WebSocket or a session. The first
	 * a worker is handed are its own: a script it imports after hands none.
	 */
	judgeConnections(given: unknown) {
		if (this.#connect !== null) return;
		const { policies, named } = (given ?? {}) as Partial<WorkerPolicies>;
		if (!Array.isArray(policies)) return;
		const parsed: { policy: Policy; self: URL }[] = [];
		for (const entry of policies) {
			if (!Array.isArray(entry)) continue;
			const [text, disposition, self] = entry;
			if (
				typeof text !== 'string' ||
				(disposition !== 'enforce' && disposition !== 'report') ||
				typeof self !== 'string'
			)
				continue;
			let url: URL;
			try {
				url = new URL(self);
			} catch (error) {
				continue;
			}
			for (const policy of parsePolicies(text, disposition, 'header'))
				if (governsConnect(policy)) parsed.push({ policy, self: url });
		}
		this.#connect = {
			policies: parsed,
			...(named === 'blob' || named === 'data' ? { named } : {}),
		};
		this.#trustViolations();
	}
	/** what a blob: worker this worker makes inherits of its policies (src/csp.ts WorkerPolicies), or null for none */
	connectInheritance(): WorkerPolicies | null {
		const policies = this.#connect?.policies ?? [];
		if (!policies.length) return null;
		return {
			policies: policies.map(({ policy, self }) => [
				policy.text,
				policy.disposition,
				self.href,
			]),
			named: 'blob',
		};
	}
	override apply(deferPost = false) {
		super.apply(deferPost);
		this.#trustViolations();
	}
	/** its listeners read its own violations as trusted, once there is a policy to report them (violationViews) */
	#trustViolations() {
		if (this.#viewsOn || !this.applied || !this.#connect?.policies.length)
			return;
		this.#viewsOn = true;
		trustTaggedViolations(
			this.global,
			this.getModule(ProxyModule)!,
			this.#violations,
		);
	}
	/**
	 * Judges a connection of this worker's to `url` (a WebSocket, a
	 * WebTransport session) by its policies' connect-src, as Chrome does
	 * (measured, Chrome 157): each policy that refuses it, report-only ones
	 * too, reports it on the worker's global a task later (trusted; the
	 * worker's URL as its documentURI, without its query as its sourceFile,
	 * `blob` or `data` for those, status 0). True where an enforced one
	 * refuses it.
	 */
	connectVerdict(url: URL): boolean {
		const connect = this.#connect;
		if (!connect?.policies.length) return false;
		const own = connect.named ?? this.url.url.href.replace(/#.*$/s, '');
		const sourceFile = connect.named ?? own.replace(/\?.*$/s, '');
		const blockedURI = url.href.replace(/#.*$/s, '');
		let refused = false;
		for (const { policy, self } of connect.policies) {
			const governed = governing(policy, 'connect-src');
			if (!governed || sourcesMatch(governed.sources, url, self)) continue;
			if (policy.disposition === 'enforce') refused = true;
			if (typeof NativeViolationEvent !== 'function') continue;
			Reflect.apply(nativeSetTimeout, globalThis, [
				() => {
					const event = new NativeViolationEvent('securitypolicyviolation', {
						bubbles: true,
						composed: true,
						blockedURI,
						documentURI: own,
						referrer: '',
						violatedDirective: 'connect-src',
						effectiveDirective: 'connect-src',
						originalPolicy: policy.text,
						disposition: policy.disposition,
						sourceFile,
						statusCode: 0,
						lineNumber: 0,
						columnNumber: 0,
						sample: '',
					});
					this.#violations.add(event);
					Reflect.apply(nativeDispatchEvent, globalThis, [event]);
				},
			]);
		}
		return refused;
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
