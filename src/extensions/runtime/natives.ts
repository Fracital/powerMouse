// What the runtime talks and schedules over. The page's runtime takes them
// as its file runs: the shell loads the runtime before the inject bundle, so
// these are the browser's own, not the inject's hooks of them (a
// BroadcastChannel the inject partitions, a fetch it routes) nor anything
// the page does later. An isolated world's copy of the runtime
// (./world/entry.ts) runs in a realm of its own whose window has no
// document: it is handed the page's (its web members) with its own realm's
// JavaScript members, and with `callback`, which makes a function of the
// world's one the page's realm calls (the browser drops a call into a realm
// whose frame is gone).
type Global = typeof globalThis & Record<string, unknown>;

function getter<T>(target: object, name: string): (that: unknown) => T {
	let object: object | null = target;
	while (object) {
		const descriptor = Object.getOwnPropertyDescriptor(object, name);
		if (descriptor?.get) {
			const get = descriptor.get;
			return (that) => Reflect.apply(get, that, []) as T;
		}
		object = Object.getPrototypeOf(object);
	}
	return (that) => (that as Record<string, T>)[name];
}

/** a function as itself (the page's realm calls its own) */
const same = <T extends Function>(fn: T): T => fn;

/** the web members of `global`, a window (a document's, or the page's of an isolated world) */
export function webNatives(global: Global) {
	const uuid = global.crypto?.randomUUID?.bind(global.crypto);
	const Document = global.Document as typeof globalThis.Document;
	const Element = global.Element as typeof globalThis.Element;
	const Node = global.Node as typeof globalThis.Node;
	return {
		/** the window the runtime works in (the page's, in an isolated world) */
		global,
		BroadcastChannel: global.BroadcastChannel,
		/** an id as Chrome makes one for a notification (a secure context's UUID) */
		randomUUID: (): string =>
			uuid?.() ??
			`${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
		fetch: global.fetch.bind(global),
		setTimeout: global.setTimeout.bind(global),
		clearTimeout: global.clearTimeout.bind(global),
		setInterval: global.setInterval.bind(global),
		clearInterval: global.clearInterval.bind(global),
		structuredClone: (global.structuredClone as typeof structuredClone).bind(
			global,
		),
		URL: global.URL as typeof URL,
		console: {
			error: global.console.error.bind(global.console),
			warn: global.console.warn.bind(global.console),
		},
		CSSStyleSheet: global.CSSStyleSheet,
		document: global.document,
		/** the real Location (the inject tags it with its stand-in) */
		location: global.location as Location,
		documentOpen: Document.prototype.open,
		documentWrite: Document.prototype.write,
		querySelector: Document.prototype.querySelector,
		querySelectorAll: Document.prototype.querySelectorAll,
		getAttribute: Element.prototype.getAttribute,
		createElement: Document.prototype.createElement,
		appendChild: Node.prototype.appendChild,
		removeChild: Node.prototype.removeChild,
		addEventListener: (global.EventTarget as typeof EventTarget).prototype
			.addEventListener,
		removeEventListener: (global.EventTarget as typeof EventTarget).prototype
			.removeEventListener,
		dispatchEvent: (global.EventTarget as typeof EventTarget).prototype
			.dispatchEvent,
		EventTarget: global.EventTarget as typeof EventTarget,
		Event: global.Event as typeof Event,
		MessageEvent: global.MessageEvent as typeof MessageEvent,
		Request: global.Request as typeof Request,
		Response: global.Response as typeof Response,
		stopImmediatePropagation: (global.Event as typeof Event).prototype
			.stopImmediatePropagation,
		DOMException: global.DOMException as typeof DOMException,
		setAttribute: Element.prototype.setAttribute,
		localName: getter<string>(Element.prototype, 'localName'),
		attachShadow: Element.prototype.attachShadow,
		/** the window's real name: the inject shadows it for a frame the host made */
		windowName: getter<string>(global, 'name'),
		readyState: getter<DocumentReadyState>(Document.prototype, 'readyState'),
		currentScript: getter<HTMLScriptElement | null>(
			Document.prototype,
			'currentScript',
		),
		scriptSrc: getter<string>(
			(global.HTMLScriptElement as typeof HTMLScriptElement).prototype,
			'src',
		),
		documentElement: getter<Element | null>(
			Document.prototype,
			'documentElement',
		),
		contentWindow: getter<Window | null>(
			(global.HTMLIFrameElement as typeof HTMLIFrameElement).prototype,
			'contentWindow',
		),
		adoptedStyleSheets: Object.getOwnPropertyDescriptor(
			Document.prototype,
			'adoptedStyleSheets',
		),
		scrollHeight: getter<number>(Element.prototype, 'scrollHeight'),
		language: (global.navigator as Navigator).language,
		languages: [...((global.navigator as Navigator).languages ?? [])],
		userAgent: (global.navigator as Navigator).userAgent,
		close: (global.close as (() => void) | undefined)?.bind(global),
		/** what makes a function of this realm's the page's realm calls */
		callback: same as <T extends Function>(fn: T, named?: Function) => T,
	};
}

/** the JavaScript members of `realm`, a global (the world's own, in an isolated world) */
export function scriptNatives(realm: Global) {
	return {
		Promise: realm.Promise as PromiseConstructor,
		JSON: {
			parse: (realm.JSON as JSON).parse,
			stringify: (realm.JSON as JSON).stringify,
		},
		Error: realm.Error as ErrorConstructor,
		TypeError: realm.TypeError as TypeErrorConstructor,
		Reflect: {
			apply: (realm.Reflect as typeof Reflect).apply,
			defineProperty: (realm.Reflect as typeof Reflect).defineProperty,
		},
		/** the browser's: the inject's hides its own keys from the page */
		ownKeys: (realm.Reflect as typeof Reflect).ownKeys,
		defineProperty: (realm.Object as ObjectConstructor).defineProperty,
		setPrototypeOf: (realm.Object as ObjectConstructor).setPrototypeOf,
		getOwnPropertyDescriptor: (realm.Object as ObjectConstructor)
			.getOwnPropertyDescriptor,
	};
}

export type Natives = ReturnType<typeof webNatives> &
	ReturnType<typeof scriptNatives>;

/**
 * The runtime's natives: filled once, before anything reads them (the
 * page's runtime as its entry runs, a world's as it is made), so the
 * modules both share read them at their calls
 */
export const natives = {} as Natives;

export function useNatives(given: Natives) {
	Object.assign(natives, given);
}

export const call = <T>(fn: Function, that: unknown, ...args: unknown[]): T =>
	natives.Reflect.apply(fn, that, args) as T;

/**
 * Show a function the runtime defines in a page as the native `name`
 * (`get href`, `postMessage`): the inject's toString answers for it as for
 * its own hooks. The inject hands this over as it loads, after the runtime
 * (src/inject/modules/Proxy.ts); until then, and in a realm it does not
 * hook, nothing changes.
 */
export const masking = {
	native: (() => {}) as (fn: Function, name: string) => void,
};

/** listen on a target of the page's with a function of this realm's */
export function listen(
	target: unknown,
	type: string,
	fn: (event: any) => void,
	options?: AddEventListenerOptions,
) {
	call(natives.addEventListener, target, type, natives.callback(fn), options);
}
