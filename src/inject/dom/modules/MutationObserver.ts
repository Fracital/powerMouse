import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteCSS } from '../../modules/Unroute';
import type DocumentClient from '../Client';

/**
 * The DOM hooks keep the value the page wrote for a routed attribute in a
 * marker attribute (`s_o:href` next to the routed `href`), and one page write
 * becomes several native ones: the property's own reflection, the routed
 * value, the marker, the property applied again. A MutationObserver would
 * see every one of them, the marker names and the routed values in
 * `oldValue`; frameworks and analytics read both. The page's observers get
 * the records the browser would have given it instead:
 *
 * - every native write made while one page write runs (a hooked
 *   setAttribute, removeAttribute, property setter and the like) is taken
 *   off the observers' queues as it happens, and the records for the
 *   attribute the page wrote become one, whose `oldValue` is the value the
 *   page saw before (the marker's previous value when there was one);
 * - the hooks' own writes the page never made (an inserted node's
 *   attributes routed on insertion) produce no record;
 * - marker records never show, and any other attribute record reports the
 *   page's value as `oldValue`.
 *
 * Everything else (childList, characterData, attributes the hooks never
 * touch) is the browser's record, in the browser's order. A callback left
 * with no record is not called.
 */
export const MARKER = 's_o:';

const isMarker = (name: string | null): name is string =>
	name !== null && name.startsWith(MARKER);

// native accessors, taken when the bundle is evaluated, before any hook:
// interface checks are not realm checks, so they serve every realm the
// bundle hooks (an about:blank child runs its creator's bundle)
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeParentNode = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;
const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'ownerDocument',
)!.get!;
const nativeNamespaceURI = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'namespaceURI',
)!.get!;
const nativeContentType = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'contentType',
)!.get!;
const recordGetter = (key: keyof MutationRecord) =>
	Reflect.getOwnPropertyDescriptor(MutationRecord.prototype, key)!
		.get! as () => unknown;
const nativeRecord = {
	type: recordGetter('type'),
	target: recordGetter('target'),
	attributeName: recordGetter('attributeName'),
	oldValue: recordGetter('oldValue'),
};

const recordType = (record: MutationRecord): string =>
	Reflect.apply(nativeRecord.type, record, []) as string;
const recordTarget = (record: MutationRecord): Node =>
	Reflect.apply(nativeRecord.target, record, []) as Node;
const recordName = (record: MutationRecord): string | null =>
	Reflect.apply(nativeRecord.attributeName, record, []) as string | null;
const recordOldValue = (record: MutationRecord): string | null =>
	Reflect.apply(nativeRecord.oldValue, record, []) as string | null;

const attributeOf = (element: Node, name: string): string | null => {
	try {
		return Reflect.apply(nativeGetAttribute, element, [name]);
	} catch (error) {
		return null;
	}
};

interface Registration {
	subtree: boolean;
	oldValue: boolean;
}

interface ObserverState {
	callback: Function;
	/** the native takeRecords of the observer's realm */
	take: () => MutationRecord[];
	/** records ready for the page, oldest first */
	queue: MutationRecord[];
	registrations: WeakMap<Node, Registration>;
	/** whether any registration asked for old values (a transient one's) */
	anyOldValue: boolean;
	ref: WeakRef<MutationObserver>;
	/** the page's value of an attribute that carries no marker */
	readback: (name: string, value: string) => string;
	schedule: (callback: () => void) => void;
	scheduled: boolean;
}

const states = new WeakMap<MutationObserver, ObserverState>();
/** observers with a registration that sees attributes */
const live = new Set<WeakRef<MutationObserver>>();
/** records already shaped for the page (an inner write's result) */
const settled = new WeakSet<object>();

interface Write {
	target: Element;
	/** the attribute the page wrote, as records name it; null: hooks only */
	name: string | null;
	/** the names whose marker stands for `name` */
	markers: Set<string>;
	/** the attributes the hooks wrote, when the page wrote none */
	written: Set<string> | null;
	records: Map<MutationObserver, MutationRecord[]>;
}
const writes: Write[] = [];

/** a record that reads as the page's: another name or old value */
function reshape(
	record: MutationRecord,
	name: string | null,
	oldValue: string | null,
): MutationRecord {
	if (recordName(record) === name && recordOldValue(record) === oldValue)
		return record;
	const shaped = new Proxy(record, {
		get: (target, key) => {
			if (key === 'attributeName') return name;
			if (key === 'oldValue') return oldValue;
			return Reflect.get(target, key, target);
		},
	});
	settled.add(shaped);
	return shaped;
}

/** whether the page's registrations covering `target` asked for old values */
function wantsOldValue(state: ObserverState, target: Node): boolean {
	let found = false;
	let node: Node | null = target;
	let own = true;
	while (node) {
		const registration = state.registrations.get(node);
		if (registration && (own || registration.subtree)) {
			if (registration.oldValue) return true;
			found = true;
		}
		node = Reflect.apply(nativeParentNode, node, []);
		own = false;
	}
	// a node removed from an observed subtree keeps a transient registration
	// until the next delivery: the observer's own setting stands for it
	return found ? false : state.anyOldValue;
}

/**
 * The page's value of attribute `name` on `target` before records[index]:
 * the marker's value then (the old value of the next marker record, or the
 * marker now) when it had one, the native old value otherwise.
 */
function pageOldValue(
	state: ObserverState,
	records: MutationRecord[],
	index: number,
): string | null {
	const record = records[index];
	const target = recordTarget(record);
	const name = recordName(record)!;
	const marker = MARKER + name;
	let markerValue: string | null | undefined;
	for (let i = index + 1; i < records.length; i++) {
		const next = records[i];
		if (
			!settled.has(next) &&
			recordType(next) === 'attributes' &&
			recordTarget(next) === target &&
			recordName(next) === marker
		) {
			markerValue = recordOldValue(next);
			break;
		}
	}
	if (markerValue === undefined) markerValue = attributeOf(target, marker);
	if (markerValue !== null) return markerValue;
	const old = recordOldValue(record);
	return old === null ? null : state.readback(name, old);
}

/** records the page did not shape itself: markers out, old values its own */
function shapeLoose(
	state: ObserverState,
	records: MutationRecord[],
): MutationRecord[] {
	const out: MutationRecord[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (settled.has(record) || recordType(record) !== 'attributes') {
			out.push(record);
			continue;
		}
		const name = recordName(record);
		if (isMarker(name)) continue;
		out.push(
			reshape(
				record,
				name,
				wantsOldValue(state, recordTarget(record))
					? pageOldValue(state, records, i)
					: null,
			),
		);
	}
	return out;
}

/** the records of one page write (or one hook write) as the browser's */
function shapeWrite(
	state: ObserverState,
	write: Write,
	records: MutationRecord[],
): MutationRecord[] {
	const { target, name } = write;
	// the attributes whose marker was written: a hook routed them again
	const rerouted = new Map<Node, Set<string>>();
	let firstMarker: MutationRecord | null = null;
	let firstOwn: MutationRecord | null = null;
	for (const record of records) {
		if (settled.has(record) || recordType(record) !== 'attributes') continue;
		const attribute = recordName(record)!;
		const node = recordTarget(record);
		if (isMarker(attribute)) {
			const base = attribute.slice(MARKER.length);
			if (!rerouted.has(node)) rerouted.set(node, new Set());
			rerouted.get(node)!.add(base);
			if (node === target && write.markers.has(base)) firstMarker ??= record;
		} else if (node === target && attribute === name) firstOwn ??= record;
	}

	// the value the page saw before its write: the marker's then, when the
	// attribute had one, the attribute's own otherwise
	const pageBefore = (): string | null => {
		let marker: string | null = null;
		if (firstMarker) marker = recordOldValue(firstMarker);
		else
			for (const base of write.markers) {
				marker = attributeOf(target, MARKER + base);
				if (marker !== null) break;
			}
		if (marker !== null) return marker;
		const native = firstOwn
			? recordOldValue(firstOwn)
			: attributeOf(target, name!);
		return native === null ? null : state.readback(name!, native);
	};

	const out: MutationRecord[] = [];
	let emitted = false;
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (settled.has(record) || recordType(record) !== 'attributes') {
			out.push(record);
			continue;
		}
		const attribute = recordName(record)!;
		const node = recordTarget(record);
		const own =
			name !== null &&
			node === target &&
			(attribute === name ||
				(isMarker(attribute) &&
					write.markers.has(attribute.slice(MARKER.length))));
		if (own) {
			// one record for the page's write, where its first native one was
			if (!emitted)
				out.push(
					reshape(
						record,
						name,
						wantsOldValue(state, target) ? pageBefore() : null,
					),
				);
			emitted = true;
			continue;
		}
		if (isMarker(attribute)) continue;
		// the hooks' own writes: what they routed, or recomputed
		if (node === target && write.written?.has(attribute)) continue;
		if (rerouted.get(node)?.has(attribute)) continue;
		out.push(
			reshape(
				record,
				attribute,
				wantsOldValue(state, node) ? pageOldValue(state, records, i) : null,
			),
		);
	}
	return out;
}

function enqueue(observer: MutationObserver, records: MutationRecord[]) {
	if (!records.length) return;
	const state = states.get(observer)!;
	for (const record of records) {
		settled.add(record);
		state.queue.push(record);
	}
	if (state.scheduled) return;
	state.scheduled = true;
	// the browser's own delivery comes first when this observer has records
	// left in its queue; this one covers a queue that was emptied
	state.schedule(() => {
		state.scheduled = false;
		deliver(observer);
	});
}

function deliver(observer: MutationObserver) {
	const state = states.get(observer);
	if (!state || !state.queue.length) return;
	const records = state.queue;
	state.queue = [];
	Reflect.apply(state.callback, observer, [records, observer]);
}

/** take every observer's pending records into the write being run */
function drain() {
	const write = writes[writes.length - 1];
	for (const ref of live) {
		const observer = ref.deref();
		if (!observer) {
			live.delete(ref);
			continue;
		}
		const state = states.get(observer)!;
		const records = Reflect.apply(state.take, observer, []);
		if (!records.length) continue;
		if (write) {
			if (!write.records.has(observer)) write.records.set(observer, []);
			const list = write.records.get(observer)!;
			for (const record of records) list.push(record);
		} else enqueue(observer, shapeLoose(state, records));
	}
}

function run<T>(write: Write, callback: () => T): T {
	drain();
	writes.push(write);
	try {
		return callback();
	} finally {
		drain();
		writes.pop();
		const outer = writes[writes.length - 1];
		for (const [observer, records] of write.records) {
			const shaped = shapeWrite(states.get(observer)!, write, records);
			for (const record of shaped) settled.add(record);
			if (outer) {
				if (!outer.records.has(observer)) outer.records.set(observer, []);
				const list = outer.records.get(observer)!;
				for (const record of shaped) list.push(record);
			} else enqueue(observer, shaped);
		}
	}
}

/**
 * The name an attribute call with `name` acts on: an HTML element of an HTML
 * document lowercases it (`setAttribute('HREF')` writes `href`), anything
 * else keeps it as given.
 */
export function attributeName(element: unknown, name: string): string {
	try {
		if (
			Reflect.apply(nativeNamespaceURI, element, []) ===
				'http://www.w3.org/1999/xhtml' &&
			Reflect.apply(
				nativeContentType,
				Reflect.apply(nativeOwnerDocument, element, []),
				[],
			) === 'text/html'
		)
			return name.toLowerCase();
	} catch (error) {
		// not an element: the call throws on its own
	}
	return name;
}

/**
 * Run a page's write of attribute `name` on `element` (a qualified name;
 * records carry its local name). The page's observers see one record for it.
 */
export function pageWrite<T>(
	element: Element,
	name: string,
	callback: () => T,
): T {
	if (!live.size) return callback();
	const qualified = attributeName(element, String(name));
	const local = qualified.slice(qualified.indexOf(':') + 1);
	return run(
		{
			target: element,
			name: local,
			markers: new Set([qualified, local]),
			written: null,
			records: new Map(),
		},
		callback,
	);
}

/**
 * Run the hooks' own writes on `element` (the attributes `names` lists)
 * outside any page write: the page made none, so its observers see none.
 */
export function hookWrite<T>(
	element: Element,
	names: () => Iterable<string>,
	callback: () => T,
): T {
	if (!live.size || writes.length) return callback();
	return run(
		{
			target: element,
			name: null,
			markers: new Set(),
			written: new Set(names()),
			records: new Map(),
		},
		callback,
	);
}

const PROPERTY_ATTRIBUTES: Record<string, string> = {
	httpEquiv: 'http-equiv',
	htmlFor: 'for',
	className: 'class',
};

/** the attribute a reflecting property writes */
export const propertyAttribute = (property: string) =>
	PROPERTY_ATTRIBUTES[property] ?? property.toLowerCase();

export default class MutationObserverModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const NativeObserver = global.MutationObserver;
		if (typeof NativeObserver !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const prototype = NativeObserver.prototype;
		const nativeObserve = prototype.observe;
		const nativeDisconnect = prototype.disconnect;
		const nativeTakeRecords = prototype.takeRecords;
		const queueMicrotask = global.queueMicrotask.bind(global);
		const readback = (name: string, value: string) =>
			name === 'style' ? unrouteCSS(this.client, value) : value;

		global.MutationObserver = proxyModule.wrapFunction(
			NativeObserver,
			(target, that, args, newTarget) => {
				// not a constructor call, or not a callback: the browser's error
				if (!newTarget || typeof args[0] !== 'function')
					return newTarget
						? Reflect.construct(target, args, newTarget)
						: Reflect.apply(target, that, args);
				const callback = args[0] as Function;
				const observer: MutationObserver = Reflect.construct(
					target,
					[
						function (
							this: MutationObserver,
							records: MutationRecord[],
							self: MutationObserver,
						) {
							const state = states.get(self);
							if (!state) return;
							for (const record of shapeLoose(state, records))
								state.queue.push(record);
							deliver(self);
						},
						...args.slice(1),
					],
					newTarget,
				);
				states.set(observer, {
					callback,
					take: nativeTakeRecords,
					queue: [],
					registrations: new WeakMap(),
					anyOldValue: false,
					ref: new WeakRef(observer),
					readback,
					schedule: queueMicrotask,
					scheduled: false,
				});
				return observer;
			},
			true,
		);

		prototype.observe = proxyModule.wrapFunction(
			nativeObserve,
			(target, that, args) => {
				const state = states.get(that);
				const options = args[1];
				if (!state || typeof options !== 'object' || options === null)
					return Reflect.apply(target, that, args);
				// read once, in the browser's order; a filter also takes the
				// markers of the names it lists, so the page's values are known
				const copy: Record<string, unknown> = {};
				for (const key of [
					'attributeFilter',
					'attributeOldValue',
					'attributes',
					'characterData',
					'characterDataOldValue',
					'childList',
					'subtree',
				]) {
					const value = (options as Record<string, unknown>)[key];
					if (value !== undefined) copy[key] = value;
				}
				const attributes =
					copy.attributes !== undefined
						? !!copy.attributes
						: copy.attributeOldValue !== undefined ||
							copy.attributeFilter !== undefined;
				const filter = copy.attributeFilter as Iterable<unknown> | undefined;
				if (
					attributes &&
					typeof filter === 'object' &&
					filter !== null &&
					typeof filter[Symbol.iterator] === 'function'
				) {
					const names = Array.from(filter, String);
					copy.attributeFilter = [
						...names,
						...names.map((name) => MARKER + name),
					];
				}
				const result = Reflect.apply(target, that, [args[0], copy]);
				if (attributes) {
					const oldValue = !!copy.attributeOldValue;
					state.registrations.set(args[0], {
						subtree: !!copy.subtree,
						oldValue,
					});
					if (oldValue) state.anyOldValue = true;
					live.add(state.ref);
				} else state.registrations.delete(args[0]);
				return result;
			},
		);

		prototype.disconnect = proxyModule.wrapFunction(
			nativeDisconnect,
			(target, that, args) => {
				const result = Reflect.apply(target, that, args);
				const state = states.get(that);
				if (state) {
					state.queue = [];
					state.registrations = new WeakMap();
					state.anyOldValue = false;
					live.delete(state.ref);
					for (const write of writes) write.records.delete(that);
				}
				return result;
			},
		);

		prototype.takeRecords = proxyModule.wrapFunction(
			nativeTakeRecords,
			(target, that, args) => {
				const records = Reflect.apply(target, that, args);
				const state = states.get(that);
				if (!state) return records;
				const taken = state.queue;
				state.queue = [];
				for (const record of shapeLoose(state, records)) taken.push(record);
				return taken;
			},
		);
	}
}
