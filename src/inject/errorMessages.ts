import { accessFailureParts } from './accessFailureParts';
import type { accessFailures } from './accessFailures';
import type Client from './Client';
import { LazyMap } from './ownCollections';

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

/** the shapes a value is iterated in (./accessFailures.ts ITERATE) */
const SHAPES = ['of', 'spread', 'args', 'array', 'assign'];

export function messageOf(error: unknown): string {
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

export default class ErrorMessages {
	readonly client: Client;
	#TypeError: ErrorConstructor;
	/** the template of each kind, `[before, after]` the printed expression (./accessFailures.ts) */
	readonly templates = new LazyMap<object, [string, string] | null>();
	/** the parts of the page's expressions printed (./accessFailures.ts) */
	readonly printed = new LazyMap<string, string | null>();
	constructor(client: Client) {
		this.client = client;
		this.#TypeError = (client.global as unknown as typeof globalThis)
			.TypeError as ErrorConstructor;
	}
	/** the page's TypeError with `message` */
	error(message: string): Error {
		return new this.#TypeError(message);
	}
	/** the part that words a failure, null when it cannot be had */
	#failures(): typeof accessFailures | null {
		try {
			return accessFailureParts.failures!();
		} catch (error) {
			return null;
		}
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
	 * `partial` (a call) calls `method`, which may be no function: V8 names
	 * the callee (./accessFailures.ts). A callable that is no function (an
	 * HTMLAllCollection) is called.
	 */
	call(method: unknown, that: unknown, args: unknown[], partial: unknown) {
		let applied: unknown;
		try {
			return Reflect.apply(method as Function, that, args);
		} catch (error) {
			applied = error;
		}
		throw this.#failures()?.callee(this, false, applied, partial) ?? applied;
	}
	/** `new` of `partial` constructs `target`, which may be no constructor */
	construct(target: unknown, args: unknown[], partial: unknown): unknown {
		try {
			return Reflect.construct(target as Function, args);
		} catch (error) {
			if (isConstructor(target)) throw error;
			throw this.#failures()?.callee(this, true, error, partial) ?? error;
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
		throw this.#failures()?.callee(this, false, applied, partial) ?? applied;
	}
	/**
	 * `value` is iterated by `shape` in `partial`: what V8 says when it is
	 * not iterable, naming the expression (./accessFailures.ts)
	 */
	iterate(value: unknown, shape: unknown, partial: unknown): unknown {
		const name = String(shape);
		if (!SHAPES.includes(name)) return value;
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
		// (no part, or unparsable: the page's own iteration throws what it throws)
		const error = this.#failures()?.iterate(this, value, name, partial);
		if (error) throw error;
		return value;
	}
	/**
	 * `value` is destructured by the pattern of `partial` (`{ a } = v`): what
	 * V8 says when it is null or undefined (./accessFailures.ts)
	 */
	coerce(value: unknown, partial: unknown): unknown {
		if (value !== null && value !== undefined) return value;
		// (no part, or unparsable: the page's own pattern throws what it throws)
		const error = this.#failures()?.coerce(this, value, partial);
		if (error) throw error;
		return value;
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
