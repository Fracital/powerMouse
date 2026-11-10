// The failing expressions of test/suites/error-messages.mjs: each case is the
// page's own code, rewritten by the proxy like any script, and records what
// its error reads as. Values the cases reach through (nothing here navigates
// or writes a real unforgeable).
const o = {
	a: { b: 1 },
	f() {},
	arrow: () => 1,
	s: 'str',
	n: null,
	u: undefined,
	arr: [1],
};
const frozen = Object.freeze({ x: 1 });
let k = 'nope';
let fk = 'arrow';
let x = 'x';
let nul = null;
let und;
const g = () => 'nope';

const cases = {
	// identifier reads the proxy routes (location, top, eval)
	'location()': () => location(),
	'top()': () => top(),
	'location.foo()': () => location.foo(),
	'top.foo()': () => top.foo(),
	'eval.foo()': () => eval.foo(),
	'location.href.foo()': () => location.href.foo(),
	'top.nope.x': () => top.nope.x,
	'top.nope.x()': () => top.nope.x(),
	'top.nope()': () => top.nope(),
	'top.nope.x = 1': () => {
		top.nope.x = 1;
	},
	'new location()': () => new location(),
	'new top()': () => new top(),
	'new location.toString()': () => new location.toString(),
	'new location.nope()': () => new location.nope(),
	'[...location]': () => [...location],
	'for (x of top)': () => {
		for (const x of top) void x;
	},
	'const [a] = location': () => {
		const [a] = location;
		return a;
	},
	'const { a } = top.nope': () => {
		const { a } = top.nope;
		return a;
	},
	'top.nope`x`': () => top.nope`x`,
	'typeof top.nope.x': () => typeof top.nope.x,
	'typeof location()': () => typeof location(),
	'`${top.nope.x}`': () => `${top.nope.x}`,
	"'use strict'; top = 1": () => {
		'use strict';
		// eslint-disable-next-line no-global-assign
		top = 1;
	},
	"eval('a b')": () => eval('a b'),
	"eval('nopeIdentifier')": () => eval('nopeIdentifier'),
	"(0, eval)('a b')": () => (0, eval)('a b'),
	"eval('location.foo()')": () => eval('location.foo()'),
	"new Function('location.foo()')()": () => new Function('location.foo()')(),
	"new Function('o', 'o[k]()')(o)": () =>
		new Function('o', 'k', 'o[k]()')(o, k),
	// computed reads (get2), unforgeable member names, index reads
	'nul[k]': () => nul[k],
	'und[k]': () => und[k],
	'o[k].x': () => o[k].x,
	'o[k].x()': () => o[k].x(),
	'o[k][k]': () => o[k][k],
	'o.a[k].x()': () => o.a[k].x(),
	'o[fk].x()': () => o[fk].x(),
	'o.location.foo()': () => o.location.foo(),
	'o.a.top.x': () => o.a.top.x,
	'o.arr[0].foo()': () => o.arr[0].foo(),
	'o.arr[5].x': () => o.arr[5].x,
	'o?.[k].x.y': () => o?.[k].x.y,
	'[...o[k]]': () => [...o[k]],
	'const { a } = o[k]': () => {
		const { a } = o[k];
		return a;
	},
	// computed calls (call2)
	'o[k]()': () => o[k](),
	'nul[k]()': () => nul[k](),
	'und[k]()': () => und[k](),
	'o[k](1, 2)': () => o[k](1, 2),
	'o.s[k]()': () => o.s[k](),
	'o.a[k]()': () => o.a[k](),
	'o[k]()()': () => o[k]()(),
	'o[fk]()()': () => o[fk]()(),
	"o['top']()": () => o['top'](),
	"o[k + 'x']()": () => o[k + 'x'](),
	'o[o.s]()': () => o[o.s](),
	'o[g()]()': () => o[g()](),
	"o[k]('a', o.f())": () => o[k]('a', o.f()),
	'o[k]`x`': () => o[k]`x`,
	// constructions (new2)
	'new o[k]()': () => new o[k](),
	'new o[fk]()': () => new o[fk](),
	'new nul[k]()': () => new nul[k](),
	'new o.a[k](1)': () => new o.a[k](1),
	// `in` (has)
	'k in 1': () => k in 1,
	'k in nul': () => k in nul,
	"k in 'str'": () => k in 'str',
	'o in 1': () => o in 1,
	'Symbol.iterator in 1': () => Symbol.iterator in 1,
	'k in und': () => k in und,
	// optional chains (method, lazy, call2 with the optional flag)
	'o?.[k](g())': () => o?.[k](g()),
	'o?.a[k](g())': () => o?.a[k](g()),
	'o?.[k]()': () => o?.[k](),
	'o?.a[k]()': () => o?.a[k](),
	'o?.a[g()].x': () => o?.a[g()].x,
	'o?.a[g()]()': () => o?.a[g()](),
	// postMessage (post)
	'nul.postMessage(1)': () => nul.postMessage(1),
	'o.postMessage(1)': () => o.postMessage(1),
	'o.s.postMessage(1)': () => o.s.postMessage(1),
	'o.postMessage.call(o, 1)': () => o.postMessage.call(o, 1),
	// patterns that name an unforgeable (pattern)
	'const { top: t } = nul': () => {
		const { top: t } = nul;
		return t;
	},
	'const { top: t } = und': () => {
		const { top: t } = und;
		return t;
	},
	'const { u: { top } } = o': () => {
		const {
			u: { top },
		} = o;
		return top;
	},
	'({ location: l } = nul)': () => {
		let l;
		({ location: l } = nul);
		return l;
	},
	// writes (set2, ref2)
	'nul[k] = 1': () => {
		nul[k] = 1;
	},
	'und[k] += 1': () => {
		und[k] += 1;
	},
	'nul[k]++': () => {
		nul[k]++;
	},
	"'use strict'; frozen[x] = 1": () => {
		'use strict';
		frozen[x] = 1;
	},
	'nul.location = 1': () => {
		nul.location = 1;
	},
	'[nul.location] = [1]': () => {
		[nul.location] = [1];
	},
	// more shapes: arguments that do work (the lazy forms), spreads, optional
	// links, patterns of parameters, iteration of calls
	'top.nope(o.f())': () => top.nope(o.f()),
	'top.document.nope(1)': () => top.document.nope(1),
	'o[k]?.x()': () => o[k]?.x(),
	'o?.[k]().x': () => o?.[k]().x,
	'nul[k]?.()': () => nul[k]?.(),
	'o[k](...[1], 2)': () => o[k](...[1], 2),
	'new o[k](...[1], 2)': () => new o[k](...[1], 2),
	'o[k](1, ...[2])': () => o[k](1, ...[2]),
	'Math.max(...location)': () => Math.max(...location),
	'Math.max(...o[k])': () => Math.max(...o[k]),
	'[...o[fk]()]': () => [...o[fk]()],
	'for (x of o[fk]())': () => {
		for (const x of o[fk]()) void x;
	},
	'const [a] = o[k]': () => {
		const [a] = o[k];
		return a;
	},
	'const [a] = o[fk]()': () => {
		const [a] = o[fk]();
		return a;
	},
	'[a] = location': () => {
		let a;
		[a] = location;
		return a;
	},
	'[a] = o[k]': () => {
		let a;
		[a] = o[k];
		return a;
	},
	'const {} = o[k]': () => {
		// eslint-disable-next-line no-empty-pattern
		const {} = o[k];
	},
	"const { 'a b': a } = o[k]": () => {
		const { 'a b': a } = o[k];
		return a;
	},
	'function f({ top }) {}; f()': () => {
		function f({ top }) {
			return top;
		}
		return f();
	},
	'function f({ top }) {}; f(null)': () => {
		function f({ top }) {
			return top;
		}
		return f(null);
	},
	'x instanceof o[k]': () => o instanceof o[k],
	'class extends o[k]': () => class extends o[k] {},
	'(o.a, o[k])()': () => (o.a, o[k])(),
	'(o.n || o[k]).x()': () => (o.n || o[k]).x(),
	'o[k] ? 1 : top.nope()': () => (o[k] ? 1 : top.nope()),
	'top.nope?.()': () => top.nope?.(),
	'o?.u[k]': () => o?.u[k],
	'o?.u[k]()': () => o?.u[k](),
	'o[k]()?.x': () => o[k]()?.x,
};

const record = (error) => {
	const result = {
		message: error?.message,
		name: error?.name,
		// the constructor of this page's realm, by identity
		constructor:
			error?.constructor === TypeError
				? 'TypeError'
				: error?.constructor === SyntaxError
					? 'SyntaxError'
					: error?.constructor === ReferenceError
						? 'ReferenceError'
						: error?.constructor === Error
							? 'Error'
							: `other: ${error?.constructor?.name}`,
		string: String(error),
	};
	const stack = typeof error?.stack === 'string' ? error.stack : '';
	const lines = stack.split('\n');
	result.header = lines[0];
	// the first frame without its position: the positions are the
	// rewritten code's (a known gap)
	result.frame = (lines[1] ?? '').replace(/:\d+:\d+/g, '');
	return result;
};

const results = {};
for (const [name, run] of Object.entries(cases))
	try {
		const value = run();
		results[name] = { threw: false, value: String(value) };
	} catch (error) {
		results[name] = record(error);
	}

// an about:blank child's code (made by the child's Function, which the
// proxy rewrites with the creator's client): its errors are the child's
const frame = document.createElement('iframe');
document.body.append(frame);
const child = frame.contentWindow;
for (const [name, body] of [
	['child: o[k]()', 'return o[k]()'],
	['child: new o[k]()', 'return new o[k]()'],
	['child: nul[k]', 'return nul[k]'],
	['child: o[k].x()', 'return o[k].x()'],
	['child: [...o[k]]', 'return [...o[k]]'],
])
	try {
		child.Function('o', 'k', 'nul', body)(o, k, nul);
		results[name] = { threw: false };
	} catch (error) {
		results[name] = {
			message: error.message,
			realm:
				error instanceof child.TypeError
					? 'child'
					: error instanceof TypeError
						? 'parent'
						: 'other',
		};
	}

// uncaught: what the window's error event reads
const uncaught = {
	'uncaught location.foo()': () => location.foo(),
	'uncaught o[k]()': () => o[k](),
	'uncaught new o[k]()': () => new o[k](),
	'uncaught o[k].x()': () => o[k].x(),
};
const names = Object.keys(uncaught);
let next = 0;
// a dedicated worker's cases (its own bundle and realm)
const worker = new Promise((resolve) => {
	const w = new Worker('/pages/error-messages-worker.js');
	w.onmessage = (event) => resolve(event.data);
	w.onerror = () => resolve({ 'worker: loads': { threw: true } });
});
addEventListener('error', async (event) => {
	const name = names[next - 1];
	results[name] = {
		message: event.message,
		error: event.error?.message,
		filename: event.filename.replace(/^.*\//, ''),
	};
	event.preventDefault();
	if (next === names.length) {
		Object.assign(results, await worker);
		window.__errorMessages = { results, done: true };
	}
});
for (const name of names)
	setTimeout(() => {
		next++;
		uncaught[name]();
	});
