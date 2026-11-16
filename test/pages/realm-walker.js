// The realm walker of the realm-surface suite. One file for every kind of
// realm: a classic script in a document, importScripts() in a classic
// worker, an import (for its side effect) in a module worker or a worklet.
// It defines `__realmWalker` on the global and nothing else, and it is page
// code: through the proxy it is rewritten like any script of the page, so
// what it records is what a page's own code reads.
//
// walk(root, options) goes from a global object through every object it can
// reach by own keys (Reflect.ownKeys, symbols too) and prototype links, and
// records, with no method of an instance called with arguments that could
// do anything:
// - each object's own keys in order, its prototype (by path), its class
//   string and whether it is extensible;
// - each property's descriptor: flags, kind, and for a function its name,
//   length, source text (this realm's Function.prototype.toString and, in a
//   window, a fresh frame's), own keys, prototype and whether it can be a
//   newTarget;
// - each accessor's getter called on the object that holds it (a
//   prototype's answers with the illegal invocation error: constructor
//   name, message, own keys, whose TypeError it is, stack shape), and on
//   every instance that inherits it (the type and the value);
// - deliberate failures: a prototype's setters and methods called on the
//   prototype itself, an instance's methods that take arguments called
//   with none, the global's constructors called without `new` and
//   constructed with no argument when they take some.
// Objects are named by the first path that reaches them, breadth first with
// each object's keys taken in sorted order, so a name never depends on the
// order the keys are listed in (which is recorded on its own).
(() => {
	const scope = globalThis;
	const R = scope.Reflect;
	const ownKeys = R.ownKeys;
	const getDescriptor = R.getOwnPropertyDescriptor;
	const getProto = R.getPrototypeOf;
	const apply = R.apply;
	const construct = R.construct;
	const isExtensible = R.isExtensible;
	const ownToString = scope.Function.prototype.toString;
	const objectToString = scope.Object.prototype.toString;
	const ReaderTypeError = scope.TypeError;
	const ReaderError = scope.Error;
	const ReaderPromise = scope.Promise;
	const ReaderString = scope.String;
	const stringify = scope.JSON.stringify;

	// the language's own constructors and namespaces: their prototypes'
	// methods do work on any receiver (Array.prototype.push on the prototype
	// itself), so they are recorded and never called
	const LANGUAGE = new Set(
		(
			'Object Function Array Number Boolean String Symbol Date Promise RegExp ' +
			'Error AggregateError EvalError RangeError ReferenceError SyntaxError ' +
			'TypeError URIError SuppressedError ArrayBuffer SharedArrayBuffer ' +
			'Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array ' +
			'Float16Array Float32Array Float64Array Uint8ClampedArray BigUint64Array ' +
			'BigInt64Array DataView Map Set WeakMap WeakSet WeakRef Proxy BigInt ' +
			'FinalizationRegistry Iterator DisposableStack AsyncDisposableStack ' +
			'Math JSON Reflect Atomics Intl Temporal globalThis console'
		).split(' '),
	);

	const keyName = (key) =>
		typeof key === 'symbol' ? `@@${ReaderString(key.description)}` : key;
	const compareKeys = (a, b) => {
		const x = keyName(a);
		const y = keyName(b);
		return x < y ? -1 : x > y ? 1 : 0;
	};
	const classOf = (value) => {
		try {
			return apply(objectToString, value, []);
		} catch (error) {
			return `threw ${error?.name}`;
		}
	};
	const brief = (text) =>
		text.length > 300 ? `${text.slice(0, 300)}...(${text.length})` : text;

	/** the function names of a stack's frames, down to the walker's own */
	function stackShape(error) {
		let stack;
		try {
			stack = error.stack;
		} catch (thrown) {
			return 'stack threw';
		}
		if (typeof stack !== 'string') return `stack ${typeof stack}`;
		const names = [];
		for (const line of stack.split('\n')) {
			const frame = /^\s+at (.*)$/.exec(line);
			if (!frame) continue;
			const text = frame[1];
			const open = text.lastIndexOf(' (');
			const name = open === -1 ? '<anonymous>' : text.slice(0, open);
			// every probe runs from one function, so what is above it is
			// the failure's own and what is below is the walker's
			if (/\bprobe$/.test(name)) return names.join(',') || '-';
			names.push(name);
		}
		return `${names.join(',')},<no probe frame>`;
	}

	function walk(root, options = {}) {
		const maxDepth = options.depth ?? 3;
		// the fixture's own globals, which are no part of the platform
		const own = new Set([
			'__realmWalker',
			'__realmWalkerAt',
			...(options.skip ?? []),
		]);
		const maxObjects = options.objects ?? 20000;
		const calls = options.calls !== false;
		const started = scope.Date.now();
		const RootFunctionProto = (() => {
			try {
				return getProto(getDescriptor(root, 'Object').value);
			} catch (error) {
				return null;
			}
		})();
		const rootValue = (name) => {
			try {
				return getDescriptor(root, name).value;
			} catch (error) {
				return null;
			}
		};
		const RootTypeError = rootValue('TypeError');
		const RootError = rootValue('Error');
		// a fresh realm's toString, where a realm can make one: a function
		// read through it is read past whatever this realm's has become
		let freshToString = null;
		let freshFrame = null;
		// (how getting it went is a fact of the realm too: a frame the
		// realm makes is its own, of its origin, natively)
		let freshness = 'none';
		if (options.fresh !== false && typeof scope.document === 'object')
			try {
				freshFrame = scope.document.createElement('iframe');
				(scope.document.body ?? scope.document.documentElement).append(
					freshFrame,
				);
				freshToString = freshFrame.contentWindow.Function.prototype.toString;
				freshness = 'own';
			} catch (error) {
				freshToString = null;
				freshness = `failed: ${error?.name}: ${error?.message}`;
			} finally {
				// out of the document again before anything is read: the
				// walk counts the window's frames like everything else
				freshFrame?.remove();
			}

		// calls the fixture leaves out, each by the fact it would be
		// recorded under, and the fact being recorded now
		const avoid = new Set(options.avoid ?? []);
		let current = '';
		const paths = new Map();
		// what an object is walked as: a number is an instance's depth,
		// 'class' a function, a prototype or anything reached as one
		const kinds = new Map();
		const queue = [];
		const record = {};
		const settling = [];
		const counts = { objects: 0, properties: 0, calls: 0, skipped: 0 };

		const isLanguage = (path) => {
			const second = path.indexOf('.', 2);
			return LANGUAGE.has(path.slice(2, second === -1 ? undefined : second));
		};
		const isWindow = (value) => {
			try {
				return value.window === value;
			} catch (error) {
				return false;
			}
		};
		const isNode = (value) => {
			try {
				return typeof value.nodeType === 'number';
			} catch (error) {
				return false;
			}
		};
		const enqueue = (value, path, kind) => {
			paths.set(value, path);
			kinds.set(value, kind);
			queue.push(value);
		};
		const pathOf = (value) => {
			if (value === null) return 'null';
			return paths.get(value) ?? '?';
		};
		// an object named in a text before the walk has named it: a mark
		// now, its path once the walk is over
		const refs = [];
		const ref = (value) => {
			if (value === null) return 'null';
			const known = paths.get(value);
			if (known !== undefined) return known;
			refs.push(value);
			return `\u0001${refs.length - 1}\u0001`;
		};
		const resolve = (text) =>
			text.includes('\u0001')
				? text.replace(/\u0001(\d+)\u0001/g, (all, index) =>
						pathOf(refs[index]),
					)
				: text;
		/** a function with a prototype object names it, before anything else can */
		const enqueueFunction = (value, path) => {
			enqueue(value, path, 'class');
			try {
				const d = getDescriptor(value, 'prototype');
				const prototype = d && d.value;
				if (
					prototype !== null &&
					(typeof prototype === 'object' || typeof prototype === 'function') &&
					!paths.has(prototype)
				)
					enqueue(prototype, `${path}.prototype`, 'class');
			} catch (error) {
				// read again, and recorded, when the function is visited
			}
		};

		/** what an error is, as a page can tell */
		const errorText = (error) => {
			if ((typeof error !== 'object' && typeof error !== 'function') || !error)
				return `threw ${typeof error}`;
			let name;
			let message;
			let keys;
			let ctor;
			try {
				name = error.name;
				message = error.message;
				ctor = error.constructor?.name;
				keys = ownKeys(error).map(keyName).join(',');
			} catch (thrown) {
				return 'threw an unreadable error';
			}
			// whose error it is: the walked realm's own TypeError (as a
			// function's errors are its realm's), the reading realm's, or
			// another kind
			const whose =
				RootTypeError && getProto(error) === RootTypeError.prototype
					? 'own'
					: error instanceof ReaderTypeError
						? 'reader'
						: RootError && error instanceof RootError
							? 'own-other'
							: error instanceof ReaderError
								? 'reader-other'
								: 'other';
			const text = `!${ctor}/${name}/${whose}/${keys}/${stackShape(error)}: ${brief(ReaderString(message))}`;
			// the commonest by far: a platform getter or method on an
			// object that is not one of its interface
			return text ===
				'!TypeError/TypeError/own/stack,message/-: Illegal invocation'
				? '!illegal'
				: text;
		};

		/**
		 * A call that should fail, and how it did. Every deliberate call of
		 * the walk goes through here, so a stack's own frames end at `probe`.
		 */
		const probe = (fn, that, args, isNew) => {
			if (avoid.has(current)) return { error: 'not called' };
			counts.calls++;
			try {
				return {
					value: isNew ? construct(fn, args) : apply(fn, that, args),
				};
			} catch (error) {
				return { error: errorText(error) };
			}
		};

		/** a value a getter or a call answered with, in a few characters */
		const valueText = (value, path, depth, entry, slot) => {
			const type = typeof value;
			if (value === null) return 'null';
			if (value === undefined) return 'undefined';
			if (type === 'string') return `s:${brief(stringify(value))}`;
			if (type !== 'object' && type !== 'function') {
				if (type === 'symbol') return `symbol:${keyName(value)}`;
				return `${type}:${ReaderString(value)}`;
			}
			const known = paths.get(value);
			if (known !== undefined) return `=>${known}`;
			if (
				value instanceof ReaderPromise ||
				classOf(value) === '[object Promise]'
			) {
				// how it settles is added once the walk is over; handled
				// from now, so a rejection is no uncaught error of the page
				if (entry) settling.push([entry, slot, value]);
				value.then(undefined, () => {});
				return 'promise';
			}
			if (value !== root && isWindow(value)) return 'window:other';
			const tag = classOf(value);
			if (isNode(value) && !(tag === '[object HTMLDocument]' && depth === 0))
				return `node:${tag}`;
			if (path === null || depth >= maxDepth) return `${type}:${tag}`;
			if (type === 'function') enqueueFunction(value, path);
			else enqueue(value, path, depth + 1);
			return `->${tag}`;
		};

		const outcomeText = (outcome, path, depth, entry, slot) =>
			'error' in outcome
				? outcome.error
				: valueText(outcome.value, path, depth, entry, slot);

		/** a function in a few characters; what is as a native's is left out */
		const functionText = (fn, expected) => {
			let text = '';
			try {
				const name = getDescriptor(fn, 'name');
				const length = getDescriptor(fn, 'length');
				const flags = (d) =>
					d
						? `${d.configurable ? 'c' : '-'}${d.enumerable ? 'e' : '-'}${d.writable ? 'w' : '-'}${'value' in d ? '' : 'A'}`
						: 'none';
				text += `F${length ? ReaderString(length.value) : '?'}`;
				if (!name || name.value !== expected)
					text += `|name=${name ? stringify(name.value) : 'none'}`;
				if (flags(name) !== 'c--' || flags(length) !== 'c--')
					text += `|flags=${flags(name)},${flags(length)}`;
				const keys = ownKeys(fn).map(keyName).join(',');
				if (keys !== 'length,name' && keys !== 'length,name,prototype')
					text += `|keys=${keys}`;
				else if (keys === 'length,name,prototype') text += '|P';
				const proto = getProto(fn);
				if (proto !== RootFunctionProto)
					text += `|proto=${proto === scope.Function.prototype ? 'reader' : ref(proto)}`;
				const native = `function ${name ? name.value : ''}() { [native code] }`;
				let own;
				try {
					own = apply(ownToString, fn, []);
				} catch (error) {
					own = errorText(error);
				}
				if (own !== native) text += `|source=${brief(stringify(own))}`;
				if (freshToString) {
					let fresh;
					try {
						fresh = apply(freshToString, fn, []);
					} catch (error) {
						fresh = errorText(error);
					}
					if (fresh !== own) text += `|fresh=${brief(stringify(fresh))}`;
				}
				let newTarget = true;
				try {
					construct(ReaderString, [], fn);
				} catch (error) {
					newTarget = false;
				}
				if (newTarget) text += '|N';
			} catch (error) {
				text += `|unreadable ${error?.name}`;
			}
			return text;
		};

		const flagsOf = (d) =>
			`${d.configurable ? 'c' : '-'}${d.enumerable ? 'e' : '-'}${'value' in d || 'writable' in d ? (d.writable ? 'w' : '-') : ''}`;

		/** one object: its entry in the record, its children on the queue */
		const visit = (object) => {
			const path = paths.get(object);
			const kind = kinds.get(object);
			const instance = typeof kind === 'number';
			const depth = instance ? kind : 0;
			const language = isLanguage(path);
			const entry = { proto: null, tag: classOf(object), props: [] };
			record[path] = entry;
			counts.objects++;
			let keys;
			let proto;
			try {
				keys = ownKeys(object);
				proto = getProto(object);
				if (!isExtensible(object)) entry.fixed = true;
			} catch (error) {
				entry.error = errorText(error);
				return;
			}
			if (typeof object === 'function') entry.fn = functionText(object, null);
			if (path === 'G') keys = keys.filter((key) => !own.has(key));
			entry.keys = keys.map(keyName).join(',');
			// a prototype is walked as a class even when nothing names it
			if (proto !== null && !paths.has(proto))
				enqueue(proto, `${path}:proto`, 'class');
			entry.protoRef = proto;
			const isPrototype = /\.prototype$|:proto$/.test(path);

			const seen = new Set();
			for (const key of [...keys].sort(compareKeys)) {
				const name = keyName(key);
				seen.add(key);
				counts.properties++;
				const at = `${path}.${name}`;
				current = at;
				if (options.trace) options.trace(at);
				let d;
				try {
					d = getDescriptor(object, key);
				} catch (error) {
					entry.props.push([name, `descriptor ${errorText(error)}`]);
					continue;
				}
				if (!d) {
					entry.props.push([name, 'no descriptor']);
					continue;
				}
				const slot = [name, ''];
				entry.props.push(slot);
				if ('value' in d || 'writable' in d) {
					const value = d.value;
					let text = `d|${flagsOf(d)}|`;
					if (typeof value === 'function') {
						const known = paths.get(value);
						if (known !== undefined) text += `=>${known}`;
						else {
							const shape = functionText(
								value,
								name.replace(/^@@(.*)$/, '[$1]'),
							);
							text += shape;
							let hasMore = false;
							try {
								hasMore = ownKeys(value).length > 2;
							} catch (error) {
								hasMore = false;
							}
							// a constructor, or a function with statics: an
							// object of its own
							if (hasMore) enqueueFunction(value, at);
							else paths.set(value, at);
							if (calls && !language) {
								// a prototype's method on the prototype
								// itself: the receiver is refused first
								if (isPrototype && key !== 'constructor') {
									text += `|on-prototype=${outcomeText(probe(value, object, []), null, 0, slot, 'on-prototype')}`;
									// and with as many arguments as it takes
									if (value.length >= 1)
										text += `|with-arguments=${outcomeText(probe(value, object, new scope.Array(value.length).fill(undefined)), null, 0, slot, 'with-arguments')}`;
								}
								// an instance's method that takes arguments,
								// with none: refused for the count
								else if (instance && !hasMore && value.length >= 1)
									text += `|no-arguments=${outcomeText(probe(value, object, []), null, 0, slot, 'no-arguments')}`;
								// a constructor of the global, called and
								// constructed with nothing
								else if (path === 'G' && hasMore && !LANGUAGE.has(name)) {
									text += `|called=${outcomeText(probe(value, undefined, []), null, 0, slot, 'called')}`;
									if (value.length >= 1)
										text += `|constructed=${outcomeText(probe(value, undefined, [], true), null, 0, slot, 'constructed')}`;
								}
							}
						}
					} else
						text += valueText(
							value,
							at,
							instance ? depth : maxDepth - 1,
							null,
							null,
						);
					slot[1] = text;
					continue;
				}
				let text = `a|${flagsOf(d)}`;
				if (typeof d.get === 'function') {
					const known = paths.get(d.get);
					if (known !== undefined) text += `|get=>${known}`;
					else {
						paths.set(d.get, `${at}<get>`);
						text += `|get=${functionText(d.get, `get ${name.replace(/^@@(.*)$/, '[$1]')}`)}`;
					}
					text += `|read=${outcomeText(probe(d.get, object, []), at, depth, slot, 'read')}`;
				} else text += '|get=none';
				if (typeof d.set === 'function') {
					const known = paths.get(d.set);
					if (known !== undefined) text += `|set=>${known}`;
					else {
						paths.set(d.set, `${at}<set>`);
						text += `|set=${functionText(d.set, `set ${name.replace(/^@@(.*)$/, '[$1]')}`)}`;
					}
					if (calls && isPrototype && !language)
						text += `|write=${outcomeText(probe(d.set, object, []), null, 0, slot, 'write')}`;
				}
				slot[1] = text;
			}
			if (!instance) return;
			// what the instance inherits: each getter read on it, each
			// method that takes arguments called with none
			entry.inherited = [];
			for (
				let holder = proto, hops = 0;
				holder !== null && hops < 20;
				holder = getProto(holder), hops++
			) {
				const from = paths.get(holder) ?? '?';
				if (isLanguage(from)) continue;
				let inheritedKeys;
				try {
					inheritedKeys = ownKeys(holder);
				} catch (error) {
					break;
				}
				for (const key of [...inheritedKeys].sort(compareKeys)) {
					if (seen.has(key)) continue;
					seen.add(key);
					const name = keyName(key);
					current = `${path}~${name}`;
					if (options.trace) options.trace(current);
					let d;
					try {
						d = getDescriptor(holder, key);
					} catch (error) {
						continue;
					}
					if (!d) continue;
					const slot = [name, ''];
					if (typeof d.get === 'function') {
						const outcome = probe(d.get, object, []);
						let text = outcomeText(
							outcome,
							`${path}.${name}`,
							depth,
							slot,
							'read',
						);
						// the same object each time, or a new one
						if (text.startsWith('->')) {
							const again = probe(d.get, object, []);
							if (again.value !== outcome.value) text += '|not the same twice';
						}
						slot[1] = text;
						entry.inherited.push(slot);
					} else if (
						calls &&
						typeof d.value === 'function' &&
						key !== 'constructor' &&
						d.value.length >= 1
					) {
						slot[1] = `no-arguments=${outcomeText(probe(d.value, object, []), null, 0, slot, 'no-arguments')}`;
						entry.inherited.push(slot);
					}
				}
			}
		};

		enqueue(root, 'G', 0);
		let cursor = 0;
		const drain = () => {
			for (; cursor < queue.length; cursor++) {
				if (counts.objects >= maxObjects) {
					counts.skipped = queue.length - cursor;
					break;
				}
				visit(queue[cursor]);
			}
		};
		drain();
		const finish = () => {
			for (const path in record) {
				const entry = record[path];
				if ('protoRef' in entry) {
					entry.proto = pathOf(entry.protoRef);
					delete entry.protoRef;
				}
				if (entry.fn) entry.fn = resolve(entry.fn);
				for (const slot of entry.props) slot[1] = resolve(slot[1]);
				if (entry.inherited)
					for (const slot of entry.inherited) slot[1] = resolve(slot[1]);
			}
		};
		counts.ms = scope.Date.now() - started;
		const result = { record, counts, fresh: freshness };
		// how each promise a call answered with settles: appended to the
		// property's text, in the order the calls were made
		let settledTo = 0;
		const settle = () => {
			const batch = settling.slice(settledTo);
			settledTo = settling.length;
			return ReaderPromise.all(
				batch.map(([slot, label, promise]) =>
					ReaderPromise.race([
						promise.then(
							(value) => `fulfilled ${typeof value}`,
							(error) => `rejected ${errorText(error)}`,
						),
						new ReaderPromise((resolve) =>
							scope.setTimeout
								? scope.setTimeout(() => resolve('pending'), 1500)
								: resolve('no timer'),
						),
					]).then((text) => {
						slot[1] += `|${label} settles=${text}`;
					}),
				),
			).then(() => {
				finish();
				return result;
			});
		};
		// one more object, read as an instance under a name of its own (a
		// node of another document, by the names this walk gave the realm)
		R.defineProperty(result, 'inspect', {
			enumerable: false,
			value: (value, path, depth = maxDepth) => {
				if (!paths.has(value)) {
					enqueue(value, path, depth);
					drain();
				}
				return settle();
			},
		});
		R.defineProperty(result, 'pathOf', { enumerable: false, value: pathOf });
		finish();
		if (settling.length)
			R.defineProperty(result, 'settled', {
				enumerable: false,
				configurable: true,
				value: settle(),
			});
		return result;
	}

	/** walk(), with every promise a call answered with settled */
	async function walkSettled(root, options) {
		const result = walk(root, options);
		if (result.settled) await result.settled;
		return result;
	}

	/**
	 * The record as lines, one per fact: `path:proto`, `path:keys`,
	 * `path.key`, `path~key` (what an instance inherits). What a harness
	 * compares, and what a realm's record is reduced against another's.
	 */
	function lines(result) {
		const out = {};
		if (result.fresh) out['walker:fresh-frame'] = result.fresh;
		for (const path in result.record) {
			const entry = result.record[path];
			out[`${path}:object`] =
				`${entry.tag}|proto=${entry.proto}${entry.fixed ? '|not extensible' : ''}${entry.fn ? `|${entry.fn}` : ''}${entry.error ? `|${entry.error}` : ''}`;
			if (entry.keys !== undefined) out[`${path}:keys`] = entry.keys;
			for (const [name, text] of entry.props) out[`${path}.${name}`] = text;
			if (entry.inherited)
				for (const [name, text] of entry.inherited)
					out[`${path}~${name}`] = text;
		}
		return out;
	}

	/** the lines of `mine` that `base` does not have as they are */
	function reduce(mine, base) {
		const changed = {};
		const missing = [];
		let same = 0;
		for (const key in mine)
			if (base[key] === mine[key]) same++;
			else changed[key] = mine[key];
		for (const key in base) if (!(key in mine)) missing.push(key);
		return { changed, missing, same };
	}

	R.defineProperty(scope, '__realmWalker', {
		value: { walk, walkSettled, lines, reduce, stackShape },
		configurable: true,
		writable: true,
		enumerable: false,
	});
})();
