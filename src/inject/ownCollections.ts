// Collections the inject keeps windows in, asked through the natives taken
// when the bundle loads. A method of WeakMap.prototype or WeakSet.prototype
// is the page's to replace, and a collection of the inject that called the
// prototype's method called the page's function with the inject's own
// arguments and took its answer: a page whose `WeakMap.prototype.get`
// answered its argument got the real window of a frame of another site out
// of the map of stand-ins, and one whose `WeakSet.prototype.has` answered
// true had every window handed out as one it already held. These answer
// from the natives whatever the page did (the subclass's prototype is
// reached by no page).
const weakMapGet = WeakMap.prototype.get;
const weakMapHas = WeakMap.prototype.has;
const weakMapSet = WeakMap.prototype.set;
const weakMapDelete = WeakMap.prototype.delete;
const weakSetHas = WeakSet.prototype.has;
const weakSetAdd = WeakSet.prototype.add;
const weakSetDelete = WeakSet.prototype.delete;

export class OwnWeakMap<K extends object, V> extends WeakMap<K, V> {
	get(key: K): V | undefined {
		return Reflect.apply(weakMapGet, this, [key]);
	}
	has(key: K): boolean {
		return Reflect.apply(weakMapHas, this, [key]);
	}
	set(key: K, value: V): this {
		Reflect.apply(weakMapSet, this, [key, value]);
		return this;
	}
	delete(key: K): boolean {
		return Reflect.apply(weakMapDelete, this, [key]);
	}
}

export class OwnWeakSet<T extends object> extends WeakSet<T> {
	has(value: T): boolean {
		return Reflect.apply(weakSetHas, this, [value]);
	}
	add(value: T): this {
		Reflect.apply(weakSetAdd, this, [value]);
		return this;
	}
	delete(value: T): boolean {
		return Reflect.apply(weakSetDelete, this, [value]);
	}
}

const NativeWeakMap = WeakMap;
const NativeWeakSet = WeakSet;
const NativeMap = Map;
const NativeSet = Set;
const mapGet = Map.prototype.get;
const mapHas = Map.prototype.has;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapClear = Map.prototype.clear;
const mapKeys = Map.prototype.keys;
const mapValues = Map.prototype.values;
const mapEntries = Map.prototype.entries;
const mapSize = Reflect.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
const setClear = Set.prototype.clear;
const setValues = Set.prototype.values;
const setSize = Reflect.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
// (what an empty one's iteration steps through; nothing writes to them)
const NO_ENTRIES = new NativeMap<never, never>();
const NO_VALUES = new NativeSet<never>();

// The collections below are made on their first write. Every frame makes
// about 150 of the inject's collections as its hooks install (one for the
// instances of each interface a hook keeps state for), and a page fills few
// of them: an empty WeakMap or Map is about 80 to 100 bytes of heap and one
// of these about 16, which is some 10 KB of every frame. Each is asked
// through the natives, as the classes above are; the collection itself is
// made from the constructor taken as the bundle loaded, since a page may
// have replaced the global by its first write.

export class LazyWeakMap<K extends object, V> {
	#map: WeakMap<K, V> | undefined;
	get(key: K): V | undefined {
		const map = this.#map;
		return map === undefined
			? undefined
			: Reflect.apply(weakMapGet, map, [key]);
	}
	has(key: K): boolean {
		const map = this.#map;
		return map !== undefined && Reflect.apply(weakMapHas, map, [key]);
	}
	set(key: K, value: V): this {
		Reflect.apply(weakMapSet, (this.#map ??= new NativeWeakMap()), [
			key,
			value,
		]);
		return this;
	}
	delete(key: K): boolean {
		const map = this.#map;
		return map !== undefined && Reflect.apply(weakMapDelete, map, [key]);
	}
}

export class LazyWeakSet<T extends object> {
	#set: WeakSet<T> | undefined;
	has(value: T): boolean {
		const set = this.#set;
		return set !== undefined && Reflect.apply(weakSetHas, set, [value]);
	}
	add(value: T): this {
		Reflect.apply(weakSetAdd, (this.#set ??= new NativeWeakSet()), [value]);
		return this;
	}
	delete(value: T): boolean {
		const set = this.#set;
		return set !== undefined && Reflect.apply(weakSetDelete, set, [value]);
	}
}

/**
 * A Map made on its first write. It is not iterable itself: its keys(),
 * values() and entries() are the native Map's iterators (an empty one's
 * when nothing was written).
 */
export class LazyMap<K, V> {
	#map: Map<K, V> | undefined;
	get size(): number {
		const map = this.#map;
		return map === undefined ? 0 : Reflect.apply(mapSize, map, []);
	}
	get(key: K): V | undefined {
		const map = this.#map;
		return map === undefined ? undefined : Reflect.apply(mapGet, map, [key]);
	}
	has(key: K): boolean {
		const map = this.#map;
		return map !== undefined && Reflect.apply(mapHas, map, [key]);
	}
	set(key: K, value: V): this {
		Reflect.apply(mapSet, (this.#map ??= new NativeMap()), [key, value]);
		return this;
	}
	delete(key: K): boolean {
		const map = this.#map;
		return map !== undefined && Reflect.apply(mapDelete, map, [key]);
	}
	clear(): void {
		const map = this.#map;
		if (map !== undefined) Reflect.apply(mapClear, map, []);
	}
	keys(): MapIterator<K> {
		return Reflect.apply(mapKeys, this.#map ?? NO_ENTRIES, []);
	}
	values(): MapIterator<V> {
		return Reflect.apply(mapValues, this.#map ?? NO_ENTRIES, []);
	}
	entries(): MapIterator<[K, V]> {
		return Reflect.apply(mapEntries, this.#map ?? NO_ENTRIES, []);
	}
}

/** A Set made on its first write; values() iterates it (see LazyMap). */
export class LazySet<T> {
	#set: Set<T> | undefined;
	get size(): number {
		const set = this.#set;
		return set === undefined ? 0 : Reflect.apply(setSize, set, []);
	}
	has(value: T): boolean {
		const set = this.#set;
		return set !== undefined && Reflect.apply(setHas, set, [value]);
	}
	add(value: T): this {
		Reflect.apply(setAdd, (this.#set ??= new NativeSet()), [value]);
		return this;
	}
	delete(value: T): boolean {
		const set = this.#set;
		return set !== undefined && Reflect.apply(setDelete, set, [value]);
	}
	clear(): void {
		const set = this.#set;
		if (set !== undefined) Reflect.apply(setClear, set, []);
	}
	values(): SetIterator<T> {
		return Reflect.apply(setValues, this.#set ?? NO_VALUES, []);
	}
}
