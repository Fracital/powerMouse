// A page's WebTransport session, on the transport's side
// (docs/webtransport.md). The page's stand-in (src/inject/webTransport.ts)
// asks for a session on a port of its own; this opens a wisp UDP stream to
// the server, runs the session over it with stomp-h3's WebTransport client
// (deploy/epoxy/h3, the module HTTP/3 uses), and serves it on the port: a
// message for each datagram, each chunk and each stream, the page asking
// for every chunk it reads and told when each one it wrote was taken, so
// the page's streams have the backpressure QUIC's flow control gives them.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { postToPort, TransportToHost, WebTransportMessage } from './messages';
import { logTransport, rideOf, transportLog } from './transportLog';
import {
	handshakeStage,
	originOf,
	startTrace,
	wispReason,
	type StageTrace,
} from './webTransportTrace';

/** stomp-h3's session (deploy/epoxy/h3/src/webtransport.rs) */
interface WtSession {
	readonly protocol: string;
	readonly max_datagram_size: number;
	open_bi(): Promise<number>;
	open_uni(): Promise<number>;
	accept_bi(): Promise<number | undefined>;
	accept_uni(): Promise<number | undefined>;
	read(handle: number, max: number): Promise<Uint8Array | undefined>;
	write(handle: number, data: Uint8Array): Promise<void>;
	finish(handle: number): Promise<void>;
	reset(handle: number, code: number): void;
	stop(handle: number, code: number): void;
	release(handle: number): void;
	/** the peer's STOP_SENDING code once it came; undefined when the send side ended otherwise */
	stopped?(handle: number): Promise<number | undefined>;
	/** the peer's RESET_STREAM code once it came, read or not; undefined when the receive side ended otherwise */
	reset_received?(handle: number): Promise<number | undefined>;
	send_datagram(data: Uint8Array): boolean;
	read_datagram(): Promise<Uint8Array | undefined>;
	close(code: number, reason: string): void;
	closed(): Promise<{ closeCode: number; reason: string }>;
	/** diagnostics: RTT, handshake time, datagram and packet counters */
	stats?(): { handshakeMs?: number; rttMs?: number } | undefined;
}
interface WtModule {
	default(): Promise<unknown>;
	connect_webtransport?: (
		url: string,
		readable: ReadableStream<Uint8Array>,
		writable: WritableStream<Uint8Array>,
		options: {
			origin: string;
			protocols: string[];
			headers: [string, string][];
			hashes: Uint8Array[];
			pem?: string;
			timeoutMs: number;
		},
	) => Promise<WtSession>;
}

/** what epoxy's connect_udp answers */
interface UdpStream {
	read: ReadableStream<Uint8Array>;
	write: WritableStream<Uint8Array>;
	/** the wisp close reason, once `read` has ended (deploy/epoxy patch 0058) */
	closeReason?: () => number | undefined;
}

/**
 * Whether a page of `origin` may open a session to `url`: false refuses it
 * before anything is opened (the built-in blocker's lists, asked as for a
 * WebSocket's handshake)
 */
export type AdmitSession = (url: URL, origin: string) => Promise<boolean>;

/** how long a session's handshake may take: Chrome gives up on a silent server after 4 s (measured) */
const HANDSHAKE_MS = 4000;
/** the most a stream's chunk carries to the page */
const CHUNK = 64 * 1024;
/**
 * What a stream may have sent the page that its reader has not taken yet.
 * Chrome reads what arrives into the page's stream as it arrives (a
 * reader that waits gets it at once, and a reset loses what was not read);
 * past this, the rest waits in QUIC's own window.
 */
const WINDOW = 256 * 1024;
/** a close's reason as it goes out: at most 1024 bytes of UTF-8, cut at a character */
function reasonOf(reason: string) {
	const bytes = new TextEncoder().encode(reason);
	if (bytes.byteLength <= 1024) return reason;
	let end = 1024;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

/** where each transport's stomp-h3 is and the roots its HTTP/3 option adds (construct.ts) */
const modules = new WeakMap<object, { url: string; pem?: string }>();
/** the stomp-h3 module at `url`, per realm: the HTTP/3 wrapper's import of the same URL is this one */
const imported = new Map<string, Promise<WtModule>>();
/** each module's wasm, instantiated the first time a session needs it */
const instantiated = new WeakMap<WtModule, Promise<unknown>>();

/** construct.ts: `transport`'s sessions use stomp-h3 at `url` */
export function useWebTransportModule(
	transport: object,
	url: string,
	pem?: string,
) {
	modules.set(transport, { url, pem });
}

/** the module's exports, before its wasm is instantiated: enough to tell whether it has a WebTransport client */
function importModule(url: string): Promise<WtModule> {
	let module = imported.get(url);
	if (!module) {
		module = import(/* @vite-ignore */ url) as Promise<WtModule>;
		// a module that did not load is tried again by the next session
		module.catch(() => imported.delete(url));
		imported.set(url, module);
	}
	return module;
}

function instantiate(module: WtModule): Promise<unknown> {
	let wasm = instantiated.get(module);
	if (!wasm) {
		wasm = module.default();
		wasm.catch(() => instantiated.delete(module));
		instantiated.set(module, wasm);
	}
	return wasm;
}

/** follows the wrappers down (RevivingTransport, Http3Transport expose `base`) */
function* layers(transport: ProxyTransport) {
	let current: unknown = transport;
	for (let depth = 0; depth < 4 && current; depth++) {
		yield current as Record<string, unknown>;
		current = (current as { base?: unknown }).base;
	}
}

/**
 * The roots the session's certificate may chain to besides the WebPKI's:
 * the HTTP/3 option's (`pem`) and the ones the host gave epoxy for its own
 * TLS (`pem_files`), so a server the host's transport trusts is trusted
 * here too
 */
function extraRoots(transport: ProxyTransport): string {
	const pems: string[] = [];
	for (const layer of layers(transport)) {
		const options = layer.opts as { pem_files?: unknown } | undefined;
		if (Array.isArray(options?.pem_files))
			for (const pem of options.pem_files)
				if (typeof pem === 'string') pems.push(pem);
		const pem = modules.get(layer)?.pem;
		if (pem) pems.push(pem);
	}
	return pems.join('\n');
}

const failure = (error: string): [TransportToHost['webtransport'][1], []] => [
	{ result: 'failure', error },
	[],
];

/** a WebTransport code a stomp-h3 rejection names ("reset 7", "stop 9"), if any */
const codeOf = (error: unknown): number | undefined => {
	const match = /^(?:reset|stop) (\d+)/.exec(
		String((error as Error)?.message ?? error),
	);
	return match ? Number(match[1]) : undefined;
};

/** what the page's session reads when the transport fails it (src/inject/webTransport.ts carry) */
const PAGE_FAILURE =
	'WebTransportError "Opening handshake failed." (source session, streamErrorCode null), as Chrome ends a session whose server cannot be reached';

/**
 * Open a session for the page and serve it on `port`; answers the rpc once
 * it is up or has failed. In the verbose mode its stages are traced
 * (webTransportTrace.ts): one `[wt]` line names the one that failed.
 */
export async function serveWebTransport(
	transport: ProxyTransport,
	session: TransportToHost['webtransport'][0],
	admit?: AdmitSession,
): Promise<[TransportToHost['webtransport'][1], []]> {
	const trace = startTrace(`page session to ${originOf(session.url)}`);
	const answer = await openWebTransport(transport, session, admit, trace);
	if (trace) {
		if (answer[0].result === 'success') trace.step('page', 'ready');
		else if (trace.failed !== 'page') trace.step('page', PAGE_FAILURE);
		trace.tell(
			answer[0].result === 'success'
				? `protocol ${answer[0].protocol ? 'chosen' : 'none'}, max datagram ${answer[0].maxDatagramSize} bytes`
				: undefined,
		);
	}
	return answer;
}

async function openWebTransport(
	transport: ProxyTransport,
	{
		url,
		origin,
		protocols,
		headers,
		hashes,
		port,
	}: TransportToHost['webtransport'][0],
	admit: AdmitSession | undefined,
	trace: StageTrace | null,
): Promise<[TransportToHost['webtransport'][1], []]> {
	let target: URL;
	try {
		target = new URL(url);
	} catch (error) {
		port.close();
		trace?.fail('setup', 'invalid URL');
		return failure('invalid URL');
	}
	trace?.step('carrier', `the Wisp connection ${rideOf(transport, true)}`);
	const moduleURL = [...layers(transport)]
		.map((layer) => modules.get(layer)?.url)
		.find(Boolean);
	type UdpClient = { connect_udp?: (url: string) => Promise<UdpStream> };
	const client = [...layers(transport)].find(
		(layer) => layer.client && typeof layer.client === 'object',
	)?.client as UdpClient | undefined;
	// a transport or a stomp-h3 without a WebTransport client (one released
	// before it had one) fails every session as the stand-in alone does:
	// before the blocker is asked or a stream is opened, so nothing is sent
	const module =
		moduleURL && client?.connect_udp
			? await importModule(moduleURL).catch(() => undefined)
			: undefined;
	const connect = module?.connect_webtransport;
	if (!module || !connect || !client?.connect_udp) {
		port.close();
		trace?.fail(
			'setup',
			!client?.connect_udp
				? 'the transport has no Wisp UDP streams'
				: !module
					? "stomp-h3 did not load (HTTP/3's module)"
					: 'this stomp-h3 has no WebTransport client',
		);
		return failure('no WebTransport on this transport');
	}
	if (admit && !(await admit(target, origin).catch(() => true))) {
		port.close();
		trace?.fail('setup', "the content blocker's lists refuse the session");
		return failure('refused');
	}
	const udpTarget = `${target.hostname}:${target.port || 443}`;
	let session: WtSession;
	let channel: UdpStream | undefined = undefined;
	let stage: 'setup' | 'udp' | 'handshake' = 'setup';
	try {
		await instantiate(module);
		stage = 'udp';
		const host = target.hostname;
		const opened = await client.connect_udp(
			`udp://${host}:${target.port || 443}`,
		);
		channel = opened;
		stage = 'handshake';
		trace?.step('udp', `Wisp UDP stream to ${udpTarget} open`);
		// the page may have closed the session while it connected: the port
		// says so by closing, which a MessagePort tells in Chrome 152 on
		let abandoned = false;
		port.addEventListener('close', () => (abandoned = true));
		port.start();
		const pem = extraRoots(transport);
		trace?.step(
			'quic',
			`handshake: ${hashes.length ? `${hashes.length} pinned certificate hashes` : `the Web PKI's roots${pem ? " and the host transport's" : ''}`}, ${protocols.length} protocols offered, ${(headers ?? []).length} page headers`,
		);
		session = await connect(url, opened.read, opened.write, {
			origin,
			protocols,
			headers: headers ?? [],
			hashes: hashes.map((hash) => new Uint8Array(hash)),
			...(pem ? { pem } : {}),
			timeoutMs: HANDSHAKE_MS,
		});
		if (abandoned) {
			session.close(0, '');
			trace?.fail('page', 'the page closed the session while it connected');
			return failure('closed while connecting');
		}
	} catch (error) {
		port.close();
		const message = String((error as Error)?.message ?? error);
		if (trace) traceFailure(trace, stage, message, channel, udpTarget);
		channel?.write.abort().catch(() => {});
		return failure(message);
	}
	if (trace) {
		const stats = statsOf(session);
		trace.step(
			'quic',
			`up (QUIC v1, ALPN h3, TLS 1.3: all stomp-h3 offers)${stats ? `, handshake ${stats}` : ''}`,
		);
		trace.step(
			'h3',
			'SETTINGS with H3_DATAGRAM and ENABLE_WEBTRANSPORT, extended CONNECT :status 200',
		);
	}
	if (transportLog.on)
		logTransport(
			`WebTransport session to ${target.origin}: HTTP/3 over QUIC over a Wisp UDP stream, ${rideOf(transport, true)}`,
		);
	serveSession(session, port);
	return [
		{
			result: 'success',
			protocol: session.protocol,
			maxDatagramSize: session.max_datagram_size,
		},
		[],
	];
}

/** `12 ms, rtt 3 ms` from stomp-h3's session stats, when it has them */
function statsOf(session: WtSession): string {
	try {
		const stats = session.stats?.();
		if (!stats) return '';
		const ms = (n: unknown) => (typeof n === 'number' ? Math.round(n) : '?');
		return `${ms(stats.handshakeMs)} ms, rtt ${ms(stats.rttMs)} ms`;
	} catch {
		return '';
	}
}

/** the stage a failure belongs to, and the relay's close reason when the stream ended */
function traceFailure(
	trace: StageTrace,
	stage: 'setup' | 'udp' | 'handshake',
	message: string,
	channel: UdpStream | undefined,
	udpTarget: string,
) {
	if (stage === 'setup') {
		trace.fail('setup', `stomp-h3's wasm did not start: ${message}`);
		return;
	}
	if (stage === 'udp') {
		trace.fail('udp', `Wisp UDP stream to ${udpTarget} not opened: ${message}`);
		return;
	}
	const { stage: failed, why } = handshakeStage(message);
	if (failed === 'udp') {
		let reason: number | undefined;
		try {
			reason = channel?.closeReason?.();
		} catch {
			reason = undefined;
		}
		trace.fail(
			'udp',
			`${why}: ${reason === undefined ? 'the relay gave no close reason (or this epoxy does not report one)' : `the relay closed it with ${wispReason(reason)}`}`,
		);
	} else trace.fail(failed, why);
	trace.step(failed, `stomp-h3: ${message}`);
}

function serveSession(session: WtSession, port: MessagePort) {
	const post = (message: WebTransportMessage, buffer?: ArrayBuffer) =>
		postToPort(port, message, buffer ? [buffer] : []);
	/** a copy out of wasm is ours to transfer */
	const bufferOf = (bytes: Uint8Array) =>
		bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? (bytes.buffer as ArrayBuffer)
			: (bytes.slice().buffer as ArrayBuffer);
	/** stream ids to stomp-h3 handles; a page stream waits for its open */
	const handles = new Map<number, Promise<number>>();
	/** the sides of each stream still in use ('r', 'w'): its handle is released when none is */
	const sides = new Map<number, Set<string>>();
	let incoming = 0;
	let over = false;
	/** the page closed the session: its port closing after says nothing more */
	let closing = false;
	const finish = () => {
		if (over) return;
		over = true;
		port.close();
	};

	const track = (id: number, handle: Promise<number>, open: string) => {
		handles.set(id, handle);
		sides.set(id, new Set(open));
	};
	const side = (write: boolean) => (write ? 'w' : 'r');
	/** one side of a stream is done with: false if it already was */
	const done = (id: number, write: boolean) => {
		const open = sides.get(id);
		if (!open?.delete(side(write))) return false;
		if (open.size) return true;
		const handle = handles.get(id);
		sides.delete(id);
		handles.delete(id);
		void handle?.then(
			(handle) => over || session.release(handle),
			() => {},
		);
		return true;
	};
	/** a send side: the peer's STOP_SENDING ends it at once, as natively, a write waiting or not */
	const watchStop = (id: number, handle: number) =>
		session.stopped?.(handle).then(
			(code) => {
				if (code === undefined || over || !done(id, true)) return;
				post({ t: 'e', id, w: true, code });
			},
			() => {},
		);
	/** a task later: what the session's streams heard in the same turn reaches the page first */
	const after = () => new Promise((resolve) => setTimeout(resolve, 0));
	/** receive sides' errors posted a task late, which the session's end waits for */
	const late = new Set<Promise<void>>();
	const fail = (id: number, write: boolean, error: unknown) => {
		if (over) return;
		// A reset that comes with the peer's STOP_SENDING (a server closing
		// as webtransport-go does) reaches the page after it, as natively:
		// Chrome errors the writable first. stomp-h3 hears the stop a hop
		// later than a read hears the reset, in the same turn.
		const stopMayCome =
			!write && session.stopped !== undefined && !!sides.get(id)?.has('w');
		if (!done(id, write)) return;
		const code = codeOf(error);
		const message: WebTransportMessage = {
			t: 'e',
			id,
			...(write ? { w: true } : {}),
			...(code === undefined ? {} : { code }),
		};
		if (!stopMayCome) return void post(message);
		const posted = after().then(() => {
			late.delete(posted);
			if (!over) post(message);
		});
		late.add(posted);
	};
	/** each receive side's credit: the page's reader took all it was sent */
	const credits = new Map<number, () => void>();
	/** a receive side: read as it comes, up to WINDOW ahead of the page's reader */
	const receive = (id: number, handle: number) => {
		let ahead = 0;
		let ended = false;
		let wait: (() => void) | undefined;
		const end = () => {
			if (ended) return false;
			ended = true;
			credits.delete(id);
			wait?.();
			return true;
		};
		credits.set(id, () => {
			ahead = 0;
			wait?.();
			wait = undefined;
		});
		const stopped = (error: unknown) => {
			if (end()) fail(id, false, error);
		};
		void (async () => {
			for (;;) {
				if (ahead >= WINDOW)
					await new Promise<void>((resolve) => (wait = resolve));
				if (ended || over) return;
				const bytes = await session.read(handle, CHUNK);
				if (ended || over) return;
				if (!bytes) {
					end();
					post({ t: 'b', id });
					return void done(id, false);
				}
				ahead += bytes.byteLength;
				const buffer = bufferOf(bytes);
				post({ t: 'b', id, b: buffer }, buffer);
			}
		})().catch(stopped);
		// a reset while the page's reader is behind ends it now, as natively
		session.reset_received?.(handle).then(
			(code) => code === undefined || stopped(new Error(`reset ${code}`)),
			() => {},
		);
		return end;
	};
	const ends = new Map<number, () => boolean>();
	const withHandle = (id: number, run: (handle: number) => unknown) => {
		const handle = handles.get(id);
		if (handle) void handle.then(run, () => {});
	};

	port.onmessage = ({ data }: MessageEvent<WebTransportMessage>) => {
		if (over) return;
		const { id } = data as { id: number };
		switch (data.t) {
			case 'd':
				session.send_datagram(new Uint8Array(data.b));
				break;
			case 'o': {
				const opening = data.uni ? session.open_uni() : session.open_bi();
				track(id, opening, data.uni ? 'w' : 'rw');
				opening.then(
					(handle) => {
						post({ t: 'n', id });
						watchStop(id, handle);
						if (!data.uni) ends.set(id, receive(id, handle));
					},
					(error) => fail(id, true, error),
				);
				break;
			}
			case 'w':
				withHandle(id, (handle) =>
					session.write(handle, new Uint8Array(data.b)).then(
						() => post({ t: 'a', id }),
						(error) => fail(id, true, error),
					),
				);
				break;
			case 'f':
				withHandle(id, (handle) =>
					session.finish(handle).then(
						() => {
							post({ t: 'a', id });
							done(id, true);
						},
						(error) => fail(id, true, error),
					),
				);
				break;
			case 'r':
			case 's':
				withHandle(id, (handle) => {
					const write = data.t === 'r';
					// (ended already: the peer's reset, stop or FIN came first)
					if (!write) ends.get(id)?.();
					if (!done(id, write)) return;
					if (write) session.reset(handle, data.code);
					else session.stop(handle, data.code);
				});
				break;
			case 'p':
				credits.get(id)?.();
				break;
			case 'c':
				closing = true;
				session.close(data.code >>> 0, reasonOf(data.reason));
				break;
		}
	};
	// the page is gone (its document unloaded, its worker ended): so is
	// its session
	port.addEventListener('close', () => {
		if (over) return;
		if (!closing) session.close(0, '');
		finish();
	});
	port.start();

	// the server's streams, as they come
	const accept = async (uni: boolean) => {
		for (;;) {
			const handle = await (uni ? session.accept_uni() : session.accept_bi());
			if (handle === undefined || over) return;
			const id = --incoming;
			track(id, Promise.resolve(handle), uni ? 'r' : 'rw');
			post({ t: 'i', id, ...(uni ? { uni } : {}) });
			if (!uni) watchStop(id, handle);
			ends.set(id, receive(id, handle));
		}
	};
	accept(false).catch(() => {});
	accept(true).catch(() => {});
	(async () => {
		for (;;) {
			const datagram = await session.read_datagram();
			if (!datagram || over) return;
			const buffer = bufferOf(datagram);
			post({ t: 'D', b: buffer }, buffer);
		}
	})().catch(() => {});
	// (a task later, and after the streams' late errors: what the
	// session's streams heard before it ended reaches the page first)
	const settled = async () => {
		await after();
		await Promise.all(late);
	};
	session.closed().then(
		async ({ closeCode, reason }) => {
			await settled();
			if (!over) post({ t: 'Z', code: closeCode, reason });
			finish();
		},
		async () => {
			await settled();
			if (!over) post({ t: 'L' });
			finish();
		},
	);
}
