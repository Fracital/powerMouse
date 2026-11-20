// What the runtime talks and schedules over, taken as this file runs: the
// shell loads the runtime before the inject bundle, so these are the
// browser's own, not the inject's hooks of them (a BroadcastChannel the
// inject partitions, a fetch it routes) nor anything the page does later.
const global = globalThis as typeof globalThis & Record<string, unknown>;

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

const uuid = global.crypto?.randomUUID?.bind(global.crypto);

export const natives = {
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
	Promise: global.Promise,
	JSON: { parse: JSON.parse, stringify: JSON.stringify },
	Error: global.Error,
	TypeError: global.TypeError,
	Reflect: { apply: Reflect.apply, defineProperty: Reflect.defineProperty },
	defineProperty: Object.defineProperty,
	CSSStyleSheet: global.CSSStyleSheet,
	document: global.document,
	documentOpen: global.Document.prototype.open,
	documentWrite: global.Document.prototype.write,
	getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
	querySelector: global.Document.prototype.querySelector,
	querySelectorAll: global.Document.prototype.querySelectorAll,
	getAttribute: global.Element.prototype.getAttribute,
	createElement: global.Document.prototype.createElement,
	appendChild: global.Node.prototype.appendChild,
	removeChild: global.Node.prototype.removeChild,
	addEventListener: global.EventTarget.prototype.addEventListener,
	setAttribute: global.Element.prototype.setAttribute,
	/** the window's real name: the inject shadows it for a frame the host made */
	windowName: getter<string>(global, 'name'),
	readyState: getter<DocumentReadyState>(
		global.Document.prototype,
		'readyState',
	),
	currentScript: getter<HTMLScriptElement | null>(
		global.Document.prototype,
		'currentScript',
	),
	scriptSrc: getter<string>(global.HTMLScriptElement.prototype, 'src'),
	documentElement: getter<Element | null>(
		global.Document.prototype,
		'documentElement',
	),
	adoptedStyleSheets: Object.getOwnPropertyDescriptor(
		global.Document.prototype,
		'adoptedStyleSheets',
	),
	scrollHeight: getter<number>(global.Element.prototype, 'scrollHeight'),
	language: global.navigator.language,
	languages: [...(global.navigator.languages ?? [])],
	userAgent: global.navigator.userAgent,
	close: global.close?.bind(global),
};

export const call = <T>(fn: Function, that: unknown, ...args: unknown[]): T =>
	natives.Reflect.apply(fn, that, args) as T;
