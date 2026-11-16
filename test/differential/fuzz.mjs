// The generative half of the differential oracle (harness.mjs): programs
// composed from the constructs the rewriter touches, each in the positions
// it can stand in, from a seed. `program(seed)` is the same text every time,
// so a difference is reproduced by its seed alone.
//
// A program runs in the world of world.js behind PRELUDE: `m` is an object
// that records what is done to it, `val(tag)` and `key(tag)` record that
// they were evaluated (so the order of evaluation is in the trace), and
// every statement says what it computed.
//
// What the generator leaves out is what the rewriter is known to answer
// otherwise than V8 (corpus.mjs KNOWN names a case of each, with why): an
// object as a computed key, an update or an arithmetic
// compound write of a window's `top` or `eval`, `arguments` beside a
// destructured parameter, a binding named `eval`, and a routed link behind
// an optional one in the same chain (`a?.b[k]`).

/** mulberry32: the generator's only source of choices */
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const PRELUDE = `var KL = "location", KT = "top", KE = "eval", KP = "postMessage", KX = "x", KF = "f", i0 = 0;
var plain = { location: "plain-location", top: "plain-top", eval: 5, x: 1, y: { x: 2, f: F("plain.y.f", 3) }, f: F("plain.f", "r"), 0: "zero" };
var m = M({ x: 1, y: M({ x: 2, f: F("m.y.f", 3) }, "m.y"), f: F("m.f", "r"), top: "m-top", location: "m-location", 0: "zero", n: null }, "m");
var arr = [1, plain, m];
var nothing = null, missing;
var val = (tag) => (log("val " + tag), tag);
var key = (tag) => (log("key " + tag), tag);
var num = (n) => (log("num " + n), n);
var C = F("C", function () { return { made: true }; });
var tag = F("tag", "tagged");
`;

const OBJECTS = [
	'm',
	'm',
	'plain',
	'plain',
	'window',
	'parent',
	'top',
	'location',
	'arr',
	'self',
	'document',
	'opener',
	'this',
	'm.y',
	'plain.y',
	'nothing',
	'missing',
	'globalThis',
];
const NAMES = ['x', 'y', 'f', 'top', 'location', 'eval', 'postMessage', 'n'];
const KEY_NAMES = ['KX', 'KL', 'KT', 'KE', 'KP', 'KF', 'i0'];
const ARITHMETIC = ['+=', '-=', '*=', '**=', '>>>=', '|='];
const LOGICAL = ['||=', '&&=', '??='];

/** the program of a seed: `{ code, seed }` */
export function program(seed) {
	const next = random(seed);
	const pick = (list) => list[Math.floor(next() * list.length)];
	const chance = (p) => next() < p;
	let counter = 0;
	const fresh = (prefix) => `${prefix}${++counter}`;
	const tagOf = () => `${counter++}`;

	const object = () => pick(OBJECTS);
	/** a member's key: `[text, guarded]`, guarded when it may name top or eval */
	const memberKey = () => {
		const kind = next();
		if (kind < 0.35) {
			const name = pick(NAMES);
			return [`.${name}`, name === 'top' || name === 'eval'];
		}
		if (kind < 0.7) {
			const name = pick(KEY_NAMES);
			return [`[${name}]`, name === 'KT' || name === 'KE'];
		}
		if (kind < 0.8)
			return [`[${pick(['"x"', '"top"', '"location"', '0', '"f"'])}]`, true];
		if (kind < 0.9) return [`[key(${JSON.stringify(pick(NAMES))})]`, true];
		return [`[KX + ""]`, false];
	};
	const optional = (member) =>
		chance(0.2)
			? member.startsWith('.')
				? `?${member}`
				: `?.${member}`
			: member;

	/** an expression that is read */
	function read(depth) {
		if (depth <= 0) {
			const kind = next();
			if (kind < 0.3) return object();
			if (kind < 0.5) return `val(${JSON.stringify(tagOf())})`;
			if (kind < 0.6) return `num(${Math.floor(next() * 5)})`;
			if (kind < 0.75)
				return pick(['location', 'top', 'eval', 'window', 'parent']);
			return `${object()}${optional(memberKey()[0])}`;
		}
		const kind = Math.floor(next() * 30);
		const inner = () => read(depth - 1);
		switch (kind) {
			case 0:
			case 1:
			case 2:
				return `${object()}${optional(memberKey()[0])}`;
			case 3:
				// (an optional link is the chain's last: see the file's head)
				return `${object()}${memberKey()[0]}${optional(memberKey()[0])}`;
			case 4:
				return `(${inner()})${optional(memberKey()[0])}`;
			case 5:
			case 6: {
				// a call: the receiver, the arguments' order
				const args = [inner(), ...(chance(0.4) ? [inner()] : [])];
				const call = chance(0.2) ? '?.(' : '(';
				return `${object()}${optional(memberKey()[0])}${call}${args.join(', ')})`;
			}
			case 7:
				return `${object()}${memberKey()[0]}(...[${inner()}])`;
			case 8:
				return `new ${pick(['C', 'plain.f', 'm[KF]', '(m.f)'])}(${inner()})`;
			case 9:
				return `${pick(['tag', 'm.f', 'm[KF]', 'plain[KF]', '(m[KF])'])}\`a\${${inner()}}b\``;
			case 10:
				return `typeof ${inner()}`;
			case 11:
				return `${pick(['KX', 'KT', '"x"', 'key("y")', 'KL'])} in ${pick(['m', 'plain', 'window', 'm.y', 'arr'])}`;
			case 12:
				return `(${inner()} ${pick(['||', '&&', '??'])} ${inner()})`;
			case 13:
				return `(${inner()} ? ${inner()} : ${inner()})`;
			case 14:
				return `(${inner()}, ${inner()})`;
			case 15:
				return `[${inner()}, ...[${inner()}]].length`;
			case 16:
				return `({ a: ${inner()}, [key("b")]: ${inner()}, location, top }).a`;
			case 17:
				return `\`t\${${inner()}}\`.length`;
			case 18:
				return `(() => ${inner()})()`;
			case 19:
				return `(function () { return ${inner()}; }).call(${object()})`;
			case 20:
				return `eval(${JSON.stringify(inner())})`;
			case 21:
				return `(0, eval)(${JSON.stringify(read(0))})`;
			case 22:
				return `new Function(${JSON.stringify(`return ${read(0)}`)})()`;
			case 23:
				return write(depth - 1);
			case 24:
				return `delete ${pick(['m', 'plain', 'm.y', 'nothing'])}${optional(memberKey()[0])}`;
			case 25:
				return `String(${inner()}).length`;
			case 26:
				return `(${inner()} === ${inner()})`;
			case 27:
				return `((a, b = ${inner()}) => typeof a + typeof b)(${inner()})`;
			case 28:
				return `(async () => await ${inner()})().constructor.name`;
			default:
				return `[...(function* () { yield ${inner()}; })()].length`;
		}
	}

	/** a write, as an expression */
	function write(depth) {
		const value = () => read(Math.max(0, depth));
		const [k, guarded] = memberKey();
		const target = `${pick(['m', 'plain', 'm.y', 'window', 'parent', 'arr', 'nothing', 'this'])}${k}`;
		const kind = Math.floor(next() * 14);
		switch (kind) {
			case 0:
			case 1:
				return `(${target} = ${value()})`;
			case 2:
			case 3:
				return `(${target} ${pick(LOGICAL)} ${value()})`;
			case 4:
				return guarded
					? `(${target} ${pick(LOGICAL)} ${value()})`
					: `(${target} ${pick(ARITHMETIC)} ${value()})`;
			case 5:
				return guarded
					? `(${target} = ${value()})`
					: `${target}${pick(['++', '--'])}`;
			case 6:
				return guarded
					? `(${target} = ${value()})`
					: `${pick(['++', '--'])}${target}`;
			case 7:
				return `([${target}] = [${value()}])`;
			case 8:
				return `({ a: ${target} = ${value()} } = {})`;
			case 9:
				return `(location ${pick(['=', '||=', '&&=', '??=', '+='])} ${value()})`;
			case 10:
				return `(${pick(['window', 'self', 'document', 'parent'])}${pick(['.location', '[KL]'])} ${pick(['=', '||=', '&&='])} ${value()})`;
			case 11:
				return `(top ${pick(['=', '||=', '??='])} ${value()})`;
			case 12:
				return `({ x: ${target}, ...${fresh('rest')} } = ${pick(['m', 'plain', 'window'])})`;
			default:
				return `([${target} = ${value()}, ...${fresh('rest')}] = ${pick(['arr', '[]', '[missing, 2]'])})`;
		}
	}

	/** a statement */
	function statement(depth) {
		const kind = Math.floor(next() * 22);
		const expression = () => read(2);
		const body = () => (depth > 0 ? statement(depth - 1) : `log(${read(1)});`);
		switch (kind) {
			case 0:
			case 1:
			case 2:
			case 3:
				return `log(${expression()});`;
			case 4:
			case 5:
				return `try { log(${expression()}); } catch (e) { log("threw", e.name, e.message); }`;
			case 6:
				return `${write(2)};`;
			case 7:
				return `var ${fresh('v')} = ${expression()};`;
			case 8: {
				const name = fresh('d');
				return `try { var { x: ${name}, top: ${name}t, [KL]: ${name}l, ...${name}r } = ${pick(['m', 'plain', 'window', 'parent', 'nothing'])}; log(typeof ${name}, ${name}t === top, typeof ${name}l); } catch (e) { log("threw", e.name, e.message); }`;
			}
			case 9: {
				const name = fresh('a');
				return `try { let [${name}, { top: ${name}t } = window, ...${name}r] = ${pick(['arr', '[m, parent]', 'nothing', '"st"'])}; log(typeof ${name}, ${name}t === top); } catch (e) { log("threw", e.name, e.message); }`;
			}
			case 10:
				return `if (${expression()}) { ${body()} } else { ${body()} }`;
			case 11:
				return `for (var ${fresh('i')} = 0, n = 0; n < 2; n++) { ${body()} }`;
			case 12: {
				const name = fresh('k');
				return `for (const ${name} in ${pick(['plain.y', 'm.y', '{ a: 1, top: 2 }'])}) { log(${name}); ${body()} }`;
			}
			case 13:
				return `for (${pick(['m[KX]', 'plain.top', 'plain[key("x")]', 'm.y[KX]'])} of [${read(1)}, ${read(0)}]) { ${body()} }`;
			case 14: {
				const name = fresh('f');
				return `function ${name}(a, { top: t, x } = ${pick(['window', 'plain', 'm', 'parent'])}) { ${body()} return [typeof a, t === top, x]; } log(${name}(${read(1)}), ${name}.length, String(${name}).length);`;
			}
			case 15: {
				const name = fresh('K');
				return `class ${name} { static s = ${read(1)}; f = ${read(1)}; [key("m")]() { return ${read(1)}; } static { ${body()} } } log(typeof ${name}.s, typeof new ${name}().f, typeof new ${name}().m());`;
			}
			case 16:
				return `with (plain) { ${body()} log(typeof location, typeof top, x); }`;
			case 17: {
				const label = fresh('l');
				return `${label}: { ${body()} if (${read(0)}) break ${label}; ${body()} }`;
			}
			case 18:
				return `switch (typeof ${read(1)}) { case "object": ${body()} break; case "string": ${body()} default: log("default"); }`;
			case 19:
				return `try { ${pick(['nothing', 'missing', 'm.n'])}${memberKey()[0]}${pick(['', '.x', '()', ' = 1', '(val("a"))', ' += val("b")'])}; } catch (e) { log("threw", e.name, e.message); }`;
			case 20: {
				const name = fresh('g');
				return `function* ${name}() { m[KX] ??= yield 1; plain[key("z")] += yield 2; return ${read(1)}; } var ${name}i = ${name}(); log(${name}i.next().value, ${name}i.next(5).value, typeof ${name}i.next(6).value);`;
			}
			default:
				return `(async () => { try { log(typeof await ${read(2)}); m[KX] += await num(2); } catch (e) { log("threw", e.name, e.message); } })();`;
		}
	}

	const count = 3 + Math.floor(next() * 6);
	const statements = [];
	// (each in a try, so that one that throws does not end the program)
	for (let i = 0; i < count; i++)
		statements.push(
			`try { ${statement(1)} } catch (e) { log("threw", e.name, e.message); }`,
		);
	return { seed, code: `${PRELUDE}${statements.join('\n')}\n` };
}
