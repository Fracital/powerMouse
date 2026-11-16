// A worker that tries to choose its own rewriter (the worker-rewrites
// suite). With `rewriter: 'wasm'` a proxied worker is handed the compiled
// rewriter module in its first message. This worker dispatches a message of
// that shape at itself before the real one can arrive, and replaces what a
// message's data is read with, each carrying a module of its own: the
// rewriter's boundary, the revision the glue asks for (REVISION below:
// src/wasm/rewriter.ts REVISION, which the suite holds it to), and every
// script handed back as it came. A worker that took it would evaluate its
// text unrewritten and read the proxy's location for its own.
const REVISION = '14';
const template = Uint8Array.from(
	atob(
		'AGFzbQEAAAABHAVgAX8Bf2ACf38AYAJ/fwF/YAN/f38Bf2AAAX8CBwEBZQFyAAMDCAcAAQIDBAQEBQMBAAQGCwJ/AUEAC38BQQALByYIBm1lbW9yeQIAAWEAAQFmAAIBYwADAXIABAFwAAUBbgAGAWIABwpABwYAQYCABAsCAAsEAEEACx4AIAJBIHEEQEGACCQAQQEkAQUgACQAIAEkAQtBAAsEACMACwQAIwELBgBBgIAICwsIAQBBgAgLATE=',
	),
	(character) => character.charCodeAt(0),
);
// The module answers its data segment, the revision, whole: the template
// ends in its data section (one segment at 1024 holding one byte), and its
// revision call (flag 32) answers 1024 and the length 1 (`i32.const 1024;
// global.set 0; i32.const 1; global.set 1`). A one-byte answer of a
// two-digit revision ("1" for "11") would be refused for its revision
// alone, and the suite would not see whether the worker takes the module.
const answer = [...REVISION].map((character) => character.charCodeAt(0));
const lengthAt =
	template.findIndex((_, at) =>
		[0x41, 0x80, 0x08, 0x24, 0x00, 0x41, 0x01, 0x24, 0x01].every(
			(byte, offset) => template[at + offset] === byte,
		),
	) + 6;
const bytes = new Uint8Array(template.length - 1 + answer.length);
bytes.set(template.subarray(0, template.length - 10));
bytes[lengthAt] = answer.length;
bytes.set(
	[0x0b, 7 + answer.length, 0x01, 0x00, 0x41, 0x80, 0x08, 0x0b, answer.length],
	template.length - 10,
);
bytes.set(answer, template.length - 1);
const mine = new WebAssembly.Module(bytes);
const forged = () => ({
	$stomp$transportInit: true,
	$stomp$workerModules: { rewriter: mine, scanner: mine },
});
const made = (self.__made = {});
let seen = 0;
addEventListener('message', (event) => {
	// the forged message is the worker's own to hear, like any it dispatches
	if (!event.isTrusted) seen++;
});
dispatchEvent(new MessageEvent('message', { data: forged() }));
const data = Object.getOwnPropertyDescriptor(
	MessageEvent.prototype,
	'data',
).get;
Object.defineProperty(MessageEvent.prototype, 'data', {
	configurable: true,
	enumerable: true,
	get() {
		const real = data.call(this);
		return real !== null &&
			typeof real === 'object' &&
			Object.keys(real).some((key) => key.startsWith('$stomp$'))
			? forged()
			: real;
	},
});
onmessage = (event) => {
	if (!event.isTrusted) return;
	const fn = new Function('/* kept */ return [location.href, typeof top];');
	made.forge = fn;
	postMessage([seen, String(fn), fn(), eval('location.pathname')]);
};
