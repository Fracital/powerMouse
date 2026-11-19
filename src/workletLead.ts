// The access API of a worklet's module (an AudioWorklet's, a paint, layout or
// animation worklet's). The rewriter routes a module's member reads, writes
// and calls through the access API, which the inject bundle puts on a
// window's or a worker scope's Number.prototype (`0..$s$j.get2(...)`). A
// worklet scope holds no inject: nothing of ours can load there (no
// importScripts, no fetch, no dynamic import), and there is nothing in one
// to stand in for (no location, no window, no eval stand-in, no other realm
// to post to). So a worklet's module declares the API itself, as a function
// of the module's own scope that its rewrite calls for it (`$s$j().get2(...)`:
// src/helperNames.ts workletAccessExpression), and every helper does what
// the page's expression does. Nothing is added to the scope's global or to
// any prototype: with no inject in the scope to hide a property of
// Number.prototype from reflection, one there was a property a page could
// list, describe and find by its keys' order. Each module of the scope
// declares its own, a function declaration, so it is there before the
// module runs: a module of an import cycle calls a function of another
// before that one ran, as natively.
// What V8 names in the error of a call of no function is the page's
// expression, which the helper prints back from the source the rewriter
// hands it; anything else fails on the page's own operation.

/**
 * The statement a worklet module's rewrite starts with: the function of the
 * module's scope `access` names, which answers the access API, one that does
 * what the page's code does with no hooks, made on the first call. Its pos
 * takes the map statement a script file's rewrite starts with
 * (rust/rwjs/src/positions.rs) and keeps nothing: a worklet keeps no
 * positions.
 */
export function workletAccess(access: string): string {
	return `function ${access}() {
	return (${access}.api ??= (() => {
	const { apply, construct, ownKeys } = Reflect;
	const NativeProxy = Proxy;
	const NativeTypeError = TypeError;
	const nullish = (value) => value === null || value === undefined;
	const keyOf = (key) =>
		(typeof key === 'object' && key !== null) || typeof key === 'function'
			? ownKeys({ [key]: 0 })[0]
			: key;
	const balanced = (text) => {
		let depth = 0;
		for (const c of text) {
			if (c === '(') depth++;
			else if (c === ')' && --depth < 0) return false;
		}
		return depth === 0;
	};
	// the callee of a call or a new the rewriter hands over (\`o[k](0)\`), as V8 prints it
	const callee = (partial) => {
		if (typeof partial !== 'string') return null;
		let text = partial.trim();
		if (text.startsWith('new ')) text = text.slice(4).trim();
		if (!text.endsWith(')')) return null;
		let depth = 0;
		let at = text.length - 1;
		for (; at > 0; at--) {
			if (text[at] === ')') depth++;
			else if (text[at] === '(' && --depth === 0) break;
		}
		if (at <= 0) return null;
		text = text.slice(0, at);
		if (text.endsWith('?.')) text = text.slice(0, -2);
		while (text.startsWith('(') && text.endsWith(')') && balanced(text.slice(1, -1)))
			text = text.slice(1, -1);
		return text || null;
	};
	const call = (method, that, args, partial) => {
		if (typeof method === 'function') return apply(method, that, args);
		const printed = callee(partial);
		if (printed === null) return apply(method, that, args);
		throw new NativeTypeError(printed + ' is not a function');
	};
	const isConstructor = (value) => {
		if (typeof value !== 'function') return false;
		try {
			construct(new NativeProxy(value, { construct: () => ({}) }), []);
			return true;
		} catch (error) {
			return false;
		}
	};
	const make = (target, args, partial) => {
		if (isConstructor(target)) return construct(target, args);
		const printed = callee(partial);
		if (printed === null) return construct(target, args);
		throw new NativeTypeError(printed + ' is not a constructor');
	};
	const NO_SCOPE = Object.freeze(
		Object.create(null, { [Symbol.toPrimitive]: { value: () => '[object Object]' } }),
	);
	const write = (object, property, value) => (object[property] = value);
	// (the options importRoute was given, for the import it routed)
	let pendingOptions;
	const api = {
		get2: (target, key, partial, optional) =>
			nullish(target) && optional ? undefined : target[keyOf(key)],
		arg: (target, key) => target[keyOf(key)],
		spread: (value) => value,
		get: (object) => object,
		set2: (target, key, operate, righthand) =>
			operate(target, nullish(target) ? key : keyOf(key), righthand),
		set1: (target, name, operate, set, righthand) => {
			const property = Symbol();
			let value = target;
			let assigned = false;
			const result = operate(
				{
					get [property]() {
						return value;
					},
					set [property](v) {
						value = v;
						assigned = true;
					},
				},
				property,
				righthand,
			);
			if (assigned) set(value);
			return result;
		},
		ref1: (target, set, name = 'location') => ({
			get value() {
				return target;
			},
			set value(value) {
				api.set1(target, name, write, set, value);
			},
		}),
		ref2: (target, key, own = write) => ({
			get value() {
				return target[keyOf(key)];
			},
			set value(value) {
				api.set2(target, key, own, value);
			},
		}),
		key: keyOf,
		smethod: (method, that, partial, optional) =>
			optional && nullish(method)
				? undefined
				: (...args) => call(method, that, args, partial),
		sset: (key, that, read, set, operate, righthand) => {
			const property = Symbol();
			return operate(
				{
					get [property]() {
						return read(key);
					},
					set [property](value) {
						set(key, value);
					},
				},
				property,
				righthand,
			);
		},
		sref: (key, that, read, set) => ({
			get value() {
				return read(key);
			},
			set value(value) {
				api.sset(key, that, read, set, write, value);
			},
		}),
		has: (key, target) => key in target,
		new2: (target, key, args, partial) => make(target[keyOf(key)], args, partial),
		call3: (target, key, name, args, partial) => {
			const object = target[keyOf(key)];
			return call(object[name], object, args, partial);
		},
		fcall: (callee, args, partial) => call(callee, undefined, args, partial),
		fnew: (callee, args, partial) => make(callee, args, partial),
		iter: (value) => value,
		coerce: (value) => value,
		// links: 1 none short-circuits, 2 the object's, 3 the call's, 0 both
		post: (target, args, links, partial) => {
			const none = links === false || links === 1;
			if (nullish(target) && !none && links !== 3) return undefined;
			const method = target.postMessage;
			if (!none && links !== 2 && nullish(method)) return undefined;
			return call(method, target, args, partial);
		},
		fn2: (target, key, partial) => {
			const method = target[keyOf(key)];
			return (...args) => call(method, target, args, partial);
		},
		call2: (target, key, args, partial, optional) => {
			const links = optional === true ? 3 : optional || 0;
			if (nullish(target) && links & 1) return undefined;
			const method = target[(key = keyOf(key))];
			if (links & 2 && nullish(method)) return undefined;
			return call(method, target, args, partial);
		},
		lazy: (target) => (nullish(target) ? undefined : (key) => target[keyOf(key)]),
		method: (target, chained, optionalCall, partial) => {
			if (nullish(target)) return chained ? undefined : (key) => target[key];
			return (key) => {
				const method = target[keyOf(key)];
				if (optionalCall && nullish(method)) return undefined;
				return (...args) => call(method, target, args, partial);
			};
		},
		poster: (target, partial, links) => {
			if (nullish(target)) {
				if (links === 1 || links === 3) return target.postMessage;
				return undefined;
			}
			const method = target.postMessage;
			if (nullish(method) && links !== 1 && links !== 2) return undefined;
			return (...args) => call(method, target, args, partial);
		},
		scope: (object) => object,
		scoped: () => NO_SCOPE,
		evalScope: (code) => code,
		isEval: () => false,
		import: (baseURL, url) => import(url),
		imported: (promise) => promise,
		importRoute: (baseURL, url, options) => {
			pendingOptions = options;
			return url;
		},
		importOptions: () => {
			const options = pendingOptions;
			pendingOptions = undefined;
			return options;
		},
		pattern: (object) => object,
		source: (value) => value,
		src: () => {},
		pos: () => {},
	};
	return Object.freeze(api);
})());
}
`;
}
