import {
	WEBRTC_CHANNEL,
	type WebRTCChannelMessage,
} from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

/*
 * WebRTC sends its packets itself, outside the proxy: a STUN or TURN server
 * the page names hears from the user's real address (and a STUN answer hands
 * the page that address as a srflx candidate), and a remote candidate the
 * page adds makes the browser send connectivity checks straight to it. The
 * page's peer connections stay real ones, but the browser never reaches a
 * server or a candidate the page chose: they see what a browser on a network
 * that drops every UDP packet would (docs/webrtc.md).
 *
 * - Each STUN/TURN server the page gives is handed to the browser as
 *   255.255.255.255 with a port of its own: sending there fails in the
 *   kernel, so nothing leaves the machine, and the browser times out exactly
 *   as it does when no answer comes (701 after about 40 s, gathering
 *   complete then). Its events and configuration read back the page's URL.
 * - A remote candidate is handed over only when its address is a host name
 *   a peer connection of this browser showed a page (two proxied pages can
 *   still talk); any other address (an IP, a host name, someone else's mDNS
 *   name) becomes 255.255.255.255 too, and reads back as the page gave it.
 * - Where the browser shows a host candidate's real address (the proxy
 *   origin was granted the camera or microphone), the page sees a random
 *   mDNS-style name for it instead, as it would without that permission.
 *
 * Everything here that runs while the page runs touches real addresses, so
 * it uses only natives taken when the bundle loads: a page that patches
 * String.prototype.split, Map.prototype.get, an iterator or
 * Object.prototype would otherwise see them or steer the gate.
 */

// natives taken when the bundle loads, before any page script runs
const NativeBroadcastChannel = globalThis.BroadcastChannel;
const nativeBroadcastPost = NativeBroadcastChannel?.prototype.postMessage;
const nativeAddListener = EventTarget.prototype.addEventListener;
const nativeEventData = Reflect.getOwnPropertyDescriptor(
	MessageEvent.prototype,
	'data',
)!.get!;
const NativeProxy = Proxy;
const NativePromise = Promise;
const promiseThen = Promise.prototype.then;
const NativeNumber = Number;
const numberIsFinite = Number.isFinite;
const mathTrunc = Math.trunc;
const isArray = Array.isArray;
const createObject = Object.create;
const NativeUint8Array = Uint8Array;
const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;
const getRandomValues = crypto.getRandomValues.bind(crypto);
const stringIndexOf = String.prototype.indexOf;
const stringLastIndexOf = String.prototype.lastIndexOf;
const stringSlice = String.prototype.slice;
const stringLower = String.prototype.toLowerCase;
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const weakHas = WeakMap.prototype.has;
const weakAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;

const indexOf = (text: string, part: string, from = 0): number =>
	Reflect.apply(stringIndexOf, text, [part, from]);
const lastIndexOf = (text: string, part: string): number =>
	Reflect.apply(stringLastIndexOf, text, [part]);
const slice = (text: string, start: number, end = text.length): string =>
	Reflect.apply(stringSlice, text, [start, end]);
const lower = (text: string): string => Reflect.apply(stringLower, text, []);
const startsWith = (text: string, prefix: string) =>
	slice(text, 0, prefix.length) === prefix;
const then = (
	promise: unknown,
	fulfilled: (value: any) => unknown,
	rejected: (error: any) => unknown,
) => Reflect.apply(promiseThen, promise, [fulfilled, rejected]);
/** a dictionary no page can reach into through Object.prototype */
const dictionary = <T>(): Record<string, T> => createObject(null);
/** append without an Array.prototype setter seeing it */
function push<T>(list: T[], value: T) {
	Reflect.defineProperty(list, list.length, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
function split(text: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (;;) {
		const end = indexOf(text, separator, start);
		if (end === -1) break;
		push(parts, slice(text, start, end));
		start = end + separator.length;
	}
	push(parts, slice(text, start));
	return parts;
}
function join(parts: string[], separator: string): string {
	let text = '';
	for (let i = 0; i < parts.length; i++)
		text += i ? separator + parts[i] : parts[i];
	return text;
}
/**
 * A list the browser reads as a WebIDL sequence through an iterator of its
 * own: Array.prototype[Symbol.iterator] and the array iterator's next are
 * the page's to patch
 */
function sequence<T>(items: T[]): T[] {
	const list: T[] = [];
	for (let i = 0; i < items.length; i++) push(list, items[i]);
	Reflect.defineProperty(list, Symbol.iterator, {
		value() {
			let index = 0;
			return {
				next: () =>
					index < list.length
						? { value: list[index++], done: false }
						: { value: undefined, done: true },
			};
		},
	});
	return list;
}

/** where the browser is sent instead: unreachable without SO_BROADCAST */
const NOWHERE = '255.255.255.255';
/** how long an mDNS name no bundle of this browser announced yet may take to be */
const ANNOUNCE_WAIT_MS = 200;
const HEX = '0123456789abcdef';

function isIPv4(host: string) {
	let dots = 0;
	let digits = 0;
	for (let i = 0; i < host.length; i++) {
		const c = host[i];
		if (c === '.') {
			if (!digits) return false;
			dots++;
			digits = 0;
		} else if (c >= '0' && c <= '9' && digits < 3) digits++;
		else return false;
	}
	return dots === 3 && digits > 0;
}
const isAddress = (host: string) => isIPv4(host) || indexOf(host, ':') !== -1;
function isName(host: string) {
	const text = lower(host);
	return (
		slice(text, text.length - 6) === '.local' ||
		slice(text, text.length - 7) === '.local.'
	);
}

/**
 * Where an object a page reads came from: the browser's own local or remote
 * side, read through this bundle (`local`, `remote`); made by the page with a
 * constructor of this bundle's realms (`page`, its own data, shown as made);
 * or neither (`unknown`: read through a realm another document's bundle hooks,
 * or made there), shown with every address hidden
 */
type Side = 'local' | 'remote' | 'page' | 'unknown';

interface State {
	/** the servers as the page gave them, in the browser's normalised form */
	servers: RTCIceServer[];
	/** the page's operations waiting behind a remote name lookup */
	pending: Promise<unknown> | null;
}

// shared by every realm this bundle hooks (about:blank frames, popups): a
// candidate one of them shows must read the same from another. Addresses are
// spelled as the browser writes them in candidates.
/** mDNS names the browser gave this browser's own host candidates */
const ownNames = dictionary<true>();
/** a host candidate's real address and the name a page sees for it */
const nameOf = dictionary<string>();
const addressOf = dictionary<string>();
/**
 * Names for addresses in `unknown` objects. Unlike the names of `nameOf`
 * (this machine's addresses, from what the browser itself reported) a
 * remote candidate never gets the address back for one: it may be an address
 * the page wrote
 */
const displayNames = dictionary<string>();
/** remote candidates sent nowhere: `foundation protocol port` -> the page's address */
const originals = dictionary<string>();
/** a server sent nowhere: its port there -> the page's `host:port`, and back */
const servers = dictionary<string>();
const nowhereOf = dictionary<number>();
// the browser makes no TURN allocation to a system port (but 53, 80 and
// 443) and fires no error for it either: a server the page put on one gets a
// system port here too, any other one a port from 1024
const isSystemPort = (port: number) =>
	port > 0 && port < 1024 && port !== 53 && port !== 80 && port !== 443;
let lastSystem = 0;
let lastServer = 1023;
const states = new WeakMap<object, State>();
const sides = new WeakMap<object, 'local' | 'remote'>();
const constructed = new WeakSet<object>();
const stateOf = (pc: unknown): State | undefined =>
	pc !== null && typeof pc === 'object'
		? Reflect.apply(weakGet, states, [pc])
		: undefined;
const mark = (object: unknown, side: 'local' | 'remote') => {
	if (object !== null && typeof object === 'object')
		Reflect.apply(weakSet, sides, [object, side]);
};
function sideOf(object: unknown): Side {
	if (object === null || typeof object !== 'object') return 'unknown';
	if (Reflect.apply(weakHas, sides, [object]))
		return Reflect.apply(weakGet, sides, [object]);
	return Reflect.apply(weakSetHas, constructed, [object]) ? 'page' : 'unknown';
}

let channel: BroadcastChannel | null = null;
const waiting = dictionary<() => void>();
let lastWaiter = 0;

function post(message: WebRTCChannelMessage) {
	if (channel) Reflect.apply(nativeBroadcastPost, channel, [message]);
}

/** an own data member of a message (never one from Object.prototype) */
function own(object: unknown, key: string): unknown {
	if (object === null || typeof object !== 'object') return undefined;
	return Reflect.getOwnPropertyDescriptor(object, key)?.value;
}

function openChannel() {
	if (channel || typeof NativeBroadcastChannel !== 'function') return;
	try {
		channel = new NativeBroadcastChannel(WEBRTC_CHANNEL);
	} catch (error) {
		// an opaque origin may not have one; this bundle then knows its own
		return;
	}
	Reflect.apply(nativeAddListener, channel, [
		'message',
		(event: MessageEvent) => {
			const data = Reflect.apply(nativeEventData, event, []);
			const kind = own(data, 'kind');
			if (kind === 'sync') {
				for (const name in ownNames) post({ kind: 'name', name });
				for (const name in addressOf)
					post({ kind: 'name', name, address: addressOf[name] });
				return;
			}
			const name = own(data, 'name');
			if (kind !== 'name' || typeof name !== 'string') return;
			const address = own(data, 'address');
			if (typeof address === 'string') {
				addressOf[name] = address;
				if (!(address in nameOf)) nameOf[address] = name;
			} else ownNames[name] = true;
			for (const id in waiting) waiting[id]();
		},
	]);
	post({ kind: 'sync' });
}

function learnName(name: string) {
	if (name in ownNames) return;
	ownNames[name] = true;
	openChannel();
	post({ kind: 'name', name });
}

function randomName() {
	const bytes = new NativeUint8Array(16);
	getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let name = '';
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) name += '-';
		name += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
	}
	return `${name}.local`;
}

/** the name a page sees for one of this machine's addresses */
function nameFor(address: string) {
	let name = nameOf[address];
	if (name === undefined) {
		name = address in displayNames ? displayNames[address] : randomName();
		nameOf[address] = name;
		addressOf[name] = address;
		openChannel();
		post({ kind: 'name', name, address });
	}
	return name;
}

/** a name for an address that may not be this machine's */
function displayName(address: string) {
	if (address in nameOf) return nameOf[address];
	if (!(address in displayNames)) displayNames[address] = randomName();
	return displayNames[address];
}

/** a candidate's fields, or null when it is not one */
function fieldsOf(candidate: string): string[] | null {
	const fields = split(candidate, ' ');
	if (
		fields.length < 8 ||
		fields[6] !== 'typ' ||
		!(
			startsWith(fields[0], 'candidate:') ||
			startsWith(fields[0], 'a=candidate:')
		)
	)
		return null;
	return fields;
}

const keyOf = (foundation: string, protocol: string, port: string) =>
	`${foundation} ${lower(protocol)} ${port}`;
const keyOfFields = (fields: string[]) =>
	keyOf(slice(fields[0], indexOf(fields[0], ':') + 1), fields[2], fields[5]);

/** a candidate address as the page may see it */
function showAddress(address: string, side: Side, key?: string): string {
	if (side === 'page') return address;
	if (side === 'local') {
		// the browser's own: a name it gave, or an address of this machine
		if (isName(address)) learnName(address);
		else if (isAddress(address)) return nameFor(address);
		return address;
	}
	if (address === NOWHERE) {
		return key !== undefined && key in originals ? originals[key] : address;
	}
	// every remote address the page gave reached the browser as NOWHERE: any
	// other is this machine's, or (unknown) may be
	if (isAddress(address)) return displayName(address);
	return address;
}

function showCandidate(candidate: string, side: Side): string {
	const fields = side === 'page' ? null : fieldsOf(candidate);
	if (!fields) return candidate;
	fields[4] = showAddress(fields[4], side, keyOfFields(fields));
	if (side !== 'remote')
		for (let i = 8; i + 1 < fields.length; i++)
			if (
				fields[i] === 'raddr' &&
				isAddress(fields[i + 1]) &&
				fields[i + 1] !== '0.0.0.0'
			) {
				fields[i + 1] = '0.0.0.0';
				if (fields[i + 2] === 'rport' && i + 3 < fields.length)
					fields[i + 3] = '0';
			}
	return join(fields, ' ');
}

const TYPE_PREFERENCE = dictionary<number>();
TYPE_PREFERENCE.host = 126;
TYPE_PREFERENCE.prflx = 110;
TYPE_PREFERENCE.srflx = 100;
TYPE_PREFERENCE.relay = 0;

/** a connection line (`c=IN IP4 x`, `a=rtcp:9 IN IP4 x`): its head and address */
function connectionLine(line: string): [head: string, address: string] | null {
	let head: string;
	if (startsWith(line, 'c=IN IP')) head = 'c=IN ';
	else if (startsWith(line, 'a=rtcp:')) {
		const at = indexOf(line, ' IN IP');
		if (at === -1) return null;
		head = slice(line, 0, at + 4);
	} else return null;
	const space = indexOf(line, ' ', head.length + 3);
	if (space === -1) return null;
	return [head, slice(line, space + 1)];
}

/**
 * The connection address the browser derives from a section's candidates
 * (webrtc's UpdateConnectionAddress): the first UDP RTP candidate of the most
 * preferred type, IPv4 over IPv6, and 0.0.0.0 when that one is a host name
 */
function connectionOf(candidates: string[][]): string {
	let address = '0.0.0.0';
	let preference = 0;
	// a host name has no family, like the start
	let family = 'name';
	for (let i = 0; i < candidates.length; i++) {
		const fields = candidates[i];
		if (fields[1] !== '1' || lower(fields[2]) !== 'udp') continue;
		const type = fields[7] in TYPE_PREFERENCE ? TYPE_PREFERENCE[fields[7]] : 0;
		const ours = isAddress(fields[4])
			? indexOf(fields[4], ':') !== -1
				? 'IP6'
				: 'IP4'
			: 'name';
		if (
			(type <= preference && family === ours) ||
			(family === 'IP4' && ours === 'IP6')
		)
			continue;
		preference = type;
		family = ours;
		address = ours === 'name' ? '0.0.0.0' : fields[4];
	}
	return address;
}

/** a description's SDP as the page may see it */
function showSDP(sdp: string, side: Side): string {
	if (side === 'page') return sdp;
	const lines = split(sdp, '\r\n');
	// a section's own candidates, as shown, for its connection line
	let shown: string[][] = [];
	let connections: number[] = [];
	const settle = () => {
		for (let c = 0; c < connections.length; c++) {
			const index = connections[c];
			const line = connectionLine(lines[index])!;
			const head = line[0];
			const address = line[1];
			let seen = address === '0.0.0.0' || address === '::';
			for (let i = 0; i < shown.length && !seen; i++)
				seen = shown[i][4] === address;
			// the browser derived it from a candidate the page sees otherwise
			if (seen) continue;
			const replacement = connectionOf(shown);
			lines[index] =
				`${head}${indexOf(replacement, ':') !== -1 ? 'IP6' : 'IP4'} ${replacement}`;
		}
		shown = [];
		connections = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (startsWith(line, 'm=')) settle();
		if (startsWith(line, 'a=candidate:')) {
			lines[index] = showCandidate(line, side);
			const fields = fieldsOf(lines[index]);
			if (fields) push(shown, fields);
		} else if (connectionLine(line)) push(connections, index);
	}
	settle();
	return join(lines, '\r\n');
}

/** the SDP a page hands back for a local description, with real addresses */
function hideSDP(sdp: string): string {
	const lines = split(sdp, '\r\n');
	for (let index = 0; index < lines.length; index++) {
		const fields = startsWith(lines[index], 'a=candidate:')
			? fieldsOf(lines[index])
			: null;
		if (!fields || !(fields[4] in addressOf)) continue;
		fields[4] = addressOf[fields[4]];
		lines[index] = join(fields, ' ');
	}
	return join(lines, '\r\n');
}

/** resolves when `check` holds after an announcement, or after `ms` */
function waitFor(check: () => boolean, ms: number): Promise<void> {
	return new NativePromise<void>((resolve) => {
		const id = ++lastWaiter;
		const finish = () => {
			delete waiting[id];
			nativeClearTimeout(timer);
			resolve();
		};
		const timer = nativeSetTimeout(finish, ms);
		waiting[id] = () => {
			if (check()) finish();
		};
	});
}

/**
 * The remote candidate the browser gets for one the page gave: `value()`
 * decides from the tables when the operation runs (so nothing a page does
 * to the promise machinery can hand the browser another string), after
 * `wait` when the decision may still change
 */
interface Admitted {
	value: () => string;
	wait?: Promise<void>;
}

function admit(candidate: string): Admitted {
	const fields = fieldsOf(candidate);
	if (!fields) return { value: () => candidate };
	const address = fields[4];
	const key = keyOfFields(fields);
	const known = () => address in ownNames || address in addressOf;
	const decide = (): string => {
		const out = split(join(fields, ' '), ' ');
		if (address in ownNames) return join(out, ' ');
		if (address in addressOf) {
			out[4] = addressOf[address];
			return join(out, ' ');
		}
		originals[key] = address;
		out[4] = NOWHERE;
		return join(out, ' ');
	};
	if (!isName(address) || known()) {
		const now = decide();
		return { value: () => now };
	}
	// another proxied page's name may still be on its way
	openChannel();
	return { value: decide, wait: waitFor(known, ANNOUNCE_WAIT_MS) };
}

function admitSDP(sdp: string): Admitted {
	const lines = split(sdp, '\r\n');
	const admitted: (Admitted | null)[] = [];
	const waits: Promise<void>[] = [];
	for (let i = 0; i < lines.length; i++) {
		const entry = startsWith(lines[i], 'a=candidate:') ? admit(lines[i]) : null;
		push(admitted, entry);
		if (entry?.wait) push(waits, entry.wait);
	}
	const value = () => {
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const entry = admitted[i];
			push(out, entry ? entry.value() : lines[i]);
		}
		return join(out, '\r\n');
	};
	return waits.length ? { value, wait: all(waits) } : { value };
}

/** resolves once every one of `promises` has settled */
function all(promises: Promise<unknown>[]): Promise<void> {
	return new NativePromise<void>((resolve) => {
		let left = promises.length;
		if (!left) resolve();
		const done = () => {
			if (--left === 0) resolve();
		};
		for (let i = 0; i < promises.length; i++) then(promises[i], done, done);
	});
}

const SCHEMES = dictionary<string>();
SCHEMES.stun = '3478';
SCHEMES.turn = '3478';
SCHEMES.stuns = '5349';
SCHEMES.turns = '5349';
const QUERIES = dictionary<string>();
QUERIES[''] = '';
QUERIES['?transport=udp'] = '?transport=udp';
QUERIES['?transport=tcp'] = '?transport=tcp';

/**
 * A server the page named, as the browser gets it: nowhere, on a port of its
 * own, built from constants (none of the page's text reaches the browser)
 */
function nowhereServer(url: string): string | null {
	const colon = indexOf(url, ':');
	if (colon === -1) return null;
	const scheme = lower(slice(url, 0, colon));
	if (!(scheme in SCHEMES)) return null;
	const rest = slice(url, colon + 1);
	const queryAt = indexOf(rest, '?');
	const authority = queryAt === -1 ? rest : slice(rest, 0, queryAt);
	const query = queryAt === -1 ? '' : lower(slice(rest, queryAt));
	if (!(query in QUERIES)) return null;
	let host = authority;
	let port = SCHEMES[scheme];
	const bracket = startsWith(authority, '[') ? indexOf(authority, ']') : -1;
	const portAt =
		bracket !== -1
			? authority[bracket + 1] === ':'
				? bracket + 1
				: -1
			: lastIndexOf(authority, ':');
	if (portAt !== -1) {
		host = slice(authority, 0, portAt);
		port = slice(authority, portAt + 1);
	}
	const key = `${host}:${port}`;
	// one server named twice (a STUN server that is also the TURN server) is
	// one server to the browser, which asks it once
	let nowhere = key in nowhereOf ? nowhereOf[key] : -1;
	if (nowhere === -1 || servers[nowhere] !== key) {
		if (isSystemPort(NativeNumber(port))) {
			do lastSystem = (lastSystem % 1023) + 1;
			while (!isSystemPort(lastSystem));
			nowhere = lastSystem;
		} else nowhere = lastServer = lastServer >= 65535 ? 1024 : lastServer + 1;
		servers[nowhere] = key;
		nowhereOf[key] = nowhere;
	}
	return `${scheme}:${NOWHERE}:${nowhere}${QUERIES[query]}`;
}

/** a server URL the browser reports, as the page named it */
function showServer(url: string): string {
	const at = indexOf(url, `${NOWHERE}:`);
	if (at === -1) return url;
	const from = at + NOWHERE.length + 1;
	let end = from;
	while (end < url.length && url[end] >= '0' && url[end] <= '9') end++;
	const port = slice(url, from, end);
	if (!(port in servers)) return url;
	return slice(url, 0, at) + servers[port] + slice(url, end);
}

/** a host address in an icecandidateerror, as the browser shows it without permission */
function redact(address: string): string {
	return indexOf(address, ':') !== -1 ? '[0:0:0:x:x:x:x:x]' : '0.0.0.x';
}

/** a candidate stats entry as the page may see it (a fresh object per read) */
function showStats(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	const stats = value as Record<string, unknown>;
	const type = own(stats, 'type');
	const clear = (key: string) => {
		const current = own(stats, key);
		if (typeof current === 'string' && current !== '') stats[key] = '';
	};
	if (type === 'local-candidate') {
		// the browser shows a host candidate's address as '' here
		clear('address');
		clear('ip');
		clear('relatedAddress');
		const url = own(stats, 'url');
		if (typeof url === 'string') stats.url = showServer(url);
	} else if (type === 'remote-candidate') {
		const key = keyOf(
			`${own(stats, 'foundation')}`,
			`${own(stats, 'protocol')}`,
			`${own(stats, 'port')}`,
		);
		// every remote address the page gave reached the browser as NOWHERE:
		// any other is this machine's (a proxied page's connection here), and
		// the browser shows a remote host name as '' too
		const remote = (name: string) => {
			const address = own(stats, name);
			if (typeof address !== 'string' || address === '') return;
			stats[name] =
				address === NOWHERE && key in originals && isAddress(originals[key])
					? originals[key]
					: '';
		};
		remote('address');
		remote('ip');
	}
	return value;
}

/** `args` with its first member replaced, built without the page's iterators */
function withFirst(args: unknown[], first: unknown): unknown[] {
	const out: unknown[] = [];
	push(out, first);
	for (let i = 1; i < args.length; i++) push(out, args[i]);
	return out;
}

export default class WebRTCModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global as unknown as Record<string, any>;
		const NativePeerConnection = global.RTCPeerConnection as
			typeof RTCPeerConnection | undefined;
		if (typeof NativePeerConnection !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const RealmPromise = global.Promise as PromiseConstructor;
		const realmThen = RealmPromise.prototype.then;
		const prototype = NativePeerConnection.prototype as unknown as Record<
			string,
			any
		>;
		const nativeGetConfiguration = prototype.getConfiguration;
		const nativeSetConfiguration = prototype.setConfiguration;
		const nativeClose = prototype.close;
		const candidatePrototype = global.RTCIceCandidate?.prototype;
		const nativeCandidate =
			candidatePrototype &&
			Reflect.getOwnPropertyDescriptor(candidatePrototype, 'candidate')?.get;
		// a page cannot make an event of its own trusted (isTrusted is an own,
		// unforgeable member of every event)
		const trusted = (event: unknown) => {
			try {
				const getter = Reflect.getOwnPropertyDescriptor(
					event as object,
					'isTrusted',
				)?.get;
				return !!getter && Reflect.apply(getter, event, []) === true;
			} catch (error) {
				return false;
			}
		};

		const hookMethod = (
			target: Record<string | symbol, any> | undefined,
			name: string | symbol,
			wrap: (native: Function, that: any, args: any[]) => any,
		) => {
			const descriptor =
				target && Reflect.getOwnPropertyDescriptor(target, name);
			if (typeof descriptor?.value !== 'function') return;
			Reflect.defineProperty(target!, name, {
				...descriptor,
				value: proxyModule.wrapFunction(descriptor.value, wrap),
			});
		};
		const hookGetter = (
			target: Record<string, any> | undefined,
			name: string,
			wrap: (value: any, that: any) => any,
		) => {
			const descriptor =
				target && Reflect.getOwnPropertyDescriptor(target, name);
			if (!descriptor?.get) return;
			Reflect.defineProperty(target!, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (native, that, args) =>
					wrap(Reflect.apply(native, that, args), that),
				),
			});
		};

		/**
		 * Run `operation` now, or behind the operations of `state` still waiting
		 * and `wait` (the browser chains a connection's operations; a page that
		 * does not await setRemoteDescription expects the next one to see it
		 * applied). The page gets a promise of its own realm.
		 */
		const run = <T>(
			state: State | undefined,
			wait: Promise<void> | undefined,
			operation: () => T,
		): T | Promise<T> => {
			const before: Promise<unknown>[] = [];
			if (state?.pending) push(before, state.pending);
			if (wait) push(before, wait);
			if (!before.length) return operation();
			const result = new NativePromise<T>((resolve, reject) => {
				const go = () => {
					try {
						resolve(operation());
					} catch (error) {
						reject(error);
					}
				};
				then(all(before), go, go);
			});
			if (state) {
				const settled = all([result]);
				state.pending = settled;
				then(
					settled,
					() => {
						if (state.pending === settled) state.pending = null;
					},
					() => undefined,
				);
			}
			return new RealmPromise<T>((resolve, reject) => {
				then(result, resolve, reject);
			});
		};

		/**
		 * The page's configuration dictionary, read by the browser itself once,
		 * with its candidate pool held back: a pool gathers the moment the
		 * configuration applies, which would reach the page's servers
		 */
		const withoutPool = (args: unknown[], pool: { size: number }) => {
			const config = args[0];
			if (
				!args.length ||
				config === null ||
				(typeof config !== 'object' && typeof config !== 'function')
			)
				return args;
			const watched = new NativeProxy(config, {
				get(object, key) {
					const value = Reflect.get(object, key);
					if (
						key !== 'iceCandidatePoolSize' ||
						value === undefined ||
						typeof value === 'symbol' ||
						typeof value === 'bigint'
					)
						return value;
					// [EnforceRange] octet, converted once here instead of natively
					const number = NativeNumber(value);
					if (!numberIsFinite(number)) return number;
					const size = mathTrunc(number);
					if (size < 0 || size > 255) return number;
					pool.size = size;
					return 0;
				},
			});
			return withFirst(args, watched);
		};

		/** point the browser at nowhere for every server the page gave */
		const configure = (pc: RTCPeerConnection, pool: number) => {
			const config = Reflect.apply(
				nativeGetConfiguration,
				pc,
				[],
			) as RTCConfiguration;
			const given = (own(config, 'iceServers') ?? []) as RTCIceServer[];
			Reflect.apply(weakSet, states, [
				pc,
				{ servers: given, pending: stateOf(pc)?.pending ?? null },
			]);
			if (!given.length && !pool) return;
			const nowhere: RTCIceServer[] = [];
			for (let i = 0; i < given.length; i++) {
				const server = given[i];
				const urls = own(server, 'urls');
				const list: string[] = [];
				if (typeof urls === 'string') push(list, urls);
				else if (isArray(urls))
					for (let u = 0; u < urls.length; u++) push(list, `${urls[u]}`);
				const routed: string[] = [];
				for (let u = 0; u < list.length; u++) {
					const url = nowhereServer(list[u]);
					if (url !== null) push(routed, url);
				}
				if (routed.length)
					push(nowhere, {
						__proto__: null,
						urls: sequence(routed),
						username: own(server, 'username'),
						credential: own(server, 'credential'),
					} as unknown as RTCIceServer);
			}
			const certificates = own(config, 'certificates');
			try {
				Reflect.apply(nativeSetConfiguration, pc, [
					{
						__proto__: null,
						...config,
						certificates: isArray(certificates)
							? sequence(certificates)
							: certificates,
						iceServers: sequence(nowhere),
						iceCandidatePoolSize: pool,
					},
				]);
			} catch (error) {
				// never leave a connection that would reach the page's servers
				Reflect.apply(nativeClose, pc, []);
				throw error;
			}
		};

		/**
		 * Replace the constructor `names` hold with one that builds its object
		 * with `build`, and reads as the browser's: its statics
		 * (generateCertificate), a prototype that cannot be replaced
		 */
		const wrapConstructor = (
			Native: Function | undefined,
			names: string[],
			build: (target: any, args: any[], newTarget: any) => object,
		) => {
			if (typeof Native !== 'function') return;
			const Wrapped = proxyModule.wrapFunction(
				Native,
				(target, that, args, newTarget) =>
					// called without new: the browser's own TypeError
					newTarget
						? build(target, args, newTarget)
						: Reflect.apply(target, that, args),
				true,
			);
			for (const key of Reflect.ownKeys(Native)) {
				if (key === 'length' || key === 'name' || key === 'prototype') continue;
				Reflect.defineProperty(
					Wrapped,
					key,
					Reflect.getOwnPropertyDescriptor(Native, key)!,
				);
			}
			Reflect.defineProperty(Wrapped, 'prototype', { writable: false });
			for (const name of names) {
				const descriptor = Reflect.getOwnPropertyDescriptor(global, name);
				if (descriptor?.value === Native)
					Reflect.defineProperty(global, name, {
						...descriptor,
						value: Wrapped,
					});
			}
		};

		wrapConstructor(
			NativePeerConnection,
			['RTCPeerConnection', 'webkitRTCPeerConnection'],
			(target, args, newTarget) => {
				const pool = { size: 0 };
				const pc = Reflect.construct(
					target,
					withoutPool(args, pool),
					newTarget,
				) as RTCPeerConnection;
				openChannel();
				configure(pc, pool.size);
				return pc;
			},
		);
		// what a page makes itself is its own data, shown as it made it
		for (const name of ['RTCIceCandidate', 'RTCSessionDescription'])
			wrapConstructor(global[name], [name], (target, args, newTarget) => {
				const made = Reflect.construct(target, args, newTarget) as object;
				Reflect.apply(weakAdd, constructed, [made]);
				return made;
			});

		hookMethod(prototype, 'getConfiguration', (native, that, args) => {
			const config = Reflect.apply(native, that, args) as RTCConfiguration;
			const state = stateOf(that);
			if (state) {
				const servers: RTCIceServer[] = [];
				for (let i = 0; i < state.servers.length; i++) {
					const server = state.servers[i];
					push(servers, {
						...server,
						urls: isArray(server.urls)
							? [...(server.urls as string[])]
							: server.urls,
					});
				}
				config.iceServers = servers;
			}
			return config;
		});

		hookMethod(prototype, 'setConfiguration', (native, that, args) => {
			// (a connection a realm of another document's bundle made too) the
			// browser checks (and normalises) the page's servers, with no
			// pool to gather from them, then gets nowhere instead
			const pool = { size: 0 };
			Reflect.apply(native, that, withoutPool(args, pool));
			configure(that, pool.size);
		});

		hookMethod(prototype, 'addIceCandidate', (native, that, args) => {
			const state = stateOf(that);
			const init = args[0];
			if (
				init === null ||
				(typeof init !== 'object' && typeof init !== 'function')
			)
				return run(state, undefined, () => Reflect.apply(native, that, args));
			// RTCIceCandidateInit, read once and in the browser's order, into a
			// dictionary of its own (a member it lacks is never read from a
			// prototype the page set up)
			const candidate = init.candidate;
			const sdpMLineIndex = init.sdpMLineIndex;
			const sdpMid = init.sdpMid;
			const usernameFragment = init.usernameFragment;
			if (typeof candidate === 'symbol')
				return Reflect.apply(native, that, withFirst(args, init));
			const text = candidate === undefined ? '' : `${candidate}`;
			const admitted = text ? admit(text) : null;
			return run(state, admitted?.wait, () => {
				const dictionary: Record<string, unknown> = createObject(null);
				dictionary.candidate = admitted ? admitted.value() : text;
				if (sdpMLineIndex !== undefined)
					dictionary.sdpMLineIndex = sdpMLineIndex;
				if (sdpMid !== undefined) dictionary.sdpMid = sdpMid;
				if (usernameFragment !== undefined)
					dictionary.usernameFragment = usernameFragment;
				return Reflect.apply(native, that, withFirst(args, dictionary));
			});
		});

		// RTCSessionDescriptionInit, read once and in the browser's order
		const descriptionOf = (init: any) => {
			const sdp = init.sdp;
			const type = init.type;
			return {
				sdp: sdp === undefined || typeof sdp === 'symbol' ? sdp : `${sdp}`,
				type,
			};
		};
		const descriptionInit = (sdp: unknown, type: unknown) => {
			const dictionary: Record<string, unknown> = createObject(null);
			if (sdp !== undefined) dictionary.sdp = sdp;
			if (type !== undefined) dictionary.type = type;
			return dictionary;
		};

		hookMethod(prototype, 'setRemoteDescription', (native, that, args) => {
			const state = stateOf(that);
			const init = args[0];
			if (
				init === null ||
				(typeof init !== 'object' && typeof init !== 'function')
			)
				return run(state, undefined, () => Reflect.apply(native, that, args));
			const { sdp, type } = descriptionOf(init);
			const admitted = typeof sdp === 'string' ? admitSDP(sdp) : null;
			return run(state, admitted?.wait, () =>
				Reflect.apply(
					native,
					that,
					withFirst(
						args,
						descriptionInit(admitted ? admitted.value() : sdp, type),
					),
				),
			);
		});

		hookMethod(prototype, 'setLocalDescription', (native, that, args) => {
			const init = args[0];
			if (
				init !== null &&
				(typeof init === 'object' || typeof init === 'function')
			) {
				const { sdp, type } = descriptionOf(init);
				args = withFirst(
					args,
					descriptionInit(typeof sdp === 'string' ? hideSDP(sdp) : sdp, type),
				);
			}
			return run(stateOf(that), undefined, () =>
				Reflect.apply(native, that, args),
			);
		});

		for (const name of ['createOffer', 'createAnswer'])
			hookMethod(prototype, name, (native, that, args) => {
				if (typeof args[0] === 'function') {
					// the legacy form hands an RTCSessionDescription to a callback
					const success = args[0];
					args = withFirst(
						args,
						function (this: unknown, description: unknown) {
							mark(description, 'local');
							return Reflect.apply(success, this, [description]);
						},
					);
				}
				const result = run(stateOf(that), undefined, () =>
					Reflect.apply(native, that, args),
				);
				if (result === null || typeof result !== 'object') return result;
				// the result is the browser's offer: shown before the page sees it
				return Reflect.apply(realmThen, result, [
					(description?: RTCSessionDescriptionInit) => {
						const sdp = own(description, 'sdp');
						if (typeof sdp === 'string')
							description!.sdp = showSDP(sdp, 'local');
						return description;
					},
				]);
			});

		for (const [name, side] of [
			['localDescription', 'local'],
			['currentLocalDescription', 'local'],
			['pendingLocalDescription', 'local'],
			['remoteDescription', 'remote'],
			['currentRemoteDescription', 'remote'],
			['pendingRemoteDescription', 'remote'],
		] as const)
			hookGetter(prototype, name, (description) => {
				mark(description, side);
				return description;
			});

		const description = global.RTCSessionDescription?.prototype;
		hookGetter(description, 'sdp', (sdp, that) =>
			typeof sdp === 'string' ? showSDP(sdp, sideOf(that)) : sdp,
		);
		hookMethod(description, 'toJSON', (native, that, args) => {
			const json = Reflect.apply(native, that, args);
			const sdp = own(json, 'sdp');
			if (typeof sdp === 'string') json.sdp = showSDP(sdp, sideOf(that));
			return json;
		});

		hookGetter(candidatePrototype, 'candidate', (value, that) =>
			typeof value === 'string' ? showCandidate(value, sideOf(that)) : value,
		);
		// read from the candidate line, the spelling every table uses
		hookGetter(candidatePrototype, 'address', (value, that) => {
			const side = sideOf(that);
			if (typeof value !== 'string' || side === 'page' || !nativeCandidate)
				return value;
			const line = Reflect.apply(nativeCandidate, that, []);
			const fields = typeof line === 'string' ? fieldsOf(line) : null;
			return fields
				? showAddress(fields[4], side, keyOfFields(fields))
				: showAddress(value, side);
		});
		hookGetter(candidatePrototype, 'relatedAddress', (value, that) => {
			const side = sideOf(that);
			return typeof value === 'string' &&
				side !== 'page' &&
				side !== 'remote' &&
				isAddress(value)
				? '0.0.0.0'
				: value;
		});
		hookGetter(candidatePrototype, 'url', (value) =>
			typeof value === 'string' ? showServer(value) : value,
		);
		hookMethod(candidatePrototype, 'toJSON', (native, that, args) => {
			const json = Reflect.apply(native, that, args);
			const line = own(json, 'candidate');
			if (typeof line === 'string')
				json.candidate = showCandidate(line, sideOf(that));
			return json;
		});

		// the candidate of an event the browser fired is its own local one
		hookGetter(
			global.RTCPeerConnectionIceEvent?.prototype,
			'candidate',
			(value, that) => {
				if (trusted(that)) mark(value, 'local');
				return value;
			},
		);
		const iceError = global.RTCPeerConnectionIceErrorEvent?.prototype;
		hookGetter(iceError, 'url', (value) =>
			typeof value === 'string' ? showServer(value) : value,
		);
		hookGetter(iceError, 'address', (value, that) =>
			typeof value === 'string' && trusted(that) ? redact(value) : value,
		);
		hookGetter(iceError, 'hostCandidate', (value, that) => {
			if (typeof value !== 'string' || !trusted(that)) return value;
			const colon = lastIndexOf(value, ':');
			return colon === -1
				? redact(value)
				: redact(slice(value, 0, colon)) + slice(value, colon);
		});

		const transport = global.RTCIceTransport?.prototype;
		const markEach = (list: unknown, side: 'local' | 'remote') => {
			if (isArray(list))
				for (let i = 0; i < list.length; i++) mark(list[i], side);
			return list;
		};
		hookMethod(transport, 'getLocalCandidates', (native, that, args) =>
			markEach(Reflect.apply(native, that, args), 'local'),
		);
		hookMethod(transport, 'getRemoteCandidates', (native, that, args) =>
			markEach(Reflect.apply(native, that, args), 'remote'),
		);
		hookMethod(transport, 'getSelectedCandidatePair', (native, that, args) => {
			const pair = Reflect.apply(native, that, args);
			mark(own(pair, 'local'), 'local');
			mark(own(pair, 'remote'), 'remote');
			return pair;
		});

		// every candidate entry of a stats report, however it is read
		const report = global.RTCStatsReport?.prototype;
		let iteratorHooked = false;
		const hookIterator = (iterator: unknown) => {
			if (iteratorHooked || iterator === null || typeof iterator !== 'object')
				return iterator;
			iteratorHooked = true;
			hookMethod(
				Reflect.getPrototypeOf(iterator) as Record<string, any>,
				'next',
				(native, that, args) => {
					const step = Reflect.apply(native, that, args);
					const value = own(step, 'value');
					if (isArray(value) && value.length === 2) showStats(value[1]);
					else showStats(value);
					return step;
				},
			);
			return iterator;
		};
		hookMethod(report, 'get', (native, that, args) =>
			showStats(Reflect.apply(native, that, args)),
		);
		hookMethod(report, 'forEach', (native, that, args) => {
			const callback = args[0];
			const thisArg = args[1];
			if (typeof callback !== 'function')
				return Reflect.apply(native, that, args);
			return Reflect.apply(native, that, [
				(value: unknown, key: unknown, map: unknown) =>
					Reflect.apply(callback, thisArg, [showStats(value), key, map]),
			]);
		});
		hookMethod(report, 'values', (native, that, args) =>
			hookIterator(Reflect.apply(native, that, args)),
		);
		const entries =
			report && Reflect.getOwnPropertyDescriptor(report, 'entries');
		const iterates =
			entries &&
			Reflect.getOwnPropertyDescriptor(report, Symbol.iterator)?.value ===
				entries.value;
		hookMethod(report, 'entries', (native, that, args) =>
			hookIterator(Reflect.apply(native, that, args)),
		);
		if (iterates)
			Reflect.defineProperty(report, Symbol.iterator, {
				...Reflect.getOwnPropertyDescriptor(report, Symbol.iterator),
				value: report.entries,
			});
		else
			hookMethod(report, Symbol.iterator, (native, that, args) =>
				hookIterator(Reflect.apply(native, that, args)),
			);
	}
}
