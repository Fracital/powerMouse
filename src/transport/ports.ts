/**
 * MessageChannel and MessagePort as the browser made them, taken when the
 * bundle that imports this loads: in a page's realm, before any of the
 * page's script. STomp's own channels in a page (a document's transport,
 * the controller's wasm modules, permission verdicts, the emulated service
 * workers' calls, a WebSocket's frames, a body's chunks) are made, started,
 * listened to and closed with these, never with what the page can replace
 * by the time a channel is made (the prototypes' `port1` and `port2`
 * getters, `start`, `close`, `addEventListener`, the `onmessage` setter,
 * `MessageEvent.prototype.data`).
 *
 * A listener hears only trusted events: a message the browser delivered
 * from the port's other end. A page that reached one of these ports (a
 * hooked method's `this`) and dispatched a MessageEvent of its own on it
 * is not heard.
 */
type Getter = (this: unknown) => unknown;
type Method = (this: unknown, ...args: unknown[]) => unknown;

const taken = (() => {
	try {
		const getter = (from: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(from, name)!.get! as Getter;
		return {
			Channel: globalThis.MessageChannel,
			port1: getter(globalThis.MessageChannel.prototype, 'port1'),
			port2: getter(globalThis.MessageChannel.prototype, 'port2'),
			start: globalThis.MessagePort.prototype.start as Method,
			close: globalThis.MessagePort.prototype.close as Method,
			listen: globalThis.EventTarget.prototype.addEventListener as Method,
			data: getter(globalThis.MessageEvent.prototype, 'data'),
			ports: getter(globalThis.MessageEvent.prototype, 'ports'),
		};
	} catch (error) {
		// a realm with no MessageChannel
		return null;
	}
})();

/**
 * Whether events say who made them: in a browser `isTrusted` is each
 * event's own, unforgeable property, true for what the browser delivered.
 * A runtime that keeps it on Event.prototype (Node, where the suites run
 * the transport) delivers every message untrusted and has no page to keep
 * out. Decided as the bundle loads, before a page could add one.
 */
const checksTrust = (() => {
	try {
		return !Reflect.getOwnPropertyDescriptor(
			globalThis.Event.prototype,
			'isTrusted',
		);
	} catch (error) {
		return false;
	}
})();

/**
 * Events STomp dispatched again itself: a module worker holds the messages
 * that come before its bundle has loaded and dispatches them once it has
 * (src/inject/worker/Client.ts). A replay is as good as the event it
 * replays: marked only when that one was the browser's (or a marked replay).
 */
const replays = new WeakSet<Event>();

/** whether the browser delivered `event`, or STomp replayed one it did */
function delivered(event: Event): boolean {
	try {
		return !checksTrust || event.isTrusted === true || replays.has(event);
	} catch (error) {
		return false;
	}
}

/** `replay` is STomp's own dispatch of `original` again */
export function replayOf(original: Event, replay: Event): void {
	if (delivered(original)) replays.add(replay);
}

/** a new channel's two ends: [the end kept, the end handed over] */
export function privateChannel(): [MessagePort, MessagePort] {
	if (!taken) {
		const channel = new MessageChannel();
		return [channel.port1, channel.port2];
	}
	const channel = new taken.Channel();
	return [
		Reflect.apply(taken.port1, channel, []) as MessagePort,
		Reflect.apply(taken.port2, channel, []) as MessagePort,
	];
}

/**
 * A trusted message event's data and ports, read with the browser's own
 * getters; null for an event the browser did not deliver (a page's own
 * `dispatchEvent`; checksTrust).
 */
export function messageOf(
	event: Event,
): { data: unknown; ports: readonly MessagePort[] } | null {
	try {
		if (!delivered(event)) return null;
		return taken
			? {
					data: Reflect.apply(taken.data, event, []),
					ports: Reflect.apply(taken.ports, event, []) as MessagePort[],
				}
			: {
					data: (event as MessageEvent).data,
					ports: (event as MessageEvent).ports,
				};
	} catch (error) {
		return null;
	}
}

/** `addEventListener` as the browser made it */
export function listenOn(
	target: EventTarget,
	type: string,
	listener: (event: Event) => void,
): void {
	if (taken) Reflect.apply(taken.listen, target, [type, listener]);
	else target.addEventListener(type, listener);
}

/**
 * Listen on `port` for `type` and start it: `listener` is given each
 * trusted event's data and ports (none for `close`)
 */
export function onPort(
	port: MessagePort,
	type: 'message' | 'messageerror' | 'close',
	listener: (data: unknown, ports: readonly MessagePort[]) => void,
): void {
	listenOn(port, type, (event) => {
		if (type === 'close') {
			if (delivered(event)) listener(undefined, []);
			return;
		}
		const message = messageOf(event);
		if (message) listener(message.data, message.ports);
	});
	startPort(port);
}

export function startPort(port: MessagePort): void {
	if (taken) Reflect.apply(taken.start, port, []);
	else port.start();
}

export function closePort(port: MessagePort): void {
	try {
		if (taken) Reflect.apply(taken.close, port, []);
		else port.close();
	} catch (error) {
		// not a port any more
	}
}
