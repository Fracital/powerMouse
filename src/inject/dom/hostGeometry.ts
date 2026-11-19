// A proxied document's window as a top-level page's: outerWidth,
// outerHeight, screenX, screenY, screenLeft and screenTop. Natively every
// frame reads the top-level window's, and a page the host frames is a
// top-level page to itself, so its window is the browser's window less the
// host's UI around the host's frame (src/controller/geometry.ts): its outer
// size is its viewport plus the browser's own UI, and its position is the
// browser window's moved by where the frame is in the host's viewport. A
// frame nested in it reads the same as it does, as natively.
//
// The browser window's own outer size and position were what the page read
// before (they were the frame's inner size at 0,0 earlier still, a window
// with no toolbar, which a real one never is outside fullscreen: the outer
// size is kept a toolbar taller than the viewport, as the browser's is).
// With them the host's bars read as browser UI: the demo's two 48 px bars
// made outerHeight - innerHeight about 200 in a normal window, and Discord,
// which takes more than 160 for its devtools docked, took its token out of
// storage on every load.
//
// Read from the window that keeps the host's geometry for the documents of
// this origin (HOST_GEOMETRY: the host's page, the controller frame, a
// slot's agent), found as siteWindows' slotAgentShare finds a slot's agent,
// at a page's first read and again when it goes; without one (a window of
// its own, a popup, or a host that keeps none) the browser's answers. The
// viewport is read when the page asks, so a resize reads as natively at
// once: the browser's UI does not change with it.
import { HOST_GEOMETRY, type HostGeometry } from '../../config';
import type ProxyModule from '../modules/Proxy';
import type DocumentClient from './Client';
import { nativeLength, nativeParent, nativeTopOf } from './siteWindows';

/** how many windows a search for the geometry's window reads at most */
const SEARCH = 64;
/** how long a document that found none asks again no sooner (ms) */
const SEARCH_AGAIN = 1000;
const MEMBERS = [
	'outerWidth',
	'outerHeight',
	'screenX',
	'screenY',
	'screenLeft',
	'screenTop',
];

/** hook `client`'s window's outer size and screen position (a document below another window) */
export function hostGeometry(client: DocumentClient, proxyModule: ProxyModule) {
	const global = client.global;
	const clientName = client.names.client;
	const accessor = (name: string) => {
		let owner: object | null = global;
		while (owner && !Reflect.getOwnPropertyDescriptor(owner, name))
			owner = Reflect.getPrototypeOf(owner);
		return owner
			? ([owner, Reflect.getOwnPropertyDescriptor(owner, name)!] as const)
			: null;
	};
	const innerWidth = accessor('innerWidth')?.[1].get;
	const innerHeight = accessor('innerHeight')?.[1].get;
	const found = MEMBERS.map(accessor);
	const natives = found.map((entry) => entry?.[1].get);
	if (!innerWidth || !innerHeight || !natives[0] || !natives[1]) return;

	/** the geometry `window` keeps for this document, when it is a window that may */
	const keptBy = (window: object) => {
		const value = Reflect.getOwnPropertyDescriptor(window, HOST_GEOMETRY);
		// never a document's (a page could make the property on its window)
		return value &&
			'value' in value &&
			!Reflect.getOwnPropertyDescriptor(window, clientName)
			? (value.value as HostGeometry)
			: undefined;
	};
	/** the window that keeps it: the real top, else a frame of it or of one of its frames */
	const search = (top: object): object | null => {
		try {
			if (top !== global && keptBy(top)) return top;
		} catch (error) {
			// another origin's (the host's page in isolation mode, the hub's)
		}
		let level: object[] = [top];
		let read = 0;
		for (let depth = 0; depth < 2 && read < SEARCH; depth++) {
			const below: object[] = [];
			for (const parent of level) {
				const count = Number(Reflect.apply(nativeLength!, parent, [])) || 0;
				for (let i = count - 1; i >= 0 && read < SEARCH; i--) {
					read++;
					const child = Reflect.get(parent, i) as object | undefined;
					if (!child || child === global) continue;
					try {
						if (keptBy(child)) return child;
					} catch (error) {
						// another origin's: the controller frame, a slot's
						below.push(child);
					}
				}
			}
			level = below;
		}
		return null;
	};

	// this document's window right below the real top: the host's frame
	let frame: object | null | undefined;
	let index = -1;
	let holder: object | null = null;
	let searched = -Infinity;
	/** [outerWidth, outerHeight, screen x offset, screen y offset], or null for the browser's */
	const read = (): readonly [number, number, number, number] | null => {
		try {
			const top = Reflect.apply(nativeTopOf!, global, []) as object;
			if (frame === undefined) {
				frame = null;
				let window: object = global;
				for (let depth = 0; depth < SEARCH; depth++) {
					const parent = Reflect.apply(nativeParent!, window, []) as object;
					if (parent === top) {
						frame = window;
						break;
					}
					if (!parent || parent === window) break;
					window = parent;
				}
			}
			if (!frame) return null;
			if (index === -1 || Reflect.get(top, index) !== frame) {
				index = -1;
				const count = Number(Reflect.apply(nativeLength!, top, [])) || 0;
				for (let i = 0; i < count; i++)
					if (Reflect.get(top, i) === frame) {
						index = i;
						break;
					}
				if (index === -1) return null;
			}
			let geometry: HostGeometry | undefined;
			try {
				geometry = holder ? keptBy(holder) : undefined;
			} catch (error) {
				// the window went away
			}
			if (!geometry) {
				const now = Date.now();
				if (now - searched < SEARCH_AGAIN) return null;
				searched = now;
				holder = search(top);
				geometry = holder ? keptBy(holder) : undefined;
			}
			const entry = geometry?.frames[index];
			if (!geometry || !entry) return null;
			// the frame's viewport, read in its own document (or, one of
			// another origin, the window's outer size less the host's UI)
			try {
				return [
					Number(Reflect.apply(innerWidth, frame, [])) + geometry.chrome[0],
					Number(Reflect.apply(innerHeight, frame, [])) + geometry.chrome[1],
					entry[0],
					entry[1],
				];
			} catch (error) {
				return [
					Number(Reflect.apply(natives[0]!, global, [])) - entry[2],
					Number(Reflect.apply(natives[1]!, global, [])) - entry[3],
					entry[0],
					entry[1],
				];
			}
		} catch (error) {
			return null;
		}
	};
	// one body for the six getters, told apart by their natives
	const body = (target: Function, that: unknown, args: unknown[]) => {
		const native = Reflect.apply(target, that, args);
		if (that !== global || typeof native !== 'number') return native;
		const geometry = read();
		if (!geometry) return native;
		let member = 0;
		while (member < natives.length && natives[member] !== target) member++;
		if (member === natives.length) return native;
		return member < 2 ? geometry[member] : native + geometry[2 + (member % 2)];
	};
	found.forEach((entry, member) => {
		if (!entry?.[1].get) return;
		Reflect.defineProperty(entry[0], MEMBERS[member], {
			...entry[1],
			get: proxyModule.wrapFunction(entry[1].get, body),
		});
	});
}
