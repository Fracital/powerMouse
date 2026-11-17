// How the access API names a page's expression in the errors it throws
// (./errorMessages.ts): the probes V8's wording is measured on and the
// printing of the page's expression, a deferred part of the document bundle
// (./dom/deferred.ts) made at the first such error, and the worker bundle's
// own (./accessFailureParts.ts). ErrorMessages keeps the paths that succeed,
// and without the part throws the error the operation threw.
import type ErrorMessages from './errorMessages';
import { messageOf } from './errorMessages';
import { printExpression } from './rewriter';

/** a function to spread arguments into, which is nothing of the page's */
const sink = (...args: unknown[]) => args;

/** the marker expressions the probes below fail on, as V8 prints them */
const VALUE = 'this.zz$v';
const FUNCTION = 'this.zz$f';
const KEY = 'zz$k';

/** `this` in a probe that fails on `this` itself (ITERATE's `bare`) */
const THIS = 'this';

type Probe = (this: { zz$v?: unknown; zz$f?: () => unknown }) => unknown;

/**
 * what `probe` throws, run with `value` as `this.zz$v` (and returned by
 * `this.zz$f()`), or as `this` itself (`bare`)
 */
function failure(probe: Probe, value?: unknown, bare = false): unknown {
	try {
		Reflect.apply(probe, bare ? value : { zz$v: value, zz$f: () => value }, []);
	} catch (error) {
		return error;
	}
	return undefined;
}

/**
 * The shapes a value is iterated in, each probed the way the page's
 * expression is: what V8 says differs by shape, by value and by the
 * expression (measured: a for-of names a member, `const [a] = o.b` names
 * nothing, `const [a] = b` names `b`, a call is "f is not a function or its
 * return value is not iterable", spread arguments say what they say).
 * `bare`: an expression that is a name, `this` or a literal
 * (own-iteration: as written: each probe is the syntax whose message it
 * measures, scripts/ownIteration.mjs)
 */
const ITERATE: Record<string, { value: Probe; call: Probe; bare?: Probe }> = {
	of: {
		value() {
			for (const x of this.zz$v as any) void x;
		},
		call() {
			for (const x of this.zz$f!() as any) void x;
		},
	},
	spread: {
		value() {
			return [...(this.zz$v as any)];
		},
		call() {
			return [...(this.zz$f!() as any)];
		},
	},
	args: {
		value() {
			return sink(...(this.zz$v as any));
		},
		call() {
			return sink(...(this.zz$f!() as any));
		},
	},
	array: {
		value() {
			const [x] = this.zz$v as any;
			return x;
		},
		call() {
			const [x] = this.zz$f!() as any;
			return x;
		},
		bare() {
			const [x] = this as any;
			return x;
		},
	},
	assign: {
		value() {
			const box: { x?: unknown } = {};
			[box.x] = this.zz$v as any;
			return box;
		},
		call() {
			const box: { x?: unknown } = {};
			[box.x] = this.zz$f!() as any;
			return box;
		},
	},
};
const BARE = ['Identifier', 'ThisExpression', 'Literal'];

const CALL: Probe = function () {
	return (this.zz$v as any)();
};
const CONSTRUCT: Probe = function () {
	return new (this as any).zz$v();
};
const DESTRUCTURE: Probe = function () {
	const { zz$k: x } = this.zz$v as any;
	return x;
};
// a parameter's pattern: V8 names the value ("of 'object null'")
const DESTRUCTURE_PARAMETER: Probe = function () {
	return (({ zz$k: x }: any) => x)(this.zz$v);
};
const DESTRUCTURE_EMPTY: Probe = function () {
	// eslint-disable-next-line no-empty-pattern
	const {} = this.zz$v as any;
};
const ATTEMPTS = 500;

/** a part of a page's expression as V8 prints it (callPrinter.ts), cached */
function print(
	messages: ErrorMessages,
	partial: unknown,
	part: string,
): string | null {
	if (typeof partial !== 'string') return null;
	const cache = messages.printed;
	const key = `${part}\u0000${partial}`;
	if (cache.has(key)) return cache.get(key)!;
	let printed: string | null = null;
	try {
		printed = printExpression(partial, part);
	} catch (error) {
		// no library to print with: the caller's fallback
	}
	if (cache.size > ATTEMPTS) cache.clear();
	cache.set(key, printed);
	return printed;
}

/** a message of `probe`'s kind naming `printed`, null when it cannot say */
function template(
	messages: ErrorMessages,
	probe: Probe,
	marker: string,
	printed: string,
): string | null {
	let template = messages.templates.get(probe);
	if (template === undefined) {
		const message = messageOf(failure(probe));
		const at = message.indexOf(marker);
		template =
			at === -1
				? null
				: [message.slice(0, at), message.slice(at + marker.length)];
		messages.templates.set(probe, template);
	}
	return template ? template[0] + printed + template[1] : null;
}

/** the message `probe` fails with for `value`, naming `printed` for the marker */
function measured(
	probe: Probe,
	value: unknown,
	marker: string,
	printed: string,
	bare = false,
): string {
	const message = messageOf(failure(probe, value, bare));
	const at = message.indexOf(marker);
	return at === -1
		? message
		: message.slice(0, at) + printed + message.slice(at + marker.length);
}

export const accessFailures = {
	/**
	 * The error of `partial` (a call, or a `new`: `construct`) whose callee
	 * is no function or no constructor, `thrown` what the operation threw:
	 * V8 names the callee, or (arguments spread other than once at the end)
	 * the call is an apply, with apply's error
	 */
	callee(
		messages: ErrorMessages,
		construct: boolean,
		thrown: unknown,
		partial: unknown,
	): Error {
		const callee = print(messages, partial, 'callee');
		if (callee === null || print(messages, partial, 'spread') === '1')
			return messages.error(messageOf(thrown));
		return messages.error(
			template(messages, construct ? CONSTRUCT : CALL, VALUE, callee) ??
				messageOf(thrown),
		);
	},
	/**
	 * `value`, not iterable, is iterated by `shape` (ITERATE) in `partial`:
	 * what V8 says, naming the expression (or the callee of a call: "f is
	 * not a function or its return value is not iterable"); null where the
	 * expression cannot be printed (the page's own iteration throws what it
	 * throws)
	 */
	iterate(
		messages: ErrorMessages,
		value: unknown,
		shape: string,
		partial: unknown,
	): Error | null {
		const probes = ITERATE[shape]!;
		const type = print(messages, partial, 'type');
		if (type === null) return null;
		if (type === 'CallExpression') {
			const callee = print(messages, partial, 'callee')!;
			return messages.error(measured(probes.call, value, FUNCTION, callee));
		}
		const printed = print(messages, partial, 'value')!;
		if (probes.bare && BARE.includes(type))
			return messages.error(measured(probes.bare, value, THIS, printed, true));
		return messages.error(measured(probes.value, value, VALUE, printed));
	},
	/**
	 * `value`, null or undefined, is destructured by the pattern of
	 * `partial` (`{ a } = v`): what V8 says, null where it cannot be printed.
	 * A destructured parameter (the rewriter declares its pattern from the
	 * parameter, which it names `<access>a<n>`) is named by its value, as V8
	 * does.
	 */
	coerce(
		messages: ErrorMessages,
		value: unknown,
		partial: unknown,
	): Error | null {
		const key = print(messages, partial, 'key');
		const printed = print(messages, partial, 'init');
		if (key === null || printed === null) return null;
		const parameter = `${messages.client.names.access}a`;
		return messages.error(
			printed.startsWith(parameter) &&
				/^\d+$/.test(printed.slice(parameter.length))
				? measured(DESTRUCTURE_PARAMETER, value, KEY, key)
				: key
					? measured(DESTRUCTURE, value, VALUE, printed).replace(KEY, key)
					: measured(DESTRUCTURE_EMPTY, value, VALUE, printed),
		);
	},
};
