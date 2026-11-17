// location.ancestorOrigins as the browser has it (src/inject/dom/modules/
// Location.ts): a deferred part (./deferred.ts), made the first time a page
// reads the list, which most documents never do. Its top level reads no
// global (./deferredParts.ts).

export interface AncestorOriginsContext {
	/** the real origins of the proxied documents above, nearest first */
	origins: () => string[];
	/** DOMStringList.prototype as the browser's own list has it */
	listPrototype: () => object;
	/** the browser's own list of this location (its answer for its errors) */
	ownList: () => object;
	/** the Proxy module's wrapFunction */
	wrapFunction: <T extends Function>(
		native: T,
		hook: (target: T, that: any, args: any[]) => unknown,
	) => T;
}

/**
 * What the location's getter answers. The list is an object of
 * DOMStringList.prototype whose own properties are the browser's (an index
 * for each origin, as a legacy platform object lists its items: not
 * writable, enumerable, configurable) and whose length, item and contains
 * are the prototype's, hooked the first time a list is made to answer for
 * it. It was an object with `length`, `item`, `contains` and an iterator of
 * its own, frozen: four keys and three function sources the browser's list
 * does not have. It is the same list on every read, as natively, until the
 * ancestors change (a removed frame's location has none, and a new list).
 */
export function ancestorOriginsList(
	context: AncestorOriginsContext,
): () => object {
	const lists = new WeakMap<object, string[]>();
	let kept: { origins: string; list: object } | null = null;
	const hooked = new WeakSet<object>();
	const hookListPrototype = (prototype: object) => {
		if (hooked.has(prototype)) return;
		hooked.add(prototype);
		const answers: Record<string, (origins: string[], args: any[]) => unknown> =
			{
				length: (origins) => origins.length,
				// (an index as the browser reads one: an unsigned long)
				item: (origins, args) => origins[Number(args[0]) >>> 0] ?? null,
				contains: (origins, args) => origins.includes(String(args[0])),
			};
		for (const key of Object.keys(answers)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			const part = descriptor?.get ? 'get' : 'value';
			const native = descriptor?.[part] as Function | undefined;
			if (!descriptor || typeof native !== 'function') continue;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				[part]: context.wrapFunction(native, (target, that, args) => {
					const origins = lists.get(that);
					// (the browser's own answer for its own lists, and its errors:
					// a receiver that is no list, a call with no argument)
					if (!origins || args.length < target.length)
						return Reflect.apply(
							target,
							origins ? context.ownList() : that,
							args,
						);
					return answers[key](origins, args);
				}),
			});
		}
	};
	return () => {
		const origins = context.origins();
		const key = origins.join(' ');
		if (kept && kept.origins === key) return kept.list;
		const prototype = context.listPrototype();
		hookListPrototype(prototype);
		const descriptors: PropertyDescriptorMap = {};
		origins.forEach((origin, index) => {
			descriptors[index] = {
				value: origin,
				enumerable: true,
				configurable: true,
			};
		});
		const list = Object.create(prototype, descriptors) as object;
		lists.set(list, origins);
		kept = { origins: key, list };
		return list;
	};
}
