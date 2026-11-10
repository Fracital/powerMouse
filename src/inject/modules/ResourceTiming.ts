import { OPAQUE_MARKER, TAO_MARKER } from '../../transport/messages';
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

		/** per entry: whether it is another origin's, and restricted */
		const judged = new WeakMap<
			object,
			{ crossOrigin: boolean; restricted: boolean }
		>();
		const judge = (entry: object) => {
			let verdict = judged.get(entry);
			if (verdict) return verdict;
			const raw = String(Reflect.apply(nameGetter, entry, []));
			let crossOrigin = false;
			try {
				const real = unrouteURL(this.client, raw) ?? raw;
				const parsed = new URL(real);
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
			verdict = { crossOrigin, restricted: crossOrigin && !marked };
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

		for (const name of RESTRICTED_TIMES)
			hook(name, (entry, native) => {
				const result = native();
				return judge(entry).restricted ? 0 : result;
			});
		for (const name of RESTRICTED_STRINGS)
			hook(name, (entry, native) => {
				const result = native();
				return judge(entry).restricted ? '' : result;
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
				? metrics.filter((metric) => {
						const name = Reflect.apply(metricName, metric, []);
						return name !== TAO_MARKER && name !== OPAQUE_MARKER;
					})
				: metrics;
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
