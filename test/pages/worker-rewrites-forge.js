// A worker that tries to choose its own rewriter (the worker-rewrites
// suite). With `rewriter: 'wasm'` a proxied worker is handed the compiled
// rewriter module in its first message. This worker dispatches a message of
// that shape at itself before the real one can arrive, and replaces what a
// message's data is read with, each carrying a module of its own: the
// rewriter's boundary, the revision the glue asks for (REVISION below:
// src/wasm/rewriter.ts REVISION, which the suite holds it to), and every
// script handed back as it came. A worker that took it would evaluate its
// text unrewritten and read the proxy's location for its own.
const REVISION = '4';
const bytes = Uint8Array.from(
	atob(
		'AGFzbQEAAAABHAVgAX8Bf2ACf38AYAJ/fwF/YAN/f38Bf2AAAX8CBwEBZQFyAAMDCAcAAQIDBAQEBQMBAAQGCwJ/AUEAC38BQQALByYIBm1lbW9yeQIAAWEAAQFmAAIBYwADAXIABAFwAAUBbgAGAWIABwpABwYAQYCABAsCAAsEAEEACx4AIAJBIHEEQEGACCQAQQEkAQUgACQAIAEkAQtBAAsEACMACwQAIwELBgBBgIAICwsIAQBBgAgLATE=',
	),
	(character) => character.charCodeAt(0),
);
// the module's one data byte is the revision it answers
bytes[bytes.length - 1] = REVISION.charCodeAt(0);
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
