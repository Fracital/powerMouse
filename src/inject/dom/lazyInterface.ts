import type Client from '../Client';
import type ProxyModule from '../modules/Proxy';

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
 * interface when the page reached it the other way first.
 */
export function lazyInterface(
	client: Client,
	proxyModule: ProxyModule,
	name: string,
	make: () => unknown,
): (value: unknown) => void {
	const global = client.global;
	let pending = true;
	const settle = (value: unknown, present: boolean) => {
		pending = false;
		client.lazyGlobals.delete(name);
		if (present)
			Reflect.defineProperty(global, name, {
				value,
				writable: true,
				enumerable: false,
				configurable: true,
			});
		else Reflect.deleteProperty(global, name);
	};
	const resolve = () => {
		if (!pending) return;
		let found: unknown;
		try {
			found = make();
		} catch (error) {
			// (the realm cannot make one: no page has an object of it either)
		}
		settle(found, found !== undefined);
	};
	client.lazyGlobals.set(name, resolve);
	const keys = Reflect.ownKeys(global);
	const after = keys[keys.indexOf(name) - 1];
	if (after !== undefined) client.globalKeyAfter.set(name, after);
	Reflect.deleteProperty(global, name);
	Reflect.defineProperty(global, name, {
		get: proxyModule.wrapFunction(
			function lazyInterface() {} as () => unknown,
			() => {
				resolve();
				return Reflect.get(global, name);
			},
		),
		set: proxyModule.wrapFunction(
			function lazyInterface(_value: unknown) {} as (value: unknown) => void,
			(_target, _that, args) => settle(args[0], true),
		),
		enumerable: false,
		configurable: true,
	});
	return (value) => {
		if (pending) settle(value, true);
	};
}
