// The world a differential case runs in (test/differential/harness.mjs),
// evaluated as a classic script in a fresh realm, natively and proxied.
//
// Natively the realm's `location`, `top` and `parent` are the page's own
// objects. Proxied, they are what a proxied page's realm really holds: a
// host location and a host top, which no page code may touch (each is a
// Proxy that records any touch as an escape), tagged the way the inject tags
// the real ones so the access API hands the page its stand-ins, which are the
// same objects the native world has. Every object of the world is a Proxy
// that records what is done to it, in order: a case's trace.
//
// Leaves `__world` for the harness (and, proxied, for the fake client of
// test/differential/runtime.ts); the harness removes it before the case runs.
// (an expression: the script's completion value is the function)
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(function (mode, names, base, bare) {
	'use strict';
	const proxied = mode === 'proxied';
	const global = globalThis;
	const trace = [];
	const labels = new WeakMap();
	const hosts = new WeakSet();
	// while the harness itself looks at a value nothing is recorded
	let quiet = 0;
	const { get, set, has, apply, construct, ownKeys, defineProperty } = Reflect;
	const { getOwnPropertyDescriptor, deleteProperty, getPrototypeOf } = Reflect;
	const nativeToString = Function.prototype.toString;
	const objectToString = Object.prototype.toString;
	const stringify = JSON.stringify;
	const isArray = Array.isArray;
	const NativeString = String;
	const NativeProxy = Proxy;
	const NativeURL = URL;
	const push = (line) => {
		if (!quiet) trace[trace.length] = line;
	};

	const keyText = (key) =>
		typeof key === 'symbol' ? `@@${key.description}` : NativeString(key);

	/** a value as a trace names it: by its label, its type or its text, never by running its code */
	function show(value, depth = 0) {
		quiet++;
		try {
			return shown(value, depth);
		} finally {
			quiet--;
		}
	}
	function shown(value, depth) {
		switch (typeof value) {
			case 'string':
				return stringify(value);
			case 'bigint':
				return `${value}n`;
			case 'symbol':
				return `@@${value.description}`;
			case 'undefined':
			case 'boolean':
				return NativeString(value);
			case 'number':
				return Object.is(value, -0) ? '-0' : NativeString(value);
		}
		if (value === null) return 'null';
		if (value === global) return '<window>';
		const label = labels.get(value);
		if (label !== undefined) return `<${label}>`;
		if (typeof value === 'function') {
			let name;
			let length;
			let source;
			try {
				name = getOwnPropertyDescriptor(value, 'name')?.value;
				length = getOwnPropertyDescriptor(value, 'length')?.value;
				// the realm's toString as a page calls it now
				source = apply(Function.prototype.toString, value, []);
			} catch (error) {
				source = `!${error?.message}`;
			}
			return `fn(${stringify(name)},${length},${stringify(source)})`;
		}
		if (depth > 2) return '{...}';
		try {
			if (
				value instanceof Error ||
				apply(objectToString, value, []) === '[object Error]'
			)
				return `${shown(value.name, 3)}(${shown(value.message, 3)})`;
			if (isArray(value)) {
				const parts = [];
				for (let i = 0; i < value.length && i < 12; i++)
					parts[i] = i in value ? shown(value[i], depth + 1) : '';
				return `[${parts.join(',')}]`;
			}
			const tag = apply(objectToString, value, []);
			if (tag !== '[object Object]') return tag;
			const parts = [];
			for (const key of ownKeys(value).slice(0, 12)) {
				const descriptor = getOwnPropertyDescriptor(value, key);
				parts.push(
					`${keyText(key)}:${'value' in descriptor ? shown(descriptor.value, depth + 1) : 'accessor'}`,
				);
			}
			const proto = getPrototypeOf(value);
			const kind =
				proto === null
					? 'null-proto '
					: proto === Object.prototype
						? ''
						: 'obj ';
			return `${kind}{${parts.join(',')}}`;
		} catch (error) {
			return `!show(${error?.message})`;
		}
	}

	// the inject's own names: what it asks of a window or of a stand-in by
	// one is nothing a page sees (they are the browser's objects and its
	// own, no Proxy of the page's)
	const internal = new Set([
		names.access,
		names.client,
		names.globalProxy,
		names.globalName,
	]);
	const unseen = (trap, key) =>
		(trap === 'has' || trap === 'get') && internal.has(key);

	/** `target` behind a Proxy that records what is done to it, as `label` */
	function membrane(target, label, silent = () => false) {
		const says = (trap, key, extra = '') => {
			if (key !== undefined && silent(trap, key)) return;
			// what the inject asks of an object of the page's by one of its
			// own names is no step of the page's code: a tell, told apart
			const tell = key !== undefined && internal.has(key) ? 'tell ' : '';
			push(
				`${tell}${label}.${trap}${key === undefined ? '' : `(${keyText(key)})`}${extra}`,
			);
		};
		const proxy = new NativeProxy(target, {
			get(t, key, receiver) {
				says('get', key);
				return get(t, key, receiver);
			},
			set(t, key, value, receiver) {
				says('set', key, `=${show(value)}`);
				return set(t, key, value, receiver);
			},
			has(t, key) {
				says('has', key);
				return has(t, key);
			},
			deleteProperty(t, key) {
				says('delete', key);
				return deleteProperty(t, key);
			},
			ownKeys(t) {
				says('ownKeys');
				return ownKeys(t);
			},
			getOwnPropertyDescriptor(t, key) {
				says('describe', key);
				return getOwnPropertyDescriptor(t, key);
			},
			defineProperty(t, key, descriptor) {
				says('define', key);
				return defineProperty(t, key, descriptor);
			},
			apply(t, that, args) {
				says(
					'call',
					undefined,
					`(${args.map((arg) => show(arg)).join(',')}) this=${show(that)}`,
				);
				return apply(t, that, args);
			},
			construct(t, args, newTarget) {
				says('new', undefined, `(${args.map((arg) => show(arg)).join(',')})`);
				return construct(t, args, newTarget);
			},
		});
		labels.set(proxy, label);
		return proxy;
	}

	/** a function of the world that records its calls: `label(args) this=...` */
	function method(label, result) {
		const fn = {
			[label](...args) {
				push(
					`${label}(${args.map((arg) => show(arg)).join(',')}) this=${show(this)}`,
				);
				return typeof result === 'function'
					? apply(result, this, args)
					: result;
			},
		}[label];
		labels.set(fn, `fn ${label}`);
		return fn;
	}

	/**
	 * What the browser really holds where the page reads a stand-in: a touch
	 * of it by anything but the access API's own tag reads is an escape
	 */
	function host(label, tags) {
		const escaped = (trap, key) =>
			push(
				`!HOST ${label}.${trap}${key === undefined ? '' : `(${keyText(key)})`}`,
			);
		// (an object, as the real ones are: `typeof location`)
		const proxy = new NativeProxy(
			{},
			{
				get(t, key) {
					if (internal.has(key)) return tags[key];
					escaped('get', key);
					return undefined;
				},
				has(t, key) {
					if (internal.has(key)) return key in tags;
					escaped('has', key);
					return false;
				},
				set(t, key) {
					escaped('set', key);
					return true;
				},
				deleteProperty(t, key) {
					escaped('delete', key);
					return true;
				},
				ownKeys() {
					escaped('ownKeys');
					return [];
				},
				getOwnPropertyDescriptor(t, key) {
					escaped('describe', key);
					return undefined;
				},
				defineProperty(t, key) {
					escaped('define', key);
					return false;
				},
				getPrototypeOf() {
					escaped('getPrototypeOf');
					return null;
				},
			},
		);
		labels.set(proxy, `HOST:${label}`);
		hosts.add(proxy);
		return proxy;
	}

	const resolve = (value) => {
		try {
			return new NativeURL(NativeString(value), base).href;
		} catch (error) {
			return `!${NativeString(value)}`;
		}
	};
	const ROUTED = 'routed:';
	/** a navigation as the browser was told of it, by the URL the page meant */
	const navigate = (label, value) =>
		push(`navigate ${label} ${resolve(value)}`);
	/** what a write of a window's real location makes of the value it is handed */
	const hostNavigate = (label, value) => {
		value = NativeString(value);
		if (!proxied) return navigate(label, value);
		// the inject hands the browser a route, never the page's URL
		if (value.startsWith(ROUTED))
			return navigate(label, value.slice(ROUTED.length));
		push(`!HOST ${label} navigated to ${stringify(value)}, no route`);
	};

	const standIns = new Map();
	const CONVERSION = new Set([
		'href',
		'toString',
		'valueOf',
		Symbol.toPrimitive,
	]);
	/** a Location the page reads, at `href`: writes of its href navigate */
	function location(label, href) {
		const target = {
			get href() {
				return href;
			},
			set href(value) {
				navigate(label, value);
			},
			origin: new NativeURL(href).origin,
			assign: method(`${label}.assign`),
			replace: method(`${label}.replace`),
			reload: method(`${label}.reload`),
			toString() {
				return href;
			},
		};
		// (a write of href is recorded by what it does)
		// (a write of href is recorded by what it does; how a Location is
		// made a string is the browser's own, which no page replaces: the
		// access API reads its href where the page's code converted it)
		const page = membrane(
			target,
			label,
			(trap, key) =>
				(trap === 'set' && key === 'href') ||
				(trap === 'get' && CONVERSION.has(key)) ||
				unseen(trap, key),
		);
		if (!proxied) return { page, real: page };
		const real = host(label, {
			[names.globalProxy]: page,
			[names.globalName]: 'location',
		});
		standIns.set(real, page);
		return { page, real };
	}

	const windows = new Set([global]);
	/**
	 * Another window of the page (`parent`, the page's top, an opener): its
	 * `location` and `top` are the real ones, as a real window's are
	 */
	function window(label, href, top) {
		const where = location(`${label}.location`, href);
		const target = {
			name: label,
			get location() {
				return where.real;
			},
			set location(value) {
				hostNavigate(`${label}.location`, value);
			},
			postMessage: method(`${label}.postMessage`),
			closed: false,
			length: 0,
			value: 7,
		};
		// (a Proxy over a real window is asked for a property's descriptor
		// after its get trap: nothing a page sees either)
		const proxy = membrane(
			target,
			label,
			(trap, key) =>
				trap === 'describe' ||
				// (a write of its location is recorded by what it does, and a
				// read of it by what is read of the location)
				((trap === 'set' || trap === 'get') && key === 'location') ||
				unseen(trap, key),
		);
		target.self = target.window = target.frames = proxy;
		// another proxied window has a client and an access API of its own,
		// which this realm's hands a write of that window's members to
		if (proxied)
			defineProperty(target, names.client, {
				value: {
					accessApi: {
						// (that window's own API answers its top as its realm sees it)
						set2: (object, key, operate, value) => {
							if (key === 'location')
								return operate(
									{
										get location() {
											return where.page;
										},
										set location(next) {
											where.page.href = next;
										},
									},
									'location',
									value,
								);
							const result = operate(object, key, value);
							return result === hostTop ? pageTop : result;
						},
					},
				},
			});
		defineProperty(target, 'top', {
			get: () => (top ? top() : proxied ? hostTop : proxy),
			enumerable: true,
			configurable: false,
		});
		windows.add(proxy);
		return proxy;
	}

	const hooks = {
		trace,
		show,
		push,
		hosts,
		windows,
		resolveTop: (value) => value,
		navigationRoute: (destination) => ROUTED + NativeString(destination),
		done(outcome) {
			push(outcome);
			return trace.join('\n');
		},
		nativeToString,
	};
	/** what a case says and makes: `log`, `M`, `F` */
	const tools = () => {
		let made = 0;
		const tool = (name, value) => {
			defineProperty(global, name, { value, enumerable: true });
			// (not a page's code: nothing here is rewritten)
			labels.set(value, `fn ${name}`);
		};
		tool('log', (...args) => {
			push(`log ${args.map((arg) => show(arg)).join(' ')}`);
		});
		tool('M', (target = {}, label = `m${++made}`) => membrane(target, label));
		tool('F', (label, result) => method(label, result));
	};
	// A bare realm holds none of the world (a conformance test's own globals
	// are all it has): the harness's hooks alone. A browser's realm is a
	// real window, with its real location, top and parent: what a case says
	// and makes is all it is given (test/suites/rewriter-differential-browser.mjs)
	if (bare || mode === 'browser') {
		if (!bare) tools();
		defineProperty(global, '__world', { configurable: true, value: hooks });
		return;
	}

	// the page's top: natively the realm's `top`; proxied, what the inject
	// answers for the host's window
	const hostTop = proxied ? host('top', {}) : null;
	const pageTop = window('top', 'https://top.example/top.html');
	const realTop = proxied ? hostTop : pageTop;
	const parent = window(
		'parent',
		'https://parent.example/dir/parent.html',
		() => realTop,
	);
	const opener = window(
		'opener',
		'https://opener.example/opener.html',
		() => realTop,
	);
	const here = location('location', base);

	const define = (name, descriptor) =>
		defineProperty(global, name, {
			enumerable: true,
			configurable: false,
			...descriptor,
		});
	define('location', {
		get: () => here.real,
		set: (value) => hostNavigate('location', value),
	});
	define('top', { get: () => realTop, set: undefined });
	for (const name of ['self', 'frames'])
		define(name, { get: () => global, set: undefined });
	// (the browser's own getter answers for a window, any window, and for
	// nothing else: the access API asks it what a window is)
	define('window', {
		get() {
			if (this === undefined || this === null || this === global) return global;
			if (windows.has(this)) return this;
			throw new TypeError('Illegal invocation');
		},
		set: undefined,
	});
	define('parent', { value: parent, writable: true, configurable: true });
	define('opener', { value: opener, writable: true, configurable: true });
	define('postMessage', {
		value: method('window.postMessage'),
		writable: true,
		configurable: true,
	});
	define('name', { value: '', writable: true, configurable: true });
	const document = membrane(
		{
			get location() {
				return here.real;
			},
			set location(value) {
				hostNavigate('location', value);
			},
			URL: base,
			title: 'page',
		},
		'document',
		// (a write of its location is recorded by what it does, and a read of
		// it by what is read of the location)
		(trap, key) =>
			((trap === 'set' || trap === 'get') && key === 'location') ||
			unseen(trap, key),
	);
	define('document', { get: () => document, set: undefined });

	tools();
	labels.set(global.URL, 'fn URL');

	hooks.resolveTop = (value) => (value === hostTop ? pageTop : value);
	defineProperty(global, '__world', { configurable: true, value: hooks });
});
