// Shared by rewriter-unit and the adversarial-fuzz suite (whose page,
// adv-fuzz.html, imports this file): scripts that put a
// payload reading `top` and `location` into every expression slot of every
// node kind the parser produces, one slot at a time and one template inside
// another. The rewriter replaces nodes with calls of the access API; a
// replacement that prints a child as the page wrote it runs that child
// unrewritten, where `top` is the real top-level window. A payload that
// comes out unrewritten is that hole, whatever node it stands in.
//
// A template is page code with `@` where the payload goes. `E` are
// expressions (they nest in any slot), `S` statements (run in a function),
// `TOP` statements that mean something else outside any function, `MODULE`
// module code (checked on the rewriter's output only: eval cannot run it).
// Options:
//   v     what the slot's value must be for the template to run natively
//         (VALUES below; default a number)
//   pass  the template's value is the slot's: it may stand in a slot that
//         needs a particular value
//   lazy  the slot is not evaluated natively (a short-circuit)
//   wait  the template's value is a promise the runner waits for
//   own   `location` in the slot is the template's own binding, not the
//         window's: only what the payload saw as `top` counts
//
// This file is a library, and a module the fixture page loads.

/** what a payload returns, by the kind of value its slot needs */
export const VALUES = {
	any: '1',
	fn: '__fzI',
	ctor: '__fzC',
	iter: '[1]',
	obj: '__fzO',
	key: "'k'",
	src: "'data:text/javascript,'",
	hash: "'#fz'",
	hashes: "['#fz']",
	eval: 'eval',
	str: "'1'",
	arr: '[]',
	win: 'window',
	post: '__fzP',
	table: '__fzQ',
};
/** a value of one of these kinds does harm when it is another (a navigation, a lost eval) */
const EXACT = new Set(['hash', 'hashes', 'eval', 'src', 'win']);

const e = (code, options = {}) => ({ code, kind: 'E', ...options });
const s = (code, options = {}) => ({ code, kind: 'S', ...options });
const t = (code, options = {}) => ({ code, kind: 'TOP', ...options });
const m = (code, options = {}) => ({ code, kind: 'MODULE', ...options });

export const TEMPLATES = [
	// array and object literals
	e('[@]'),
	e('[, @][1]', { pass: true }),
	e('[...@]', { v: 'iter' }),
	e('({ a: @ }).a', { pass: true }),
	e('({ [@]: 1 })', { v: 'key' }),
	e('({ [@]() {} })', { v: 'key' }),
	e('({ get [@]() { return 1; } })', { v: 'key' }),
	e('({ set [@](v) {} })', { v: 'key' }),
	e('({ async *[@]() {} })', { v: 'key' }),
	e('({ ...@ })', { v: 'obj' }),
	e('({ __proto__: @ })', { v: 'obj' }),
	e('({ m() { return @; } }).m()', { pass: true }),
	e('({ get a() { return @; } }).a', { pass: true }),
	e('({ set a(v) { @; } }).a = 1'),
	e('({ m(a = @) { return a; } }).m()', { pass: true }),
	// functions: bodies, defaults, parameter patterns
	e('(function () { return @; })()', { pass: true }),
	e('(function (a = @) { return a; })()', { pass: true }),
	e('(function ({ a = @ }) { return a; })({})', { pass: true }),
	e('(function ([a = @]) { return a; })([])', { pass: true }),
	e('(function ({ [@]: a }) {})({})', { v: 'key' }),
	e('(function (...[a = @]) { return a; })()', { pass: true }),
	e('(function ({ top: t = @ }) { return t; })({})', { pass: true }),
	e('(function ({ location: l = @ }) { return l; })({})', { pass: true }),
	e('(function ({ top: t }, u = @) { return u; })({})', { pass: true }),
	e('(function ({ top: t }, u = (t, @)) { return u; })({})', { pass: true }),
	e('(function ({ a: { b = @ } }) { return b; })({ a: {} })', { pass: true }),
	e('(function ({ top: t, [@]: z }) {})({})', { v: 'key' }),
	e('(function ([{ top: t = @ }]) { return t; })([{}])', { pass: true }),
	e('(function (...[{ top: t = @ }]) { return t; })({})', { pass: true }),
	e('(() => @)()', { pass: true }),
	e('((a = @) => a)()', { pass: true }),
	e('(({ a = @ }) => a)({})', { pass: true }),
	e('(({ [@]: a }) => a)({})', { v: 'key' }),
	e('(({ top: t = @ }) => t)({})', { pass: true }),
	e('(({ top: t }, u = (t, @)) => u)({})', { pass: true }),
	e('(function* () { yield @; })().next().value', { pass: true }),
	e('(function* () { yield* @; })().next()', { v: 'iter' }),
	e('(function* (a = @) {})()'),
	e('new (function () { this.a = @; })().a', { pass: true }),
	e('(async () => @)()', { wait: true }),
	e('(async () => await @)()', { wait: true }),
	e('(async (a = @) => a)()', { wait: true }),
	e('(async ({ top: t = @ }) => t)({})', { wait: true }),
	e('(async function () { for await (const x of @); })()', {
		v: 'iter',
		wait: true,
	}),
	e('(async function () { for await (const { top: t = @ } of [{}]); })()', {
		wait: true,
	}),
	e('(async function* () { yield @; })().next()', { wait: true }),
	e('(async () => { await 0; return @; })()', { wait: true }),
	// classes
	e('(class extends @ {})', { v: 'ctor' }),
	e('new (class { a = @; })().a', { pass: true }),
	e('(class { static a = @; }).a', { pass: true }),
	e('(class { [@]() {} })', { v: 'key' }),
	e('(class { static [@]() {} })', { v: 'key' }),
	e('(class { [@] = 1; })', { v: 'key' }),
	e('(class { static [@] = 1; })', { v: 'key' }),
	e('(class { get [@]() { return 1; } })', { v: 'key' }),
	e('(class { static { @; } })'),
	e('new (class { #a = @; g() { return this.#a; } })().g()', { pass: true }),
	e('new (class { constructor(a = @) { this.a = a; } })().a', {
		pass: true,
	}),
	e('new (class { m(a = @) { return a; } })().m()', { pass: true }),
	e('(class { static m() { return @; } }).m()', { pass: true }),
	e('(class { static #p = 1; static t(o) { return #p in o; } }).t(@)', {
		v: 'obj',
	}),
	e('new (class extends __fzC { constructor() { super(@); } })()'),
	e('new (class extends __fzB { m() { return super.m(@); } })().m()', {
		pass: true,
	}),
	e('new (class extends __fzB { m() { return super[@]; } })().m()', {
		v: 'key',
	}),
	e('new (class extends __fzB { m() { super[@] = 1; } })().m()', {
		v: 'key',
	}),
	e('new (class extends __fzB { m() { super.x = @; } })().m()'),
	e('new (class extends __fzB { m() { return super.postMessage(@); } })().m()'),
	e(
		'new (class extends __fzB { m() { return super.postMessage.call(this, @); } })().m()',
	),
	// operators
	e('-@'),
	e('+@'),
	e('!@'),
	e('~@'),
	e('typeof @'),
	e('void @'),
	// (a member is deleted, not read)
	e('delete @', { lazy: true }),
	e('delete @.a', { v: 'obj' }),
	e('delete __fzO[@]', { v: 'key' }),
	e('@ + 1'),
	e('1 + @'),
	e('@ == 1'),
	e('@ in __fzO', { v: 'key' }),
	e("'a' in @", { v: 'obj' }),
	e('__fzK in @', { v: 'obj' }),
	e('@ in window', { v: 'key' }),
	e('@ instanceof __fzC'),
	e('__fzO instanceof @', { v: 'ctor' }),
	e('@ && 1'),
	e('1 && @', { pass: true }),
	e('0 || @', { pass: true }),
	e('null ?? @', { pass: true }),
	e('1 || @', { lazy: true }),
	e('0 && @', { lazy: true }),
	e('1 ?? @', { lazy: true }),
	e('@ ? 1 : 2'),
	e('1 ? @ : 2', { pass: true }),
	e('0 ? 1 : @', { pass: true }),
	e('0 ? @ : 1', { lazy: true }),
	e('(@, 1)'),
	e('(1, @)', { pass: true }),
	e('(@)', { pass: true }),
	e('__fzO[@]++', { v: 'key' }),
	e('++__fzO[@]', { v: 'key' }),
	e('@.a++', { v: 'obj' }),
	e('--@.a', { v: 'obj' }),
	// assignments
	e('__fzO.a = @', { pass: true }),
	e('__fzO[@] = 1', { v: 'key' }),
	e("__fzO['a'] = @", { pass: true }),
	e('__fzO[__fzK] = @', { pass: true }),
	e('@.a = 1', { v: 'obj' }),
	e('@[__fzK] = 1', { v: 'obj' }),
	e('__fzO.a += @'),
	e('__fzO[__fzK] += @'),
	e('({}).z ||= @', { pass: true }),
	e('({}).z ??= @', { pass: true }),
	e('({ z: 1 }).z &&= @', { pass: true }),
	e('({ z: 1 }).z ||= @', { lazy: true }),
	e('({ z: 1 }).z ??= @', { lazy: true }),
	e('({}).z &&= @', { lazy: true }),
	e('({})[__fzK] ||= @', { pass: true }),
	e('({ k: 1 })[__fzK] ||= @', { lazy: true }),
	e('({ k: 1 })[__fzK] ??= @', { lazy: true }),
	e('({})[__fzK] &&= @', { lazy: true }),
	e('(function () { var x; x = @; return x; })()', { pass: true }),
	e('(function () { var x = 1; x += @; return x; })()'),
	e('(function () { let x; x ??= @; return x; })()', { pass: true }),
	// assignments the rewriter routes
	e('location = @', { v: 'hash' }),
	e('location += @', { v: 'hash' }),
	e('location &&= @', { v: 'hash' }),
	e('location ||= @', { v: 'hash', lazy: true }),
	e('location ??= @', { v: 'hash', lazy: true }),
	e('top = @'),
	e('top ||= @', { lazy: true }),
	e('top &&= @'),
	e('eval = @', { v: 'eval' }),
	e('eval ??= @', { v: 'eval', lazy: true }),
	e('window.location = @', { v: 'hash' }),
	e("window['location'] = @", { v: 'hash' }),
	e('window[__fzL] = @', { v: 'hash' }),
	e('self.location = @', { v: 'hash' }),
	e('document.location = @', { v: 'hash' }),
	e('location.href = @', { v: 'hash' }),
	e('location.hash = @', { v: 'hash' }),
	e('top.location = @', { v: 'hash' }),
	e('top.location.hash = @', { v: 'hash' }),
	e('parent.location = @', { v: 'hash' }),
	e('window.top = @'),
	e('window.eval = @', { v: 'eval' }),
	e("@.location = '#fz'", { v: 'win' }),
	e("@[__fzL] = '#fz'", { v: 'win' }),
	e("@.location.hash = '#fz'", { v: 'win' }),
	// destructuring assignments
	e('[__fzO.a = @] = []'),
	e('({ a: __fzO.a = @ } = {})'),
	e('({ [@]: __fzO.a } = {})', { v: 'key' }),
	e('[__fzO[@]] = [1]', { v: 'key' }),
	e('[@.a] = [1]', { v: 'obj' }),
	e('({ a: __fzO[@] } = {})', { v: 'key' }),
	e('[...__fzO[@]] = []', { v: 'key' }),
	e('({ ...__fzO[@] } = {})', { v: 'key' }),
	e('[location = @] = []', { v: 'hash' }),
	e('({ location = @ } = {})', { v: 'hash' }),
	e('({ a: location = @ } = {})', { v: 'hash' }),
	e('[window.location = @] = []', { v: 'hash' }),
	e('[window[__fzL] = @] = []', { v: 'hash' }),
	e('[top = @] = []'),
	e("[@.location] = ['#fz']", { v: 'win' }),
	e("[@[__fzL]] = ['#fz']", { v: 'win' }),
	e('[window[@]] = [1]', { v: 'key' }),
	e('({ top: __fzO.a = @ } = {})'),
	e('[{ a: __fzO.a = @ }] = [{}]'),
	e('[{ top: __fzO.a = @ }] = [{}]'),
	e('({ a: [__fzO.a = @] } = { a: [] })'),
	e('({ a: { top: __fzO.a = @ } } = { a: {} })'),
	// calls
	e('@()', { v: 'fn' }),
	e('__fzI(@)', { pass: true }),
	e('__fzI(...@)', { v: 'iter' }),
	e('__fzI?.(@)', { pass: true }),
	e('@?.()', { v: 'fn' }),
	e('@?.a', { v: 'obj' }),
	e('@?.[__fzK]', { v: 'obj' }),
	e('__fzO?.[@]', { v: 'key' }),
	e('null?.[@]', { lazy: true }),
	e('null?.a(@)', { lazy: true }),
	e('null?.[__fzK](@)', { lazy: true }),
	e('__fzO.a?.b(@)', { lazy: true }),
	e('__fzO.a?.[__fzK](@)', { lazy: true }),
	e('__fzO.m?.(@)', { lazy: true }),
	e('__fzO[__fzK]?.(@)', { lazy: true }),
	e('@.toString()', { v: 'obj' }),
	e('__fzN.m(@)', { pass: true }),
	e("__fzN['m'](@)", { pass: true }),
	e('__fzN[__fzM](@)', { pass: true }),
	e('__fzN?.[__fzM](@)', { pass: true }),
	e('__fzN[__fzM]?.(@)', { pass: true }),
	e('__fzN?.m(@)', { pass: true }),
	e('__fzN.m(@).a'),
	e('__fzN[__fzM](@)[__fzK]'),
	e('location.toString(@)'),
	e('top.__fzI(@)', { pass: true }),
	e('window.top.__fzI(@)', { pass: true }),
	e("top['__fzI'](@)", { pass: true }),
	e('location[@]', { v: 'key' }),
	e('top[@]', { v: 'key' }),
	e('window[@]', { v: 'key' }),
	e('@.top', { v: 'win' }),
	e('@.location', { v: 'win' }),
	e('@[__fzL]', { v: 'win' }),
	e("@.eval('1')", { v: 'win' }),
	e('location.assign(@)', { v: 'hash' }),
	e('location.replace(@)', { v: 'hash' }),
	e('top.location.replace(@)', { v: 'hash' }),
	e('eval(@)', { v: 'str' }),
	e("eval('1', @)"),
	e('eval?.(@)', { v: 'str' }),
	e('(0, eval)(@)', { v: 'str' }),
	e('window.eval(@)', { v: 'str' }),
	e("@('1')", { v: 'eval' }),
	e('(function (eval) { return eval(@); })(__fzI)', { pass: true }),
	// calls that post
	e('__fzP.postMessage(@)'),
	e('__fzP.postMessage(1, @)'),
	e("__fzP['postMessage'](@)"),
	e('@.postMessage(1)', { v: 'post' }),
	e('__fzP?.postMessage(@)'),
	e('null?.postMessage(@)', { lazy: true }),
	e('__fzP.postMessage.call(__fzP, @)'),
	e('__fzP.postMessage.call(@, 1)', { v: 'post' }),
	e('__fzP.postMessage.apply(__fzP, @)', { v: 'arr' }),
	e('__fzP.postMessage.apply(__fzP, [], @)'),
	e('Reflect.apply(__fzP.postMessage, __fzP, @)', { v: 'arr' }),
	e('Reflect.apply(__fzP.postMessage, @, [])', { v: 'post' }),
	e('Reflect.apply(__fzP.postMessage, __fzP, [], @)'),
	e('@.postMessage.call(__fzP, 1)', { v: 'post' }),
	e('@.postMessage.apply(__fzP, [])', { v: 'post' }),
	e('Reflect.apply(@.postMessage, __fzP, [])', { v: 'post' }),
	// constructions
	e('new (@)', { v: 'ctor' }),
	e('new (@)()', { v: 'ctor' }),
	e('new __fzC(@)'),
	e('new __fzC(...@)', { v: 'iter' }),
	e('new __fzQ[@]()', { v: 'key' }),
	e('new (@.k)()', { v: 'table' }),
	e('new (@).k()', { v: 'table' }),
	e('new __fzQ.k(@)'),
	e('new __fzQ[__fzK](@)'),
	e('new top.Object(@)'),
	e('new top.Object(...@)', { v: 'iter' }),
	// templates
	e('`${@}`'),
	e('@`x`', { v: 'fn' }),
	e('__fzI`${@}`'),
	e('__fzN.m`${@}`'),
	e('__fzN[__fzM]`${@}`'),
	e('top.__fzI`${@}`'),
	// members
	e('@.a', { v: 'obj' }),
	e('__fzO[@]', { v: 'key' }),
	e('@[0]', { v: 'obj' }),
	e('@[__fzK]', { v: 'obj' }),
	e('__fzO.a?.[@]', { lazy: true }),
	// dynamic import
	e('import(@)', { v: 'src', wait: true }),
	e('import(@, {})', { v: 'src', wait: true }),
	e("import('data:text/javascript,', @)", { v: 'obj', wait: true }),

	// statements
	s('@;'),
	s('{ @; }'),
	s('if (@) ;'),
	s('if (0) ; else @;'),
	s('for (var i = @; i < 0; ) ;'),
	s('for (let i = 0, j = @; i < 0; ) ;'),
	s('for (; @; ) break;'),
	s('for (var i = 0; i < 1; i++, @) ;'),
	s('for (@; false; ) ;'),
	s('for (const x in @) ;', { v: 'obj' }),
	s('for (const x of @) ;', { v: 'iter' }),
	s('for (var x of @) ;', { v: 'iter' }),
	s('for (__fzO.a of @) ;', { v: 'iter' }),
	s('for (__fzO[@] of [1]) ;', { v: 'key' }),
	s('for (__fzO[@] in { a: 1 }) ;', { v: 'key' }),
	s('for (@.a of [1]) ;', { v: 'obj' }),
	s('for (const { a = @ } of [{}]) ;'),
	s('for (const [a = @] of [[]]) ;'),
	s('for (const { [@]: a } of [{}]) ;', { v: 'key' }),
	s('for ({ a: __fzO.a = @ } of [{}]) ;'),
	s('for (const { top: t = @ } of [{}]) ;'),
	s('for (var { top: t = @ } of [{}]) ;'),
	s('for ({ top: __fzO.a = @ } of [{}]) ;'),
	s('for (const [{ top: t = @ }] of [[{}]]) ;'),
	s('for (var { a = @ } in { b: 1 }) ;'),
	s('for (const x of [1]) @;'),
	s('for (const x in { a: 1 }) { @; }'),
	s('for (const { top: t } of [{}]) { @; }'),
	s('for (location of @) ;', { v: 'hashes' }),
	s('while (@) break;'),
	s('do ; while ((@, false));'),
	s('let i = 0; while (i++ < 1) @;'),
	s('do @; while (0);'),
	s('switch (@) { case 1: }'),
	s('switch (1) { case @: }'),
	s('switch (1) { default: @; }'),
	s('try { throw @; } catch (error) {}'),
	s('try { throw 1; } catch (error) { @; }'),
	s('try { } finally { @; }'),
	s('try { throw {}; } catch ({ a = @ }) {}'),
	s('try { throw {}; } catch ({ [@]: a }) {}', { v: 'key' }),
	s('try { throw {}; } catch ({ top: t = @ }) {}'),
	s('try { throw [{}]; } catch ([{ top: t = @ }]) {}'),
	s('try { throw {}; } catch ({ top: t }) { @; }'),
	s('with (@) ;', { v: 'obj' }),
	s('with ({}) { @; }'),
	s('with ({ a: 1 }) a = @;'),
	s('l: @;'),
	s('l: { @; break l; }'),
	s('return @;'),
	s('var a = @;'),
	s('let a = @;'),
	s('const a = @;'),
	s('var a = 1, b = @;'),
	s('const { a = @ } = {};'),
	s('const { [@]: a } = {};', { v: 'key' }),
	s('const [a = @] = [];'),
	s('const { a: { b = @ } } = { a: {} };'),
	s('const { a: [b = @] } = { a: [] };'),
	s('const [{ a = @ }] = [{}];'),
	s('const { top: t = @ } = {};'),
	s('const { location: l = @ } = {};'),
	s('const { top: t, [@]: z } = {};', { v: 'key' }),
	s('const [{ top: t = @ }] = [{}];'),
	s('const { a: [{ top: t = @ }] } = { a: [{}] };'),
	s('const [a = @] = [[]][0];'),
	s('const { a = @ } = [{}][0];'),
	s('var { a = @ } = {};'),
	s('const [...[a = @]] = [];'),
	s('const { a, ...r } = @;', { v: 'obj' }),
	s('const { top: t } = @;', { v: 'obj' }),
	s('const [{ top: t }] = @;', { v: 'iter' }),
	s('var location = @;', { own: true }),
	s('function f(a = @) {} f();'),
	s('function f({ a = @ }) {} f({});'),
	s('function f({ top: t = @ }) {} f({});'),
	s('async function f(a = @) {} f();'),
	s('function* g(a = @) {} g();'),
	s('class A { a = @; } new A();'),
	s('class A { static a = @; }'),
	s('class A { [@]() {} }', { v: 'key' }),
	s('class A extends @ {}', { v: 'ctor' }),
	s('class A { static { @; } }'),
	s('if (1) function f(a = @) {} f();'),
	s('label: for (;;) { @; break label; }'),
	s('debugger; @;'),

	// statements outside any function
	t('@;'),
	t('var __fzV = @;'),
	t('var location = @;', { v: 'hash' }),
	t('var { location } = { location: @ };', { v: 'hash' }),
	t('var [location = @] = [];', { v: 'hash' }),
	t('{ var location = @; }', { v: 'hash' }),
	t('if (1) var location = @;', { v: 'hash' }),
	t('for (var location = @; false; ) ;', { v: 'hash' }),
	t('for (var location of @) ;', { v: 'hashes' }),
	t('var top = @;'),
	t('function __fzD(a = @) {} __fzD();'),
	t('{ class A { static a = @; } }'),
	t('{ const { top: t = @ } = {}; }'),

	// module code: the rewriter's output only
	m('export default @;'),
	m('export const a = @;'),
	m('export const { a = @ } = {};'),
	m('export const { top: t = @ } = {};'),
	m('export default class extends @ {}', { v: 'ctor' }),
	m('export default function (a = @) {}'),
	m('export function f({ top: t = @ }) {}'),
	m('await @;'),
	m('for await (const x of @) ;', { v: 'iter' }),
	m('import.meta.a = @;'),
	m('var location = @;'),
];

/**
 * The payloads: each reads `top` and `location` in code of its own (a
 * function, an arrow with no `this`, a getter, a tagged template's
 * expressions) and hands them to `__fz`, then gives the slot its value.
 * The last two are the bare names, for the check on the rewriter's output.
 */
export const SHAPES = [
	(value) => `(function () { __fz(top, location); return ${value}; })()`,
	(value) => `(() => (__fz(top, location), ${value}))()`,
	(value) => `({ get g() { __fz(top, location); return ${value}; } }).g`,
	(value) => `__fzT\`\${top}\${location}\${${value}}\``,
];
export const BARE = ['top', 'location'];

/** the globals the templates and payloads use: page code, run before any case */
export const HARNESS = `
window.__fzSeen = null;
window.__fz = (t, l) => {
	window.__fzSeen = {
		top: t === window ? 'self' : 'OTHER-WINDOW',
		location: l === window.location ? 'self' : 'OTHER-LOCATION',
	};
};
window.__fzT = (strings, t, l, value) => (window.__fz(t, l), value);
window.__fzI = (value) => value;
window.__fzC = class {};
window.__fzB = class {
	m(value) {
		return value;
	}
	postMessage() {}
};
window.__fzK = 'k';
window.__fzL = 'location';
window.__fzM = 'm';
window.__fzReset = () => {
	window.__fzSeen = null;
	window.__fzO = {};
	window.__fzN = { m: (value) => value };
	window.__fzP = { postMessage() {} };
	window.__fzQ = { k: class {} };
};
`;

/** mulberry32: the same cases for the same seed */
export function random(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let n = a;
		n = Math.imul(n ^ (n >>> 15), n | 1);
		n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
		return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
	};
}

const fill = (template, text) => template.code.replace('@', () => text);

/** the script a template makes with `text` in its slot */
function script(template, text) {
	const code = fill(template, text);
	switch (template.kind) {
		case 'E':
			return `(function () { return (${code}); })()`;
		case 'S':
			return `(function () { ${code} })()`;
		default:
			return code;
	}
}

/**
 * One case: `outer`'s slot holds the payload, or `inner` (an expression
 * template) holding it. Null when the pair cannot be run: the outer slot
 * needs a value the inner one does not pass through.
 */
export function makeCase(outer, inner, payload) {
	if (inner && inner.kind !== 'E') return null;
	if (inner && inner.wait) return null;
	const needs = outer.v ?? 'any';
	if (inner && EXACT.has(needs) && !inner.pass) return null;
	const kind = inner ? (inner.pass ? needs : (inner.v ?? 'any')) : needs;
	if (inner && inner.pass && inner.v && inner.v !== needs) return null;
	const value = VALUES[kind];
	const text = typeof payload === 'function' ? payload(value) : payload;
	return {
		code: script(outer, inner ? `(${fill(inner, text)})` : text),
		name: inner ? `${outer.code}  <-  ${inner.code}` : outer.code,
		kind: outer.kind,
		lazy: !!(outer.lazy || inner?.lazy),
		wait: !!outer.wait,
		own: !!outer.own,
	};
}

/** every template with the payload in its own slot, the shape chosen by `pick` */
export function single(pick) {
	return TEMPLATES.map((template) => makeCase(template, null, pick())).filter(
		Boolean,
	);
}

/** `count` pairs of templates chosen by `next`, a payload in the inner one */
export function pairs(count, next, pick) {
	const inner = TEMPLATES.filter((template) => template.kind === 'E');
	const cases = [];
	for (let guard = 0; cases.length < count && guard < count * 20; guard++) {
		const made = makeCase(
			TEMPLATES[Math.floor(next() * TEMPLATES.length)],
			inner[Math.floor(next() * inner.length)],
			pick(),
		);
		if (made) cases.push(made);
	}
	return cases;
}

/** every pair of templates (the check on the rewriter's output can afford them all) */
export function allPairs(payload) {
	const inner = TEMPLATES.filter((template) => template.kind === 'E');
	const cases = [];
	for (const outer of TEMPLATES)
		for (const template of inner) {
			const made = makeCase(outer, template, payload);
			if (made) cases.push(made);
		}
	return cases;
}

const isNode = (value) =>
	value !== null && typeof value === 'object' && typeof value.type === 'string';

/** the child nodes of `node`, with the key each stands under */
function children(node, visit) {
	for (const key in node) {
		if (key === 'range' || key === 'loc') continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) visit(item, key);
		} else if (isNode(value)) visit(value, key);
	}
}

const helper = (node, access, name) =>
	node?.type === 'CallExpression' &&
	node.callee.type === 'MemberExpression' &&
	!node.callee.computed &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === access &&
	node.callee.property.name === name;

/**
 * What is wrong with the rewriter's output for a case, read off its syntax
 * tree: a `top` or `location` that is a value and not the access API's to
 * resolve, or no payload left at all. `tree` is the output parsed; `access`
 * the access API's name.
 */
export function unrewritten(tree, access = '$s$j') {
	const problems = [];
	let payloads = 0;
	const walk = (node, parent, key, grand) => {
		if (
			(node.type === 'CallExpression' &&
				node.callee.type === 'Identifier' &&
				node.callee.name === '__fz') ||
			(node.type === 'TaggedTemplateExpression' &&
				node.tag.type === 'Identifier' &&
				node.tag.name === '__fzT')
		)
			payloads++;
		if (
			node.type === 'Identifier' &&
			(node.name === 'top' || node.name === 'location') &&
			!named(node, parent, key, grand, access)
		)
			problems.push(
				`${node.name} is read as written (under ${parent?.type}.${key})`,
			);
		children(node, (child, under) => walk(child, node, under, parent));
	};
	walk(tree, null, '', null);
	return { problems, payloads };
}

/** whether an identifier is a name, a binding or the access API's argument, not a read of the window's */
function named(node, parent, key, grand, access) {
	switch (parent?.type) {
		case 'MemberExpression':
			return key === 'property' && !parent.computed;
		case 'Property':
			// a pattern's value binds; a literal's is read
			return (
				(key === 'key' && !parent.computed && !parent.shorthand) ||
				(key === 'value' && grand?.type === 'ObjectPattern')
			);
		case 'MethodDefinition':
		case 'PropertyDefinition':
			return key === 'key' && !parent.computed;
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
			return true;
		case 'VariableDeclarator':
			return key === 'id';
		case 'FunctionDeclaration':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return key === 'id' || key === 'params';
		case 'ClassDeclaration':
		case 'ClassExpression':
			return key === 'id';
		case 'ArrayPattern':
		case 'RestElement':
		case 'CatchClause':
			return true;
		case 'AssignmentPattern':
			return key === 'left';
		case 'UnaryExpression':
			// (`delete top` stays as written under both rewriters: strict
			// code refuses it, as natively, and sloppy code answers false)
			return parent.operator === 'typeof' || parent.operator === 'delete';
		case 'CallExpression':
			// $s$j.get(top, 'top'), $s$j.set1(location, ...), $s$j.ref1(location, ...)
			return (
				key === 'arguments' &&
				parent.arguments[0] === node &&
				(helper(parent, access, 'get') ||
					helper(parent, access, 'set1') ||
					helper(parent, access, 'ref1'))
			);
		case 'AssignmentExpression':
			// the arrow the rewriter hands set1 and ref1 to write the name with
			return (
				key === 'left' &&
				parent.right.type === 'Identifier' &&
				parent.right.name === 't$v' &&
				grand?.type === 'ArrowFunctionExpression'
			);
	}
	return false;
}

/**
 * The fields of the parser's node kinds that hold a node, read from its
 * type declarations: `{ 'CallExpression.callee': 'Expression | Super' }`.
 * A field no template reaches and no exemption names is a slot nobody
 * checked.
 */
export function nodeFields(declarations) {
	const interfaces = new Map();
	const pattern =
		/export interface (\w+)(?: extends ([\w, ]+))? \{([\s\S]*?)\n\}/g;
	for (const [, name, parents, body] of declarations.matchAll(pattern)) {
		const fields = new Map();
		let type = null;
		for (const [, field, value] of body.matchAll(/\n\s+(\w+)\??: ([^;]+);/g)) {
			if (field === 'type') {
				const literal = /^'(\w+)'$/.exec(value.trim());
				if (literal) type = literal[1];
			} else fields.set(field, value.trim().replace(/\s+/g, ' '));
		}
		interfaces.set(name, {
			type,
			fields,
			parents: parents ? parents.split(',').map((parent) => parent.trim()) : [],
		});
	}
	const all = (name, seen = new Set()) => {
		const found = new Map();
		const entry = interfaces.get(name);
		if (!entry || seen.has(name)) return found;
		seen.add(name);
		for (const parent of entry.parents)
			for (const [field, value] of all(parent, seen)) found.set(field, value);
		for (const [field, value] of entry.fields) found.set(field, value);
		return found;
	};
	const out = {};
	for (const [name, entry] of interfaces) {
		if (!entry.type) continue;
		for (const [field, value] of all(name)) {
			// a field that names a node type (a capitalised name that is no
			// built-in of the declarations)
			const names = value.match(/\b[A-Z]\w+/g) ?? [];
			if (
				!names.some(
					(word) =>
						!['RegExp', 'SourceLocation', 'Comment', 'Position'].includes(word),
				)
			)
				continue;
			out[`${entry.type}.${field}`] = value;
		}
	}
	return out;
}

/**
 * The fields of the parser's node kinds that hold a node and that no
 * template reaches, with the reason none needs to: nothing there is an
 * expression the page's code could be read from. A field of a node kind the
 * parser gains later is in neither list, and rewriter-unit fails until a
 * template reaches it or it is named here.
 */
export const EXEMPT = {
	// an operator, a label, a name: text, not an expression
	'AssignmentExpression.operator': 'operator',
	'BinaryExpression.operator': 'operator',
	'LogicalExpression.operator': 'operator',
	'UpdateExpression.operator': 'operator',
	'UnaryExpression.operator': 'operator',
	'BreakStatement.label': 'label',
	'ContinueStatement.label': 'label',
	'LabeledStatement.label': 'label',
	'MetaProperty.meta': 'name',
	'MetaProperty.property': 'name',
	'TemplateLiteral.quasis': 'text',
	// a binding: the pattern's own targets and defaults are reached through
	// AssignmentPattern.right and the patterns' element and value fields
	'AssignmentPattern.left': 'binding',
	'RestElement.value': 'not produced by the parser',
	// static imports and exports: specifiers are names, sources and
	// attributes string literals
	'ExportAllDeclaration.source': 'module syntax',
	'ExportAllDeclaration.exported': 'module syntax',
	'ExportAllDeclaration.attributes': 'module syntax',
	'ExportNamedDeclaration.specifiers': 'module syntax',
	'ExportNamedDeclaration.source': 'module syntax',
	'ExportNamedDeclaration.attributes': 'module syntax',
	'ExportSpecifier.local': 'module syntax',
	'ExportSpecifier.exported': 'module syntax',
	'ImportDeclaration.source': 'module syntax',
	'ImportDeclaration.specifiers': 'module syntax',
	'ImportDeclaration.attributes': 'module syntax',
	'ImportAttribute.key': 'module syntax',
	'ImportAttribute.value': 'module syntax',
	'ImportDefaultSpecifier.local': 'module syntax',
	'ImportNamespaceSpecifier.local': 'module syntax',
	'ImportSpecifier.local': 'module syntax',
	'ImportSpecifier.imported': 'module syntax',
	// syntax Chrome rejects (a script with it is a SyntaxError natively, and
	// the rewriter hands it back as it came or prints it without them)
	'AccessorProperty.key': 'accessor fields: not in Chrome',
	'AccessorProperty.value': 'accessor fields: not in Chrome',
	'AccessorProperty.decorators': 'decorators: not in Chrome',
	'PropertyDefinition.decorators': 'decorators: not in Chrome',
	'MethodDefinition.decorators': 'decorators: not in Chrome',
	'Decorator.expression': 'decorators: not in Chrome',
	// parser options the rewriter does not turn on
	'ParenthesizedExpression.expression': 'preserveParens is off',
	'JSXNamespacedName.namespace': 'jsx is off',
	'JSXNamespacedName.name': 'jsx is off',
	'JSXAttribute.name': 'jsx is off',
	'JSXAttribute.value': 'jsx is off',
	'JSXClosingElement.name': 'jsx is off',
	'JSXElement.openingElement': 'jsx is off',
	'JSXElement.closingElement': 'jsx is off',
	'JSXElement.children': 'jsx is off',
	'JSXExpressionContainer.expression': 'jsx is off',
	'JSXFragment.openingFragment': 'jsx is off',
	'JSXFragment.closingFragment': 'jsx is off',
	'JSXFragment.children': 'jsx is off',
	'JSXMemberExpression.object': 'jsx is off',
	'JSXMemberExpression.property': 'jsx is off',
	'JSXOpeningElement.name': 'jsx is off',
	'JSXOpeningElement.attributes': 'jsx is off',
	'JSXSpreadAttribute.argument': 'jsx is off',
	'JSXSpreadChild.expression': 'jsx is off',
};

/**
 * The `Type.field` steps the templates reach: each template parsed with a
 * marker in its slot, and the path from the template's own code down to it
 */
export function reached(parse) {
	const steps = new Set();
	for (const template of TEMPLATES) {
		const code = fill(template, '__fzSlot');
		const tree = parse(
			template.kind === 'E'
				? `(${code});`
				: template.kind === 'S'
					? `function w() { ${code} }`
					: code,
			{ module: template.kind === 'MODULE', next: true, webcompat: true },
		);
		// the wrapper a statement template is parsed in is not the template's
		const skip = template.kind === 'S' ? 3 : 0;
		let found = null;
		const walk = (node, path) => {
			if (found) return;
			if (node.type === 'Identifier' && node.name === '__fzSlot') {
				found = path;
				return;
			}
			children(node, (child, key) =>
				walk(child, [...path, `${node.type}.${key}`]),
			);
		};
		walk(tree, []);
		if (!found) throw new Error(`no slot in ${template.code}`);
		for (const step of found.slice(skip)) steps.add(step);
	}
	return steps;
}
