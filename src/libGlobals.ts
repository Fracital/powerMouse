// The globals the rewriter library (src/rewriterLib.ts) reads, injected into
// it by build.js the way the inject bundles' snapshots are: each is the realm
// the library was made for (`__stompRealm`, its factory's argument) or, when
// it was made without one, the library's own realm's, taken when the
// library is evaluated. The library is evaluated in a realm no page code
// runs in (a frame's top made it, src/inject/dom/rewriterRealm.ts), which is
// then detached: a detached realm still runs its code, but its DOM globals
// (URL, atob, TextEncoder) are gone unless taken while it was attached.
// In a frame that makes its own copy the realm is the inject's snapshot,
// taken before the page ran.
//
// Every name the inject bundles inject is listed, so the library's code
// names none of them and stays the same text wherever it is evaluated.

declare const __stompRealm: Record<string, any> | undefined;

const realm: Record<string, any> =
	typeof __stompRealm === 'object' && __stompRealm !== null
		? __stompRealm
		: globalThis;
const take = (name: string) => realm[name] ?? (globalThis as any)[name];

export const URL: typeof globalThis.URL = take('URL');
export const atob: typeof globalThis.atob = take('atob');
export const btoa: typeof globalThis.btoa = take('btoa');
export const TextEncoder: typeof globalThis.TextEncoder = take('TextEncoder');
export const TextDecoder: typeof globalThis.TextDecoder = take('TextDecoder');
/**
 * meriyah clones an identifier or a string literal it reads twice (`{ a }`
 * is a key and a value) with structuredClone, which a detached realm still
 * has but which answers undefined there. Its nodes are plain data: a deep
 * copy of objects and arrays is the same clone.
 */
function cloneData<T>(value: T): T {
	if (typeof value !== 'object' || value === null) return value;
	if (Array.isArray(value)) return value.map(cloneData) as T;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(value))
		copy[key] = cloneData((value as Record<string, unknown>)[key]);
	return copy as T;
}
export const structuredClone = cloneData as typeof globalThis.structuredClone;
export const Reflect: typeof globalThis.Reflect = take('Reflect');
// (the wasm rewriter's instance is made in this realm from a module it is
// handed, src/rewriterLib.ts adopt)
export const WebAssembly: typeof globalThis.WebAssembly = take('WebAssembly');
export const Function: typeof globalThis.Function = take('Function');
export const fetch: typeof globalThis.fetch = take('fetch');
export const Request: typeof globalThis.Request = take('Request');
export const Response: typeof globalThis.Response = take('Response');
export const XMLHttpRequest: typeof globalThis.XMLHttpRequest =
	take('XMLHttpRequest');
export const XMLHttpRequestEventTarget: typeof globalThis.XMLHttpRequestEventTarget =
	take('XMLHttpRequestEventTarget');
export const EventSource: typeof globalThis.EventSource = take('EventSource');
export const WebSocket: typeof globalThis.WebSocket = take('WebSocket');
export const DOMParser: typeof globalThis.DOMParser = take('DOMParser');
export const navigator: typeof globalThis.navigator = take('navigator');
export const postMessage: typeof globalThis.postMessage = take('postMessage');

/**
 * Every global taken above, by name: what a library evaluated later in this
 * realm is made with (the light library hands them to the rewriter library
 * it loads, src/rewriterLight.ts). By then the realm may be detached, and
 * what it would look up itself is gone.
 */
export const realmGlobals: Record<string, unknown> = {
	URL,
	atob,
	btoa,
	TextEncoder,
	TextDecoder,
	Reflect,
	WebAssembly,
	Function,
	fetch,
	Request,
	Response,
	XMLHttpRequest,
	XMLHttpRequestEventTarget,
	EventSource,
	WebSocket,
	DOMParser,
	navigator,
	postMessage,
};

/**
 * What the library logs, kept for the realm that asked (it replays the
 * messages after the call): the library never calls out, so no code of the
 * caller's, which a page can reach, runs while the library's is on the stack.
 */
export const messages: [level: 'log' | 'warn' | 'error', text: string][] = [];
const logger =
	(level: 'log' | 'warn' | 'error') =>
	(...args: unknown[]) => {
		messages.push([level, args.map((arg) => String(arg)).join(' ')]);
	};
export const console = {
	log: logger('log'),
	info: logger('log'),
	debug: logger('log'),
	warn: logger('warn'),
	error: logger('error'),
};
