import type Client from '../Client';

/** a name held by lazyInterface: what its shared accessor and resolver are bound to */
interface Held {
	client: Client;
	name: string;
	make: (() => unknown) | null;
	get?: Function;
}

/** the name settled as `value` (`present`), or gone; its hold is over */
function settle(held: Held, value: unknown, present: boolean) {
	const { client, name } = held;
	held.make = null;
	client.lazyGlobals.delete(name);
	if (present)
		Reflect.defineProperty(client.global, name, {
			value,
			writable: true,
			enumerable: false,
			configurable: true,
		});
	else Reflect.deleteProperty(client.global, name);
}

/**
 * The interface made, if the name is still held and still the hold's: a
 * page that deleted or redefined the name has its own (asked with the name
 * settled first: the Reflection module resolves it too)
 */
function resolve(this: Held) {
	const { make, client, name } = this;
	if (!make) return;
	this.make = null;
	client.lazyGlobals.delete(name);
	if (Reflect.getOwnPropertyDescriptor(client.global, name)?.get !== this.get)
		return;
	let found: unknown;
	try {
		found = make();
	} catch (error) {
		// (the realm cannot make one: no page has an object of it either)
	}
	settle(this, found, found !== undefined);
}

// One getter, one setter and one resolver for every held name, each bound
// to the name's record: a hold is a record and three bound functions, not
// a wrapper pair and their closures (frame-cost). The page never sees them:
// the Reflection module resolves a held name before any reflective
// question about it.
function heldGet(this: Held) {
	Reflect.apply(resolve, this, []);
	return Reflect.get(this.client.global, this.name);
}
function heldSet(this: Held, value: unknown) {
	settle(this, value, true);
}

/**
 * Hold the realm's global interface `name` behind an accessor until it is
 * first read, for a hook whose interface a page reaches only through the
 * name or through an object the inject already hooks the way to (a
 * getContext, a navigator getter). The browser makes an interface the first
 * time anything names it, and a hook that reads its prototype makes it in
 * every frame, which costs a frame that never uses it its heap: deleting
 * the browser's lazy property does not make it, redefining it in place
 * does.
 *
 * The first read calls `make`, which hooks the interface and returns it,
 * reached the other way (a throwaway context, the navigator's object), or
 * undefined when the realm has none (then the name goes, as it is never
 * had); the name is then the data property it natively is, before the page
 * has the interface. The Reflection module resolves the name before any
 * reflective question about it (client.lazyGlobals) and lists it among the
 * window's keys where the browser does (client.globalKeyAfter), so a page
 * never sees the accessor. The function returned settles the name with the
 * interface when the page reached it the other way first. A name the page
 * deleted or defined itself before reading it stays the page's.
 */
export function lazyInterface(
	client: Client,
	name: string,
	make: () => unknown,
): (value: unknown) => void {
	const global = client.global;
	const held: Held = { client, name, make };
	held.get = heldGet.bind(held);
	client.lazyGlobals.set(name, resolve.bind(held));
	const keys = Reflect.ownKeys(global);
	const after = keys[keys.indexOf(name) - 1];
	if (after !== undefined) client.globalKeyAfter.set(name, after);
	Reflect.deleteProperty(global, name);
	Reflect.defineProperty(global, name, {
		get: held.get as () => unknown,
		set: heldSet.bind(held),
		enumerable: false,
		configurable: true,
	});
	return (value) => {
		if (held.make) settle(held, value, true);
	};
}
