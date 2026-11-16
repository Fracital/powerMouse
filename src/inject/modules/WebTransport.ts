import { postToPort } from '../../transport/messages';
import { closePort, onPort, privateChannel } from '../../transport/ports';
import Client from '../Client';
import Module from '../Module';
import { withStack } from '../nativeErrors';
import type { Context, Property, Session } from '../webTransportLazy';
import { webTransportParts } from '../webTransportParts';
import ProxyModule from './Proxy';

/*
 * WebTransport (docs/webtransport.md). The browser's own WebTransport opens
 * a QUIC connection from the network service, from the user's address, to
 * whatever server a page names: nothing of the proxy is in its path. So a
 * page never gets the browser's constructor. `WebTransport` is a stand-in
 * that reads as the browser's (the browser's own prototype, with the
 * stand-in as its `constructor`), checks its arguments as the browser does,
 * and makes sessions of STomp's own: ordinary objects on the browser's
 * prototype, whose members are the browser's functions wrapped to answer
 * for a session of ours and to run as they are for anything else.
 *
 * A session's handshake starts when Chrome's own throttle of a page's
 * handshakes would start it, and from there it is carried through the
 * transport (src/transport/webTransportHost.ts: stomp-h3 over a wisp UDP
 * stream) by a library of its own (../webTransport.ts, the asset
 * `webTransport`), which the bundle loads when a realm's first session
 * starts. One that does not come up ends as the browser's does when its
 * server cannot be reached: `closed` and then `ready` reject with "Opening
 * handshake failed.".
 *
 * A frame that never constructs one pays for the constructor's wrapper and
 * nothing else: the prototypes are wrapped, and the other WebTransport
 * interfaces looked at, when a realm makes its first session.
 */

type Realm = Record<string, any>;
/** one of a session's four streams: datagrams in and out, the server's bidirectional and unidirectional streams */
type Part = 0 | 1 | 2 | 3;

// one table for every realm this bundle covers (a session's members work
// through any of those realms' prototypes, as the browser's do), made with
// the first session
let sessions: WeakMap<object, Session>;
/** a session's `datagrams` */
let duplexes: WeakMap<object, Session>;
/** the errors a session ends with: their `source` reads 'session' */
let sessionErrors: WeakSet<object>;

// taken as the bundle loads, before a page could replace them
const { now } = Date;
const { random } = Math;
const later = setTimeout;
const cancel = clearTimeout;
const bufferLength = Reflect.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	'byteLength',
)!.get!;
const isView = ArrayBuffer.isView;

// ---- Chrome's throttle of a page's handshakes (WebTransportThrottleContext) ----

const MAX_PENDING = 64;
/** how long a failed handshake counts as pending */
const PENALTY_MS = 5 * 60 * 1000;
/**
 * Run `start` when Chrome would start the handshake (false: Chrome would
 * refuse it, with 64 pending), and free a handshake's place `after` ms from
 * now. One for the bundle, made with the first session.
 */
let throttle: (start: () => void) => boolean;
let release: (after: number) => void;

function makeThrottle() {
	let pending = 0;
	const waiting: (() => void)[] = [];
	let headTime = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const startOne = () => {
		timer = undefined;
		const start = waiting.shift();
		if (!start) return;
		headTime = now();
		pending++;
		start();
		if (waiting.length) schedule();
	};
	// the head of the queue starts after 10 ms doubled for each handshake
	// pending, give or take a half
	const schedule = () => {
		if (timer !== undefined) cancel(timer);
		timer = undefined;
		if (pending === 0) return startOne();
		const base =
			pending > 13 ? 60000 : Math.min(10 * 2 ** (pending - 1), 60000);
		const after = headTime + base * (random() + 0.5) - now();
		if (after <= 0) return startOne();
		timer = later(startOne, after);
	};
	release = (after) => {
		later(() => {
			pending--;
			if (waiting.length) schedule();
		}, after);
	};
	throttle = (start) => {
		if (pending + waiting.length >= MAX_PENDING) return false;
		waiting.push(start);
		if (timer === undefined) {
			headTime = now();
			schedule();
		}
		return true;
	};
}

// ---- a realm's stand-in ----

const INCOMING_AGE = 1;
const OUTGOING_AGE = 2;
const INCOMING_BUFFER = 3;
const OUTGOING_BUFFER = 4;

function standIn(client: Client, Native: Function, proxyModule: ProxyModule) {
	if (!sessions) {
		sessions = new WeakMap();
		duplexes = new WeakMap();
		sessionErrors = new WeakSet();
		makeThrottle();
	}
	const realm = client.global as unknown as Realm;
	const { TypeError, RangeError, DOMException, Promise, Object } = realm as {
		TypeError: TypeErrorConstructor;
		RangeError: RangeErrorConstructor;
		DOMException: typeof globalThis.DOMException;
		Promise: PromiseConstructor;
		Object: ObjectConstructor;
	};
	const NativeError = realm.WebTransportError as new (init: {
		message: string;
	}) => object;
	// Chrome 155 keeps a stream asked for while the session connects (before
	// it, one asked for without a connection is refused at once) and takes
	// other ages for the datagrams (measured on 152 to 156)
	const modern =
		Number(/Chrome\/(\d+)/.exec(String(realm.navigator?.userAgent))?.[1]) >=
		155;

	// (the browser's stack names the refusal alone, its message what refused)
	const failed = (
		context: string,
		text: string,
		Kind: ErrorConstructor = TypeError,
	) => {
		const error = withStack(new Kind(text));
		// (formatted now, from the refusal: a stack is formatted once)
		void error.stack;
		error.message = `Failed to ${context}: ${text}`;
		return error;
	};
	/** a WebIDL string or number of the page's value: a symbol is refused in the browser's words */
	const primitive = (value: unknown, context: string, type = 'string') => {
		if (typeof value === 'symbol')
			throw failed(context, `Cannot convert a Symbol value to a ${type}`);
		return type === 'string' ? `${value as string}` : +(value as number);
	};
	const notOfType = (type: string) =>
		`The provided value is not of type '${type}'.`;
	const reading = (context: string, name: string, type: string) =>
		`${context}: Failed to read the '${name}' property from '${type}'`;
	const syntax = (text: string) =>
		withStack(
			new DOMException(
				`Failed to construct 'WebTransport': ${text}`,
				'SyntaxError',
			),
		);
	const sessionError = (message: string) => {
		const error = new NativeError({ message });
		sessionErrors.add(error);
		return withStack(error);
	};

	/** a WebIDL sequence: the page's iterable, read once */
	const sequence = <T>(
		value: unknown,
		context: string,
		each: (item: unknown) => T,
	): T[] => {
		if (
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			throw failed(
				context,
				'The provided value cannot be converted to a sequence.',
			);
		const method = (value as Iterable<unknown>)[Symbol.iterator];
		if (typeof method !== 'function')
			throw failed(
				context,
				'The object must have a callable @@iterator property.',
			);
		const iterator = Reflect.apply(method, value, []) as Iterator<unknown>;
		const out: T[] = [];
		for (;;) {
			const step = iterator.next();
			if (step.done) return out;
			out.push(each(step.value));
		}
	};
	const isObject = (value: unknown) =>
		typeof value === 'object' || typeof value === 'function';
	/** an ArrayBuffer or a view of any realm */
	const isBuffer = (value: unknown) => {
		if (isView(value)) return true;
		try {
			Reflect.apply(bufferLength, value, []);
			return true;
		} catch (error) {
			return false;
		}
	};
	const promiseOf = (property: Property) =>
		(property.promise ??= new Promise((resolve, reject) => {
			const { done } = property;
			if (done) (done[0] ? resolve : reject)(done[1]);
			else property.settle = [resolve, reject];
		}));
	const settle = (property: Property, fulfilled: boolean, value: unknown) => {
		if (property.done) return;
		property.done = [fulfilled, value];
		property.settle?.[+!fulfilled](value);
	};
	const reject = (property: Property, reason: unknown) =>
		settle(property, false, reason);
	/** the bytes of a buffer or a view of any realm, copied now */
	const copy = (value: ArrayBuffer | ArrayBufferView) =>
		isView(value)
			? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
			: new Uint8Array(value).slice();

	/** the constructor's options, read as Chrome reads them: `protocols`, then `serverCertificateHashes` */
	const options = (value: unknown): [string[], ArrayBuffer[]] => {
		const context = "construct 'WebTransport'";
		const values: ArrayBuffer[] = [];
		if (value === undefined || value === null) return [[], values];
		if (!isObject(value))
			throw failed(context, notOfType('WebTransportOptions'));
		const given = value as Record<string, unknown>;
		const from = (name: string) =>
			reading(context, name, 'WebTransportOptions');
		const protocols = given.protocols;
		const names =
			protocols === undefined
				? []
				: sequence(
						protocols,
						from('protocols'),
						(item) => primitive(item, from('protocols')) as string,
					);
		const hashes = given.serverCertificateHashes;
		const reads = from('serverCertificateHashes');
		if (hashes !== undefined)
			sequence(hashes, reads, (item) => {
				if (item === undefined || item === null) return;
				if (!isObject(item)) throw failed(reads, notOfType('WebTransportHash'));
				const hash = item as Record<string, unknown>;
				const algorithm = hash.algorithm;
				const name =
					algorithm === undefined
						? undefined
						: primitive(
								algorithm,
								reading(reads, 'algorithm', 'WebTransportHash'),
							);
				const bytes = hash.value;
				if (bytes !== undefined && !isBuffer(bytes))
					throw failed(
						reading(reads, 'value', 'WebTransportHash'),
						notOfType('(ArrayBuffer or ArrayBufferView)'),
					);
				if (name === 'sha-256' && bytes !== undefined)
					values.push(copy(bytes as ArrayBuffer).buffer);
			});
		return [names, values];
	};

	/** what ends a session: Chrome's order (WebTransport::Cleanup) */
	const end = (session: Session, message: string, made?: object) => {
		if (session.over) return;
		session.over = true;
		const error = (session.error = made ?? sessionError(message));
		if (session.creations.length) {
			const closed = withStack(
				new DOMException(
					'The WebTransport connection is not open.',
					'InvalidStateError',
				),
			);
			for (const made of session.creations.splice(0)) made[1](closed);
		}
		const { controllers } = session;
		controllers[0]?.error(error);
		controllers[1]?.error(error);
		for (const write of session.writes.splice(0)) write[2](error);
		reject(session.closed, error);
		reject(session.ready, error);
		controllers[2]?.error(error);
		controllers[3]?.error(error);
	};

	/** one of a session's streams, made when the page first asks for it */
	const stream = (session: Session, part: Part) => {
		const made = session.streams[part];
		if (made) return made;
		const start = (controller: { error(reason: unknown): void }) => {
			if ('error' in session) controller.error(session.error);
			else session.controllers[part] = controller;
		};
		return (session.streams[part] =
			part === 1
				? new realm.WritableStream(
						{
							start,
							write: (chunk: unknown) => {
								if (!isBuffer(chunk))
									throw withStack(
										new TypeError(
											"Failed to execute 'write' on 'WritableStreamDefaultWriter': Datagram is not an ArrayBuffer or ArrayBufferView type.",
										),
									);
								const bytes = copy(chunk as ArrayBuffer);
								if (session.live) return session.live.datagram(bytes);
								return new Promise((resolve, refuse) => {
									session.writes.push([bytes, resolve, refuse]);
								});
							},
						},
						{ highWaterMark: 1 },
					)
				: part === 0
					? new realm.ReadableStream({
							type: 'bytes',
							start,
							pull: () =>
								session.live?.pull() ??
								new Promise<void>((resolve) => (session.pending = resolve)),
						})
					: new realm.ReadableStream({ start }, { highWaterMark: 1 }));
	};

	const construct = (args: unknown[], newTarget: Function) => {
		const input = (
			primitive(args[0], "construct 'WebTransport'") as string
		).toWellFormed();
		const [protocols, hashes] = options(args[1]);
		// (no base: a relative URL is none)
		let url: URL;
		try {
			url = new URL(input);
		} catch (error) {
			throw syntax(`The URL '${input}' is invalid.`);
		}
		if (url.protocol !== 'https:')
			throw syntax(
				`The URL's scheme must be 'https'. '${url.protocol.slice(0, -1)}' is not allowed.`,
			);
		if (url.hash || url.href.endsWith('#'))
			throw syntax(
				`The URL contains a fragment identifier ('#${url.hash.slice(1)}'). Fragment identifiers are not allowed in WebTransport URLs.`,
			);
		// the page's own connect-src (a document's; no worker's is known
		// here, as for a WebSocket): the browser reports the refusal itself,
		// by a request the browser's copy of the policy refuses
		// (DocumentClient.connectRefusal), and a policy that only reports
		// hears of it from the inject
		const policed = client as {
			connectRefusal?: (url: URL) => boolean;
			reportRefusal?: (directive: string, url: URL) => void;
		};
		const refused = policed.connectRefusal?.(url) ?? false;
		if (!refused) policed.reportRefusal?.('connect-src', url);
		const seen: string[] = [];
		for (const name of protocols) {
			if (name === '') throw syntax('Protocol name cannot be empty.');
			if (/[^\x20-\x7e]/.test(name))
				throw syntax('Protocol name contains invalid characters.');
			if (name.length >= 512)
				throw syntax('Protocol name is longer than 512 bytes.');
			if (seen.includes(name))
				throw syntax('Duplicate protocols are not allowed.');
			seen.push(name);
		}

		const session: Session = {
			over: false,
			ready: {},
			closed: {},
			creations: [],
			streams: [],
			controllers: [],
			writes: [],
			numbers: [1024, null, null, 1, 1],
			url: url.href,
			protocols,
			hashes,
		};
		const made = Reflect.construct(Object, [], newTarget) as object;
		sessions.set(made, session);
		if (refused) {
			// as the browser ends one: `ready`, then `closed`, and nothing else
			session.over = true;
			const error = sessionError(
				`Refused to connect to '${url.href}' because it violates the document's Content Security Policy`,
			);
			reject(session.ready, error);
			reject(session.closed, error);
			return made;
		}

		// the handshake starts when Chrome's would; one that failed, or was
		// closed after it started, keeps its place for five minutes
		const queued = throttle(() => {
			if (session.over) return release(0);
			// (what carries it is evaluated now, the first time: the document
			// bundle's is a deferred part, ../webTransportParts.ts)
			Promise.resolve()
				.then(() => webTransportParts.carry!()(context, session))
				.then(
					(up) => release(up ? 0 : PENALTY_MS),
					() => {
						release(PENALTY_MS);
						end(session, 'Opening handshake failed.');
					},
				);
		});
		if (!queued) later(() => end(session, 'Connection lost.'), 1);
		return made;
	};

	/** createBidirectionalStream and createUnidirectionalStream */
	const create = (name: string) => (session: Session, given?: unknown) => {
		const context = `execute '${name}' on 'WebTransport'`;
		return new Promise((resolve, refuse) => {
			if (given !== undefined && given !== null && !isObject(given))
				throw failed(context, notOfType('WebTransportSendStreamOptions'));
			const uni = name === 'createUnidirectionalStream';
			if (session.live && !session.over) return resolve(session.live.open(uni));
			if (!modern)
				throw withStack(
					new DOMException(
						`Failed to ${context}: No connection.`,
						'NetworkError',
					),
				);
			if (session.over)
				throw withStack(
					new DOMException(
						`Failed to ${context}: The WebTransport connection is not open.`,
						'InvalidStateError',
					),
				);
			session.creations.push([resolve, refuse, uni]);
		});
	};

	/** a member of `datagrams` that is a number the page may set */
	const number = (index: number, name: string, long = false) => ({
		get: (session: Session) =>
			long
				? Math.min(session.numbers[index]!, 0x7fffffff)
				: session.numbers[index],
		set: (session: Session, value: unknown) => {
			const { numbers } = session;
			if (index === INCOMING_AGE || index === OUTGOING_AGE) {
				if (value === undefined || value === null) {
					numbers[index] = null;
					return;
				}
				const age = +(value as number);
				const context = `set the '${name}' property on 'WebTransportDatagramDuplexStream'`;
				if (modern) {
					// Chrome 155 on: any number but a negative one, and 0 for none
					if (age < 0 || age !== age)
						throw failed(
							context,
							`${name} must be non-negative and not NaN`,
							RangeError,
						);
					numbers[index] = age === 0 ? null : age;
					return;
				}
				// before it: one that is not finite is refused, and one that is
				// not above zero changes nothing
				if (age - age !== 0)
					throw failed(context, 'The provided double value is non-finite.');
				if (age > 0) numbers[index] = age;
			} else {
				// the buffer sizes are unsigned longs of at least 1, and the
				// high water marks the same numbers read and set as longs
				const count = long ? Number(value) | 0 : Number(value) >>> 0;
				numbers[index] = count < 1 ? 1 : count;
			}
		},
	});

	/** `impl`'s members in place of `prototype`'s own, for the objects in `table` */
	const hook = (
		prototype: object,
		table: WeakMap<object, Session>,
		impl: Record<string, Partial<Record<'get' | 'set' | 'value', Function>>>,
	) => {
		for (const key in impl) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			// a member this browser does not have
			if (!descriptor) continue;
			const parts = impl[key];
			for (const part of ['get', 'set', 'value'] as const) {
				const own = parts[part];
				const native = descriptor[part] as Function | undefined;
				if (!own || typeof native !== 'function') continue;
				descriptor[part] = proxyModule.wrapFunction(
					native,
					(target, that, args) => {
						const session = table.get(that);
						return session
							? own(session, ...args)
							: Reflect.apply(target, that, args);
					},
				);
			}
			Reflect.defineProperty(prototype, key, descriptor);
		}
	};
	const part = (index: Part) => ({
		get: (session: Session) => stream(session, index),
	});
	hook(Native.prototype, sessions, {
		ready: { get: (session: Session) => promiseOf(session.ready) },
		closed: { get: (session: Session) => promiseOf(session.closed) },
		protocol: { get: (session: Session) => session.protocol ?? '' },
		datagrams: {
			get: (session: Session) => {
				if (!session.datagrams) {
					session.datagrams = Reflect.construct(
						Object,
						[],
						realm.WebTransportDatagramDuplexStream,
					) as object;
					duplexes.set(session.datagrams, session);
				}
				return session.datagrams;
			},
		},
		incomingBidirectionalStreams: part(2),
		incomingUnidirectionalStreams: part(3),
		close: {
			value: (session: Session, info?: unknown) => {
				const read: unknown[] = [0, ''];
				if (info !== undefined && info !== null) {
					const context = "execute 'close' on 'WebTransport'";
					if (!isObject(info))
						throw failed(context, notOfType('WebTransportCloseInfo'));
					// read as the browser reads them, for what a getter does
					['closeCode', 'reason'].forEach((name, index) => {
						const value = (info as Record<string, unknown>)[name];
						if (value !== undefined)
							read[index] = primitive(
								value,
								reading(context, name, 'WebTransportCloseInfo'),
								index ? 'string' : 'number',
							);
					});
				}
				if (session.live && !session.over)
					return session.live.close(
						Number(read[0]) >>> 0,
						(read[1] as string).toWellFormed(),
					);
				end(session, 'close() is called while connecting.');
			},
		},
		createBidirectionalStream: { value: create('createBidirectionalStream') },
		createUnidirectionalStream: {
			value: create('createUnidirectionalStream'),
		},
	});
	hook(realm.WebTransportDatagramDuplexStream.prototype, duplexes, {
		readable: part(0),
		writable: part(1),
		maxDatagramSize: { get: (session: Session) => session.numbers[0] },
		incomingMaxAge: number(INCOMING_AGE, 'incomingMaxAge'),
		outgoingMaxAge: number(OUTGOING_AGE, 'outgoingMaxAge'),
		incomingMaxBufferedDatagrams: number(INCOMING_BUFFER, ''),
		outgoingMaxBufferedDatagrams: number(OUTGOING_BUFFER, ''),
		incomingHighWaterMark: number(INCOMING_BUFFER, '', true),
		outgoingHighWaterMark: number(OUTGOING_BUFFER, '', true),
	});
	// an error a page makes is a stream's; the ones a session ends with are
	// made here, and say so
	const source = Reflect.getOwnPropertyDescriptor(
		NativeError.prototype,
		'source',
	);
	if (source?.get) {
		source.get = proxyModule.wrapFunction(source.get, (target, that, args) =>
			sessionErrors.has(that) ? 'session' : Reflect.apply(target, that, args),
		);
		Reflect.defineProperty(NativeError.prototype, 'source', source);
	}
	const context: Context = {
		realm,
		origin: client.url.url.origin,
		client: client as unknown as Context['client'],
		ports: { privateChannel, onPort, post: postToPort, closePort },
		natives: {
			Promise,
			Uint8Array: realm.Uint8Array as Uint8ArrayConstructor,
			RangeError,
			TypeError,
		},
		isBuffer,
		copy,
		end,
		settle,
		sessionError,
		withStack,
		hook,
		stream,
		modern,
		Reflect,
	};
	return construct;
}

export default class WebTransportModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global as unknown as Realm;
		// (a context that is not secure has none)
		const Native = global.WebTransport as Function | undefined;
		if (typeof Native !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
		let construct: ReturnType<typeof standIn> | undefined;
		global.WebTransport = proxyModule.wrapFunction(
			Native,
			(target, that, args, newTarget) =>
				(construct ??= standIn(client, Native, proxyModule))(args, newTarget),
			true,
		);
	}
}
