import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import type DocumentClient from '../Client';
import { deferred } from '../deferred';
// (the natives the deferred long task and frame handlers read: taken as the
// bundle runs)
import '../longEntryNatives';

// the browser's own, taken when the bundle runs
const nativeEntryType =
	typeof PerformanceEntry === 'function'
		? Reflect.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'entryType')
				?.get
		: undefined;

/** whether the page may see `entry`, which is made ready for it first */
export type Admit = (entry: object) => boolean;

/**
 * The performance entries that are not a load's: what each shows a page is
 * the browser's view of the page in proxy URL space (an image's routed URL,
 * the frame the host put the page in). An entry reaches the page through a
 * list (performance.getEntries*, an observer's list, takeRecords), where
 * each type's handler sees it first: it hooks the entry's interface the
 * first time one comes, from the entry itself. No interface is named before
 * that: a frame that never has a long task pays nothing for the hooks of
 * one (frame-cost), as natively a frame that never has one never makes
 * PerformanceLongTaskTiming.
 *
 * Here: the URL of the image a largest contentful paint or an element
 * timing entry names is the page's URL of it. A long animation frame's
 * scripts are LongFrames.ts, a long task's culprit LongTasks.ts.
 */
export default class EntryTimingModule extends Module<DocumentClient> {
	#types = new Map<string, Admit>();
	/** `admit` sees every entry of `type` before the page does */
	onType(type: string, admit: Admit) {
		this.#types.set(type, admit);
	}
	/** an Admit that runs `install` with the interface prototype of the first entry it sees */
	first(install: (prototype: object) => void, admit?: Admit): Admit {
		let installed = false;
		return (entry) => {
			if (!installed) {
				installed = true;
				install(Reflect.getPrototypeOf(entry)!);
			}
			return admit ? admit(entry) : true;
		};
	}
	/** the getter `name` of `prototype` answers with `value`, which may ask the browser's */
	hookGetter(
		prototype: object,
		name: string,
		value: (that: any, native: () => any) => unknown,
	): (() => unknown) | undefined {
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, name);
		if (!descriptor?.get) return undefined;
		const get = this.client
			.getModule(ProxyModule)!
			.wrapFunction(descriptor.get, (target, that, args) =>
				value(that, () => Reflect.apply(target, that, args)),
			);
		Reflect.defineProperty(prototype, name, { ...descriptor, get });
		return get;
	}
	/** `prototype`'s own toJSON hands its result to `patch` first */
	hookJSON(
		prototype: object,
		patch: (json: Record<string, unknown>, that: any) => void,
	): ((this: object) => unknown) | undefined {
		const toJSON = Reflect.getOwnPropertyDescriptor(prototype, 'toJSON')?.value;
		if (typeof toJSON !== 'function') return undefined;
		const wrapped = this.client
			.getModule(ProxyModule)!
			.wrapFunction(toJSON, (target, that, args) => {
				const json = Reflect.apply(target, that, args);
				if (json && typeof json === 'object')
					patch(json as Record<string, unknown>, that);
				return json;
			});
		(prototype as { toJSON: unknown }).toJSON = wrapped;
		return wrapped;
	}
	/** the page's URL for one the browser has: none for the proxy's own */
	pageURL(url: unknown): unknown {
		return typeof url === 'string' && url !== ''
			? (unrouteURL(this.client, url) ?? '')
			: url;
	}
	apply() {
		const moduleClient = this.client;
		const global = moduleClient.global as typeof globalThis &
			Record<string, any>;
		if (!nativeEntryType || typeof global.Performance !== 'function') return;
		// Every list of entries the page reads (performance.getEntries*, an
		// observer's list, takeRecords) and whether an observer's callback
		// runs at all are Unroute's, which asks this of each entry: a type
		// with a handler is the handler's to admit
		moduleClient.admitEntry = (entry) => {
			let admit: Admit | undefined;
			try {
				admit = this.#types.get(
					String(Reflect.apply(nativeEntryType, entry, [])),
				);
			} catch (error) {
				// not an entry: as it is
			}
			return admit ? admit(entry) : true;
		};

		// the image an entry names, by the page's URL
		const named = () =>
			this.first((prototype) => {
				this.hookGetter(prototype, 'url', (that, native) =>
					this.pageURL(native()),
				);
				this.hookJSON(prototype, (json) => {
					if ('url' in json) json.url = this.pageURL(json.url);
				});
			});
		this.onType('largest-contentful-paint', named());
		this.onType('element', named());
		// (each made when its first entry comes, deferred parts: a frame
		// that never has a long frame or task does not carry their code)
		const late = (name: 'longFrames' | 'longTasks') => {
			let admit: Admit | undefined;
			return (entry: object) =>
				(admit ??= deferred()[name](moduleClient, this))(entry);
		};
		this.onType('long-animation-frame', late('longFrames'));
		this.onType('longtask', late('longTasks'));
	}
}
