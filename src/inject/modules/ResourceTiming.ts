import {
	AWAY_MARKER,
	CACHED_MARKER,
	CONNECTION_MARKER,
	CORS_MARKER,
	Delivery,
	ENCODING_MARKER,
	HOPS_MARKER,
	KEPT_LOAD,
	KEPT_MARKER,
	KeptLoad,
	MEMORY_MARKER,
	OPAQUE_MARKER,
	PROTOCOL_MARKER,
	PROXY_METRICS,
	REVALIDATED_MARKER,
	siteMetrics,
	SIZE_MARKER,
	TAO_MARKER,
	TIMING_DENIED_MARKER,
	UNREPORTED_MARKER,
	WORKER_SCRIPT_MARKER,
	XHR_MARKER,
} from '../../transport/messages';
import { readConnectionMark } from '../../transport/responseFacts';
import Client from '../Client';
import Module from '../Module';
import { LazyMap, LazySet, LazyWeakMap, LazyWeakSet } from '../ownCollections';
import ProxyModule, { memberName } from './Proxy';
import UnrouteModule, { unrouteURL } from './Unroute';

// the browser's own members, taken when the bundle runs
const serverTimingOf =
	typeof PerformanceResourceTiming === 'function'
		? Reflect.getOwnPropertyDescriptor(
				PerformanceResourceTiming.prototype,
				'serverTiming',
			)?.get
		: undefined;
const metricNameOf =
	typeof PerformanceServerTiming === 'function'
		? Reflect.getOwnPropertyDescriptor(
				PerformanceServerTiming.prototype,
				'name',
			)?.get
		: undefined;

// (before the Unroute module filters them and before any page code can
// replace them)
const nativeTakeRecords =
	typeof PerformanceObserver === 'function'
		? PerformanceObserver.prototype.takeRecords
		: undefined;
const nativeObserve =
	typeof PerformanceObserver === 'function'
		? PerformanceObserver.prototype.observe
		: undefined;
const nativeListEntries =
	typeof PerformanceObserverEntryList === 'function'
		? PerformanceObserverEntryList.prototype.getEntries
		: undefined;
const nativeEntryName =
	typeof PerformanceEntry === 'function'
		? Reflect.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'name')?.get
		: undefined;

const nativeEntryStart =
	typeof PerformanceEntry === 'function'
		? Reflect.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'startTime')
				?.get
		: undefined;
const nativeResponseEnd =
	typeof PerformanceResourceTiming === 'function'
		? Reflect.getOwnPropertyDescriptor(
				PerformanceResourceTiming.prototype,
				'responseEnd',
			)?.get
		: undefined;
const nativeTimeOrigin =
	typeof Performance === 'function'
		? Reflect.getOwnPropertyDescriptor(Performance.prototype, 'timeOrigin')?.get
		: undefined;
const nativeEntriesByType =
	typeof Performance === 'function'
		? Performance.prototype.getEntriesByType
		: undefined;
const nativeEntryType =
	typeof PerformanceEntry === 'function'
		? Reflect.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'entryType')
				?.get
		: undefined;

/** how far a kept load's note may be from its entry's own times (two clocks) */
const KEPT_SLACK_MS = 2000;
/** how many kept loads' notes a context keeps */
const KEPT_NOTES = 4096;
/** how many of the names of its loads a context remembers (unreported) */
const LOADED_NAMES = 4096;

/** a URL without its fragment (a resource timing entry's name has none) */
const withoutFragment = (url: string) => {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
};

/** whether a resource timing entry carries one of the proxy's own metrics */
export function hasProxyMetric(entry: object, name: string): boolean {
	if (!serverTimingOf || !metricNameOf) return false;
	try {
		return (Reflect.apply(serverTimingOf, entry, []) as object[]).some(
			(metric) => Reflect.apply(metricNameOf, metric, []) === name,
		);
	} catch (error) {
		return false;
	}
}

/**
 * For a worker's importScripts(): whether the browser's last load of a
 * route ended at another origin than the request's own through redirects no
 * CORS allowed. The service worker marks the last hop of such a chain
 * (AWAY_MARKER) in the load's resource timing entry, which is queued once
 * the call is over. An observer of the inject's own hears of every entry,
 * made before any of the page's script runs, so what the page does to its
 * timing buffer (clears it, lets it fill, replaces the methods that read it)
 * changes nothing; its pending records are taken at every ask, since
 * imports load while script runs.
 */
export function awayLoads(
	global: typeof globalThis,
): (routed: string) => boolean {
	const away = new Set<string>();
	// (a name to resolve a route against: every entry's is the proxy's origin)
	let base = '';
	const note = (entries: object[]) => {
		for (let i = 0; i < entries.length; i++) {
			const name = String(Reflect.apply(nativeEntryName!, entries[i], []));
			base = name;
			if (hasProxyMetric(entries[i]!, AWAY_MARKER)) away.add(name);
			else away.delete(name);
		}
	};
	let take = () => {};
	if (
		typeof global.PerformanceObserver === 'function' &&
		nativeTakeRecords &&
		nativeObserve &&
		nativeListEntries &&
		nativeEntryName
	)
		try {
			const observer = new global.PerformanceObserver((list: object) =>
				note(Reflect.apply(nativeListEntries, list, []) as object[]),
			);
			Reflect.apply(nativeObserve, observer, [{ type: 'resource' }]);
			take = () =>
				note(Reflect.apply(nativeTakeRecords, observer, []) as object[]);
		} catch (error) {
			// no resource timing here: nothing is marked
		}
	return (routed) => {
		take();
		if (!away.size) return false;
		try {
			return away.has(new URL(routed, base).href);
		} catch (error) {
			return false;
		}
	};
}

/** what a resource of another origin without Timing-Allow-Origin shows as 0 */
const RESTRICTED_TIMES = [
	'redirectStart',
	'redirectEnd',
	'domainLookupStart',
	'domainLookupEnd',
	'connectStart',
	'connectEnd',
	'secureConnectionStart',
	'requestStart',
	'firstInterimResponseStart',
	'finalResponseHeadersStart',
	'responseStart',
	'transferSize',
	'encodedBodySize',
	'decodedBodySize',
];
/** what it shows as '' */
const RESTRICTED_STRINGS = ['nextHopProtocol', 'deliveryType'];

/**
 * Resource timing as the browser gates it between origins. Every route is
 * same-origin to the browser, so the entry of another site's resource had
 * every detail: its timings, its sizes, its Server-Timing and its status.
 * Natively those need the resource's Timing-Allow-Origin to name the page
 * (the status and content type need CORS), which only the service worker
 * sees: it marks a resource of another origin that passed with a
 * Server-Timing metric of its own (TAO_MARKER), which the page never sees.
 * An entry of another origin without the mark reads as Chrome's restricted
 * one, in getters and in toJSON, and so does one whose redirects went
 * through an origin that did not allow it (TIMING_DENIED_MARKER).
 * `workerStart` is 0 for every entry: the page has no service worker of its
 * own (the proxy's answers them all), and the times and sizes a service
 * worker's answer has in the browser read as a network load's do (the
 * hooks below, each with what was measured natively).
 */
export default class ResourceTimingModule extends Module<Client> {
	/**
	 * Asks the worker how the loads its kept script responses answered were
	 * delivered (src/server/keptLoads.ts), by their routed URLs: for each,
	 * [when, how] oldest first. Set by the module that has the synchronous
	 * bridge (a document's), for a page that reads an entry before the
	 * worker's note of it has come.
	 */
	askKeptLoads?: (urls: string[]) => unknown;
	#opaqueLoads?: (loaded: string) => boolean;
	/**
	 * Whether a load of one of the page's own URLs (as the browser has it:
	 * routed) was marked by the worker as another origin's (OPAQUE_MARKER on
	 * the load's timing entry: one redirected through another origin, one
	 * the page's emulated service worker answered with an opaque response).
	 * An observer of the inject's own hears of every entry, whatever the
	 * page does to its timing buffer (clears it, lets it fill, replaces the
	 * methods that read it), and its pending records are taken when it is
	 * asked, so a load asked about in its own load event is known already:
	 * once per run of the page's script (no load ends while script runs), so
	 * a loop of draws takes them once. Made by the first module that asks,
	 * while the document starts.
	 */
	opaqueLoads(): (loaded: string) => boolean {
		if (this.#opaqueLoads) return this.#opaqueLoads;
		const global = this.client.global;
		const marked = new LazySet<string>();
		const realOf = (loaded: string) =>
			withoutFragment(unrouteURL(this.client, loaded) ?? loaded);
		const noteEntries = (entries: object[]) => {
			for (const entry of entries)
				if (hasProxyMetric(entry, OPAQUE_MARKER))
					marked.add(
						realOf(String(Reflect.apply(nativeEntryName!, entry, []))),
					);
		};
		let takePending = () => {};
		if (
			typeof global.PerformanceObserver === 'function' &&
			nativeTakeRecords &&
			nativeObserve &&
			nativeListEntries &&
			nativeEntryName
		)
			try {
				const observer = new global.PerformanceObserver((list: object) =>
					noteEntries(Reflect.apply(nativeListEntries, list, []) as object[]),
				);
				Reflect.apply(nativeObserve, observer, [
					{ type: 'resource', buffered: true },
				]);
				const queueMicrotask = global.queueMicrotask;
				let taken = false;
				const stale = () => {
					taken = false;
				};
				takePending = () => {
					if (taken) return;
					taken = true;
					Reflect.apply(queueMicrotask, global, [stale]);
					noteEntries(
						Reflect.apply(nativeTakeRecords, observer, []) as object[],
					);
				};
			} catch (error) {
				// no resource timing here: nothing is marked
			}
		return (this.#opaqueLoads = (loaded) => {
			takePending();
			return marked.size > 0 && marked.has(realOf(loaded));
		});
	}
	/**
	 * Whether the page's resource timing has no entry for the load `entry`
	 * is of, though the browser has one:
	 * - a load a style sheet of another origin made, when the page took the
	 *   sheet without cors (the worker marks it: UNREPORTED_MARKER);
	 * - a load the renderer's memory cache would have answered (`delivery`
	 *   says `memory`) of something this document loaded before. Natively
	 *   that makes no request and no entry: a document's second use of what
	 *   it has is not a load. Through the proxy the browser asks the worker
	 *   again for every rewritten script and style sheet (they go out
	 *   no-cache) and has an entry for each answer: a script the page
	 *   inserts twice, and on Chrome 152 (not 156, measured) what the
	 *   parser asks for after its preload scanner fetched it.
	 * Every entry is looked at once, in the order the browser lists them
	 * (by when they started), once per run of the page's script.
	 */
	#unreported(
		delivery: (entry: object) => Delivery,
	): (entry: object) => boolean {
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const hidden = new LazyWeakSet<object>();
		const examined = new WeakSet<object>();
		/** what this document loaded, by the names the browser has */
		const loaded = new Set<string>();
		let looked = false;
		const stale = () => {
			looked = false;
		};
		const examine = (entry: object) => {
			examined.add(entry);
			if (hasProxyMetric(entry, UNREPORTED_MARKER)) {
				hidden.add(entry);
				return;
			}
			const name = String(Reflect.apply(nativeEntryName!, entry, []));
			if (!loaded.has(name)) {
				loaded.add(name);
				if (loaded.size > LOADED_NAMES)
					loaded.delete(loaded.values().next().value!);
			} else if (delivery(entry) === 'memory') hidden.add(entry);
		};
		const look = () => {
			if (looked) return;
			looked = true;
			try {
				Reflect.apply(global.queueMicrotask, global, [stale]);
				for (const entry of Reflect.apply(
					nativeEntriesByType!,
					global.performance,
					['resource'],
				) as object[])
					if (!examined.has(entry)) examine(entry);
			} catch (error) {
				// no list to look through: each entry as it is asked about
				looked = false;
			}
		};
		return (entry) => {
			try {
				if (Reflect.apply(nativeEntryType!, entry, []) !== 'resource')
					return false;
				look();
				if (!examined.has(entry)) examine(entry);
				return hidden.has(entry);
			} catch (error) {
				return false;
			}
		};
	}
	apply() {
		const client = this.client;
		// a document's script of its own origin redirected through another
		// is muted, as the observer below tells (Unroute)
		if (client.isDOM) {
			const unroute = client.getModule(UnrouteModule);
			if (unroute) unroute.opaqueLoad = this.opaqueLoads();
		}
		const global = client.global as typeof globalThis & Record<string, any>;
		const Timing = global.PerformanceResourceTiming;
		if (typeof Timing !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
		const proto = Timing.prototype;

		const getter = (name: string) =>
			Reflect.getOwnPropertyDescriptor(proto, name)?.get;
		const nameGetter = Reflect.getOwnPropertyDescriptor(
			global.PerformanceEntry.prototype,
			'name',
		)!.get!;
		const nativeServerTiming = getter('serverTiming');
		const metricName = Reflect.getOwnPropertyDescriptor(
			global.PerformanceServerTiming?.prototype ?? {},
			'name',
		)?.get;
		const own = () => (client.opaqueRequests ? 'null' : client.url.url.origin);

		/**
		 * per entry: whether it is another origin's, restricted, and its
		 * status the page's to read; whether its URL is one no network
		 * answers (about:srcdoc, a blob:), which the browser's entry is right
		 * about; its real URL's scheme
		 */
		interface Verdict {
			crossOrigin: boolean;
			restricted: boolean;
			statusShown: boolean;
			local: boolean;
			protocol: string;
		}
		const judged = new LazyWeakMap<object, Verdict>();
		const judge = (entry: object) => {
			let verdict = judged.get(entry);
			if (verdict) return verdict;
			const raw = String(Reflect.apply(nameGetter, entry, []));
			let crossOrigin = false;
			let protocol = '';
			try {
				const real = unrouteURL(client, raw) ?? raw;
				const parsed = new URL(real);
				protocol = parsed.protocol;
				crossOrigin =
					/^https?:$/.test(parsed.protocol) && parsed.origin !== own();
			} catch (error) {
				// not a URL: as the page's own
			}
			const marks = new Set<string>();
			if (nativeServerTiming && metricName)
				for (const metric of Reflect.apply(
					nativeServerTiming,
					entry,
					[],
				) as object[])
					marks.add(String(Reflect.apply(metricName, metric, [])));
			verdict = {
				crossOrigin,
				restricted:
					marks.has(TIMING_DENIED_MARKER) ||
					(crossOrigin && !marks.has(TAO_MARKER)),
				// (a cors request's answer, or the page's own origin's unless
				// its chain went through another's without cors)
				statusShown:
					marks.has(CORS_MARKER) || (!crossOrigin && !marks.has(OPAQUE_MARKER)),
				local: !/^https?:$/.test(protocol),
				protocol,
			};
			judged.set(entry, verdict);
			return verdict;
		};
		// (`value` is the wrapper's hook itself, called with the native getter
		// and the entry: a hook made around it cost a frame a function and a
		// context for each getter)
		const hook = (
			name: string,
			value: (target: Function, entry: object, args: unknown[]) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) return;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, value),
			});
		};

		// What went over the wire is the worker's to say: the browser has a
		// service worker's answer as 0 bytes transferred, of no protocol, from
		// a cache (or from "cache-storage"). Natively a load from the network
		// transferred its body and 300 bytes (the specification's stand-in
		// for the headers), one a 304 confirmed the 300, and one from a cache
		// nothing; the renderer's memory cache keeps the protocol its
		// resource came over and the HTTP cache has none (messages.ts
		// Delivery). The worker marks the answers it gave from its own
		// caches, and the protocol the origin's answer came over when its
		// transport says (PROTOCOL_MARKER); else the entry names the scheme's
		// usual one.
		const bodySize = Reflect.getOwnPropertyDescriptor(
			proto,
			'encodedBodySize',
		)?.get;
		//
		// A script the rewrite cache kept goes out as the store's own Response
		// (KEPT_MARKER), which says nothing of the load it answers: the worker
		// notes each one's delivery by URL and time and tells this window
		// (KEPT_LOAD). A page that reads an entry before its note has come
		// asks the worker, which is running (it just answered the load), once
		// for every such entry it can read now. An entry with no note (a
		// worker's, which hears nothing and has no bridge) reads as the HTTP
		// cache's, which a kept response most often is.
		const keptNotes = new LazyMap<string, KeptLoad[]>();
		let keptNoted = 0;
		const noteKept = (url: string, load: KeptLoad) => {
			const list = keptNotes.get(url);
			if (list) list.push(load);
			else keptNotes.set(url, [load]);
			if (++keptNoted > KEPT_NOTES) {
				const [oldest, its] = keptNotes.entries().next().value!;
				its.shift();
				keptNoted--;
				if (!its.length) keptNotes.delete(oldest);
			}
		};
		client.onServiceWorkerMessage((data) => {
			if (typeof data !== 'object' || data === null) return;
			const load = (data as Record<string, unknown>)[KEPT_LOAD];
			if (Array.isArray(load) && load.length === 3)
				noteKept(String(load[0]), [Number(load[1]), load[2] as Delivery]);
		});
		// (the name the browser has: the routed URL, which the worker notes
		// the load by)
		const routedName = (entry: object) =>
			String(Reflect.apply(nativeEntryName ?? nameGetter, entry, []));
		/** the note made nearest to the load of `entry`, of `notes` */
		const noteFor = (
			entry: object,
			notes: readonly KeptLoad[] | undefined,
		): Delivery | undefined => {
			if (!notes?.length) return undefined;
			let found: Delivery | undefined;
			try {
				const origin = Reflect.apply(
					nativeTimeOrigin!,
					global.performance,
					[],
				) as number;
				const start =
					origin + (Reflect.apply(nativeEntryStart!, entry, []) as number);
				const end =
					origin + (Reflect.apply(nativeResponseEnd!, entry, []) as number);
				let nearest = KEPT_SLACK_MS;
				for (const [at, how] of notes) {
					const distance = at < start ? start - at : at > end ? at - end : 0;
					if (distance >= nearest) continue;
					nearest = distance;
					found = how;
				}
			} catch (error) {
				// no clock to place a note by
			}
			return found;
		};
		const keptDeliveries = new LazyWeakMap<object, Delivery>();
		const keptDelivery = (entry: object): Delivery => {
			const known = keptDeliveries.get(entry);
			if (known) return known;
			let delivery = noteFor(entry, keptNotes.get(routedName(entry)));
			if (!delivery && this.askKeptLoads) {
				// not told yet: the worker is asked, for this entry and every
				// other one it has not told of
				const pending = [entry];
				try {
					for (const other of Reflect.apply(
						nativeEntriesByType!,
						global.performance,
						['resource'],
					) as object[])
						if (
							other !== entry &&
							!keptDeliveries.has(other) &&
							hasProxyMetric(other, KEPT_MARKER) &&
							!noteFor(other, keptNotes.get(routedName(other)))
						)
							pending.push(other);
				} catch (error) {
					// this entry alone
				}
				const urls = [...new Set(pending.map(routedName))];
				try {
					const answer = this.askKeptLoads(urls);
					if (Array.isArray(answer))
						urls.forEach((url, index) => {
							const notes: unknown = answer[index];
							if (!Array.isArray(notes)) return;
							const have = new Set(
								(keptNotes.get(url) ?? []).map(([at]) => at),
							);
							for (const note of notes)
								if (Array.isArray(note) && !have.has(note[0]))
									noteKept(url, [Number(note[0]), note[1] as Delivery]);
						});
				} catch (error) {
					// no answer in time
				}
				for (const other of pending)
					if (other !== entry)
						keptDeliveries.set(
							other,
							noteFor(other, keptNotes.get(routedName(other))) ?? 'cache',
						);
				delivery = noteFor(entry, keptNotes.get(routedName(entry)));
			}
			delivery ??= 'cache';
			keptDeliveries.set(entry, delivery);
			return delivery;
		};
		const workerStart = getter('workerStart');
		const responseStart = getter('responseStart');
		/**
		 * Whether the renderer's memory cache answered the load of `entry`
		 * without asking the worker: a site's next document's load of what an
		 * earlier one of the site loaded, by the route of the site's mark
		 * (src/memoryMark.ts). Every load the worker answers has a worker
		 * start; this one has none, and the Server-Timing of the load whose
		 * response it keeps, which says how that one came.
		 */
		const fromRenderer = (entry: object) =>
			!!workerStart &&
			!!responseStart &&
			Reflect.apply(workerStart, entry, []) === 0 &&
			Reflect.apply(responseStart, entry, []) !== 0;
		/** how the worker answered the load of `entry` */
		const delivery = (entry: object): Delivery => {
			if (fromRenderer(entry)) return 'memory';
			if (hasProxyMetric(entry, KEPT_MARKER)) return keptDelivery(entry);
			const memory = hasProxyMetric(entry, MEMORY_MARKER);
			return hasProxyMetric(entry, CACHED_MARKER)
				? memory
					? 'memory'
					: 'cache'
				: hasProxyMetric(entry, REVALIDATED_MARKER)
					? memory
						? 'memory-revalidated'
						: 'revalidated'
					: 'network';
		};

		if (nativeEntryName && nativeEntryType && nativeEntriesByType)
			client.unreportedEntry = this.#unreported(delivery);

		// A navigation that went through link routes (src/visited.ts) was
		// redirected by the worker, once for each: the document's navigation
		// timing counts the site's redirects only, and shows none when the
		// site made none. The worker says how many were its own (HOPS_MARKER)
		const navigationProto = global.PerformanceNavigationTiming?.prototype as
			object | undefined;
		const redirectCount =
			navigationProto &&
			Reflect.getOwnPropertyDescriptor(navigationProto, 'redirectCount');
		const metricDuration = Reflect.getOwnPropertyDescriptor(
			global.PerformanceServerTiming?.prototype ?? {},
			'duration',
		)?.get;
		/** the redirects of a navigation entry that were the site's own; null for any other entry, or one the worker made none of */
		const siteRedirects = (entry: object): number | null => {
			if (!redirectCount?.get || !nativeServerTiming || !metricName)
				return null;
			try {
				const counted = Reflect.apply(redirectCount.get, entry, []) as number;
				for (const metric of Reflect.apply(
					nativeServerTiming,
					entry,
					[],
				) as object[])
					if (Reflect.apply(metricName, metric, []) === HOPS_MARKER)
						return Math.max(
							0,
							counted -
								(metricDuration
									? Number(Reflect.apply(metricDuration, metric, []))
									: 0),
						);
			} catch (error) {
				// not a navigation entry
			}
			return null;
		};
		if (navigationProto && redirectCount?.get)
			Reflect.defineProperty(navigationProto, 'redirectCount', {
				...redirectCount,
				get: proxyModule.wrapFunction(
					redirectCount.get,
					(target, that, args) => {
						const counted = Reflect.apply(target, that, args);
						return siteRedirects(that as object) ?? counted;
					},
				),
			});
		// the same of the document's own navigation, for the older interfaces
		const getEntriesByType = global.Performance?.prototype.getEntriesByType;
		const ownRedirects = (): number | null => {
			try {
				const [entry] = Reflect.apply(getEntriesByType, global.performance, [
					'navigation',
				]) as object[];
				return entry ? siteRedirects(entry) : null;
			} catch (error) {
				return null;
			}
		};
		const legacy = (
			proto: object | undefined,
			name: string,
			value: (native: unknown, redirects: number) => unknown,
		) => {
			const descriptor = proto && Reflect.getOwnPropertyDescriptor(proto, name);
			if (!proto || !descriptor?.get) return;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const native = Reflect.apply(target, that, args);
					const redirects = ownRedirects();
					return redirects === null ? native : value(native, redirects);
				}),
			});
		};
		// (only in a document the worker redirected, which its entry says
		// from the start: naming the two interfaces and redefining their
		// getters costs a frame about 8 KB, and most frames are not a link's)
		if (ownRedirects() !== null) {
			legacy(
				global.PerformanceNavigation?.prototype,
				'redirectCount',
				(native, redirects) => redirects,
			);
			for (const name of ['redirectStart', 'redirectEnd'])
				legacy(
					global.PerformanceTiming?.prototype,
					name,
					(native, redirects) => (redirects === 0 ? 0 : native),
				);
		}

		// the sizes the origin's body had, when they are not what the browser
		// counted of the worker's answer (a rewritten text, a body that came
		// compressed): [encoded, decoded or null] (SIZE_MARKER)
		const metricDescription = Reflect.getOwnPropertyDescriptor(
			global.PerformanceServerTiming?.prototype ?? {},
			'description',
		)?.get;
		const toldSizes = (entry: object): [number, number | null] | null => {
			// (a document whose markup came after its shell: what the worker
			// read of its body, which the shell's metric could not say yet)
			if (
				client.documentSizes &&
				entryType &&
				Reflect.apply(entryType, entry, []) === 'navigation'
			)
				return client.documentSizes;
			if (!nativeServerTiming || !metricName || !metricDuration) return null;
			for (const metric of Reflect.apply(
				nativeServerTiming,
				entry,
				[],
			) as object[])
				if (Reflect.apply(metricName, metric, []) === SIZE_MARKER) {
					const decoded = metricDescription
						? String(Reflect.apply(metricDescription, metric, []))
						: '';
					return [
						Number(Reflect.apply(metricDuration, metric, [])),
						/^\d+$/.test(decoded) ? Number(decoded) : null,
					];
				}
			return null;
		};
		/** the description of the worker's metric `mark` on `entry`, or null when it has none */
		const markDescription = (entry: object, mark: string): string | null => {
			if (!nativeServerTiming || !metricName || !metricDescription) return null;
			for (const metric of Reflect.apply(
				nativeServerTiming,
				entry,
				[],
			) as object[])
				if (Reflect.apply(metricName, metric, []) === mark)
					return String(Reflect.apply(metricDescription, metric, []));
			return null;
		};
		const entryType = Reflect.getOwnPropertyDescriptor(
			global.PerformanceEntry.prototype,
			'entryType',
		)?.get;
		const startTime = Reflect.getOwnPropertyDescriptor(
			global.PerformanceEntry.prototype,
			'startTime',
		)?.get;
		// (the browser's own, taken before the hooks below replace them)
		const times = {
			startTime,
			fetchStart: getter('fetchStart'),
			redirectStart: getter('redirectStart'),
			redirectEnd: getter('redirectEnd'),
			requestStart: getter('requestStart'),
			responseStart: getter('responseStart'),
		};
		const read = (entry: object, name: keyof typeof times) => {
			const get = times[name];
			return get ? (Reflect.apply(get, entry, []) as number) : 0;
		};
		const isResource = (entry: object) =>
			!!entryType && Reflect.apply(entryType, entry, []) === 'resource';
		/** whether an answer came at all (an aborted or refused load has none) */
		const answered = (entry: object) => read(entry, 'responseStart') !== 0;
		// A service worker's answer starts its fetch after the load started
		// (the worker is asked first), and a redirect it answers leaves the
		// redirect's times out of order (measured: redirectStart after
		// redirectEnd, fetchStart at the load's start). Natively a load
		// without a redirect fetches from its start, and one with redirects
		// has them from its start to the last hop's fetch; the times of a
		// connection that was there already are the fetch's own.
		/** when the page's fetch of `entry` started, and the browser's own figure for it */
		const fetchStarts = (entry: object): [page: number, native: number] => {
			const native = read(entry, 'fetchStart');
			// (a navigation's own times are the browser's)
			if (!isResource(entry)) return [native, native];
			const redirectEnd = read(entry, 'redirectEnd');
			if (redirectEnd === 0) return [read(entry, 'startTime'), native];
			const request = read(entry, 'requestStart');
			return [
				Math.max(
					redirectEnd,
					Math.min(read(entry, 'redirectStart'), request || Infinity),
				),
				native,
			];
		};
		hook('fetchStart', (target, entry, args) => {
			const result = Reflect.apply(target, entry, args);
			const verdict = judge(entry);
			if (verdict.local) return result;
			if (verdict.restricted)
				return isResource(entry) ? read(entry, 'startTime') : result;
			return fetchStarts(entry)[0];
		});
		const CONNECTION_TIMES = [
			'domainLookupStart',
			'domainLookupEnd',
			'connectStart',
			'connectEnd',
			'requestStart',
		];
		// The connection the origin's answer came on, as the transport saw
		// it (CONNECTION_MARKER, from the request's arrival at the
		// transport): from where the page's fetch started, in order and
		// within its answer. One that had carried a request before has every
		// step at the fetch's start, secureConnectionStart too, and the
		// request just after (measured natively); a step the transport did
		// not see is the next one's (no lookup: at the connection's start).
		// secureConnectionStart is 0 for an http URL.
		/** an entry's connection times as the transport told them, or null */
		const toldConnection = (
			entry: object,
			https: boolean,
		): Record<string, number> | null => {
			if (!answered(entry) || delivery(entry) !== 'network') return null;
			const text = markDescription(entry, CONNECTION_MARKER);
			const told = text === null ? null : readConnectionMark(text);
			if (!told) return null;
			const start = fetchStarts(entry)[0];
			const end = read(entry, 'responseStart');
			let last = start;
			// (each no earlier than the step before, none past the answer)
			const at = (offset: number | undefined, otherwise: number) =>
				(last = Math.min(
					end,
					Math.max(last, offset === undefined ? otherwise : start + offset),
				));
			if (told.reused)
				return {
					domainLookupStart: start,
					domainLookupEnd: start,
					connectStart: start,
					secureConnectionStart: https ? start : 0,
					connectEnd: start,
					requestStart: at(told.requestStart, start),
				};
			const connect =
				told.connectStart === undefined ? start : start + told.connectStart;
			const times: Record<string, number> = {
				domainLookupStart: at(told.dnsStart, connect),
				domainLookupEnd: at(told.dnsEnd, connect),
				connectStart: at(told.connectStart, connect),
			};
			const secure = at(told.secureStart, last);
			times.secureConnectionStart = https ? secure : 0;
			times.connectEnd = at(told.connectEnd, last);
			times.requestStart = at(told.requestStart, last);
			return times;
		};

		// one call for every time (and every string) it hooks, which reads
		// which one it is from the native getter it wraps
		const restrictedTime = (
			target: Function,
			entry: object,
			args: unknown[],
		) => {
			const name = memberName(target);
			const result = Reflect.apply(target, entry, args);
			const verdict = judge(entry);
			if (verdict.local) return result;
			if (verdict.restricted) return 0;
			if (name === 'redirectStart' || name === 'redirectEnd') {
				if (result === 0 || siteRedirects(entry) === 0) return 0;
				// (a navigation's are the browser's: it starts at 0, its
				// redirects after it)
				return name === 'redirectStart' && isResource(entry)
					? read(entry, 'startTime')
					: result;
			}
			if (name === 'secureConnectionStart' || CONNECTION_TIMES.includes(name)) {
				const told = toldConnection(entry, verdict.protocol === 'https:');
				if (told) return told[name];
				if (name === 'secureConnectionStart') return result;
				if (result === 0) return 0;
				const [page, own] = fetchStarts(entry);
				return result === own ? page : Math.max(result as number, page);
			}
			// The browser has no final headers' time for a service worker's
			// answer and gives the response's start as an interim one's.
			// Natively that is how an answer from the HTTP cache reads; one
			// from the network (a revalidation too) has no interim response
			// and its headers at the response's start (measured in Chrome
			// 152 and 156).
			if (
				name === 'firstInterimResponseStart' ||
				name === 'finalResponseHeadersStart'
			) {
				if (!answered(entry)) return result;
				// (a dedicated worker's script has neither: measured)
				if (hasProxyMetric(entry, WORKER_SCRIPT_MARKER)) return 0;
				const how = delivery(entry);
				// (nor has what the renderer's memory cache answers)
				if (how === 'memory') return 0;
				return (how === 'cache') === (name === 'firstInterimResponseStart')
					? read(entry, 'responseStart')
					: 0;
			}
			const sizes = name.endsWith('BodySize') ? toldSizes(entry) : null;
			if (name === 'encodedBodySize') return sizes ? sizes[0] : result;
			if (name === 'decodedBodySize') return sizes?.[1] ?? result;
			// (the shell's bytes, which the browser counted, stand for the body's)
			if (
				name === 'transferSize' &&
				result !== 0 &&
				bodySize &&
				client.documentSizes &&
				Reflect.apply(entryType!, entry, []) === 'navigation'
			)
				return (
					result -
					(Reflect.apply(bodySize, entry, []) as number) +
					client.documentSizes[0]
				);
			if (name !== 'transferSize' || result !== 0 || !bodySize) return result;
			// (nothing came of a load that was aborted or refused)
			if (!answered(entry)) return 0;
			const how = delivery(entry);
			return how === 'cache' || how === 'memory'
				? 0
				: how === 'network'
					? (toldSizes(entry)?.[0] ??
							(Reflect.apply(bodySize, entry, []) as number)) + 300
					: 300;
		};
		for (const name of RESTRICTED_TIMES) hook(name, restrictedTime);
		const restrictedString = (
			target: Function,
			entry: object,
			args: unknown[],
		) => {
			const name = memberName(target);
			const result = Reflect.apply(target, entry, args);
			const verdict = judge(entry);
			if (verdict.local) return result;
			if (verdict.restricted) return '';
			const how = delivery(entry);
			if (name === 'nextHopProtocol')
				// (the HTTP cache's answer has none, nor has a load nothing
				// answered)
				return result !== '' ||
					how === 'cache' ||
					how === 'revalidated' ||
					!answered(entry)
					? result
					: (markDescription(entry, PROTOCOL_MARKER) ??
							(verdict.protocol === 'https:'
								? 'h2'
								: verdict.protocol === 'http:'
									? 'http/1.1'
									: ''));
			// deliveryType: a cache's answer is the cache's, but for what the
			// renderer revalidated; the worker's own way of answering (its
			// Cache API entry for a kept script) is not the page's to see
			return how !== 'network' && how !== 'memory-revalidated'
				? 'cache'
				: result === 'cache' || result === 'cache-storage'
					? ''
					: result;
		};
		for (const name of RESTRICTED_STRINGS) hook(name, restrictedString);
		hook('workerStart', (target, entry, args) => {
			Reflect.apply(target, entry, args);
			return 0;
		});
		// the encoding of another origin's cors answer is not a header the
		// browser was given (ENCODING_MARKER)
		hook('contentEncoding', (target, entry, args) => {
			const result = Reflect.apply(target, entry, args);
			const verdict = judge(entry);
			if (verdict.local) return result;
			// (shown with the status, whatever the timing: measured)
			if (!verdict.statusShown) return '';
			if (
				result === '' &&
				nativeServerTiming &&
				metricName &&
				metricDescription
			)
				for (const metric of Reflect.apply(
					nativeServerTiming,
					entry,
					[],
				) as object[])
					if (Reflect.apply(metricName, metric, []) === ENCODING_MARKER)
						return String(Reflect.apply(metricDescription, metric, []));
			return result;
		});
		// the status and content type of another origin's resource need CORS,
		// which the worker's check decided (CORS_MARKER)
		for (const [name, empty] of [
			['responseStatus', 0],
			['contentType', ''],
		] as const)
			hook(name, (target, entry, args) => {
				const result = Reflect.apply(target, entry, args);
				return judge(entry).statusShown ? result : empty;
			});
		// (a frozen array, a new one at each read, as the browser's is; made
		// from the browser's own, so it is the entry's realm's)
		hook('serverTiming', (target, entry, args) => {
			const metrics = Reflect.apply(target, entry, args) as object[];
			const restricted = judge(entry).restricted;
			return Object.freeze(
				metrics.filter(
					(metric) =>
						!restricted &&
						(!metricName ||
							!PROXY_METRICS.includes(
								String(Reflect.apply(metricName, metric, [])),
							)),
				),
			);
		});
		// a site's metric named like a mark has the name the site gave it
		// (the worker escaped it: siteMetrics)
		const metricProto = global.PerformanceServerTiming?.prototype;
		if (metricName && metricProto) {
			Reflect.defineProperty(metricProto, 'name', {
				...Reflect.getOwnPropertyDescriptor(metricProto, 'name'),
				get: proxyModule.wrapFunction(metricName, (target, that, args) =>
					siteMetrics(Reflect.apply(target, that, args)),
				),
			});
			metricProto.toJSON = proxyModule.wrapFunction(
				metricProto.toJSON,
				(target, that, args) => {
					const json = Reflect.apply(target, that, args);
					if (json) json.name = siteMetrics(json.name);
					return json;
				},
			);
		}
		// an XMLHttpRequest goes as a fetch() of the inject's: the worker
		// marks its answer (XHR_MARKER)
		hook('initiatorType', (target, entry, args) => {
			const result = Reflect.apply(target, entry, args);
			return result === 'fetch' && hasProxyMetric(entry, XHR_MARKER)
				? 'xmlhttprequest'
				: result;
		});

		// toJSON reads the browser's own values: each field the page could
		// not read through its getter is the getter's
		for (const timing of [proto, global.PerformanceNavigationTiming?.prototype])
			if (timing && Object.hasOwn(timing, 'toJSON'))
				timing.toJSON = proxyModule.wrapFunction(
					timing.toJSON,
					(target, that, args) => {
						const json = Reflect.apply(target, that, args) as Record<
							string,
							unknown
						>;
						if (!json || typeof json !== 'object') return json;
						for (const name of [
							...RESTRICTED_TIMES,
							...RESTRICTED_STRINGS,
							'fetchStart',
							'contentEncoding',
							'initiatorType',
							'workerStart',
							'responseStatus',
							'contentType',
						])
							if (name in json) json[name] = Reflect.get(proto, name, that);
						if (navigationProto && 'redirectCount' in json)
							json.redirectCount = Reflect.get(
								navigationProto,
								'redirectCount',
								that,
							);
						if (Array.isArray(json.serverTiming))
							json.serverTiming = (
								Reflect.get(proto, 'serverTiming', that) as unknown as {
									toJSON(): unknown;
								}[]
							).map((metric) => metric.toJSON());
						return json;
					},
				);
	}
}
