// The curated corpus of the differential oracle (harness.mjs): every
// construct the rewriter touches, in every syntactic position it can stand
// in. A case is a classic script (or a module, `type`) that runs in the
// world of world.js: `location`, `top`, `parent`, `opener`, `window`, `self`,
// `frames`, `document`, `postMessage`; `log(...)` records its arguments,
// `M(target, label)` makes an object that records what is done to it and
// `F(label, result)` a function that records its calls.
//
// The crossed families come from two lists: what is read or written (a
// guarded name, a member that may be one, a member that is none) and where
// it stands. The rest are written by hand, one construct a case.

/** what a case reads: guarded names and members, and plain ones beside them */
export const READS = [
	'location',
	'top',
	'eval',
	'parent.location',
	'parent.top',
	'window.location',
	'window.top',
	'self["location"]',
	'window[KL]',
	'parent[KT]',
	'document.location',
	'top.location',
	'top.top',
	'globalThis.top',
	'this.location',
	'window.eval',
	'opener.postMessage',
	'window["postMessage"]',
	'parent[KP]',
	'plain.location',
	'plain.top',
	'plain[KL]',
	'plain[KX]',
	'm[KX]',
	'm.top',
	'm[0]',
	'frames[0]',
	'm[sym]',
	'm[keyObject]',
	'"text"[1]',
	'[7, 8][i1]',
];

/** what the crossed cases start with: the names READS and WRITES use */
export const PRELUDE = `var KL = "location", KT = "top", KP = "postMessage", KX = "x", i1 = 1;
var sym = Symbol("s");
var plain = { location: "plain-location", top: "plain-top", x: "plain-x", eval: 5 };
var m = M({ x: { y: 1, f: F("m.x.f", 4) }, top: { y: 2 }, 0: "zero", [sym]: "symbol", key: "by-object" }, "m");
var keyObject = { toString: F("keyObject.toString", "key") };
var next = (tag) => (log("value " + tag), "https://page.example/next/" + tag);
`;

/** where a read stands: `@` is the read */
export const READ_POSITIONS = [
	'log(@)',
	'log(typeof @)',
	'log(@ === @)',
	'log(@.y)',
	'log(@[KX])',
	'log(@?.y)',
	'log(@?.[KX])',
	'log(@?.y?.z)',
	'log(@?.[KX]?.[KX])',
	'log((@).y)',
	'log(@ ?? "nullish")',
	'log(@ || "falsy")',
	'log(@ && "truthy")',
	'log(!@)',
	'log(void @)',
	'log(`${typeof @}`)',
	'log([@].length)',
	'log({ a: @ }.a === @)',
	'log({ [typeof @]: 1 })',
	'log([...[@]].length)',
	'log(((a) => typeof a)(@))',
	'log(((a = @) => typeof a)())',
	'log((function () { return typeof @; })())',
	'log((() => typeof @)())',
	'var a1 = @; log(typeof a1)',
	'let a2 = @; log(typeof a2)',
	'const { y: a3 } = @ ?? {}; log(a3)',
	'var [a4] = [@]; log(typeof a4)',
	'if (@) log("then"); else log("else")',
	'log(@ ? 1 : 2)',
	'switch (typeof @) { case "object": log("object"); break; default: log("other"); }',
	'for (var a5 = @; a5; a5 = null) log(typeof a5)',
	'try { throw @; } catch (e) { log(typeof e); }',
	'log(typeof (0, @))',
	'log(@ instanceof Object)',
	'log("y" in Object(@))',
	'class C1 { f = typeof @; static s = typeof @; } log(new C1().f, C1.s)',
	'class C2 { static { log(typeof @); } }',
	'log(((...a) => a.length)(...[@]))',
	'label: { log(typeof @); break label; }',
	'log(delete @)',
	'log(typeof @, typeof @)',
	'log((@, 1))',
	'var a6 = { get g() { return typeof @; } }; log(a6.g)',
	'function* g1() { yield typeof @; } log(g1().next().value)',
	'(async () => { log(typeof (await @)); })()',
	'log(new (function () { this.v = typeof @; })().v)',
];

/** what a case writes */
export const WRITES = [
	'location',
	'window.location',
	'self["location"]',
	'window[KL]',
	'document.location',
	'parent.location',
	'parent[KL]',
	'top.location',
	'plain.location',
	'plain[KL]',
	'plain[KX]',
	'm[KX]',
	'm.x',
	'm[0]',
	'm[keyObject]',
	'top',
	'window.top',
	'plain.top',
	'eval',
	'window.name',
	'this[KX]',
];

/** where a write stands: `@` is the target, `V` a value whose evaluation is recorded */
export const WRITE_POSITIONS = [
	'log(@ = next("a"))',
	'@ = next("a"); log("after")',
	'log(@ += next("b"))',
	'log(@ ||= next("c"))',
	'log(@ &&= next("d"))',
	'log(@ ??= next("e"))',
	'log(typeof @++)',
	'log(typeof --@)',
	'[@] = [next("f")]; log("after")',
	'[@ = next("g")] = []; log("after")',
	'({ a: @ } = { a: next("h") }); log("after")',
	'({ a: @ = next("i") } = {}); log("after")',
	'[...@] = [1]; log("after")',
	'({ ...@ } = { a: 1 }); log("after")',
	'for (@ of [next("j")]) log("body"); log("after")',
	'for (@ in { k: 1 }) log("body"); log("after")',
	'log((@) = next("l"))',
	'"use strict"; log(@ = next("m"))',
	'(function () { "use strict"; log(@ = next("n")); })()',
	'log(@ = @)',
	'log(@ **= 2)',
	'log(@ >>>= 1)',
];

const crossed = (family, items, positions) =>
	positions.flatMap((position, p) =>
		items.map((item, i) => ({
			name: `${family}#${p}.${i}`,
			code: PRELUDE + position.replaceAll('@', item),
		})),
	);

/** the cases written by hand: `[family, code, type?]` */
const HAND = [
	// ---- calls: the receiver, the arguments' order, what is called
	['call', 'var o = M({ f: F("f", 1) }, "o"), k = "f"; log(o[k](log("arg")))'],
	[
		'call',
		'var o = { f() { return this === o; } }, k = "f"; log(o[k](), (o[k])(), (0, o[k])() )',
	],
	[
		'call',
		'var o = { f() { return this; } }, k = "f"; log(o[k]?.() === o, o?.[k]() === o, o?.[k]?.() === o)',
	],
	[
		'call',
		'var o = null, k = "f"; log(o?.[k](log("never")), o?.[k]?.(log("never")))',
	],
	['call', 'var o = {}, k = "f"; log(o[k]?.(log("never")))'],
	[
		'call',
		'var o = M({}, "o"), k = "f"; try { o[k](log("arg")); } catch (e) { log(e.name, e.message); }',
	],
	[
		'call',
		'var o = null, k = "f"; try { o[k](log("arg")); } catch (e) { log(e.name, e.message); }',
	],
	[
		'call',
		'var o = { f: 1 }; try { o.f(); } catch (e) { log(e.name, e.message); }',
	],
	['call', 'try { location.nothing(); } catch (e) { log(e.name, e.message); }'],
	[
		'call',
		'try { top.nothing.deeper(); } catch (e) { log(e.name, e.message); }',
	],
	['call', 'try { location(); } catch (e) { log(e.name, e.message); }'],
	['call', 'try { new location(); } catch (e) { log(e.name, e.message); }'],
	['call', 'try { new top.nothing(); } catch (e) { log(e.name, e.message); }'],
	['call', 'location.assign(log("arg"), 2); location.reload()'],
	['call', 'location["assign"]("u"); var k = "replace"; location[k]("v")'],
	['call', 'var f = location.assign; f("detached")'],
	['call', 'var o = M({ f: F("f") }, "o"); o.f?.(1); o?.f(2); o["f"](3)'],
	[
		'call',
		'var o = { k: { f: F("f") } }, a = "k"; o[a].f(1); o[a]["f"](2); o[a].f?.(3)',
	],
	[
		'call',
		'var o = { f: F("f") }, k = "f"; o[k](...[1, 2], ...[3]); o[k](...M([4, 5], "spread"))',
	],
	[
		'call',
		'var k = { toString: F("key", "f") }, o = M({ f: F("f") }, "o"); o[k](1)',
	],
	[
		'call',
		'var o = M({ f: F("f") }, "o"), k = "f"; new o[k](1); new (o[k])(2); new o[k]',
	],
	[
		'call',
		'var C = F("C"); var o = { C }; new o.C(1); new o["C"](2); var k = "C"; new o[k](3).constructor',
	],
	['call', 'var o = { f: F("f") }, k = "f"; o[k]`a${1}b`; var t = o[k]; t`c`'],
	[
		'call',
		'var o = M({ f: F("tag", "r") }, "o"), k = "f"; log(o[k]`x${log("sub")}y`)',
	],
	[
		'call',
		'top.postMessage("m", "*"); parent.postMessage({ a: 1 }, "https://parent.example"); postMessage("self", "*")',
	],
	[
		'call',
		'var w = parent; w.postMessage?.("opt", "*"); w?.postMessage("opt2", "*"); var n = null; n?.postMessage(log("never"))',
	],
	[
		'call',
		'var pm = parent.postMessage; pm("detached", "*"); parent.postMessage.call(opener, "called", "*"); parent.postMessage.apply(opener, ["applied", "*"])',
	],
	[
		'call',
		'var k = "postMessage"; parent[k]("computed", "*"); parent["post" + "Message"]("joined", "*")',
	],
	['call', 'var b = parent.postMessage.bind(parent); b("bound", "*")'],
	['call', 'with (parent) { postMessage("with", "*"); }'],
	[
		'call',
		'var o = { postMessage: F("own.postMessage") }; o.postMessage(1); with (o) postMessage(2)',
	],
	[
		'call',
		'var o = { f: F("f") }; var k = "f"; (o[k])(1); (0, o[k])(2); (o[k], o[k])(3)',
	],
	[
		'call',
		'var o = M({ get f() { log("getter"); return F("f"); } }, "o"), k = "f"; o[k](1); o[k]?.(2)',
	],
	[
		'call',
		'log([1, 2, 3][2], "abc"[0], [1, 2, 3]["length"], "abc".length, [[1]][0][0])',
	],
	['call', 'var a = [3, 1, 2], i = 0; log(a[i++], a[i++], a[i], i)'],
	[
		'call',
		'function f() { return arguments[0] + arguments[arguments.length - 1]; } log(f(1, 2, 3))',
	],

	// ---- member reads: getters once, keys once, order
	[
		'member',
		'var o = M({ get g() { log("getter"); return 1; } }, "o"), k = "g"; log(o[k], o?.[k], o["g"])',
	],
	[
		'member',
		'var k = { toString() { log("toString"); return "x"; } }; var o = M({ x: 1 }, "o"); log(o[k])',
	],
	[
		'member',
		'var k = { [Symbol.toPrimitive](hint) { log("hint " + hint); return "x"; } }; var o = { x: 1 }; log(o[k])',
	],
	[
		'member',
		'var o = M({ a: M({ b: M({ c: 1 }, "b") }, "a") }, "o"), x = "a", y = "b", z = "c"; log(o[x][y][z])',
	],
	[
		'member',
		'var o = null, k = "x"; try { o[k]; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'var o, k = "x"; try { o[k].y; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'var o = {}, k = "x"; try { o[k].y; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'var o = {}, k = "x"; try { o[k][k]; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { top.missing.deeper; } catch (e) { log(e.name, e.message); }',
	],
	['member', 'try { undefinedName[0]; } catch (e) { log(e.name, e.message); }'],
	[
		'member',
		'var f = () => (log("object"), { x: 1 }), g = () => (log("key"), "x"); log(f()[g()])',
	],
	[
		'member',
		'var o = null; log(o?.[log("never")], o?.x[log("never")], o?.[0].y.z)',
	],
	[
		'member',
		'var o = { a: null }; log(o.a?.[log("never")], o?.a?.b[log("never 2")])',
	],
	[
		'member',
		'var o = { a: { b: 1 } }, k = "a"; log(o?.[k].b, o[k]?.b, (o?.[k]).b, o?.[k]?.["b"])',
	],
	[
		'member',
		'var s = "location"; log(window[s] === location, window["loc" + "ation"] === location, self[s].href)',
	],
	[
		'member',
		'var s = "top"; log(window[s] === top, parent[s] === top, window[s][s] === top)',
	],
	[
		'member',
		'log(location.href, location["href"], location?.href, window.location.href, document.location.href)',
	],
	[
		'member',
		'log(top === window.top, top === self.top, top.top === top, parent.top === top, top.parent === undefined)',
	],
	[
		'member',
		'log(location === window.location, location === document.location, location === self["location"])',
	],
	[
		'member',
		'log(typeof location, typeof top, typeof eval, typeof window.location, typeof parent.top)',
	],
	[
		'member',
		'log(String(location), `${location}`, location + "", "" + top.location)',
	],
	[
		'member',
		'log(Object.keys({ location, top }).join(), ({ location }).location === location, ({ top }).top === top)',
	],
	[
		'member',
		'var { location: l, top: t } = window; log(l === location, t === top)',
	],
	['member', 'var { location: { href } } = window; log(href)'],
	[
		'member',
		'var { location: l = log("default never") } = window; log(l === location)',
	],
	[
		'member',
		'var { ["loc" + "ation"]: l, ...rest } = { location: 1, other: 2 }; log(l, rest)',
	],
	['member', 'var [a, { top: t }] = [1, parent]; log(a, t === top)'],
	['member', 'var { top: t, ...others } = { top: 1, a: 2 }; log(t, others)'],
	[
		'member',
		'function f({ location: l }, [{ top: t }] = [parent]) { return [l === location, t === top]; } log(f(window))',
	],
	[
		'member',
		'var f = ({ top: t } = parent, u = t) => u === top; log(f(), f.length)',
	],
	[
		'member',
		'for (const { location: l } of [window, parent]) log(l === location, typeof l)',
	],
	['member', 'for (var { top: t } of [window]) log(t === top)'],
	[
		'member',
		'try { throw window; } catch ({ location: l, top: t }) { log(l === location, t === top); }',
	],
	[
		'member',
		'try { var { top: t } = null; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { var { location: l } = undefined; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { (({ top: t }) => t)(null); } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { var [a] = top.missing; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { for (var x of top.missing) ; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { log(...top.missing); } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'try { [...location.missing]; } catch (e) { log(e.name, e.message); }',
	],
	[
		'member',
		'var it = M({ [Symbol.iterator]() { log("iterator"); var n = 0; return { next() { log("next"); return { done: n++ > 1, value: n }; }, return() { log("return"); return {}; } }; } }, "it"); var [a] = it; var [b, c, d] = it; log(a, b, c, d)',
	],
	[
		'member',
		'var it = { [Symbol.iterator]() { var n = 0; return { next() { log("next"); return { done: false, value: { top: n++ } }; }, return() { log("return"); return {}; } }; } }; var [{ top: a }, { top: b }] = it; log(a, b)',
	],
	[
		'member',
		'var o = M({ a: 1, top: 2 }, "o"); var { a, top: t } = o; log(a, t)',
	],
	[
		'member',
		'var o = M({ a: 1, b: 2 }, "o"); var { a, ...rest } = o; log(a, rest)',
	],
	[
		'member',
		'var o = M({ a: 1 }, "o"), k = "a"; var { [k]: v, [log("key 2")]: w } = o; log(v, w)',
	],

	// ---- `in`, delete, typeof
	[
		'operators',
		'var o = M({ a: 1 }, "o"), k = "a"; log(k in o, "a" in o, "b" in o, 0 in [1], Symbol.iterator in [])',
	],
	[
		'operators',
		'log("location" in window, "top" in window, "eval" in window, "nothing" in window)',
	],
	[
		'operators',
		'var k = "$s$j"; log(k in window, "$s$j" in window, "$P$s" in window, k in {}, k in { $s$j: 1 })',
	],
	['operators', 'try { "a" in 1; } catch (e) { log(e.name, e.message); }'],
	[
		'operators',
		'var k = "a"; try { k in null; } catch (e) { log(e.name, e.message); }',
	],
	[
		'operators',
		'var k = { toString() { log("toString"); return "a"; } }; log(k in { a: 1 })',
	],
	[
		'operators',
		'var o = M({ a: 1, b: 2 }, "o"), k = "a"; log(delete o[k], delete o.b, delete o?.[k], delete o.c)',
	],
	[
		'operators',
		'log(delete window.location, delete window["top"], typeof location, typeof top)',
	],
	[
		'operators',
		'log(typeof nothing, typeof location.nothing, typeof top?.nothing, typeof window[0])',
	],
	[
		'operators',
		'var x = 1; log(delete x, typeof x); y = 2; log(delete y, typeof y)',
	],
	[
		'operators',
		'class A { #p = 1; static has(o) { return #p in o; } } log(A.has(new A()), A.has({}))',
	],
	[
		'operators',
		'var o = M({ a: 1, b: 2 }, "o"); for (var k in o) log(k, o[k])',
	],
	[
		'operators',
		'var o = { a: 1, b: 2 }; for (const k in o) { o[k] += 1; } log(o)',
	],
	[
		'operators',
		'var a = [1, 2, 3]; for (var i = 0; i < a.length; i++) a[i] *= 2; log(a)',
	],
	['operators', 'var a = [1, 2, 3], s = 0; for (var i in a) s += a[i]; log(s)'],

	// ---- writes: order of the target, the key, the old value and the new
	[
		'write',
		'var o = M({ k: 1 }, "o"), k = "k"; o[k] += (log("value"), 1); log(o.k)',
	],
	['write', 'var o = { n: 1 }, k = "n"; o[k] += (o[k] = 10, 1); log(o.n)'],
	[
		'write',
		'var o = { n: 1 }, k = "n", f = () => { o.n = 100; return 1; }; o[k] += f(); log(o.n)',
	],
	[
		'write',
		'var count = { a: 0 }, k = "a"; function walk(d) { if (d > 0) count[k] += walk(d - 1); return 1; } walk(3); log(count.a)',
	],
	[
		'write',
		'var o = M({ k: 0 }, "o"), k = "k"; o[k] ||= (log("value"), 5); o[k] ||= (log("never"), 6); log(o.k)',
	],
	[
		'write',
		'var o = M({ k: 1 }, "o"), k = "k"; o[k] &&= (log("value"), 0); o[k] &&= (log("never"), 6); log(o.k)',
	],
	[
		'write',
		'var o = M({}, "o"), k = "k"; o[k] ??= (log("value"), 5); o[k] ??= (log("never"), 6); log(o.k)',
	],
	[
		'write',
		'var cache = {}, calls = 0, make = () => ++calls; var k = "a"; cache[k] ??= make(); cache[k] ??= make(); cache[k] ||= make(); log(cache.a, calls)',
	],
	[
		'write',
		'var o = M({ get k() { log("get"); return 1; }, set k(v) { log("set " + v); } }, "o"), k = "k"; o[k]++; ++o[k]; o[k] += 2; o[k] = 9',
	],
	[
		'write',
		'var o = { k: 1 }, k = "k"; log(o[k]++, ++o[k], o[k]--, --o[k], o.k)',
	],
	['write', 'var o = { k: 1n }, k = "k"; log(o[k]++, o[k] += 2n, o.k)'],
	['write', 'var o = { k: "a" }, k = "k"; log(o[k] += "b", o[k]++, o.k)'],
	[
		'write',
		'var f = () => (log("object"), o), g = () => (log("key"), "k"), h = () => (log("value"), 1), o = {}; f()[g()] = h(); f()[g()] += h(); log(o)',
	],
	[
		'write',
		'var o = null, k = "k"; try { o[k] = log("value"); } catch (e) { log(e.name, e.message); }',
	],
	[
		'write',
		'var o, k = "k"; try { o[k] += log("value"); } catch (e) { log(e.name, e.message); }',
	],
	[
		'write',
		'var o = null; try { o[log("key")] = log("value"); } catch (e) { log(e.name, e.message); }',
	],
	[
		'write',
		'"use strict"; var o = Object.freeze({ k: 1 }), k = "k"; try { o[k] = 2; } catch (e) { log(e.name, e.message); }',
	],
	['write', 'var o = Object.freeze({ k: 1 }), k = "k"; o[k] = 2; log(o.k)'],
	[
		'write',
		'"use strict"; var k = "k"; try { "str"[k] = 2; } catch (e) { log(e.name, e.message); }',
	],
	[
		'write',
		'"use strict"; try { undefinedGlobal = 1; } catch (e) { log(e.name, e.message); }',
	],
	[
		'write',
		'"use strict"; try { top = 1; } catch (e) { log(e.name, e.message); } log(top === window.top)',
	],
	[
		'write',
		'top = 1; window.top = 2; self["top"] = 3; log(top === parent.top)',
	],
	[
		'write',
		'var k = { toString() { log("toString"); return "k"; } }, o = M({}, "o"); o[k] = 1; o[k] += 1; log(o.k)',
	],
	[
		'write',
		'var a = [], i = 0; a[i++] = i; a[i++] = i; a[i] = a[i - 1] = 7; log(a, i)',
	],
	['write', 'var a = [1, 2]; [a[0], a[1]] = [a[1], a[0]]; log(a)'],
	[
		'write',
		'var o = M({}, "o"), k = "a"; [o[k], o.b, o[log("key"), "c"]] = [1, 2, 3]; log(o.a, o.b, o.c)',
	],
	[
		'write',
		'var o = M({}, "o"), k = "a"; ({ x: o[k], y: o.b = log("default") } = { x: 1 }); log(o.a)',
	],
	[
		'write',
		'var o = {}, k = "a"; for (o[k] of [1, 2]) log(o.a); for (o[k] in { z: 1 }) log(o.a)',
	],
	[
		'write',
		'var o = M({ 0: "a" }, "o"); o[0] = "b"; o["1"] = "c"; o[0] += "d"; log(o[0], o[1])',
	],
	[
		'write',
		'var s = { selectedIndex: 0, 0: "a" }, node = { n: 1 }; s[0] = node; s[1] = node; log(s[0] === node, s[1] === node)',
	],
	[
		'write',
		'var a = [1], o = { n: 1 }; a[0] = o; a[1] = o; a["2"] = a[0]; log(a.length, a[2] === o)',
	],
	[
		'write',
		'location = "https://page.example/one"; location.href = "two"; window.location = "three"; document.location = "/four"; self["location"] = "?five"',
	],
	[
		'write',
		'var k = "location"; window[k] = "six"; parent[k] = "seven"; parent.location = "eight"; top.location = "nine"; parent.location.href = "ten"',
	],
	[
		'write',
		'location ||= "never"; location &&= "and"; location ??= "never"; location += "#hash"',
	],
	[
		'write',
		'var l = location; l.href = "kept"; var w = window; w.location = "w"; var d = document; d.location = "d"',
	],
	[
		'write',
		'function f() { location = "in-function"; } f(); (() => { location = "in-arrow"; })()',
	],
	['write', 'var location = "https://page.example/var"; log(typeof location)'],
	['write', 'var location; log(typeof location); var top; log(typeof top)'],
	[
		'write',
		'var { location } = { location: "https://page.example/pattern" }; log(typeof location)',
	],
	[
		'write',
		'var [location] = ["https://page.example/array"]; log(typeof location)',
	],
	[
		'write',
		'for (var location of ["https://page.example/loop"]) log(typeof location)',
	],
	[
		'write',
		'for (var location = "https://page.example/init"; false; ) ; log(typeof location)',
	],
	[
		'write',
		'function f() { var location = "local"; return location; } log(f(), typeof location)',
	],
	[
		'write',
		'function f(location) { location = "param"; return location; } log(f("a"), typeof location)',
	],
	['write', 'function f(top, eval) { return [top, eval]; } log(f(1, 2))'],
	['write', '{ let location = "block"; log(location); } log(typeof location)'],
	[
		'write',
		'var f = (location) => location + 1; log(f(1)); var g = ({ location }) => location; log(g({ location: 2 }))',
	],
	[
		'write',
		'try { throw 1; } catch (location) { log(location); } try { throw 2; } catch (top) { log(top); }',
	],
	[
		'write',
		'class location2 { static top = 1; location = 2; ["location"]() { return 3; } } log(location2.top, new location2().location, typeof new location2()["location"])',
	],
	[
		'write',
		'var o = { location: 1, top: 2, eval: 3, get parent() { return 4; } }; log(o.location, o.top, o.eval, o.parent, o)',
	],
	[
		'write',
		'var o = { location() { return 1; }, top() { return 2; }, eval() { return 3; } }; log(o.location(), o.top(), o.eval(), o.location.name, o.top.name, o.eval.name)',
	],
	[
		'write',
		'label: for (var i = 0; i < 2; i++) { location: for (;;) { break location; } top: { continue label; } }; log(i)',
	],

	// ---- eval: direct and not, scope, completion values, strictness
	[
		'eval',
		'var x = "global"; function f() { var x = "local"; return [eval("x"), (0, eval)("x"), eval?.("x"), window.eval("x")]; } log(f())',
	],
	[
		'eval',
		'function f() { var x = "local"; var e = eval; return [e("typeof x"), (eval)("x"), eval.call(null, "typeof x")]; } log(f())',
	],
	[
		'eval',
		'function f() { eval("var inner = 1"); return typeof inner; } log(f(), typeof inner)',
	],
	[
		'eval',
		'function f() { "use strict"; eval("var inner = 1"); return typeof inner; } log(f())',
	],
	[
		'eval',
		'(0, eval)("var made = 1"); log(typeof made, delete made, typeof made)',
	],
	[
		'eval',
		'log(eval("1; 2"), eval("var a = 1"), eval("if (true) { 3 } else { 4 }"), eval(""), eval("5;;"), eval("do { 6; break; } while (0)"))',
	],
	[
		'eval',
		'log(eval("L: { 1; break L; }"), eval("7; try { 8 } finally { 9 }"), eval("x = 3; switch (1) { case 1: 4 }"), eval("({ a: 1 })"), eval("{ a: 1 }"))',
	],
	[
		'eval',
		'log(eval(5), eval(null), eval(), eval({ toString() { return "9"; } }).toString(), eval("1", "2"))',
	],
	[
		'eval',
		'log(eval("location") === location, eval("top") === top, eval("window.location.href"), (0, eval)("typeof top"))',
	],
	[
		'eval',
		'log(eval("eval") === eval, eval("eval(\\"1 + 1\\")"), eval("(0, eval)(\\"typeof location\\")"))',
	],
	[
		'eval',
		'log(eval.name, eval.length, typeof eval, eval === window.eval, eval === globalThis.eval, String(eval))',
	],
	[
		'eval',
		'var saved = eval; eval = saved; function f() { var x = "local"; return eval("x"); } log(f())',
	],
	[
		'eval',
		'var x = "global"; function f(eval) { var x = "local"; return eval("x"); } log(f((c) => "param:" + c), f(eval))',
	],
	[
		'eval',
		'function f() { var eval = (c) => "local:" + c; return eval("x"); } log(f())',
	],
	['eval', 'try { eval("var 1x"); } catch (e) { log(e.name, e.message); }'],
	[
		'eval',
		'try { eval("throw new RangeError(\\"thrown\\")"); } catch (e) { log(e.name, e.message); }',
	],
	[
		'eval',
		'try { eval("\\"use strict\\"; undefinedThing = 1"); } catch (e) { log(e.name, e.message); }',
	],
	[
		'eval',
		'function f() { return eval("arguments.length"); } log(f(1, 2, 3)); var g = () => { try { return eval("typeof arguments"); } catch (e) { return e.name; } }; log(g())',
	],
	[
		'eval',
		'function f() { return eval("this"); } log(f.call(7) == 7, eval("this") === window, (0, eval)("this") === window)',
	],
	[
		'eval',
		'class A { m() { return eval("new.target"); } } function B() { return eval("new.target === B"); } log(new A().m(), new B() instanceof B, B())',
	],
	[
		'eval',
		'class A { x = 1; #p = 2; m() { return eval("this.#p + this.x"); } } log(new A().m())',
	],
	[
		'eval',
		'class A { static f() { return 1; } } class B extends A { static f() { return eval("super.f()") + 1; } } log(B.f())',
	],
	[
		'eval',
		'var r = eval("function declared() { return 1; } declared()"); log(r, typeof declared)',
	],
	[
		'eval',
		'eval("let scoped = 1; var hoisted = 2;"); log(typeof scoped, typeof hoisted)',
	],
	[
		'eval',
		'var code = "top === window.top && location === window.location"; log(eval(code), (0, eval)(code), new Function("return " + code)())',
	],
	[
		'eval',
		'log(eval("var z = location.href; z"), eval("(function () { return top === parent.top; })()"))',
	],
	[
		'eval',
		'var o = { eval(c) { return "method:" + c; } }; log(o.eval("x"), o["eval"]("y")); with (o) log(eval("z"))',
	],
	[
		'eval',
		'log(eval(...["1 + 1"]), eval("2", log("second")), eval(log("first") || "3"))',
	],
	[
		'eval',
		'var e = eval; log(e === eval, [eval][0] === eval, { eval }.eval === eval, (() => eval)() === e)',
	],
	[
		'eval',
		'log(new Function("a", "b", "return a + b")(1, 2), Function("return typeof location")(), new Function("return this")() === window)',
	],
	[
		'eval',
		'var f = new Function("a", "b = 2", "return a + b"); log(f.name, f.length, String(f))',
	],
	[
		'eval',
		'var f = Function("return top === window.top && location.href"); log(f(), f.toString())',
	],
	[
		'eval',
		'log(Function.prototype.constructor === Function, (() => {}).constructor === Function, Function.name, Function.length, Function instanceof Function)',
	],
	[
		'eval',
		'var G = Object.getPrototypeOf(function* () {}).constructor; var g = new G("a", "yield a; yield top === window.top"); log([...g(1)], String(g))',
	],
	[
		'eval',
		'var A = Object.getPrototypeOf(async function () {}).constructor; new A("return await location.href")().then(log); log(String(new A("x", "return x")))',
	],
	[
		'eval',
		'try { new Function("a b"); } catch (e) { log(e.name, e.message); }',
	],
	['eval', 'try { new Function("}", "{"); } catch (e) { log(e.name); }'],
	[
		'eval',
		'log(new Function("/*a*/", "return 1")(), new Function("a = 1 //", "return a")(), new Function("a", "b", "c", "return [a, b, c]")(1, 2, 3))',
	],

	// ---- functions as the page reads them back
	['source', 'function f(a, b) { return location; } log(f, f.name, f.length)'],
	[
		'source',
		'var f = function named(a = 1, ...rest) { return top; }; log(f, f.name, f.length)',
	],
	[
		'source',
		'var f = (a, b) => location.href + a; var g = async (x) => { await top; }; log(f, g)',
	],
	[
		'source',
		'var o = { m(a) { return top; }, get g() { return location; }, set s(v) { top; }, async *ag() {}, ["c" + 1]() { return eval; } }; log(o.m, Object.getOwnPropertyDescriptor(o, "g").get, Object.getOwnPropertyDescriptor(o, "s").set, o.ag, o.c1)',
	],
	[
		'source',
		'class A { constructor(a) { this.a = location; } static s() { return top; } m() { return eval; } #p() {} get g() { return 1; } } log(A, A.s, new A().m, Object.getOwnPropertyDescriptor(A.prototype, "g").get)',
	],
	[
		'source',
		'var A = class extends Object { f = location; }; var B = class Named { static { top; } }; log(A, B, A.name, B.name)',
	],
	[
		'source',
		'function* g(a) { yield location; } async function h() { await top; } async function* i() { yield eval; } log(g, h, i)',
	],
	[
		'source',
		'function f({ top: t }, [l] = [location], ...{ length }) { return [t, l, length]; } log(f, f.length, f.name)',
	],
	[
		'source',
		'var f = ({ location: l }) => l, g = ({ top } = window, x = top) => x; log(f, g, f.length, g.length)',
	],
	[
		'source',
		'function outer() { function inner() { return location; } return inner; } log(outer, outer())',
	],
	[
		'source',
		'var f = function () { return top; }, g = () => top, h = async () => top, k = function* () {}; log(f.name, g.name, h.name, k.name, f, g)',
	],
	[
		'source',
		'var o = { f: function () {}, g: () => {}, ["h"]: function () {}, i: class {} }; log(o.f.name, o.g.name, o.h.name, o.i.name)',
	],
	[
		'source',
		'function f() { /* location */ return "top"; } log(f, String(f).length)',
	],
	[
		'source',
		'log((function(){return location}).toString(), (()=>top).toString(), (class{m(){eval}}).toString())',
	],
	[
		'source',
		'function f(a, b) {} log(Function.prototype.toString.call(f), f.toString === Function.prototype.toString, Function.prototype.toString.name, String(Function.prototype.toString))',
	],
	[
		'source',
		'function f(a) { "use strict"; return top; } function g(a) { \'use strict\'; return [a]; } log(f, g, f(1) === top)',
	],
	[
		'source',
		'var f = function(a){return this.location}; log(f.call(window) === location, f.bind(window).name, f.bind(window)() === location)',
	],
	[
		'source',
		'function f() { return f.caller; } function g() { return arguments.callee === g; } log(f(), g())',
	],
	[
		'source',
		'function f(a, b) { arguments[0] = 9; return [a, arguments.length, f.length]; } log(f(1), f(1, 2, 3))',
	],
	[
		'source',
		'function f({ top: t }, b) { arguments[1] = 9; return [b, arguments.length, typeof arguments[0]]; } log(f(window, 2))',
	],
	[
		'source',
		'function f(a, { top: t }) { a = 5; return [arguments[0], arguments.length]; } log(f(1, window))',
	],
	[
		'source',
		'function f({ top: t } = window) { return [arguments.length, t === top]; } log(f(), f(parent), f.length)',
	],
	['source', 'var f = function ({ top: t }) { "use strict"; }; '],
	['source', 'function f(a, a) { return a; } log(f(1, 2))'],
	[
		'source',
		'function f({ top: t }, t2 = () => t) { var t = 5; return [t2() === top, t]; } log(f(window))',
	],
	[
		'source',
		'function f({ top: t }) { { function t() {} } return typeof t; } log(f(window))',
	],
	[
		'source',
		'var x = "outer"; function f({ top: t }, g = () => x) { var x = "inner"; return g(); } log(f(window))',
	],
	[
		'source',
		'function f([a, { top: t }] = [1, window], ...[b, { location: l }]) { return [a, t === top, b, l]; } log(f(undefined, 2, { location: 3 }))',
	],
	[
		'source',
		'try { (function ({ top: t }) {})(); } catch (e) { log(e.name, e.message); }',
	],
	[
		'source',
		'try { (({ location: { href } }) => href)({}); } catch (e) { log(e.name, e.message); }',
	],

	// ---- classes
	[
		'class',
		'class A { static location = 1; static top = location; top = top; ["location"] = 2; static ["eval"] = 3; } log(A.location, A.top === location, new A().top === top, new A().location, A.eval)',
	],
	[
		'class',
		'class A { #location = location; get location() { return this.#location; } static #top = top; static t() { return A.#top; } } log(new A().location === location, A.t() === top)',
	],
	[
		'class',
		'class A extends (log("heritage"), Object) { constructor() { log("before super"); super(); log(this.location); } } new A()',
	],
	[
		'class',
		'var k = "m"; class A { [k]() { return 1; } static [k + "s"]() { return 2; } get [k + "g"]() { return 3; } } log(new A().m(), A.ms(), new A().mg)',
	],
	[
		'class',
		'class B { get top() { return "B.top"; } eval() { return "B.eval"; } set location(v) { log("B.location=" + v); } get location() { return "B.location"; } } class A extends B { m() { return [super.top, super.eval(), super.location, super["top"]]; } w() { super.location = "x"; super["location"] += "y"; } } log(new A().m()); new A().w()',
	],
	[
		'class',
		'var k = "f"; class B { f() { return this; } } class A extends B { m() { return super[k]() === this; } static s() { return super.constructor === Function; } } log(new A().m(), A.s())',
	],
	[
		'class',
		'var o = { __proto__: { top: "proto.top", f() { return this === o; } }, m() { return [super.top, super.f(), super["f"]()]; } }; log(o.m())',
	],
	[
		'class',
		'class A { static #count = 0; static inc() { return A.#count++; } #x = 1; has(o) { return #x in o; } add() { this.#x += 1; return this.#x; } } log(A.inc(), A.inc(), new A().has({}), new A().add())',
	],
	[
		'class',
		'class A { static { this.made = location.href; var local = top; A.same = local === window.top; } } log(A.made, A.same)',
	],
	[
		'class',
		'class A { a = this.b; b = 2; static c = this.name; static d = new.target; } log(new A().a, A.c, A.d)',
	],
	[
		'class',
		'class A { constructor() { return M({}, "instance"); } } class B extends A { f = 1; ["g"] = 2; } new B()',
	],
	[
		'class',
		'class A { m() { return new.target; } } function F2() { return new.target === F2; } log(new A().m(), new F2() instanceof F2, Reflect.construct(F2, []) instanceof F2)',
	],
	[
		'class',
		'class A { static async *[Symbol.asyncIterator]() { yield location.href; } } (async () => { for await (const v of A) log(v); })()',
	],
	[
		'class',
		'class A { get [Symbol.toStringTag]() { return "T"; } static [Symbol.hasInstance](v) { return v === top; } } log(String(new A()), top instanceof A, location instanceof A)',
	],

	// ---- generators, async, labels, with, using
	[
		'flow',
		'function* g() { var a = yield location.href; var o = {}; o[a] = yield top === window.top; return o; } var it = g(); log(it.next(), it.next("k"), it.next(5))',
	],
	[
		'flow',
		'function* g() { var o = { n: 1 }, k = "n"; o[k] += yield 1; return o.n; } var it = g(); it.next(); log(it.next(10))',
	],
	[
		'flow',
		'function* g() { var o = {}, k = "n"; o[k] ??= yield "asked"; o[k] ??= yield "never"; return o.n; } var it = g(); log(it.next(), it.next(7))',
	],
	[
		'flow',
		'async function f() { var o = { n: 1 }, k = "n"; o[k] += await 2; o[k] ||= await log("never"); return o.n; } f().then(log)',
	],
	[
		'flow',
		'async function f() { try { await top.missing.deeper; } catch (e) { return [e.name, e.message]; } } f().then(log)',
	],
	[
		'flow',
		'async function f() { var o = { k: { f: async () => location.href } }, a = "k"; return await o[a].f(); } f().then(log)',
	],
	[
		'flow',
		'(async () => { for await (var x of [location.href, Promise.resolve(top === window.top)]) log(x); })()',
	],
	[
		'flow',
		'async function* g() { yield* [1, 2]; yield await location.href; } (async () => { for await (const v of g()) log(v); })()',
	],
	['flow', 'function* g() { yield* M([1, 2], "delegate"); } log([...g()])'],
	[
		'flow',
		'var o = M({ a: 1 }, "scope"); with (o) { log(a); a = 2; log(typeof location, typeof top, typeof b); }',
	],
	[
		'flow',
		'var o = { location: "with-location", top: "with-top", eval: (c) => "with-eval:" + c }; with (o) { log(location, top, eval("x")); location = "written"; } log(o.location, typeof location)',
	],
	[
		'flow',
		'with ({ x: 1 }) { var inWith = x; function declared() { return x; } } log(inWith, typeof declared)',
	],
	[
		'flow',
		'var o = M({}, "scope"); with (o) { var k = "a"; o[k] = 1; log(typeof nothing); }',
	],
	[
		'flow',
		'var o = { [Symbol.unscopables]: { hidden: true }, hidden: 1, shown: 2 }, hidden = "outer"; with (o) log(hidden, shown)',
	],
	[
		'flow',
		'outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j === 1) continue outer; if (i === 2) break outer; log(i, j, [i, j][j]); } }',
	],
	[
		'flow',
		'var o = { a: 1 }; a: { b: { if (o["a"]) break a; log("never"); } log("never"); } log("done")',
	],
	[
		'flow',
		'switch (location.href.length > 0) { case true: let k = "x"; log({ x: 1 }[k]); case false: log("fall"); break; default: log("never"); }',
	],
	[
		'flow',
		'do var x = [1][0]; while (false); if (x) function hoisted() { return 1; } log(x, typeof hoisted)',
	],
	[
		'flow',
		'{ function block() { return 1; } } log(typeof block); if (true) { function inIf() {} } log(typeof inIf)',
	],
	[
		'flow',
		'log(typeof late); { function late() {} } log(typeof late); var f = late; { function late() { return 2; } } log(f === late)',
	],
	[
		'flow',
		'try { log(tdz); let tdz = 1; } catch (e) { log(e.name, e.message); }',
	],
	[
		'flow',
		'try { let a = a; } catch (e) { log(e.name, e.message); } try { const { [k]: v, k = "x" } = { x: 1 }; } catch (e) { log(e.name, e.message); }',
	],
	[
		'flow',
		'try { (function (a = b, b = 1) {})(); } catch (e) { log(e.name, e.message); }',
	],
	[
		'flow',
		'try { var o = {}, k = "k"; o[k] = v2; let v2 = 1; } catch (e) { log(e.name, e.message); }',
	],
	[
		'flow',
		'try { class A extends top.missing {} } catch (e) { log(e.name, e.message); }',
	],
	[
		'flow',
		'var a = [1, 2, 3]; a: for (var x of a) { for (var y of a) { if (y > x) continue a; log(x, y); } }',
	],
	[
		'flow',
		'var d = { [Symbol.dispose]() { log("disposed"); } }; { using r = d; log("body", typeof location); } log("after")',
	],
	[
		'flow',
		'var k = "a"; { using r = { [Symbol.dispose]: F("dispose") }, s = null; var o = {}; o[k] = r; } log(typeof o.a)',
	],
	[
		'flow',
		'(async () => { { await using r = { async [Symbol.asyncDispose]() { log("async disposed"); } }; log("body"); } log("after"); })()',
	],
	[
		'flow',
		'for (using r of [{ [Symbol.dispose]() { log("d1"); } }]) log("iteration", typeof top)',
	],

	// ---- the text around a rewrite: ASI, comments, line terminators, escapes
	[
		'text',
		'var a = 1\nvar o = { k: 2 }, k = "k"\nvar b = o[k]\n;[a, b] = [b, a]\nlog(a, b)',
	],
	['text', 'var o = { k: () => 5 }, k = "k"\nvar a = o\n[k]\nlog(typeof a)'],
	[
		'text',
		'var o = { k: 1 }, k = "k", f = (v) => v\nvar a = f\n(o[k])\nlog(a)',
	],
	[
		'text',
		'var k = "k", o = { k: 1 }\no[k]++\n;(function () { log("called") })()\nlog(o.k)',
	],
	['text', 'var k = "k", o = { k: 1 }\no[k]++\n++o[k]\nlog(o.k)'],
	['text', 'var k = "k", o = { k: 1 }, i = 0\ni\n++\no[k]\nlog(i, o.k)'],
	['text', 'var c = "1"\nvar r = eval(c)\n;(log)(r)'],
	[
		'text',
		'var c = "log"\neval(c)("called")\nvar t = 1\neval("t")\n(log)("after")',
	],
	['text', 'function f() { return\nlocation }\nlog(f())'],
	[
		'text',
		'function f() { return /* c */ location /* d */ . /* e */ href }\nlog(f())',
	],
	[
		'text',
		'var o = { k: 1 }, k = "k"; log(o /* a */ [ /* b */ k /* c */ ] /* d */)',
	],
	['text', 'var o = { k: 1 }, k = "k"; log(o // a\n[ // b\nk // c\n])'],
	['text', 'var o = { k: { v: 1 } }, k = "k"; log(o [k] .v)'],
	[
		'text',
		'var o={k:1},k="k";log(o[k]/2/1,o[k]/o[k],/[/]/.test("/"),o[k]/ /a/.source.length)',
	],
	[
		'text',
		'var a = 4, g = 2, k = "source"; log(a /g/ 1, /a/g[k], a / /b/g[k].length)',
	],
	['text', 'var o = { k: 1 }, k = "k"; log(o[k]<!--a\n)'],
	[
		'text',
		'var x = 1;\n<!-- comment\nlog(x)\n--> another\nlog(location.href.length > 0)',
	],
	['text', '#!/usr/bin/env node\nlog(location.href)'],
	[
		'text',
		'log(l\\u006fcation === location, t\\u{6f}p === top, window.l\\u006fcation === location, typeof \\u0065val)',
	],
	[
		'text',
		'var o = { l\\u006fcation: 1, "t\\u006fp": 2 }; log(o.location, o.top, o["l\\u006fcation"])',
	],
	[
		'text',
		'var \\u{61}b = 1, k = "\\u006b", o = { k: 2 }; log(ab, o[k], o.\\u006b)',
	],
	[
		'text',
		'log(1_000[0], 0x10["toString"](2), 1n["constructor"] === BigInt, 1.5e3.toFixed, .5["constructor"] === Number)',
	],
	[
		'text',
		'var k = "length"; log("a\\u2028b"[k], `a\nb`[k], "\\0\\x41\\u{1F600}"[k], \'\\\n\'[k])',
	],
	[
		'text',
		'var k = "raw"; log(((s) => s[k][0])`a\\nb${1}`, String.raw`\\u00${1}`, ((s) => s[0])`\\unicode` === undefined)',
	],
	[
		'text',
		'var é = { ü: 1 }, k = "ü"; log(é[k], "😀"[1] === String.fromCharCode(0xde00), [..."😀x"].length)',
	],
	['text', 'var o = { k: 1 }, k = "k";;; log(o[k]);;'],
	[
		'text',
		'var o = { k: 1 }, k = "k"; if (o[k]) log("a"); else log("b")\nwhile (o[k]--) log("loop")\ndo log("do"); while (o[k]++ < 0)',
	],
	[
		'text',
		'var o = { f: () => () => 1 }, k = "f"; log(o[k]()(), new (o[k]())(), typeof new (class { m() {} })()[("m")])',
	],
	[
		'text',
		'var a = { b: { c: [10, 20] } }, i = 1; log(a.b.c[i], a["b"].c[i - 1], a?.b?.c?.[i], (a.b).c[i])',
	],
	[
		'text',
		'var f = async () => 1, async = (v) => v, o = { async: 1, await: 2, yield: 3, let: 4, static: 5, get: 6, set: 7, of: 8 }, k = "await"; log(async(1), o[k], o.yield, o.let)',
	],
	[
		'text',
		'var yield_ = 1, let_ = 2; var let = 3, yield = 4, await = 5, async = 6, of = 7, get = 8; log(let, yield, await, async, of, get, [let][0])',
	],
	[
		'text',
		'var o = { if: 1, class: 2, new: 3, typeof: 4, delete: 5, in: 6 }, k = "in"; log(o.if, o.class, o.new, o[k], k in o)',
	],
	[
		'text',
		'"use strict"; var o = { k: 1 }, k = "k"; log(o[k], (function () { return this; })(), typeof location)',
	],
	[
		'text',
		'"use strict"\nvar o = { k: 1 }, k = "k"\nlog(o[k], (function () { return this; })())',
	],
	[
		'text',
		'\'use strict\'; var k = "k"; try { ({})[k].x = undefinedName; } catch (e) { log(e.name, e.message); }',
	],
	[
		'text',
		'("use strict"); var k = "k"; log((function () { return this === window; })())',
	],
	[
		'text',
		'"use\\x20strict"; log((function () { return this === window; })())',
	],
	[
		'text',
		'function f() { "use strict"; "use asm"; return [this, typeof top]; } log(f())',
	],
	[
		'text',
		'/* leading */ // comment\n"use strict" /* trailing */ ; log((function () { return this; })())',
	],
	[
		'text',
		'var re = /location/g, s = "top location eval"; log(s.match(re), /top/.test(s), s.replace(/eval/, (m) => m.length))',
	],
	[
		'text',
		'var t = `location ${location.href} top ${top === window.top} ${`nested ${typeof eval}`}`; log(t)',
	],
	[
		'text',
		'var k = "x", o = { x: 1 }; log(`${o[k]}${o?.[k]}${k in o}`, `${{ a: o[k] }.a}`)',
	],
	[
		'text',
		'var o = { k: 1 }, k = "k"; log(o[k] ? o[k] : o[k], o[k] ? { a: o[k] } : [o[k]], [o[k], , o[k]].length)',
	],
	[
		'text',
		'var x = 0, o = { k: 5 }, k = "k"; x = o[k], x++, x += o[k]; log(x)',
	],
	[
		'text',
		'var a = [1, 2, 3], i = 0; while (i < a.length) { if (a[i] === 2) { i++; continue; } log(a[i++]); }',
	],
	[
		'text',
		'log(typeof document.location, document.URL, document["URL"], document.title)',
	],
	[
		'text',
		'var obj = { get [KEY]() { return 1; } }, KEY = "late"; log(Object.keys(obj))',
	],
	['text', 'log(((a, b = a[0], [c] = a) => [b, c])([9]))'],
	['text', 'var v8 = { runtime: 1 }; log(v8.runtime % 2, 5 %v8.runtime)'],
	['text', 'var a = 1, b = { c: 2 }, k = "c"; a = b\n[k]; log(a)'],
	['text', 'var k = "k", o = { k: 1 }; var r = o[k]\n`t`; '],
	[
		'text',
		'var x = { valueOf: F("valueOf", 3) }, o = { 3: "three" }; log(o[+x], o[x])',
	],
	[
		'text',
		'var i = 0, a = [[1, 2], [3, 4]]; log(a[i][i + 1], a[i + 1][i], a[a[i][i]][a[i][i]])',
	],

	// ---- tagged, spread, new, iteration of what a helper answered
	[
		'shapes',
		'var w = [window, parent]; log(w[0].location === location, w[1].top === top, w.map((x) => x.top === top))',
	],
	[
		'shapes',
		'var ws = { a: window }; var k = "a"; log(ws[k].location.href, ws[k]["location"]["href"], ws[k].top === top)',
	],
	[
		'shapes',
		'function get(o, k) { return o[k]; } log(get(window, "location") === location, get(window, "top") === top, get(parent, "top") === top, get(window, "eval") === eval)',
	],
	[
		'shapes',
		'function set(o, k, v) { o[k] = v; } set(window, "location", "https://page.example/set"); set(parent, "location", "/parent-set")',
	],
	[
		'shapes',
		'log(Object.entries({ location: 1, top: 2 }), JSON.stringify({ location: "l", top: "t", eval: "e" }), JSON.parse(\'{"location":1,"top":2}\').top)',
	],
	[
		'shapes',
		'var a = [location, top, eval]; log(a[0] === location, a[1] === top, a[2] === eval, a.indexOf(top), a.includes(location))',
	],
	[
		'shapes',
		'var m = new Map([[location, 1], [top, 2]]); log(m.get(location), m.get(top), m.get(window.location), m.get(parent.top), new Set([top, window.top, parent.top]).size)',
	],
	[
		'shapes',
		'log([..."ab"][1], [...[1, 2]].length, Math.max(...[1, 5, 3]), [...new Set([location, location])].length)',
	],
	[
		'shapes',
		'log((() => arguments)?.length, typeof globalThis, globalThis === window, this === window, self === frames)',
	],
	[
		'shapes',
		'var o = { toString() { return "location"; } }; log(window[o] === location, o + "" in window)',
	],
	[
		'shapes',
		'log(window.window === window, window.self.frames.window === window, window["window"]["self"] === self)',
	],
	[
		'shapes',
		'log(parent.parent === undefined, parent.self === parent, parent.window.location === parent.location, opener.top === top)',
	],
	[
		'shapes',
		'log(parent.value, parent["value"], parent?.value, parent.closed, opener.name, top.name, top.length)',
	],
	[
		'shapes',
		'var names = ["location", "top", "eval", "postMessage", "name", "value"]; for (var n of names) log(n, typeof window[n], typeof parent[n])',
	],
	[
		'shapes',
		'var w = window; for (var hops = 0; w !== w.top && hops < 5; hops++) w = w.parent ?? w.top; log(hops, w === top)',
	],
	[
		'shapes',
		'log(top.location === top.location, parent.location === parent.location, parent.location !== location, top.location.href)',
	],
	[
		'shapes',
		'var seen = []; for (var w of [window, parent, opener, top]) seen.push(w.location.href); log(seen)',
	],
	[
		'shapes',
		'var d = Object.getOwnPropertyDescriptor(plainHolder = { get location() { return 1; } }, "location"); log(typeof d.get, plainHolder.location)',
	],

	// ---- what test262 and the generator found
	[
		'found',
		'var o = { top: 1 }, t; var r = ({ top: t } = o); log(r === o, t); var a, b; var s = ([a, { top: b }] = [1, o]); log(Array.isArray(s), s.length, b)',
	],
	[
		'found',
		'var o = M({ top: 1, k: 2 }, "o"), t, u, k = "k"; log(({ top: t, [k]: u } = o) === o, t, u); o.x = 3',
	],
	[
		'found',
		'var t; function f(v) { return v; } log(f({ top: t } = window) === window, t === top, (0, { top: t } = parent) === parent)',
	],
	[
		'found',
		'var o = {}, k = "$s$j"; o[k] = true; var j = "location"; o[j] = 1; o.eval = 2; log(o)',
	],
	[
		'found',
		'var x = "global"; function f() { var x = "local"; return [eval("x", ...[]), eval(...[], "x"), eval(...["x"], "y")]; } log(f())',
	],
	[
		'found',
		'var w = M({}, "w"); try { w?.postMessage(log("argument")); } catch (e) { log(e.name, e.message); } log(w.postMessage?.(log("never")))',
	],
	[
		'found',
		'var n = null; try { n.postMessage?.(log("never")); } catch (e) { log(e.name, e.message); } log(n?.postMessage(log("never")), n?.postMessage?.(1))',
	],
	[
		'found',
		'var w = M({ get postMessage() { log("getter"); return F("posted"); } }, "w"); w.postMessage(log("a")); w?.postMessage(1); w.postMessage?.(log("b"))',
	],
	[
		'found',
		'try { document?.postMessage(log("argument")); } catch (e) { log(e.name, e.message); } try { ({}).postMessage(1); } catch (e) { log(e.name, e.message); }',
	],
	[
		'found',
		'log((window.location ||= "never") === location, (document.location &&= location) === location, typeof (self.location ??= 1))',
	],
	[
		'found',
		'log((parent.location ||= "never") === parent.location, typeof (window.location += "#x"), window.location++)',
	],
	[
		'found',
		'try { top.nope`x`; } catch (e) { log(e.name, e.message); } try { location.href`y`; } catch (e) { log(e.name, e.message); }',
	],
	[
		'found',
		'let { 1n: a, 0x10n: b } = { 1: "one", 16: "sixteen" }; var c; ({ 2n: c } = [0, 0, "two"]); log(a, b, c)',
	],
	[
		'found',
		'class Callable extends Function { constructor() { super("return 7"); } hi() { return "hi"; } } var f = new Callable(); log(f instanceof Callable, f(), f.hi(), Reflect.construct(Function, ["return 1"], Callable) instanceof Callable)',
	],
	[
		'found',
		'log(Function.prototype.toString.call(Function.prototype)); function f() {} Object.setPrototypeOf(f, { toString() { return "mine"; } }); log(Function.prototype.toString.call(f), String(f))',
	],
	[
		'found',
		'var p = M({ a: 1, b: 2 }, "p"), k = "a"; var { [k]: v, ...rest } = p; log(v, rest)',
	],
	[
		'found',
		'var a = {}, k = "x"; try { log(a?.[k][k]); } catch (e) { log(e.name, e.message); }',
	],
	[
		'found',
		'var o = M({ f: F("f") }, "o"), k = "f"; log(delete o?.[k], "f" in o, delete o?.f, delete o?.[k]?.x)',
	],
	[
		'found',
		'var o = { f() { return this === o; } }, k = "f"; log(o[k]`a`, (o[k])`b`, o?.[k]`c` === undefined)',
		undefined,
	],
	[
		'found',
		'log(String(Function.prototype)); var g = function h() { return 1; }; Object.setPrototypeOf(g, Object.prototype); log(Function.prototype.toString.call(g), String(g))',
	],
];

const KEY_ONCE =
	'an object that is a computed key is converted once by the access API where V8 converts it for the read and again for the write (a compound write whose value does no work, an update)';
const HOST_TOP =
	"an update or an arithmetic compound write of a window's `top` converts the host's top to a primitive (the result is the same: NaN or a string no page tells apart)";
const PARAMETERS =
	'a parameter pattern that reads through the access API is declared at the top of the body: the parameter list becomes a simple one (a sloppy `arguments` object is mapped), and its names share the scope of the body';
/**
 * The cases known to differ, by name, each with why. A case named here that
 * leaves the same trace again fails the suite (rewriter-differential); the
 * case's code is its reproduction.
 */
export const KNOWN = {
	'write#22': KEY_ONCE,
	'write#6.14': KEY_ONCE,
	'write#7.14': KEY_ONCE,
	'write#20.14': KEY_ONCE,
	'write#21.14': KEY_ONCE,
	'write#6.16': HOST_TOP,
	'write#7.16': HOST_TOP,
	'write#20.16': HOST_TOP,
	'write#21.16': HOST_TOP,
	'eval#12':
		"a binding named `eval` that holds the page's eval: the page holds the stand-in a read answers, whose call is no direct eval",
	'source#19': PARAMETERS,
	'source#20': PARAMETERS,
	'source#24': PARAMETERS,
	'source#25': PARAMETERS,
	'text#7':
		'the value of a direct eval called when it is no function: V8 names `eval(...)`, the rewritten call is a conditional',
	'found#16':
		'a routed link behind an optional one (`a?.[k][k]`): the helper is handed the value of the chain before it, undefined whether `a` short-circuited or `a[k]` is undefined, and answers undefined for both (the error-messages suite records the same as EARLIER_LINK)',
};

/** every case of the curated corpus: `{ name, code, type? }` */
export function cases() {
	const counts = new Map();
	const hand = HAND.map(([family, code, type]) => {
		const index = counts.get(family) ?? 0;
		counts.set(family, index + 1);
		return { name: `${family}#${index}`, code, type };
	});
	return [
		...hand,
		...crossed('read', READS, READ_POSITIONS),
		...crossed('write', WRITES, WRITE_POSITIONS),
	];
}
