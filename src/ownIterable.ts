// What the inject's own loops, spreads and destructuring iterate. A page can
// replace every native of the iteration protocol (Array.prototype's
// Symbol.iterator, %ArrayIteratorPrototype%.next, the String, Map and Set
// iterators; a polyfill does), and the syntax asks the realm's current ones
// each time: a loop of the inject over its own array called the page's
// function, which saw what the inject was doing and could hand it other
// values. build.js (scripts/ownIteration.mjs) hands every iterable of the
// inject bundles' and the rewriter library's syntax to `ownIterable`, which
// answers for the native kinds (arrays, strings, the collections, typed
// arrays, the DOM's array-likes and their iterators) with an iterator of its
// own that steps the native one by the natives taken as the bundle loads,
// before any page script ran. An array is stepped by index as natively,
// which is also how Chrome reads an array the page hands a method that takes
// a sequence: it asks none of the iteration natives. Anything else (a page's
// own iterable) is handed back as it is, and the syntax asks it as natively.
// Nothing here iterates by syntax once it has loaded.
//
// build.js evaluates this file as the end of the first file a bundle injects
// (src/inject/snapshot.ts, src/libGlobals.ts), so every file of the bundle
// has its names with no import, and it costs no module of its own. It names
// nothing of either: the realm's own Reflect.apply, taken here.
const apply = globalThis.Reflect.apply;
const protoOf = Object.getPrototypeOf;
// (also how a WebIDL sequence of the inject's tells an array: Chrome reads
// one by index, src/inject/webTransportStandIn.ts)
export const isArray = Array.isArray;
const objectProto = Object.prototype;
const iteratorKey = Symbol.iterator;
// what a native kind's prototype makes its native iterator with (0: it is
// one), and what steps that
const iterationKinds: [object, Function | 0, Function][] = [];
// a kind's getter that takes no other object, with the kind's row
const brands: [Function, Function, Function][] = [];
const iterationKind = (
	proto: any,
	sample: unknown,
	brand?: string | 0,
	make = proto[iteratorKey],
) => {
	const iterator = protoOf(apply(make, sample, []));
	iterationKinds.push(
		[proto, make, iterator.next],
		[iterator, 0, iterator.next],
	);
	if (brand) brands.push([proto.__lookupGetter__(brand), make, iterator.next]);
	return make;
};
const arrayValues = iterationKind(Array.prototype, []);
iterationKind(protoOf(Uint8Array.prototype), new Uint8Array(), 'length');
iterationKind(String.prototype, '');
iterationKind(Map.prototype, new Map(), 'size');
iterationKind(Set.prototype, new Set(), 'size');
const matches = protoOf(/(?:)/[Symbol.matchAll](''));
iterationKinds.push([matches, 0, matches.next]);
// (a document's array-likes; a worker has none. This runs as the bundle
// loads: its own iteration asks no page's function yet)
['NodeList', 'HTMLCollection', 'NamedNodeMap', 'DOMTokenList'].forEach(
	(name) => {
		const type = (globalThis as any)[name];
		if (type) iterationKind(type.prototype, [], 0, arrayValues);
	},
);

class OwnIterator {
	declare i: unknown;
	declare n: Function;
	declare e?: 1 | 2;
	constructor(iterator: unknown, next: Function, how?: 1 | 2) {
		this.i = iterator;
		this.n = next;
		this.e = how;
	}
	[iteratorKey]() {
		return this;
	}
	next() {
		const result = apply(this.n, this.i, []);
		if (this.e! > 1 && !result.done) result.value = ownIterable(result.value);
		return result;
	}
}

/**
 * An array's steps, as its native iterator takes them (its length and the
 * element read again at every step, done for good once past the end),
 * without a call of the native one per element: the inject's loops are
 * over arrays nearly all of them, and a step through the native cost
 * several times one by index.
 */
class OwnArrayIterator {
	declare a: any;
	declare i: number;
	declare e?: 1 | 2;
	constructor(array: any, how?: 1 | 2) {
		this.a = array;
		this.i = 0;
		this.e = how;
	}
	[iteratorKey]() {
		return this;
	}
	next() {
		const array = this.a;
		const index = this.i;
		if (array === undefined || index >= array.length) {
			this.a = undefined;
			return { value: undefined, done: true };
		}
		this.i = index + 1;
		const value = array[index];
		return { value: this.e! > 1 ? ownIterable(value) : value, done: false };
	}
}

/**
 * `value` to iterate: as it is, or an iterator of its own. `how`: 1 for
 * `[...value]`, its values (an array); 2 for a loop whose variable is an
 * array pattern, each value as its own to iterate (`for ([k, v] of map)`).
 * A native kind is known by its prototype, or else (a typed array, another
 * of the DOM's array-likes: a CSSRuleList) by the iterator it has.
 */
export function ownIterable(value: any, how?: 1 | 2): any {
	let own = value;
	if (isArray(value)) own = new OwnArrayIterator(value, how);
	else if (value !== null && value !== undefined)
		for (let pass = 0; pass < 2 && own === value; pass++) {
			const key = pass
				? value[iteratorKey]
				: isArray(value)
					? Array.prototype
					: protoOf(value);
			for (let index = 0; index < iterationKinds.length; index++) {
				const kind = iterationKinds[index];
				if (kind[pass] === key) {
					own = new OwnIterator(
						kind[1] ? apply(kind[1], value, []) : value,
						kind[2],
						how,
					);
					break;
				}
			}
		}
	// A collection of another realm's (a parent's, a child's), whose natives
	// are that realm's page's: its kind's getter takes it, and its prototypes
	// end in another Object.prototype (a subclass of the page's keeps what it
	// overrides; an array of another realm is an array already)
	for (let index = 0; own === value && index < brands.length; index++) {
		const brand = brands[index];
		try {
			apply(brand[0], value, []);
			let proto = value;
			while ((proto = protoOf(proto)) && proto !== objectProto);
			if (!proto)
				own = new OwnIterator(apply(brand[1], value, []), brand[2], how);
		} catch (error) {
			// not of this kind
		}
	}
	return how === 1 ? [...own] : own;
}

/** `ownIterable([...items])` for a list the inject writes out */
export const ownItems = (...items: unknown[]) => ownIterable(items);
