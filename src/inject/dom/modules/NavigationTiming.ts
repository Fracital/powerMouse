import { HOPS_MARKER } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { hasProxyMetric } from '../../modules/ResourceTiming';
import { unrouteURL } from '../../modules/Unroute';
import type DocumentClient from '../Client';
import EntryTimingModule from './EntryTiming';

// the browser's own, taken when the bundle runs
const nativeEntriesByType =
	typeof Performance === 'function'
		? Performance.prototype.getEntriesByType
		: undefined;
const getterOf = (holder: unknown, name: string) =>
	typeof holder === 'function'
		? Reflect.getOwnPropertyDescriptor(holder.prototype as object, name)?.get
		: undefined;
const nativeServerTiming = getterOf(
	globalThis.PerformanceResourceTiming,
	'serverTiming',
);
const nativeMetricName = getterOf(globalThis.PerformanceServerTiming, 'name');
const nativeMetricDuration = getterOf(
	globalThis.PerformanceServerTiming,
	'duration',
);

/** the HOPS_MARKER duration of a navigation whose site's redirects crossed origins (src/server/rewrites.ts) */
const CROSSED = 99;
/**
 * What Chrome 152 and 156 report as a navigation confidence's
 * `randomizedTriggerRate` (the performance-navigation suite compares it
 * with the browser's)
 */
const TRIGGER_RATE = 0.4994798;

/**
 * Navigation timing as a top-level document of the page's own origin reads
 * it, where the browser answers for a frame of the proxy's origin:
 *
 * - `unloadEventStart` and `unloadEventEnd` are the previous document's
 *   only when it was of the new document's origin and no redirect on the
 *   way was of another. Every proxied document is the proxy's origin, so a
 *   proxied top that follows another site's document read that document's
 *   unload times. (A frame inside a proxied page is given a fresh context
 *   before a document of another origin loads in it, freshContext.ts, and
 *   has no previous document then.)
 * - `performance.timing.toJSON()` and `performance.navigation.toJSON()`
 *   are the browser's own values where the getters beside them are the
 *   page's (the worker's own redirects, ResourceTiming.ts).
 * - `confidence` is an object for a top-level document and null in a
 *   frame; a proxied top is a frame of the host.
 *
 * The two older interfaces are named and hooked only in a document that
 * needs it (as ResourceTiming does, about 8 KB a frame), and the
 * confidence's interface when the page first reads one.
 */
export default class NavigationTimingModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		if (!nativeEntriesByType) return;
		let entry: object | undefined;
		try {
			[entry] = Reflect.apply(nativeEntriesByType, client.global.performance, [
				'navigation',
			]) as object[];
		} catch (error) {
			// no timeline here
		}
		// (a frame's document that came straight from its site, which most
		// are, reads as the browser has it: none of this runs there)
		if (entry && (!client.nested || hasProxyMetric(entry, HOPS_MARKER)))
			navigationTiming(client, entry);
	}
}

function navigationTiming(client: DocumentClient, entry: object) {
	const global = client.global as typeof globalThis & Record<string, any>;
	const prototype = global.PerformanceNavigationTiming?.prototype as
		object | undefined;
	const timing = client.getModule(EntryTimingModule);
	if (!prototype || !timing) return;
	const proxyModule = client.getModule(ProxyModule)!;
	const getter = (holder: object, name: string) =>
		Reflect.getOwnPropertyDescriptor(holder, name)?.get;
	const hook = timing.hookGetter.bind(timing);
	const hookJSON = timing.hookJSON.bind(timing);

	/** the worker's own redirects on the way here (null: none), and whether the site's crossed origins */
	let hops: number | null = null;
	try {
		if (nativeServerTiming && nativeMetricName && nativeMetricDuration)
			for (const metric of Reflect.apply(
				nativeServerTiming,
				entry,
				[],
			) as object[])
				if (Reflect.apply(nativeMetricName, metric, []) === HOPS_MARKER)
					hops = Number(Reflect.apply(nativeMetricDuration, metric, []));
	} catch (error) {
		// not an entry with Server-Timing
	}

	// Whether the document before this one is another origin's to this
	// one: a redirect on the way was (the worker's mark), or the page's
	// own view of where it came from has no entry for it (the
	// Navigation API hides another origin's, as natively; read when
	// first asked, once every module has made its hooks)
	const unloadStart = getter(prototype, 'unloadEventStart');
	const hadPrevious =
		!client.nested &&
		!!unloadStart &&
		Reflect.apply(unloadStart, entry, []) !== 0;
	let foreign: boolean | undefined;
	const foreignUnload = (): boolean => {
		if (foreign !== undefined) return foreign;
		foreign = hops === CROSSED;
		if (!foreign)
			try {
				const activation = global.navigation?.activation;
				const before = activation?.from;
				if (activation && before === null) foreign = true;
				else if (before && typeof before.url === 'string')
					foreign =
						new URL(unrouteURL(client, before.url) ?? before.url).origin !==
						client.origin;
			} catch (error) {
				// no previous entry to read: as the browser has it
			}
		return foreign;
	};
	const UNLOAD = ['unloadEventStart', 'unloadEventEnd'];
	if (hadPrevious) {
		for (const name of UNLOAD)
			hook(prototype, name, (that, native) => {
				const time = native();
				return foreignUnload() ? 0 : time;
			});
		hookJSON(prototype, (json) => {
			if (foreignUnload())
				for (const name of UNLOAD) if (name in json) json[name] = 0;
		});
	}

	// the older interfaces serialise what their getters answer
	if (hadPrevious || hops !== null) {
		const timing = global.PerformanceTiming?.prototype as object | undefined;
		if (timing) {
			if (hadPrevious)
				for (const name of UNLOAD)
					hook(timing, name, (that, native) => {
						const time = native();
						return foreignUnload() ? 0 : time;
					});
			const shown = ['redirectStart', 'redirectEnd', ...UNLOAD].map(
				(name) => [name, getter(timing, name)] as const,
			);
			hookJSON(timing, (json, that) => {
				for (const [name, get] of shown)
					if (get && name in json) json[name] = Reflect.apply(get, that, []);
			});
		}
		const navigation = global.PerformanceNavigation?.prototype as
			object | undefined;
		const redirectCount = navigation && getter(navigation, 'redirectCount');
		if (navigation && redirectCount)
			hookJSON(navigation, (json, that) => {
				if ('redirectCount' in json)
					json.redirectCount = Reflect.apply(redirectCount, that, []);
			});
	}

	// A top-level document's confidence. The value is the browser's
	// randomized answer by design (the real one with the trigger rate's
	// chance of a coin toss instead): a proxied top draws its own once,
	// from "high", which a navigation in a running browser is
	if (client.nested || !getter(prototype, 'confidence')) return;
	const drawn =
		Math.random() < TRIGGER_RATE && Math.random() < 0.5 ? 'low' : 'high';
	const standIns = new WeakSet<object>();
	let confidence: object | undefined;
	const standIn = (): object | null => {
		if (confidence === undefined) {
			const Confidence = global.PerformanceTimingConfidence;
			if (typeof Confidence !== 'function') return null;
			confidence = Confidence.prototype as object;
			const answers: Record<string, unknown> = {
				randomizedTriggerRate: TRIGGER_RATE,
				value: drawn,
			};
			for (const name of Reflect.ownKeys(answers) as string[])
				hook(confidence, name, (that, native) =>
					standIns.has(that) ? answers[name] : native(),
				);
			const toJSON = Reflect.getOwnPropertyDescriptor(
				confidence,
				'toJSON',
			)?.value;
			if (typeof toJSON === 'function')
				(confidence as { toJSON: unknown }).toJSON = proxyModule.wrapFunction(
					toJSON,
					(target, that, args) => {
						if (!standIns.has(that)) return Reflect.apply(target, that, args);
						const json = new global.Object() as Record<string, unknown>;
						json.randomizedTriggerRate = TRIGGER_RATE;
						json.value = drawn;
						return json;
					},
				);
		}
		// (a new object at every read, as the browser's)
		const made = global.Object.create(confidence) as object;
		standIns.add(made);
		return made;
	};
	hook(prototype, 'confidence', (that, native) => native() ?? standIn());
	hookJSON(prototype, (json) => {
		if (json.confidence !== null || !('confidence' in json)) return;
		// (the object itself, as the browser's own serialisation has it)
		json.confidence = standIn();
	});
}
