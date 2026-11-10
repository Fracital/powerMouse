import type Client from './Client';
import { printExpression } from './rewriter';

/**
 * The errors the access API throws for an expression the rewriter routed
 * to it, with V8's own message for the page's expression: V8 names the
 * failing callee or value by printing it back from the code (`o[k] is not
 * a function`), which here is the helper's code (`$s$j.call2(...)`, or
 * "Function.prototype.apply was called on undefined" from the helper's own
 * apply). The wording is taken from a real error of this V8: the operation
 * that fails is done again in the bundle on a marker expression
 * (`this.zz$v`), whose printed form is then replaced with the page's
 * expression printed the way V8 prints it (src/callPrinter.ts, from the
 * source the rewriter hands the helper). The error is made with the page's
 * realm's constructor (an about:blank child runs its creator's bundle), so
 * its stack is a fresh one, from which the inject's frames are dropped like
 * from any (Unroute).
 */

// taken when the bundle loads, before any page code could replace them
const ITERATOR = Symbol.iterator;
const NativeProxy = Proxy;
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

function messageOf(error: unknown): string {
	try {
		const message =
			typeof error === 'object' && error !== null
				? Reflect.get(error, 'message')
				: error;
		return typeof message === 'string' ? message : String(message);
	} catch (failure) {
		return '';
	}
}

/**
 * The shapes a value is iterated in, each probed the way the page's
 * expression is: what V8 says differs by shape, by value and by the
 * expression (measured: a for-of names a member, `const [a] = o.b` names
 * nothing, `const [a] = b` names `b`, a call is "f is not a function or its
 * return value is not iterable", spread arguments say what they say).
 * `bare`: an expression that is a name, `this` or a literal
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

export default class ErrorMessages {
	#client: Client;
	#TypeError: ErrorConstructor;
	/** the template of each kind, `[before, after]` the printed expression */
	#templates = new Map<Probe, [string, string] | null>();
	#printed = new Map<string, string | null>();
	constructor(client: Client) {
		this.#client = client;
		this.#TypeError = (client.global as unknown as typeof globalThis)
			.TypeError as ErrorConstructor;
	}
	/** the page's TypeError with `message` */
	error(message: string): Error {
		return new this.#TypeError(message);
	}
	/** a part of a page's expression as V8 prints it (callPrinter.ts), cached */
	print(partial: unknown, part: string): string | null {
		if (typeof partial !== 'string') return null;
		const key = `${part}\u0000${partial}`;
		if (this.#printed.has(key)) return this.#printed.get(key)!;
		let printed: string | null = null;
		try {
			printed = printExpression(partial, part);
		} catch (error) {
			// no library to print with: the caller's fallback
		}
		if (this.#printed.size > ATTEMPTS) this.#printed.clear();
		this.#printed.set(key, printed);
		return printed;
	}
	/** a message of `probe`'s kind naming `printed`, null when it cannot say */
	#template(probe: Probe, marker: string, printed: string): string | null {
		let template = this.#templates.get(probe);
		if (template === undefined) {
			const message = messageOf(failure(probe));
			const at = message.indexOf(marker);
			template =
				at === -1
					? null
					: [message.slice(0, at), message.slice(at + marker.length)];
			this.#templates.set(probe, template);
		}
		return template ? template[0] + printed + template[1] : null;
	}
	/** the message `probe` fails with for `value`, naming `printed` for the marker */
	#measured(
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
	/** a member read of a null or undefined `target`, as V8 says it */
	read(target: unknown, key: unknown): Error {
		let message = '';
		try {
			void (target as any)[key as any];
		} catch (error) {
			message = messageOf(error);
		}
		return this.error(message);
	}
	/**
	 * `partial` (a call) calls `method`, which is no function: V8 names the
	 * callee, or (arguments spread other than once at the end) the call is
	 * an apply, with apply's error. A callable that is no function (an
	 * HTMLAllCollection) is called.
	 */
	call(method: unknown, that: unknown, args: unknown[], partial: unknown) {
		let applied: unknown;
		try {
			return Reflect.apply(method as Function, that, args);
		} catch (error) {
			applied = error;
		}
		const callee = this.print(partial, 'callee');
		if (callee === null || this.print(partial, 'spread') === '1')
			throw this.error(messageOf(applied));
		throw this.error(this.#template(CALL, VALUE, callee) ?? messageOf(applied));
	}
	/**
	 * A rewritten `x.postMessage(...)` (`.call`, `.apply`, `Reflect.apply`
	 * forms too) whose postMessage is no function: what the page's call does
	 * with it, or throws
	 */
	post(method: unknown, that: unknown, args: unknown[], partial: unknown) {
		const callee = this.print(partial, 'callee');
		const via = /\.(call|apply)$/.exec(callee ?? '')?.[1];
		if (callee === null || callee === 'Reflect.apply' || !via)
			return this.call(method, that, args, partial);
		if (method === null || method === undefined) throw this.read(method, via);
		const fn = (method as any)[via];
		if (typeof fn === 'function')
			return Reflect.apply(
				fn,
				method,
				via === 'call' ? [that, ...args] : [that, args],
			);
		throw this.error(
			this.#template(CALL, VALUE, callee) ?? `${callee} is not a function`,
		);
	}
	/** `new` of `partial` constructs `target`, which may be no constructor */
	construct(target: unknown, args: unknown[], partial: unknown): unknown {
		try {
			return Reflect.construct(target as Function, args);
		} catch (error) {
			if (isConstructor(target)) throw error;
			const callee = this.print(partial, 'callee');
			if (callee === null || this.print(partial, 'spread') === '1')
				throw this.error(messageOf(error));
			throw this.error(
				this.#template(CONSTRUCT, VALUE, callee) ?? messageOf(error),
			);
		}
	}
	/**
	 * A plain call of `callee` (`location()`, `o[k](a)(b)`): its value came
	 * out of a helper, which V8 would print in its message
	 */
	callValue(callee: unknown, args: unknown[], partial: unknown): unknown {
		if (typeof callee === 'function')
			return Reflect.apply(callee, undefined, args);
		let applied: unknown;
		try {
			return Reflect.apply(callee as Function, undefined, args);
		} catch (error) {
			applied = error;
		}
		const printed = this.print(partial, 'callee');
		if (printed === null || this.print(partial, 'spread') === '1')
			throw this.error(messageOf(applied));
		throw this.error(
			this.#template(CALL, VALUE, printed) ?? messageOf(applied),
		);
	}
	/**
	 * `value` is iterated by `shape` (ITERATE) in `partial`: what V8 says
	 * when it is not iterable, naming the expression (or the callee of a
	 * call: "f is not a function or its return value is not iterable")
	 */
	iterate(value: unknown, shape: unknown, partial: unknown): unknown {
		const probes = ITERATE[String(shape)];
		if (!probes) return value;
		try {
			if (
				value !== null &&
				value !== undefined &&
				typeof (value as any)[ITERATOR] === 'function'
			)
				return value;
		} catch (error) {
			// a getter that throws: the page's iteration throws it again
			return value;
		}
		// (unparsable: the page's own iteration throws what it throws)
		const type = this.print(partial, 'type');
		if (type === null) return value;
		if (type === 'CallExpression') {
			const callee = this.print(partial, 'callee')!;
			throw this.error(this.#measured(probes.call, value, FUNCTION, callee));
		}
		const printed = this.print(partial, 'value')!;
		if (probes.bare && BARE.includes(type))
			throw this.error(this.#measured(probes.bare, value, THIS, printed, true));
		throw this.error(this.#measured(probes.value, value, VALUE, printed));
	}
	/**
	 * `value` is destructured by the pattern of `partial` (`{ a } = v`): what
	 * V8 says when it is null or undefined. A destructured parameter (the
	 * rewriter declares its pattern from the parameter, which it names
	 * `<access>a<n>`) is named by its value, as V8 does.
	 */
	coerce(value: unknown, partial: unknown): unknown {
		if (value !== null && value !== undefined) return value;
		const key = this.print(partial, 'key');
		const printed = this.print(partial, 'init');
		if (key === null || printed === null) return value;
		const parameter = `${this.#client.names.access}a`;
		const message =
			printed.startsWith(parameter) &&
			/^\d+$/.test(printed.slice(parameter.length))
				? this.#measured(DESTRUCTURE_PARAMETER, value, KEY, key)
				: key
					? this.#measured(DESTRUCTURE, value, VALUE, printed).replace(KEY, key)
					: this.#measured(DESTRUCTURE_EMPTY, value, VALUE, printed);
		throw this.error(message);
	}
}

const CONSTRUCT_TRAP = { construct: () => ({}) };

/**
 * Whether `value` can be constructed, without running anything of it: a
 * Proxy of a constructor is one (whose own trap answers), of anything else
 * is not
 */
function isConstructor(value: unknown): boolean {
	if (typeof value !== 'function') return false;
	try {
		Reflect.construct(new NativeProxy(value, CONSTRUCT_TRAP), []);
		return true;
	} catch (error) {
		return false;
	}
}
