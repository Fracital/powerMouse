import {
	CACHED_MARKER,
	OPAQUE_MARKER,
	PROXY_METRICS,
	TAO_MARKER,
	XHR_MARKER,
} from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';
import { unrouteURL } from './Unroute';

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
 * one, in getters and in toJSON. `workerStart` is 0 for every entry: the
 * page has no service worker of its own (the proxy's answers them all).
 */
export default class ResourceTimingModule extends Module<Client> {
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
		const marked = new Set<string>();
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
	apply() {
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const Timing = global.PerformanceResourceTiming;
		if (typeof Timing !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const proto = Timing.prototype;

		const getter = (name: string) =>
			Reflect.getOwnPropertyDescriptor(proto, name)?.get;
		const nameGetter = Reflect.getOwnPropertyDescriptor(
			global.PerformanceEntry.prototype,
			'name',
		)!.get!;
		const nativeServerTiming = getter('serverTiming');
		const nativeInitiator = getter('initiatorType');
		const metricName = Reflect.getOwnPropertyDescriptor(
			global.PerformanceServerTiming?.prototype ?? {},
			'name',
		)?.get;
		const own = () =>
			this.client.opaqueRequests ? 'null' : this.client.url.url.origin;

		/** per entry: whether it is another origin's, and restricted; its real URL's scheme */
		const judged = new WeakMap<
			object,
			{ crossOrigin: boolean; restricted: boolean; protocol: string }
		>();
		const judge = (entry: object) => {
			let verdict = judged.get(entry);
			if (verdict) return verdict;
			const raw = String(Reflect.apply(nameGetter, entry, []));
			let crossOrigin = false;
			let protocol = '';
			try {
				const real = unrouteURL(this.client, raw) ?? raw;
				const parsed = new URL(real);
				protocol = parsed.protocol;
				crossOrigin =
					/^https?:$/.test(parsed.protocol) && parsed.origin !== own();
			} catch (error) {
				// not a URL: as the page's own
			}
			const marked =
				crossOrigin &&
				!!nativeServerTiming &&
				!!metricName &&
				(Reflect.apply(nativeServerTiming, entry, []) as object[]).some(
					(metric) => Reflect.apply(metricName, metric, []) === TAO_MARKER,
				);
			verdict = { crossOrigin, restricted: crossOrigin && !marked, protocol };
			judged.set(entry, verdict);
			return verdict;
		};
		const hook = (
			name: string,
			value: (entry: object, native: () => unknown) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) return;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
					value(that as object, () => Reflect.apply(target, that, args)),
				),
			});
		};

		// What went over the wire is the worker's to say: the browser has a
		// service worker's answer as 0 bytes transferred, of no protocol, from
		// a cache. Natively a load from the network transferred its body and
		// 300 bytes (the specification's stand-in for the headers), and one
		// from the cache nothing; the worker marks the answers it gave from
		// its own caches. No transport says which protocol the origin spoke:
		// the entry names the scheme's usual one.
		const bodySize = Reflect.getOwnPropertyDescriptor(
			proto,
			'encodedBodySize',
		)?.get;
		const fromCache = (entry: object) => hasProxyMetric(entry, CACHED_MARKER);
		for (const name of RESTRICTED_TIMES)
			hook(name, (entry, native) => {
				const result = native();
				if (judge(entry).restricted) return 0;
				if (name !== 'transferSize' || result !== 0 || !bodySize) return result;
				return fromCache(entry)
					? 0
					: (Reflect.apply(bodySize, entry, []) as number) + 300;
			});
		for (const name of RESTRICTED_STRINGS)
			hook(name, (entry, native) => {
				const result = native();
				const verdict = judge(entry);
				if (verdict.restricted) return '';
				if (name === 'nextHopProtocol')
					return result !== ''
						? result
						: verdict.protocol === 'https:'
							? 'h2'
							: verdict.protocol === 'http:'
								? 'http/1.1'
								: '';
				// deliveryType: the worker's cache hit is the cache's, its answer
				// from the network is not
				return fromCache(entry) ? 'cache' : result === 'cache' ? '' : result;
			});
		hook('workerStart', (entry, native) => {
			native();
			return 0;
		});
		// the status and content type of another origin's resource need CORS:
		// a fetch or XMLHttpRequest reached the page only past the worker's
		// check; any other load is taken as a no-cors one
		const corsInitiators = ['fetch', 'xmlhttprequest'];
		for (const [name, empty] of [
			['responseStatus', 0],
			['contentType', ''],
		] as const)
			hook(name, (entry, native) => {
				const result = native();
				if (!judge(entry).crossOrigin) return result;
				const initiator = nativeInitiator
					? String(Reflect.apply(nativeInitiator, entry, []))
					: '';
				return corsInitiators.includes(initiator) ? result : empty;
			});
		hook('serverTiming', (entry, native) => {
			const metrics = native() as object[];
			if (judge(entry).restricted) return [];
			return metricName
				? metrics.filter(
						(metric) =>
							!PROXY_METRICS.includes(
								String(Reflect.apply(metricName, metric, [])),
							),
					)
				: metrics;
		});
		// an XMLHttpRequest goes as a fetch() of the inject's: the worker
		// marks its answer (XHR_MARKER)
		hook('initiatorType', (entry, native) => {
			const result = native();
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
							'initiatorType',
							'workerStart',
							'responseStatus',
							'contentType',
						])
							if (name in json) json[name] = Reflect.get(proto, name, that);
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
