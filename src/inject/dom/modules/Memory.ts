import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

// performance.memory per site, as a renderer process of each site's own
// would report it. Every proxied site shares the proxy's one renderer
// process, so performance.memory.usedJSHeapSize is the whole process's heap:
// a frame and the page that embeds it read the same figure, where natively
// (each site its own process) they never do. Cloudflare Turnstile reads the
// challenge frame's heap and its embedder's and rejects a frame whose figure
// equals its embedder's (measured: emulating this alone turns the native
// no-isolation checkbox into a pass, docs/process-model.md).
//
// A site's figure is its own baseline (a small plausible floor, the same on
// every reload of that site, derived from the site so it is no new
// fingerprint) plus what the real shared heap has grown since the site's
// first realm started. Every realm of one site (its frames, their
// about:blank and srcdoc children) reads the same figure: the baseline is a
// function of the site, and the growth is measured from a start kept once
// per site on the proxied top, which every proxied realm of the tab shares
// same-origin. Two sites differ (different baseline, different start); a
// frame and its embedder of another site differ, as natively. The figure is
// exact and updates at most every 50 ms, as Chrome reports in a renderer
// locked to one site (bucketed figures appear only without site isolation).
//
// Chrome only (performance.memory and MemoryInfo exist nowhere else);
// jsHeapSizeLimit is left as the browser's, since a separate process on the
// same machine reports the same limit. A worker has no performance.memory,
// so this is a document module.

/** what a site's realms agree on: when its heap growth is measured from, and its last reading */
interface SiteMemory {
	/** the real used heap when this site's first realm read it */
	start: number;
	/** the site's baseline used heap (a plausible floor, stable per site) */
	base: number;
	/** the last figure handed out, and when (the 50 ms cache) */
	cache: { used: number; total: number } | null;
	at: number;
}

/** the registry of per-site memory, shared same-origin across the proxied tab */
const REGISTRY = Symbol.for('$stomp$memory');

/**
 * A plausible baseline used heap for `site` (0.7 to 1.8 MB), the same on
 * every reload (FNV-1a of the site, so no new fingerprint and different
 * sites differ). Byte-precise, not a round number: Chrome reports an exact
 * heap in a renderer locked to one site, and a round figure would itself be
 * a tell. A page's growth is added on top, so two reads apart move finely.
 */
function baselineFor(site: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < site.length; i++) {
		hash ^= site.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return 700000 + ((hash >>> 8) % 1100000);
}

/** how long a figure is reused before the heap is read again (Chrome's 50 ms cache) */
const CACHE_MS = 50;

export default class MemoryModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const performance = global.performance as
			(Performance & { memory?: object }) | undefined;
		const Performance = global.Performance as typeof globalThis.Performance &
			(new () => Performance);
		if (!performance?.memory || typeof Performance !== 'function') return;
		const memoryDescriptor = Reflect.getOwnPropertyDescriptor(
			Performance.prototype,
			'memory',
		);
		const memoryGet = memoryDescriptor?.get;
		if (!memoryGet) return;
		// MemoryInfo has no global interface object: reach its prototype
		// through an instance
		const proto = Object.getPrototypeOf(
			Reflect.apply(memoryGet, performance, []),
		) as object;
		const usedDescriptor = Reflect.getOwnPropertyDescriptor(
			proto,
			'usedJSHeapSize',
		);
		const totalDescriptor = Reflect.getOwnPropertyDescriptor(
			proto,
			'totalJSHeapSize',
		);
		const usedGet = usedDescriptor?.get;
		const totalGet = totalDescriptor?.get;
		if (!usedGet || !totalGet) return;
		const proxyModule = this.client.getModule(ProxyModule)!;

		// this document's site: its registrable domain and port, or a key of
		// its own for an opaque origin (another site to everyone), kept while
		// the document is
		const opaqueKey = `opaque:${this.client.realOrigin()}:${Math.random()}`;
		const siteOf = () => this.client.siteKey ?? opaqueKey;

		// the registry on the proxied top, which every proxied realm of the
		// tab reaches same-origin (the host page may be another origin): one
		// entry per site, so a site's frames and their about:blank children
		// agree. A realm that cannot reach it (a window being torn down) keeps
		// its own, which still differs from another site's.
		const registry = ((): Map<string, SiteMemory> => {
			try {
				const top = this.client.proxiedTop as Record<symbol, unknown>;
				let map = top[REGISTRY] as Map<string, SiteMemory> | undefined;
				if (!map) {
					map = new Map();
					Reflect.defineProperty(top, REGISTRY, {
						value: map,
						configurable: true,
					});
				}
				return map;
			} catch (error) {
				return new Map();
			}
		})();

		const entryOf = (site: string): SiteMemory => {
			let entry = registry.get(site);
			if (!entry) {
				entry = {
					start: Reflect.apply(usedGet, performance.memory, []),
					base: baselineFor(site),
					cache: null,
					at: -Infinity,
				};
				registry.set(site, entry);
			}
			return entry;
		};

		const sample = (memory: object) => {
			const entry = entryOf(siteOf());
			// Date.now, not performance.now: each realm's clock has its own
			// time origin, and the cache is shared across a site's realms
			const now = Date.now();
			if (entry.cache && now - entry.at < CACHE_MS) return entry.cache;
			const used = Reflect.apply(usedGet, memory, []) as number;
			const total = Reflect.apply(totalGet, memory, []) as number;
			const ownUsed = Math.round(entry.base + Math.max(0, used - entry.start));
			// keep the real total-to-used ratio, never below the used figure
			const ownTotal = Math.max(
				ownUsed,
				Math.round(ownUsed * (total / Math.max(used, 1))),
			);
			entry.cache = { used: ownUsed, total: ownTotal };
			entry.at = now;
			return entry.cache;
		};

		Reflect.defineProperty(proto, 'usedJSHeapSize', {
			...usedDescriptor,
			get: proxyModule.wrapFunction(usedGet, (target, that, args) => {
				// the native getter first: a non-MemoryInfo `this` throws
				// Illegal invocation, as natively
				Reflect.apply(target, that, args);
				return sample(that).used;
			}),
		});
		Reflect.defineProperty(proto, 'totalJSHeapSize', {
			...totalDescriptor,
			get: proxyModule.wrapFunction(totalGet, (target, that, args) => {
				Reflect.apply(target, that, args);
				return sample(that).total;
			}),
		});
	}
}
