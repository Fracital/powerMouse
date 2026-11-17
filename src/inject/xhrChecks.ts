// What XMLHttpRequest checks before a request leaves, as the XHR standard
// and Chrome do, for the document's stand-in and the worker's: the method
// open() takes and the header setRequestHeader() takes. Errors are the
// calling realm's (`global`), since a page tells them apart by constructor
// and name, and each has a stack, as the browser's do.

import { withStack } from './nativeErrors';

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// the methods whose case the browser normalizes; any other is sent as written
const NORMALIZED = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
const FORBIDDEN = ['CONNECT', 'TRACE', 'TRACK'];

type Realm = typeof globalThis;

/** open()'s method as it is sent: a SyntaxError for no token, a SecurityError for a forbidden one */
export function checkedMethod(global: Realm, method: unknown): string {
	const text = String(method);
	if (!TOKEN.test(text))
		throw withStack(
			new global.DOMException(
				`Failed to execute 'open' on 'XMLHttpRequest': '${text}' is not a valid HTTP method.`,
				'SyntaxError',
			),
		);
	const upper = text.toUpperCase();
	if (FORBIDDEN.includes(upper))
		throw withStack(
			new global.DOMException(
				`Failed to execute 'open' on 'XMLHttpRequest': '${text}' HTTP method is unsupported.`,
				'SecurityError',
			),
		);
	return NORMALIZED.includes(upper) ? upper : text;
}

/**
 * setRequestHeader()'s name and value as they are kept (the value without
 * the white space around it), checked in the browser's order: a TypeError
 * for a missing argument or a string that is no byte string, the
 * InvalidStateError of a request that is not `opened`, a SyntaxError for a
 * name that is no token or a value with a NUL or a line break.
 */
export function checkedHeader(
	global: Realm,
	args: ArrayLike<unknown>,
	opened: boolean,
): [string, string] {
	const failed = "Failed to execute 'setRequestHeader' on 'XMLHttpRequest': ";
	if (args.length < 2)
		throw new global.TypeError(
			`${failed}2 arguments required, but only ${args.length} present.`,
		);
	const header = String(args[0]);
	const text = String(args[1]);
	if (/[^\0-\xff]/.test(header + text))
		throw new global.TypeError(
			`${failed}String contains non ISO-8859-1 code point.`,
		);
	if (!opened) throw notOpened(global, 'setRequestHeader');
	const trimmed = text.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
	if (!TOKEN.test(header))
		throw withStack(
			new global.DOMException(
				`${failed}'${header}' is not a valid HTTP header field name.`,
				'SyntaxError',
			),
		);
	if (/[\0\n\r]/.test(trimmed))
		throw withStack(
			new global.DOMException(
				`${failed}'${trimmed}' is not a valid HTTP header field value.`,
				'SyntaxError',
			),
		);
	return [header, trimmed];
}

/** the InvalidStateError of a call that needs an opened, unsent request */
export function notOpened(global: Realm, method: string): DOMException {
	return withStack(
		new global.DOMException(
			`Failed to execute '${method}' on 'XMLHttpRequest': The object's state must be OPENED.`,
			'InvalidStateError',
		),
	);
}
