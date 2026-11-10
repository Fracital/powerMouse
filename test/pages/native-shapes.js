// Shared by native-shapes.html and its worker: what a page can learn about
// the shape of a global, as a value that compares by JSON
(() => {
	const attempt = (f) => {
		try {
			return f();
		} catch (error) {
			return `${error?.name}: ${error?.message}`;
		}
	};
	const source = (f) => attempt(() => Function.prototype.toString.call(f));
	// a function by what a page reads of it
	const fn = (f) => ({
		name: f.name,
		length: f.length,
		source: source(f),
		keys: Reflect.ownKeys(f).map(String),
		prototype: 'prototype' in f,
	});
	const value = (v) => {
		if (typeof v === 'function') return fn(v);
		if (typeof v === 'symbol') return String(v);
		if (typeof v === 'object' && v !== null)
			return `object ${Object.prototype.toString.call(v)}`;
		return v === undefined ? 'undefined' : v;
	};
	const descriptor = (d) =>
		d === undefined
			? 'none'
			: [
					d.writable === undefined ? '-' : d.writable ? 'w' : '',
					d.enumerable ? 'e' : '',
					d.configurable ? 'c' : '',
					'value' in d ? value(d.value) : null,
					'get' in d ? value(d.get) : null,
					'set' in d ? value(d.set) : null,
				];
	const descriptors = (object, skip = []) =>
		Reflect.ownKeys(object)
			.filter((key) => !skip.includes(key))
			.map((key) => [
				String(key),
				descriptor(Reflect.getOwnPropertyDescriptor(object, key)),
			]);
	// the global (or 'other') whose prototype `object` is
	const owners = new Map();
	const owner = (object, global) => {
		if (object === null) return null;
		if (object === Function.prototype) return 'Function.prototype';
		if (object === Object.prototype) return 'Object.prototype';
		if (!owners.has(global)) {
			const map = new Map();
			for (const name of Object.getOwnPropertyNames(global))
				try {
					const v = global[name];
					if (typeof v === 'function' && v.prototype && !map.has(v.prototype))
						map.set(v.prototype, name);
				} catch (error) {
					// a getter that throws
				}
			owners.set(global, map);
		}
		return owners.get(global).get(object) ?? 'other';
	};
	const chain = (object, global) => {
		const names = [];
		for (let p = object; p; p = Object.getPrototypeOf(p))
			names.push(owner(p, global));
		return names;
	};
	/** a constructor: its own properties, its chain, its prototype's */
	const constructor = (C, global) => ({
		...fn(C),
		own: descriptors(C, ['prototype']),
		prototypeDescriptor: descriptor(
			Reflect.getOwnPropertyDescriptor(C, 'prototype'),
		).slice(0, 3),
		// the constructor it inherits from, and whether that is the global
		parent: (() => {
			const parent = Object.getPrototypeOf(C);
			if (parent === Function.prototype) return 'Function.prototype';
			if (typeof parent !== 'function') return String(parent);
			return [parent.name, global[parent.name] === parent];
		})(),
		chain: C.prototype ? chain(C.prototype, global) : null,
		constructorIs: C.prototype
			? C.prototype.constructor === C
				? 'itself'
				: (C.prototype.constructor?.name ?? String(C.prototype.constructor))
			: null,
		constructorDescriptor: C.prototype
			? descriptor(
					Reflect.getOwnPropertyDescriptor(C.prototype, 'constructor'),
				).slice(0, 3)
			: null,
		global: descriptor(
			Reflect.getOwnPropertyDescriptor(global, C.name) ??
				Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(global), C.name),
		).slice(0, 3),
		called: attempt(() => typeof C()),
	});
	/** every constructor on the global, by name */
	const constructors = (global) => {
		const result = {};
		for (const name of Object.getOwnPropertyNames(global)) {
			if (!/^[A-Z]/.test(name)) continue;
			let C;
			try {
				C = global[name];
			} catch (error) {
				continue;
			}
			if (typeof C !== 'function' || !('prototype' in C)) continue;
			result[name] = attempt(() => constructor(C, global));
		}
		return result;
	};
	/** each prototype's own members, by constructor name */
	const prototypes = (global, names) =>
		Object.fromEntries(
			names.map((name) => [
				name,
				attempt(() => descriptors(global[name].prototype)),
			]),
		);
	self.__shapes = {
		attempt,
		fn,
		value,
		descriptor,
		descriptors,
		constructor,
		constructors,
		prototypes,
	};
})();
