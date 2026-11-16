import type Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

// the browser's own members, taken when the bundle runs
const performanceProto =
	typeof Performance === 'function' ? Performance.prototype : undefined;
const nativeSetSize = performanceProto?.setResourceTimingBufferSize;
const nativeClear = performanceProto?.clearResourceTimings;
const nativeEntriesByType = performanceProto?.getEntriesByType;
const observerProto =
	typeof PerformanceObserver === 'function'
		? PerformanceObserver.prototype
		: undefined;
const nativeObserve = observerProto?.observe;
const nativeTakeRecords = observerProto?.takeRecords;
const nativeListEntries =
	typeof PerformanceObserverEntryList === 'function'
		? PerformanceObserverEntryList.prototype.getEntries
		: undefined;
const nativeResponseEnd =
	typeof PerformanceResourceTiming === 'function'
		? Reflect.getOwnPropertyDescriptor(
				PerformanceResourceTiming.prototype,
				'responseEnd',
			)?.get
		: undefined;
const nativeAddListener =
	typeof EventTarget === 'function'
		? EventTarget.prototype.addEventListener
		: undefined;
const eventProto = typeof Event === 'function' ? Event.prototype : undefined;
const nativeStop = eventProto?.stopImmediatePropagation;
const nativePhase =
	eventProto && Reflect.getOwnPropertyDescriptor(eventProto, 'eventPhase')?.get;

/** the size of the browser's resource timing buffer until a page sets one */
const DEFAULT_SIZE = 250;
/** the largest size the browser takes (an unsigned long) */
const MAX_SIZE = 0xffffffff;
/**
 * How many of the proxy's own entries the browser's buffer may come to hold
 * beside the page's. Past it the buffer is kept full: an entry of the
 * proxy's is dropped as it comes and one of the page's is let in by the
 * buffer's own task (see `full`)
 */
const OWN_ENTRIES = 2000;

/**
 * A page's resource timing buffer holds the page's entries only. The
 * browser has one buffer for a document (or worker), 250 entries until the
 * page says otherwise, and every request the proxy makes there for itself
 * (the inject bundles, each beacon of the synchronous bridge, a route of
 * the worker's) is an entry in it that the page never sees: a page that
 * used its storage a hundred times had 150 entries left, heard
 * `resourcetimingbufferfull` at its 150th load and every time a beacon came
 * after it, and lost every entry from then on.
 *
 * The browser's buffer is sized for both: the page's size and one more for
 * each entry of the proxy's it holds, raised as an observer of the
 * inject's hears of each. The browser then fills the buffer, fires its own
 * (trusted) event and takes or drops what waited exactly as it does
 * natively, on the page's count. What that cannot make exact is settled
 * where the browser decides: a listener added before any of the page's
 * hears every `resourcetimingbufferfull` first. One the page's own count
 * did not earn (only the proxy's entries waited, or the page's still have
 * room because an entry of the proxy's took the last place a moment
 * before the size was raised) goes no further, and the size is set so the
 * browser's task takes in the page's entries that have room and nothing
 * else. Until that task runs such an entry is not in the browser's buffer
 * yet: `read` names them for the page's reads.
 */
export default class ResourceBufferModule extends Module<Client> {
	/**
	 * How many entries the browser counts as dropped that natively it would
	 * not have (the proxy's own, or the page's that waited only behind
	 * them): a buffered observer's `droppedEntriesCount` has them
	 */
	notThePages = 0;
	/**
	 * Brings the count up to now and returns the page's entries that are
	 * in its buffer though the browser's task has not taken them in yet
	 */
	read: () => object[] = () => [];
	/**
	 * Starts the accounting; `pageEntry` says whether the page may see an
	 * entry. Called once, by the module that filters the page's reads,
	 * before any hook of its own and before any script of the page's
	 */
	start(pageEntry: (entry: object) => boolean) {
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const performance = global.performance as Performance | undefined;
		const Observer = global.PerformanceObserver;
		const proto = global.Performance?.prototype as Performance | undefined;
		if (
			!performance ||
			!proto ||
			typeof Observer !== 'function' ||
			!nativeSetSize ||
			!nativeClear ||
			!nativeEntriesByType ||
			!nativeObserve ||
			!nativeTakeRecords ||
			!nativeListEntries ||
			!nativeAddListener ||
			!nativeStop ||
			!nativePhase
		)
			return;
		const proxyModule = this.client.getModule(ProxyModule)!;

		/** the page's buffer size */
		let size = DEFAULT_SIZE;
		/** the browser's, as last set here */
		let nativeSize = DEFAULT_SIZE;
		/** the entries in the browser's buffer, and how many of them are the page's */
		let held = 0;
		let own = 0;
		/**
		 * The entries that found the browser's buffer full, in the order
		 * they came: they wait for the browser's task, which fires the event
		 * and then takes in what has room. `late`: one of the page's that
		 * natively would have waited too (the page's own buffer was full)
		 */
		let queued: { entry: object; page: boolean; late: boolean }[] = [];
		/** the event the browser's task is dispatching, or the last one it did */
		let event: Event | null = null;

		const setNative = (wanted: number) => {
			nativeSize = Math.max(0, Math.min(wanted, MAX_SIZE));
			Reflect.apply(nativeSetSize, performance, [nativeSize]);
		};
		const room = () => Math.max(0, size - own);
		/** the browser's size while nothing waits (see OWN_ENTRIES) */
		const settle = () =>
			setNative(held - own >= OWN_ENTRIES ? held : held + room());
		/**
		 * How many of the first entries that wait the browser's task is to
		 * take in: up to the last of the page's that has room
		 */
		const admitted = () => {
			let left = room();
			let count = 0;
			for (let index = 0; index < queued.length && left > 0; index++)
				if (queued[index].page) {
					left--;
					count = index + 1;
				}
			return count;
		};
		/** the browser's buffer as it is, when nothing waits: the count never drifts where it matters */
		const recount = () => {
			held = 0;
			own = 0;
			for (const entry of Reflect.apply(nativeEntriesByType, performance, [
				'resource',
			]) as object[]) {
				held++;
				if (pageEntry(entry)) own++;
			}
		};
		/** what the browser's task did after its event: took in what had room, or dropped what waited when nothing had */
		const afterEvent = () => {
			event = null;
			const took = Math.min(Math.max(0, nativeSize - held), queued.length);
			for (const { page } of queued.splice(0, took)) {
				held++;
				if (page) own++;
			}
			if (took === 0) queued = [];
			// (entries still wait: the task fires its event again at once)
			if (!queued.length) {
				recount();
				settle();
			}
		};
		const arrived = (entries: object[]) => {
			let grew = false;
			const before = own;
			for (const entry of entries) {
				const page = pageEntry(entry);
				// (while any waits the browser's task is due, and every arrival
				// waits with them)
				if (!queued.length && held < nativeSize) {
					held++;
					if (page) own++;
					else grew = true;
					continue;
				}
				let ahead = 0;
				let late = false;
				for (const waiting of queued)
					if (waiting.page) {
						ahead++;
						late ||= waiting.late;
					}
				late = page && (late || size - own - ahead <= 0);
				if (!late) this.notThePages++;
				queued.push({ entry, page, late });
			}
			if (queued.length) return;
			// the page's buffer has just filled: the next entry is the one
			// that must find the browser's full
			const filled = own >= size && before < size;
			if (filled) recount();
			if (grew || filled) settle();
		};
		/** an observer's entries in the order they came (its list is by start time) */
		const byArrival = (entries: object[]) =>
			nativeResponseEnd && entries.length > 1
				? entries
						.map((entry) => ({
							entry,
							end: Reflect.apply(nativeResponseEnd, entry, []) as number,
						}))
						.sort((a, b) => a.end - b.end)
						.map(({ entry }) => entry)
				: entries;
		const dispatching = () =>
			event !== null && Reflect.apply(nativePhase, event, []) !== 0;
		let observer: PerformanceObserver | undefined;
		const sync = () => {
			if (event && !dispatching()) afterEvent();
			if (observer)
				arrived(Reflect.apply(nativeTakeRecords, observer, []) as object[]);
		};
		try {
			observer = new Observer((list: object) => {
				if (event && !dispatching()) afterEvent();
				arrived(
					byArrival(Reflect.apply(nativeListEntries, list, []) as object[]),
				);
			}) as PerformanceObserver;
			Reflect.apply(nativeObserve, observer, [{ type: 'resource' }]);
		} catch (error) {
			// no resource timing here: nothing to account for
			return;
		}
		// what the context's own start left in the buffer (the inject's bundles)
		recount();
		settle();

		// before any listener of the page's: the browser's task fired its
		// event because its buffer is full, which is the page's business only
		// when one of the page's entries waits and the page's buffer is full
		const full = (fired: Event) => {
			if (!fired.isTrusted) return;
			sync();
			event = fired;
			let pages = 0;
			for (const waiting of queued) if (waiting.page) pages++;
			const left = room();
			if (left === 0 && pages > 0) return;
			Reflect.apply(nativeStop, fired, []);
			// every entry that waits, when the page's all have room (the size
			// that leaves is the settled one); else up to the last of the
			// page's that has, and the task's next round is the page's event
			setNative(
				left > 0 &&
					pages <= left &&
					held - own + queued.length - pages < OWN_ENTRIES
					? held + queued.length + left - pages
					: held + admitted(),
			);
		};
		Reflect.apply(nativeAddListener, performance, [
			'resourcetimingbufferfull',
			full,
		]);

		this.read = () => {
			sync();
			// (inside the page's handler nothing that waits is in the buffer
			// yet, natively either)
			if (!queued.length || event) return [];
			const waiting: object[] = [];
			let left = room();
			for (const { entry, page } of queued) {
				if (left <= 0) break;
				if (!page) continue;
				waiting.push(entry);
				left--;
			}
			return waiting;
		};

		proto.setResourceTimingBufferSize = proxyModule.wrapFunction(
			proto.setResourceTimingBufferSize,
			(target, that, args) => {
				// the browser's own checks and conversion first
				const result = Reflect.apply(target, that, args);
				if (that !== performance) return result;
				sync();
				const wanted = Number(args[0]);
				size = Number.isFinite(wanted) ? Math.trunc(wanted) >>> 0 : 0;
				// in the page's handler the task takes in next what now has
				// room; with entries waiting outside it, the task decides
				if (event) setNative(held + admitted());
				else if (queued.length) setNative(nativeSize);
				else settle();
				return result;
			},
		);
		proto.clearResourceTimings = proxyModule.wrapFunction(
			proto.clearResourceTimings,
			(target, that, args) => {
				if (that !== performance) return Reflect.apply(target, that, args);
				sync();
				const result = Reflect.apply(target, that, args);
				held = 0;
				own = 0;
				// (and the entries an ancestor's loads for this document left)
				this.client.adoptedLoads.length = 0;
				if (event) setNative(admitted());
				// (entries wait for the task: it finds the buffer full, and its
				// event settles them)
				else if (queued.length) setNative(0);
				else settle();
				return result;
			},
		);
	}
}
