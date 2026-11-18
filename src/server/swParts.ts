// The service worker's parts (build.js SW_PARTS): data a worker may never
// read, which its script carries as text and parses the first time
// something asks for it. Chrome compiles every function of a service
// worker's script when it installs it, and serializes all of it into the
// script's code cache before it dispatches the install event: on a first
// visit both are on the way from register() to the controller, and every
// start after that deserializes and runs what the file holds, its literals
// among them. A part's text is in a comment of the script, which neither
// the compiler nor the cache reads. The comment is the script's own, so a
// part is always this build's, and reading it compiles nothing: a part is
// never code to evaluate (a host whose policy forbids compiling strings,
// which forbids the wasm modules too, runs on what the parts hold).
//
// build.js writes the comment as the body of `__stompSwParts`, a function
// declared in the bundle's scope: each part is `\u0002<name>\u0003<text>`,
// with every `*/` written `*\u0001/`.

/** the function whose comment holds the parts (build.js swPartsHolder) */
declare function __stompSwParts(): void;

/** the marks of the holder's comment (build.js SW_PART_NAME, SW_PART_TEXT, SW_PART_CLOSE) */
const NAME = '\u0002';
const TEXT = '\u0003';
const CLOSE = '*\u0001/';

/**
 * The text of the part `name`, as build.js wrote it; read anew at each
 * call (whoever asks keeps what it made of it)
 */
export function swPart(name: string): string {
	const holder = Function.prototype.toString.call(__stompSwParts);
	const mark = `${NAME}${name}${TEXT}`;
	const at = holder.indexOf(mark);
	if (at < 0)
		throw new Error(`STomp: the service worker carries no part '${name}'`);
	const from = at + mark.length;
	let to = holder.indexOf(NAME, from);
	if (to < 0) to = holder.lastIndexOf('*/');
	return holder.slice(from, to).replaceAll(CLOSE, '*/');
}
