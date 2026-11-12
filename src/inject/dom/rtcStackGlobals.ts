// The globals of the WebRTC stand-in library (rtcStack.ts): esbuild injects
// these where its code names them, as it injects the inject bundle's
// snapshots (../snapshot.ts, snapshot.ts) into that bundle. They are the
// bundle's own, handed over as `__stompRtcSnap` when the inject's WebRTC
// module evaluates the file: taken when the bundle loaded, before any page
// script, not when the library is evaluated.
declare const __stompRtcSnap: {
	Reflect: typeof globalThis.Reflect;
	Function: typeof globalThis.Function;
	fetch: typeof globalThis.fetch;
	URL: typeof globalThis.URL;
	Request: typeof globalThis.Request;
	Response: typeof globalThis.Response;
	XMLHttpRequest: typeof globalThis.XMLHttpRequest;
	XMLHttpRequestEventTarget: typeof globalThis.XMLHttpRequestEventTarget;
	EventSource: typeof globalThis.EventSource;
	WebSocket: typeof globalThis.WebSocket;
	bindDescriptors: Function;
	DOMParser: typeof globalThis.DOMParser;
	navigator: Navigator;
	postMessage: typeof globalThis.postMessage;
};
export const Reflect = __stompRtcSnap.Reflect;
export const Function = __stompRtcSnap.Function;
export const fetch = __stompRtcSnap.fetch;
export const URL = __stompRtcSnap.URL;
export const Request = __stompRtcSnap.Request;
export const Response = __stompRtcSnap.Response;
export const XMLHttpRequest = __stompRtcSnap.XMLHttpRequest;
export const XMLHttpRequestEventTarget =
	__stompRtcSnap.XMLHttpRequestEventTarget;
export const EventSource = __stompRtcSnap.EventSource;
export const WebSocket = __stompRtcSnap.WebSocket;
export const bindDescriptors = __stompRtcSnap.bindDescriptors;
export const DOMParser = __stompRtcSnap.DOMParser;
export const navigator = __stompRtcSnap.navigator;
export const postMessage = __stompRtcSnap.postMessage;
