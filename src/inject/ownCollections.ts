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
