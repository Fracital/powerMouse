import { postToPort } from '../transport/messages';
import { closePort, onPort, privateChannel } from '../transport/ports';
import type Client from './Client';
import type ProxyModule from './modules/Proxy';
import {
	bufferLength,
	cancel,
	isView,
	later,
	now,
	random,
} from './modules/WebTransport';
import { withStack } from './nativeErrors';
import type { Context, Property, Session } from './webTransportLazy';
import { webTransportParts } from './webTransportParts';

// The page's WebTransport stand-in (docs/webtransport.md,
// ./modules/WebTransport.ts): made when a realm first constructs a session.
// In a document it is a deferred part of the bundle (./dom/deferred.ts), so
// its top level reads no global: what it takes of the realm before any page
// script ran is the module's (./modules/WebTransport.ts).

type Realm = Record<string, any>;
/** one of a session's four streams: datagrams in and out, the server's bidirectional and unidirectional streams */
type Part = 0 | 1 | 2 | 3;

// one table for every realm this bundle covers (a session's members work
// through any of those realms' prototypes, as the browser's do), made with
// the first session
let sessions: WeakMap<object, Session>;
/** a session's `datagrams` */
let duplexes: WeakMap<object, Session>;
/** leading and trailing HTTP whitespace */
const HTTP_SPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
/**
 * The request headers Chrome leaves out of a session's CONNECT without a
 * word (measured on 157): Fetch's forbidden request headers, and
 * user-agent
 */
const DROPPED = [
	'accept-charset',
	'accept-encoding',
	'access-control-request-headers',
	'access-control-request-method',
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'date',
	'dnt',
	'expect',
	'host',
	'keep-alive',
	'origin',
	'referer',
	'set-cookie',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'via',
	'user-agent',
];
const OVERRIDES = [
	'x-http-method',
	'x-http-method-override',
	'x-method-override',
];
const dropped = (name: string, value: string) =>
	DROPPED.includes(name) ||
	name.startsWith('sec-') ||
	name.startsWith('proxy-') ||
	(OVERRIDES.includes(name) &&
		value
			.split(',')
			.some((method) =>
				['connect', 'trace', 'track'].includes(
					method.replace(HTTP_SPACE, '').toLowerCase(),
				),
			));
/** the errors a session ends with: their `source` reads 'session' */
let sessionErrors: WeakSet<object>;

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

/** the options' and a session's anticipated counts of the server's streams (Chrome 158 on), bidirectional first */
const ANTICIPATED = [
	'anticipatedConcurrentIncomingBidirectionalStreams',
	'anticipatedConcurrentIncomingUnidirectionalStreams',
];
/** the optional dictionary members, in Chrome's order (159 adds two enums) */
const LATER_OPTIONS = [
	...ANTICIPATED,
	'congestionControl',
	'datagramsReadableType',
	'headers',
];

const INCOMING_AGE = 1;
const OUTGOING_AGE = 2;
const INCOMING_BUFFER = 3;
const OUTGOING_BUFFER = 4;

export function standIn(
	client: Client,
	Native: Function,
	proxyModule: ProxyModule,
) {
	if (!sessions) {
		sessions = new WeakMap();
		duplexes = new WeakMap();
		sessionErrors = new WeakSet();
		makeThrottle();
	}
	const realm = client.global as unknown as Realm;
	const { TypeError, RangeError, DOMException, Promise, Object, Date } =
		realm as {
			TypeError: TypeErrorConstructor;
			RangeError: RangeErrorConstructor;
			DOMException: typeof globalThis.DOMException;
			Promise: PromiseConstructor;
			Object: ObjectConstructor;
			Date: DateConstructor;
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
		// an array is stepped as the native array iterator steps it, as
		// Chrome does: it calls none of the iteration natives, which the page
		// may have replaced (access-tamper)
		const iterator = (
			isArray(value) ? ownIterable(value) : Reflect.apply(method, value, [])
		) as Iterator<unknown>;
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

	// the members of the options a browser may leave out (Chrome 157 reads
	// `headers`, 158 the anticipated stream counts before it): which this one
	// reads is asked of the realm's own constructor once, with a URL it
	// refuses after reading them, so nothing is opened
	let optionsRead: string[] | undefined;
	const readsOption = (name: string) =>
		(optionsRead ??= (() => {
			const read: string[] = [];
			const probe = {};
			for (const each of LATER_OPTIONS)
				Reflect.defineProperty(probe, each, {
					get: () => void read.push(each),
					enumerable: true,
				});
			try {
				Reflect.construct(Native, ['', probe]);
			} catch (error) {
				// the URL, refused
			}
			return read;
		})()).includes(name);
	/** the page's object as a primitive, as ToPrimitive with the hint `number` makes it */
	const toPrimitive = (value: object, context: string) => {
		const given = value as Record<PropertyKey, unknown>;
		const exotic = given[Symbol.toPrimitive];
		if (exotic !== undefined && exotic !== null) {
			if (typeof exotic !== 'function') {
				// (in the engine's words, which describe the value and the object:
				// a Date's ToPrimitive is the engine's runtime one, as the
				// browser's conversion, where `+` words it otherwise)
				const like = {};
				Reflect.setPrototypeOf(like, Reflect.getPrototypeOf(value));
				Reflect.defineProperty(like, Symbol.toPrimitive, { value: exotic });
				let text = '';
				try {
					Reflect.construct(Date, [like]);
				} catch (error) {
					text = (error as Error).message;
				}
				throw failed(context, text);
			}
			const made: unknown = Reflect.apply(exotic, value, ['number']);
			if (!isObject(made)) return made;
		} else
			for (const name of ['valueOf', 'toString']) {
				const method = given[name];
				if (typeof method !== 'function') continue;
				const made: unknown = Reflect.apply(method, value, []);
				if (!isObject(made)) return made;
			}
		throw failed(context, 'Cannot convert object to primitive value');
	};
	/**
	 * A WebIDL `[EnforceRange] unsigned short?` of the page's value. What the
	 * conversion itself refuses carries `context` as Chrome's does; what the
	 * page's own valueOf throws is thrown as it is
	 */
	const unsignedShort = (value: unknown, context: string) => {
		if (value === undefined || value === null) return null;
		const made = isObject(value)
			? toPrimitive(value as object, context)
			: value;
		if (typeof made === 'symbol' || typeof made === 'bigint')
			throw failed(
				context,
				`Cannot convert a ${typeof made === 'symbol' ? 'Symbol' : 'BigInt'} value to a number`,
			);
		const number = +(made as number);
		if (number !== number)
			throw failed(context, "Value is not of type 'unsigned short'.");
		if (number - number !== 0)
			throw failed(
				context,
				"Value is infinite and not of type 'unsigned short'.",
			);
		if (number <= -1 || number >= 0x10000)
			throw failed(
				context,
				"Value is outside the 'unsigned short' value range.",
			);
		// (truncated; -0.5 is 0)
		return number - (number % 1) + 0;
	};
	/** a WebIDL ByteString of the page's value */
	const byteString = (value: unknown, context: string) => {
		const text = primitive(value, context) as string;
		if (/[\u0100-\uffff]/.test(text))
			throw failed(context, 'String contains non ISO-8859-1 code point.');
		return text;
	};
	/** `headers`: (record<ByteString, ByteString> or sequence<sequence<ByteString>>), read as Chrome reads it */
	const headerList = (value: unknown, context: string): string[][] => {
		if (value === undefined) return [];
		if (value === null || !isObject(value))
			throw failed(
				context,
				notOfType(
					'(record<ByteString, ByteString> or sequence<sequence<ByteString>>)',
				),
			);
		const given = value as Record<PropertyKey, unknown>;
		const method = given[Symbol.iterator];
		if (method !== undefined && method !== null)
			return sequence(value, context, (pair) =>
				sequence(pair, context, (item) => byteString(item, context)),
			);
		const out: string[][] = [];
		for (const key of Reflect.ownKeys(given)) {
			if (!Reflect.getOwnPropertyDescriptor(given, key)?.enumerable) continue;
			const name = byteString(key, context);
			out.push([name, byteString(given[key], context)]);
		}
		return out;
	};

	/**
	 * The constructor's options, read as Chrome reads them: the anticipated
	 * counts of the server's bidirectional and unidirectional streams (158
	 * on), `headers` (157 on), `protocols`, then `serverCertificateHashes`
	 */
	const options = (
		value: unknown,
	): [string[], ArrayBuffer[], string[][], (number | null)[], boolean] => {
		const context = "construct 'WebTransport'";
		const values: ArrayBuffer[] = [];
		if (value === undefined || value === null)
			return [
				[],
				values,
				[],
				[null, null],
				!readsOption('datagramsReadableType'),
			];
		if (!isObject(value))
			throw failed(context, notOfType('WebTransportOptions'));
		const given = value as Record<string, unknown>;
		const from = (name: string) =>
			reading(context, name, 'WebTransportOptions');
		const counts = ANTICIPATED.map((name) =>
			readsOption(name) ? unsignedShort(given[name], from(name)) : null,
		);
		/** WebIDL enum strings, read before headers on Chrome 159. */
		const enumOption = (name: string, type: string, allowed: string[]) => {
			if (!readsOption(name)) return undefined;
			const value = given[name];
			if (value === undefined) return undefined;
			const text = primitive(value, from(name)) as string;
			if (!allowed.includes(text))
				throw failed(
					from(name),
					`The provided value '${text}' is not a valid enum value of type ${type}.`,
				);
			return text;
		};
		enumOption('congestionControl', 'WebTransportCongestionControl', [
			'default',
			'throughput',
			'low-latency',
		]);
		const readableType = enumOption(
			'datagramsReadableType',
			'ReadableStreamType',
			['bytes'],
		);
		const headers = readsOption('headers')
			? headerList(given.headers, from('headers'))
			: [];
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
		return [
			names,
			values,
			headers,
			counts,
			!readsOption('datagramsReadableType') || readableType === 'bytes',
		];
	};

	/** the page's headers as Chrome sends them, or Chrome's refusal of them */
	const headersOut = (given: string[][]) => {
		const context = "construct 'WebTransport'";
		const out: [string, string][] = [];
		let reserved = false;
		for (const pair of given) {
			if (pair.length !== 2) throw failed(context, 'Invalid value');
			if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(pair[0]))
				throw failed(context, 'Invalid name');
			const value = pair[1].replace(HTTP_SPACE, '');
			if (/[\0\r\n]/.test(value)) throw failed(context, 'Invalid value');
			const name = pair[0].toLowerCase();
			if (name === 'wt-available-protocols') reserved = true;
			if (dropped(name, value)) continue;
			// sorted by name, in the page's order within one
			let at = out.length;
			while (at > 0 && out[at - 1][0] > name) at--;
			out.splice(at, 0, [name, value]);
		}
		if (reserved)
			throw failed(
				context,
				"The 'wt-available-protocols' header cannot be set.",
			);
		return out;
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
							...(session.datagramBytes ? { type: 'bytes' } : {}),
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
		const [protocols, hashes, given, anticipated, datagramBytes] = options(
			args[1],
		);
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
		// the page's own connect-src. A document's: the browser reports the
		// refusal itself, by a request the browser's copy of the policy
		// refuses (DocumentClient.connectRefusal), and a policy that only
		// reports hears of it from the inject. A worker's (its script's
		// response's, or its creator's): the worker reports every refusal
		// itself (WorkerClient.connectVerdict)
		const policed = client as {
			connectRefusal?: (url: URL) => boolean;
			reportRefusal?: (directive: string, url: URL) => void;
			connectVerdict?: (url: URL) => boolean;
		};
		let refused: boolean;
		if (policed.connectVerdict) refused = policed.connectVerdict(url);
		else {
			refused = policed.connectRefusal?.(url) ?? false;
			if (!refused) policed.reportRefusal?.('connect-src', url);
		}
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
		const headers = headersOut(given);

		const session: Session = {
			over: false,
			ready: {},
			closed: {},
			draining: {},
			creations: [],
			streams: [],
			controllers: [],
			writes: [],
			numbers: [1024, null, null, 1, 1],
			url: url.href,
			protocols,
			headers,
			hashes,
			anticipated,
			datagramBytes,
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
			// Chrome 159 reads the send-group and send-order options, in that
			// order, even when a connection is still opening. Earlier versions
			// do not touch them. Preserve observable getters and their errors.
			if (
				readsOption('datagramsReadableType') &&
				given !== undefined &&
				given !== null
			) {
				const options = given as Record<string, unknown>;
				void options.sendGroup;
				void options.sendOrder;
			}
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
	/** an anticipated count of the server's streams, which the page may set again */
	const anticipated = (index: number) => ({
		get: (session: Session) => session.anticipated[index],
		set: (session: Session, value: unknown) => {
			session.anticipated[index] = unsignedShort(
				value,
				`set the '${ANTICIPATED[index]}' property on 'WebTransport'`,
			);
		},
	});
	// an empty Headers the page cannot change (the browser's `responseHeaders`
	// guard): the realm's own, taken with its first session
	const ResponseOf = realm.Response as typeof Response | undefined;
	const errorResponse = ResponseOf?.error;
	const headersOf =
		ResponseOf &&
		Reflect.getOwnPropertyDescriptor(ResponseOf.prototype, 'headers')?.get;
	hook(Native.prototype, sessions, {
		// a session is HTTP/3 with datagrams once up (stomp-h3 has no other)
		reliability: {
			get: (session: Session) =>
				session.live ? 'supports-unreliable' : 'pending',
		},
		// (stomp-h3 tells no DRAIN_WEBTRANSPORT_SESSION: it stays pending, as
		// the browser's does for a session that ends otherwise)
		draining: { get: (session: Session) => promiseOf(session.draining) },
		// (the server's fields are not handed over by stomp-h3: an up session's
		// are none, what Chrome shows of a server that sends only `:status`
		// and `wt-protocol`)
		responseHeaders: {
			get: (session: Session) =>
				session.live && errorResponse && headersOf
					? (session.responseHeaders ??= Reflect.apply(
							headersOf,
							Reflect.apply(errorResponse, ResponseOf, []),
							[],
						) as object)
					: null,
		},
		anticipatedConcurrentIncomingBidirectionalStreams: anticipated(0),
		anticipatedConcurrentIncomingUnidirectionalStreams: anticipated(1),
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
