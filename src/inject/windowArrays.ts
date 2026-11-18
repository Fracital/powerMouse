// What a browser's array method called with a window as its receiver, or a
// window handed as a list of arguments, reads of it (modules/Reflection.ts
// applyWindowChildren, which says why): a deferred part of the document
// bundle (./dom/deferredParts.ts), made at a document's first such call.
// Only a scope with windows reaches it, so the worker bundle has none. The
// hooks, and the checks that a receiver is a window, stay in the bundle.
import type ProxyModule from './modules/Proxy';
import { readerOf, READERS, SPREADABLE } from './modules/Reflection';
import { LazyWeakMap } from './ownCollections';

/** what the part reads of the Reflection module's scope */
export interface WindowArraysContext {
	/** the access API's member read */
	get: (object: unknown, key: unknown, container?: unknown) => unknown;
	isWindow: (value: unknown) => boolean;
	proxyModule: ProxyModule;
}

const isIndex = (key: unknown): key is string => {
	if (typeof key !== 'string') return false;
	const index = +key;
	return index >= 0 && index % 1 === 0 && `${index}` === key;
};

/** the part's functions, for one client's realm */
export function windowArrays({
	get,
	isWindow,
	proxyModule,
}: WindowArraysContext) {
	// a window as the page may read it: a child as `window[i]` hands it
	// out, any other key the window's own (`length` included). It is
	// handed to concat only once the window was found spreadable.
	const views = new LazyWeakMap<object, object>();
	const viewOf = (window: any): object => {
		let view = views.get(window);
		if (!view) {
			view = new Proxy(Object.create(null) as object, {
				get: (_, key) =>
					isIndex(key)
						? get(window[key], +key, window)
						: key === SPREADABLE || Reflect.get(window, key),
				has: (_, key) => Reflect.has(window, key),
			});
			views.set(window, view);
		}
		return view;
	};
	// a window given as a list of arguments: read at once, as natively
	const childrenOf = (window: any): unknown[] => {
		const length = window.length;
		const children: unknown[] = [];
		for (let index = 0; index < length; index++)
			children[index] = get(window[index], index, window);
		return children;
	};
	const route = (
		native: Function,
		name: string,
		window: object,
		args: unknown[],
	): unknown => {
		const callback = args[0];
		if (name === 'sort') {
			// sort writes the window, which the browser refuses after the
			// comparisons: those see what the page may of each child
			const shown = (value: unknown) => get(value, 0, window);
			const compare =
				callback === undefined
					? (a: unknown, b: unknown) => {
							const x = `${shown(a)}`;
							const y = `${shown(b)}`;
							return x < y ? -1 : y < x ? 1 : 0;
						}
					: typeof callback === 'function'
						? (a: unknown, b: unknown) =>
								Reflect.apply(callback, undefined, [shown(a), shown(b)])
						: callback;
			return Reflect.apply(native, window, [compare]);
		}
		const at = READERS[name];
		if (at > 0 && typeof callback === 'function')
			args[0] = function (this: unknown, ...values: unknown[]) {
				if (values.length > at) values[at] = window;
				return Reflect.apply(callback, this, values);
			};
		return Reflect.apply(native, viewOf(window), args);
	};
	// a method bound to a window
	const routers = new LazyWeakMap<Function, Function>();
	const routerOf = (native: Function) => {
		let router = routers.get(native);
		if (!router) {
			router = proxyModule.wrapFunction(native, (target, that, args) =>
				isWindow(that)
					? route(target, readerOf(target)!, that, args)
					: Reflect.apply(target, that, args),
			);
			routers.set(native, router);
		}
		return router;
	};
	return { viewOf, childrenOf, route, routerOf };
}

export type WindowArrays = ReturnType<typeof windowArrays>;
