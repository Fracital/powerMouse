import type Client from './Client';
import type DocumentClient from './dom/Client';

// taken when the bundle loads, before any page code could replace it
const captureStackTrace = (
	Error as { captureStackTrace?: (target: object, ctor?: Function) => void }
).captureStackTrace;

/**
 * An exception the inject throws in the browser's place, given the stack a
 * thrown one has: V8 captures one for every DOMException the browser throws,
 * while one made with `new DOMException` has none, and a page reading
 * `error.stack` saw `undefined`. The inject's own frames are dropped from it
 * like from any stack (Unroute).
 */
export function withStack<T extends object>(error: T, skip = 0): T {
	if (skip) skippedFrames.set(error, skip);
	if (typeof captureStackTrace === 'function')
		Reflect.apply(captureStackTrace, undefined, [error]);
	return error;
}

/**
 * How many of the page's frames an error's stack leaves out: the browser's
 * error for a cross-origin property read or write has none for the function
 * that made the access (measured), and a stand-in throwing in its place
 * runs inside that function.
 */
export const skippedFrames = new WeakMap<object, number>();

const parses = (input: string, base: string) => {
	try {
		new URL(input, base);
		return true;
	} catch (error) {
		return false;
	}
};

/**
 * Whether the browser's own call would refuse `input` as a URL that does not
 * parse, against the page's URL and against the context's real base alike.
 * A hook then hands the input to the native API as it is, which throws (or
 * rejects with) the browser's own error, naming the input as the page wrote
 * it, where resolving it first threw URL's. Nothing loads: the browser
 * parses the URL before it fetches anything.
 */
export function failsToParse(client: Client, input: string): boolean {
	const base = client.isDOM
		? (client as DocumentClient).baseURI.href
		: client.global.location.href;
	return !parses(input, client.url.toString()) && !parses(input, base);
}
