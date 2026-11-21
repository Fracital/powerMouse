// An opt-in Tor-only Wisp relay. holyWisp validates a name with DNS before
// sending the *original hostname* in its SOCKS5 CONNECT (ATYP 3). Giving it
// the ordinary resolver leaks the destination, and makes .onion fail before
// Tor sees it. This loopback DNS server returns a public, never-dialled A
// placeholder for that validation; the only outbound TCP path is SOCKS5.
// It NEVER asks or forwards a question to another DNS server.
//
// A SOCKS greeting only proves that something listens on the port. Whether
// Tor has bootstrapped and builds circuits is watched by createTorMonitor:
// Tor's control port's events over one connection kept open (STATUS_CLIENT's
// BOOTSTRAP and CIRCUIT_ESTABLISHED, as Brave's Tor launcher follows them)
// when one is configured, else the relay's own traffic, and a bounded
// CONNECT through SOCKS to a probe host only when there is none. The relay
// takes new Wisp connections only while that says ready (demo/server.js).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { holyWisp } from 'holywisp';

// A syntactically public address: holyWisp's outbound-address policy rejects
// private/test-net addresses during name validation, including with a proxy.
// This address is never a TCP dial target: proxy is mandatory and all TCP
// streams are proxied by hostname. IP-literal CONNECTs are forbidden.
const VALIDATION_A = Buffer.from([1, 1, 1, 1]);
// Local and special-use names never go to Tor: the host's own names, Tor's
// `.exit`/`.noconnect` notations, and the reverse-lookup zones.
const BLOCKED_NAMES =
	/(?:^|\.)(?:localhost|local|lan|internal|intranet|home\.arpa|in-addr\.arpa|ip6\.arpa|exit|noconnect|test|invalid|example)$/i;
// A last label that is a number (`127.0.0.1` spelled in a form the IP
// literal check does not read, `0x7f.1`) is an address, not a name: no
// public top-level domain is numeric.
const NUMERIC_LAST_LABEL = /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/i;

// The ports no browser request goes to (fetch.spec.whatwg.org/#port-blocking,
// src/server/badPorts.ts): a page could not reach them natively, so the Tor
// relay refuses them too (mail, IRC, SSH, ...). Port 0 is no Wisp port.
export const TOR_BLOCKED_PORTS = [
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
	87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
	139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
	540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
	2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
	6679, 6697, 10080,
];

/** Whether a hostname is one the Tor relay refuses before any lookup. */
export function blockedTorName(name) {
	return (
		name.length > 253 ||
		!name.includes('.') ||
		BLOCKED_NAMES.test(name) ||
		NUMERIC_LAST_LABEL.test(name)
	);
}

/** Answer only ordinary uncompressed DNS questions, without upstream I/O. */
export function validationDnsAnswer(query) {
	if (!Buffer.isBuffer(query) || query.length < 17 || query.length > 4096)
		return null;
	if (query[2] & 0xf8 || query.readUInt16BE(4) !== 1) return null;
	let offset = 12;
	const labels = [];
	while (offset < query.length) {
		const length = query[offset++];
		if (length === 0) break;
		if (length > 63 || offset + length > query.length) return null;
		const label = query.toString('ascii', offset, offset + length);
		if (!/^[a-z0-9_-]+$/i.test(label)) return null;
		labels.push(label);
		offset += length;
	}
	if (!labels.length || offset + 4 > query.length) return null;
	const end = offset + 4;
	const type = query.readUInt16BE(offset);
	const klass = query.readUInt16BE(offset + 2);
	const name = labels.join('.');
	const denied = blockedTorName(name);
	const answerA = !denied && klass === 1 && type === 1;
	const response = Buffer.alloc(12);
	query.copy(response, 0, 0, 2);
	response.writeUInt16BE(0x8180 | (denied ? 3 : 0), 2); // response, recursive available; NXDOMAIN for local names
	response.writeUInt16BE(1, 4); // echo exactly the question for the resolver's name check
	response.writeUInt16BE(answerA ? 1 : 0, 6);
	const question = query.subarray(12, end);
	if (!answerA) return Buffer.concat([response, question]);
	const record = Buffer.from([
		0xc0,
		0x0c, // pointer to original question name
		0x00,
		0x01, // A
		0x00,
		0x01, // IN
		0,
		0,
		0,
		0, // TTL 0: cache no placeholder addresses
		0,
		4,
		...VALIDATION_A,
	]);
	return Buffer.concat([response, question, record]);
}

/** Bind the DNS validation shim to loopback on an ephemeral UDP port. */
export async function openValidationDns() {
	const socket = createSocket('udp4');
	socket.on('message', (query, peer) => {
		const response = validationDnsAnswer(query);
		if (response) socket.send(response, peer.port, peer.address);
	});
	await new Promise((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(0, '127.0.0.1', () => {
			socket.off('error', reject);
			resolve();
		});
	});
	return {
		address: `127.0.0.1:${socket.address().port}`,
		socket,
		close: () => new Promise((resolve) => socket.close(resolve)),
	};
}

/** Only a locally owned SOCKS5 endpoint is accepted as the Tor egress. */
export function parseTorSocks5(value) {
	let url = null;
	try {
		url = new URL(value);
	} catch {
		// the message below says what it must be
	}
	if (
		!url ||
		url.protocol !== 'socks5h:' ||
		!['127.0.0.1', '[::1]'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname ||
		url.search ||
		url.hash
	)
		throw new TypeError(
			'STOMP_TOR_SOCKS5 must be socks5h://127.0.0.1:PORT or socks5h://[::1]:PORT (no credentials)',
		);
	const port = Number(url.port || 1080);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new TypeError('Invalid Tor SOCKS5 port');
	return {
		url: url.href,
		host: url.hostname === '[::1]' ? '::1' : url.hostname,
		port,
	};
}

/**
 * Tor's control port, which must be the machine's own: `127.0.0.1:PORT`,
 * `[::1]:PORT` or `unix:/absolute/path` (Tor's ControlSocket).
 */
export function parseTorControl(value) {
	const text = String(value).trim();
	if (text.startsWith('unix:')) {
		const path = text.slice(5);
		if (!isAbsolute(path) || path.includes('\0'))
			throw new TypeError('STOMP_TOR_CONTROL unix: needs an absolute path');
		return { path };
	}
	const match = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(text);
	const port = Number(match?.[2]);
	if (!match || port < 1 || port > 65535)
		throw new TypeError(
			'STOMP_TOR_CONTROL must be 127.0.0.1:PORT, [::1]:PORT or unix:/path',
		);
	return { host: match[1] === '[::1]' ? '::1' : match[1], port };
}

/** The circuit probe's destination: a public hostname and a port. */
export function parseTorProbe(value) {
	const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(String(value).trim());
	const port = Number(match?.[2]);
	if (
		!match ||
		port < 1 ||
		port > 65535 ||
		isIP(match[1]) ||
		blockedTorName(match[1].toLowerCase())
	)
		throw new TypeError(
			'STOMP_TOR_PROBE must be host:port with a public hostname, or off',
		);
	return { host: match[1].toLowerCase(), port };
}

/** One socket with a deadline: `finish` settles once and destroys it. */
function bounded(options, timeoutMs, onSocket) {
	return new Promise((resolve, reject) => {
		const socket = connect(options);
		let done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		// a wall-clock bound, not an idle one: a peer that trickles bytes
		// must not hold a check open
		const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
		timer.unref?.();
		socket.once('error', (error) => finish(error));
		socket.once('close', () => finish(new Error('closed')));
		onSocket(socket, finish);
	});
}

/** SOCKS5 method negotiation only: proves a SOCKS endpoint exists, not that Tor bootstrapped. */
export async function probeTorSocks5({ host, port }, timeoutMs = 1200) {
	await bounded({ host, port }, timeoutMs, (socket, finish) => {
		socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
		socket.once('data', (bytes) =>
			finish(
				bytes.length >= 2 && bytes[0] === 5 && bytes[1] === 0
					? null
					: new Error('Tor SOCKS5 refused no-auth negotiation'),
			),
		);
	}).catch((error) => {
		throw new Error(`Tor SOCKS5 probe: ${error.message}`);
	});
}

/**
 * A SOCKS5 CONNECT through Tor to `target` (a public host:port), closed as
 * soon as Tor answers: Tor replies success only once a circuit carried the
 * connection to the destination, so this is the readiness signal when no
 * control port is configured. Nothing is sent to the destination.
 */
export async function probeTorCircuit(
	{ host, port },
	target,
	timeoutMs = 30000,
) {
	const name = Buffer.from(target.host, 'ascii');
	const request = Buffer.concat([
		Buffer.from([5, 1, 0, 3, name.length]),
		name,
		Buffer.from([target.port >> 8, target.port & 255]),
	]);
	await bounded({ host, port }, timeoutMs, (socket, finish) => {
		let step = 0;
		let pending = Buffer.alloc(0);
		socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			if (step === 0 && pending.length >= 2) {
				if (pending[0] !== 5 || pending[1] !== 0)
					return finish(new Error('SOCKS5 refused no-auth negotiation'));
				pending = pending.subarray(2);
				step = 1;
				socket.write(request);
			}
			if (step === 1 && pending.length >= 2)
				finish(
					pending[0] === 5 && pending[1] === 0
						? null
						: new Error(`SOCKS5 CONNECT failed (reply ${pending[1]})`),
				);
		});
	});
}

const CONTROL_SERVER_KEY =
	'Tor safe cookie authentication server-to-controller hash';
const CONTROL_CLIENT_KEY =
	'Tor safe cookie authentication controller-to-server hash';

/**
 * A Tor control-protocol reader: each reply's lines as `{ code, lines }` to
 * the command that waits for it, and each asynchronous event (650) to
 * `onEvent` as its lines
 */
function controlReader(socket, finish, onEvent = () => {}) {
	let buffer = '';
	let lines = [];
	const waiting = [];
	socket.setEncoding('latin1');
	socket.on('data', (text) => {
		buffer += text;
		// a control port that sends without end is no Tor
		if (buffer.length > 65536) return finish(new Error('reply too long'));
		let newline;
		while ((newline = buffer.indexOf('\r\n')) !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 2);
			lines.push(line);
			// `250 OK` ends a reply, `250-...` and `250+...` continue it
			if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
				const reply = { code: Number(line.slice(0, 3)), lines };
				lines = [];
				if (reply.code === 650) onEvent(reply.lines);
				else waiting.shift()?.(reply);
			}
		}
	});
	return (command) =>
		new Promise((resolve) => {
			waiting.push(resolve);
			socket.write(`${command}\r\n`);
		});
}

const quoted = (text) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Parse `status/bootstrap-phase`'s value (`NOTICE BOOTSTRAP PROGRESS=50 TAG=... SUMMARY="..."`). */
export function parseBootstrapPhase(value) {
	const progress = Number(/\bPROGRESS=(\d{1,3})\b/.exec(value)?.[1]);
	if (!Number.isInteger(progress) || progress > 100) return null;
	const tag = /\bTAG=([a-z0-9_]+)/i.exec(value)?.[1] ?? '';
	const summary = /\bSUMMARY="((?:[^"\\]|\\.)*)"/.exec(value)?.[1] ?? '';
	return {
		progress,
		tag,
		// what Tor says of the phase, printable ASCII only and short: it is
		// shown to visitors as is
		summary: summary
			.replace(/\\(.)/g, '$1')
			.replace(/[^\x20-\x7e]/g, '')
			.slice(0, 80),
		warning: /^WARN\b/.test(value),
	};
}

/**
 * Authenticate on a control connection with what PROTOCOLINFO offers: NULL,
 * SAFECOOKIE (the cookie file is read, never sent: only an HMAC of it is,
 * after the port proved it knows the cookie too) or HASHEDPASSWORD with
 * `password`. The plain COOKIE method is not used, since it would send the
 * file's bytes to whoever listens there.
 */
async function authenticate(ask, { password, cookieFile }) {
	const info = await ask('PROTOCOLINFO 1');
	if (info.code !== 250) throw new Error('PROTOCOLINFO refused');
	const auth = info.lines.find((line) => /^250-AUTH /.test(line)) ?? '';
	const methods = (/METHODS=([A-Z,]+)/.exec(auth)?.[1] ?? '').split(',');
	const offeredFile = /COOKIEFILE="((?:[^"\\]|\\.)*)"/.exec(auth)?.[1];
	let command;
	if (methods.includes('NULL')) command = 'AUTHENTICATE';
	else if (methods.includes('HASHEDPASSWORD') && password)
		command = `AUTHENTICATE ${quoted(password)}`;
	else if (methods.includes('SAFECOOKIE')) {
		const path = cookieFile || offeredFile?.replace(/\\(.)/g, '$1');
		if (!path || !isAbsolute(path)) throw new Error('no control cookie file');
		const cookie = await readFile(path);
		if (cookie.length !== 32) throw new Error('not a Tor cookie file');
		const clientNonce = randomBytes(32);
		const challenge = await ask(
			`AUTHCHALLENGE SAFECOOKIE ${clientNonce.toString('hex')}`,
		);
		const hash = /SERVERHASH=([0-9A-F]{64})/i.exec(challenge.lines[0])?.[1];
		const nonce = /SERVERNONCE=([0-9A-F]{64})/i.exec(challenge.lines[0])?.[1];
		if (challenge.code !== 250 || !hash || !nonce)
			throw new Error('AUTHCHALLENGE refused');
		const message = Buffer.concat([
			cookie,
			clientNonce,
			Buffer.from(nonce, 'hex'),
		]);
		const expected = createHmac('sha256', CONTROL_SERVER_KEY)
			.update(message)
			.digest();
		if (!timingSafeEqual(expected, Buffer.from(hash, 'hex')))
			throw new Error('control port does not know the cookie');
		command = `AUTHENTICATE ${createHmac('sha256', CONTROL_CLIENT_KEY)
			.update(message)
			.digest('hex')}`;
	} else throw new Error('no usable control authentication');
	if ((await ask(command)).code !== 250)
		throw new Error('control authentication failed');
}

/** `GETINFO status/bootstrap-phase` and `status/circuit-established` */
async function askBootstrap(ask) {
	const phase = await ask('GETINFO status/bootstrap-phase');
	const value = phase.lines
		.find((line) => line.startsWith('250-status/bootstrap-phase='))
		?.slice('250-status/bootstrap-phase='.length);
	const bootstrap = phase.code === 250 && value && parseBootstrapPhase(value);
	if (!bootstrap) throw new Error('no bootstrap phase');
	// older Tor may not know it: then the phase alone says
	const circuit = await ask('GETINFO status/circuit-established');
	const established = circuit.lines
		.find((line) => line.startsWith('250-status/circuit-established='))
		?.slice(-1);
	return {
		...bootstrap,
		circuit: circuit.code === 250 && established ? established === '1' : null,
	};
}

/** Ask Tor's control port once how far it bootstrapped (a fresh connection, bounded). */
export async function queryTorControl(
	control,
	{ password = '', cookieFile = '', timeoutMs = 3000 } = {},
) {
	return bounded(control, timeoutMs, (socket, finish) => {
		const ask = controlReader(socket, finish);
		socket.once('connect', async () => {
			try {
				await authenticate(ask, { password, cookieFile });
				const phase = await askBootstrap(ask);
				socket.write('QUIT\r\n');
				finish(null, phase);
			} catch (error) {
				finish(error);
			}
		});
	}).catch((error) => {
		throw new Error(`Tor control port: ${error.message}`);
	});
}

/**
 * What one Tor control event changes of `{ progress, summary, circuit,
 * live }`, or null for an event that says nothing of readiness. The events
 * Brave's Tor launcher reads (STATUS_CLIENT's BOOTSTRAP,
 * CIRCUIT_ESTABLISHED and CIRCUIT_NOT_ESTABLISHED) and NETWORK_LIVENESS.
 */
export function parseTorEvent(line) {
	const text = String(line).replace(/^650[ -]/, '');
	if (/^STATUS_CLIENT \S+ BOOTSTRAP\b/.test(text)) {
		const phase = parseBootstrapPhase(text.replace(/^STATUS_CLIENT /, ''));
		return phase && { progress: phase.progress, summary: phase.summary };
	}
	if (/^STATUS_CLIENT \S+ CIRCUIT_ESTABLISHED\b/.test(text))
		return { circuit: true };
	if (/^STATUS_CLIENT \S+ CIRCUIT_NOT_ESTABLISHED\b/.test(text))
		return { circuit: false };
	if (/^NETWORK_LIVENESS DOWN\b/.test(text)) return { live: false };
	if (/^NETWORK_LIVENESS UP\b/.test(text)) return { live: true };
	return null;
}

/**
 * One control connection, kept open, as Brave's Tor launcher keeps its own
 * (components/tor/tor_control.cc): authenticated, asked the bootstrap
 * phase and whether a circuit is established once, then told of every
 * change (`SETEVENTS STATUS_CLIENT NETWORK_LIVENESS`). Its `phase` is
 * `{ progress, tag, summary, circuit, live }`; it emits `change` with it,
 * and `close` once when the connection goes (Tor stopped). Setting up is
 * bounded at `timeoutMs`; nothing is polled after.
 */
export function openTorControl(
	control,
	{ password = '', cookieFile = '', timeoutMs = 3000 } = {},
) {
	return new Promise((resolve, reject) => {
		const session = new EventEmitter();
		const socket = connect(control);
		let open = false;
		let closed = false;
		const end = (error) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			socket.destroy();
			if (open) session.emit('close');
			else reject(error ?? new Error('closed'));
		};
		const timer = setTimeout(() => end(new Error('timed out')), timeoutMs);
		timer.unref?.();
		socket.once('error', (error) => end(error));
		socket.once('close', () => end());
		const pending = [];
		const apply = (lines) => {
			const change = parseTorEvent(lines[0] ?? '');
			if (!change) return;
			if (!open) return pending.push(change);
			// a circuit's word after the network came back is asked again
			if (change.live === true && session.phase.circuit === false)
				ask('GETINFO status/circuit-established')
					.then((reply) => {
						const value = reply.lines
							.find((line) =>
								line.startsWith('250-status/circuit-established='),
							)
							?.slice(-1);
						if (value) update({ circuit: value === '1' });
					})
					.catch(() => {});
			update(change.live === false ? { circuit: false, live: false } : change);
		};
		const update = (change) => {
			const next = { ...session.phase, ...change };
			if (JSON.stringify(next) === JSON.stringify(session.phase)) return;
			session.phase = next;
			session.emit('change', next);
		};
		const ask = controlReader(socket, end, apply);
		session.close = () => {
			if (!closed) socket.write('QUIT\r\n');
			end();
		};
		socket.once('connect', async () => {
			try {
				await authenticate(ask, { password, cookieFile });
				// subscribed first: a change between the answer and the
				// subscription is not lost (Brave asks circuit-established
				// after it for the same reason)
				const events = await ask('SETEVENTS STATUS_CLIENT NETWORK_LIVENESS');
				if (events.code !== 250) throw new Error('SETEVENTS refused');
				session.phase = { ...(await askBootstrap(ask)), live: true };
				open = true;
				clearTimeout(timer);
				socket.setKeepAlive(true, 30000);
				for (const change of pending.splice(0)) update(change);
				resolve(session);
			} catch (error) {
				end(error);
			}
		});
	}).catch((error) => {
		throw new Error(`Tor control port: ${error.message}`);
	});
}

/**
 * Watches whether the Tor behind `socks` can carry connections. Its state is
 * `down` (no SOCKS listener, or the relay is not running), `bootstrapping`
 * (Tor answers but has no working circuit yet; `progress` is Tor's when the
 * control port says), `ready`, or `unknown` (Tor answers and nothing more
 * can be learnt: no control port and the probe turned off).
 *
 * With a control port it follows Tor's events over one connection kept
 * open (openTorControl), as Brave does, and asks it nothing while it is
 * open: only the SOCKS listener on this machine is greeted every `slowMs`
 * (no circuit, no traffic through Tor), since a Tor whose control port
 * speaks can still have lost it. When the control connection closes, Tor
 * is checked again at once and the connection opened again every `fastMs`
 * until it is back.
 *
 * Without one, the relay's own traffic is the signal (`traffic`, the
 * relay's counters: bytes that came back from a destination went through a
 * Tor circuit), read every `slowMs` from the relay on this machine. The
 * circuit probe through Tor runs only when that says nothing: until the
 * first evidence (every `probeFastMs`), when streams were opened and no
 * byte came back for `stallMs` (failures), and when nothing went through
 * for `probeSlowMs` (idle). A SOCKS greeting every `fastMs` until ready and
 * `slowMs` after says whether Tor answers at all.
 *
 * Checks are bounded and one at a time; `refresh()` asks for one now, at
 * most once per `minMs`, so a page that polls cannot make it probe more.
 * It emits `change` with the new snapshot.
 */
export function createTorMonitor({
	socks,
	control = null,
	password = '',
	cookieFile = '',
	probe = null,
	traffic = null,
	relayRunning = () => true,
	fastMs = 2000,
	slowMs = 5000,
	probeFastMs = 10000,
	probeSlowMs = 300000,
	probeTimeoutMs = 30000,
	stallMs = 20000,
	minMs = 1000,
	log = (line) => console.log(line),
} = {}) {
	const monitor = new EventEmitter();
	let state = {
		state: 'bootstrapping',
		progress: null,
		summary: 'Checking Tor',
		via: control ? 'control' : probe ? 'probe' : 'socks',
	};
	let checkedAt = 0;
	let running = null;
	let timer = null;
	let stopped = false;
	let probing = null;
	let lastProbe = { at: 0, ok: false };
	let probeFailures = 0;
	let controlWarned = false;
	// the control connection, while it is open
	let session = null;
	let opening = null;
	// the relay's counters as last read, and what they said
	let counted = null;
	let workedAt = 0;
	let stalledSince = 0;
	let probes = 0;

	const set = (next) => {
		const changed =
			next.state !== state.state ||
			next.progress !== state.progress ||
			next.summary !== state.summary ||
			next.via !== state.via;
		const was = state.state;
		state = next;
		if (!changed) return;
		if (next.state !== was)
			log(
				`Tor: ${next.state}${next.progress !== null && next.state !== 'ready' ? ` ${next.progress}%` : ''} (${next.via})`,
			);
		monitor.emit('change', monitor.snapshot());
	};

	const fromControl = (phase) => {
		const ready = phase.progress === 100 && phase.circuit !== false;
		set({
			state: ready ? 'ready' : 'bootstrapping',
			progress: phase.progress,
			summary:
				phase.live === false
					? 'Tor lost the network'
					: phase.progress === 100 && phase.circuit === false
						? 'No Tor circuit established'
						: phase.summary,
			via: 'control',
		});
	};

	/** open the control connection if it is not, and follow it */
	async function openControl() {
		if (session) return session;
		opening ??= openTorControl(control, { password, cookieFile })
			.then((opened) => {
				controlWarned = false;
				if (stopped) {
					opened.close();
					return null;
				}
				session = opened;
				opened.on('change', (phase) => {
					if (session === opened && !stopped) fromControl(phase);
				});
				opened.once('close', () => {
					if (session !== opened) return;
					session = null;
					// Tor stopped, or restarts: what is left is asked now
					if (!stopped) check();
				});
				return opened;
			})
			.catch((error) => {
				// a broken control port setting is the operator's to fix: say
				// so once (the message names no secret), and fall back to the
				// probe, or to not knowing
				if (!controlWarned) console.warn(error.message);
				controlWarned = true;
				return null;
			})
			.finally(() => {
				opening = null;
			});
		return opening;
	}

	// the probe runs beside the checks: it can take as long as a circuit
	// does, and a check must not wait for it
	const circuitProbe = () => {
		if (probing) return;
		probes++;
		probing = probeTorCircuit(socks, probe, probeTimeoutMs).then(
			() => true,
			() => false,
		);
		probing.then((ok) => {
			probing = null;
			lastProbe = { at: Date.now(), ok };
			probeFailures = ok ? 0 : probeFailures + 1;
			if (ok) stalledSince = 0;
			if (!stopped) check();
		});
	};

	/** what the relay's counters say since the last read */
	async function readTraffic() {
		if (!traffic) return;
		let now;
		try {
			now = await traffic();
		} catch {
			return;
		}
		if (!now) return;
		if (counted && now.out > counted.out) {
			// bytes came back from a destination: a circuit carried them
			workedAt = Date.now();
			probeFailures = 0;
			stalledSince = 0;
		} else if (counted && now.streams > counted.streams && !stalledSince)
			stalledSince = Date.now();
		counted = now;
	}

	/** whether the circuit probe is due (see createTorMonitor) */
	function probeDue() {
		const now = Date.now();
		const evidence = Math.max(workedAt, lastProbe.ok ? lastProbe.at : 0);
		// nothing known yet, or the last probe failed: every probeFastMs
		if (!evidence || probeFailures) return now - lastProbe.at >= probeFastMs;
		// streams that got nothing back: a probe says whether Tor is why
		if (stalledSince && now - stalledSince >= stallMs)
			return now - lastProbe.at >= probeFastMs;
		// idle: nothing went through for a while
		return now - evidence >= probeSlowMs;
	}

	async function once() {
		if (!relayRunning())
			return set({
				state: 'down',
				progress: null,
				summary: 'Tor relay is not running',
				via: 'relay',
			});
		// the SOCKS listener answers a greeting (local, no circuit): a Tor
		// whose control port still speaks may have lost it
		try {
			await probeTorSocks5(socks);
		} catch {
			// a Tor that comes back proves its circuits again
			lastProbe = { at: 0, ok: false };
			probeFailures = 0;
			workedAt = 0;
			stalledSince = 0;
			return set({
				state: 'down',
				progress: null,
				summary: 'Tor is not running',
				via: 'socks',
			});
		}
		// Tor's own word on its bootstrap and circuits, while it speaks:
		// nothing to ask
		if (session) return fromControl(session.phase);
		if (control) {
			const opened = await openControl();
			if (opened) return fromControl(opened.phase);
		}
		if (probe) {
			await readTraffic();
			if (probeDue()) circuitProbe();
			const worked = workedAt > 0 || lastProbe.ok;
			// one failed probe of a working Tor is not yet an outage
			const ok =
				(worked && probeFailures === 0) ||
				(state.state === 'ready' && probeFailures < 2);
			const byTraffic = workedAt > 0 && workedAt >= lastProbe.at;
			return set({
				state: ok ? 'ready' : 'bootstrapping',
				progress: null,
				summary: ok
					? byTraffic
						? 'Tor carries traffic'
						: 'Tor circuit works'
					: lastProbe.at
						? 'Waiting for a Tor circuit'
						: 'Checking for a Tor circuit',
				via: ok && byTraffic ? 'traffic' : 'probe',
			});
		}
		set({
			state: 'unknown',
			progress: null,
			summary: 'Tor answers; readiness is not checked',
			via: 'socks',
		});
	}

	function check() {
		if (running) return running;
		clearTimeout(timer);
		running = once()
			.catch(() => {})
			.finally(() => {
				running = null;
				checkedAt = Date.now();
				if (stopped) return;
				timer = setTimeout(
					check,
					state.state === 'ready' || state.state === 'unknown' || session
						? slowMs
						: fastMs,
				);
				timer.unref?.();
			});
		return running;
	}

	monitor.snapshot = () => ({
		...state,
		checked: session ? 0 : checkedAt ? Date.now() - checkedAt : null,
	});
	monitor.refresh = () => {
		if (!running && !session && Date.now() - checkedAt >= minMs) check();
		return monitor.snapshot();
	};
	monitor.check = check;
	/** how many circuit probes were sent (for the tests) */
	monitor.probes = () => probes;
	/** New Wisp connections are taken only in these states. */
	monitor.accepting = () =>
		state.state === 'ready' || state.state === 'unknown';
	monitor.stop = () => {
		stopped = true;
		clearTimeout(timer);
		session?.close();
		session = null;
	};
	return monitor;
}

function externalTorWisp(value) {
	const url = new URL(value);
	if (
		!['ws:', 'wss:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.hash ||
		(url.protocol === 'ws:' &&
			!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
	)
		throw new TypeError(
			'STOMP_TOR_WISP_URL must be a wss:// URL (ws:// only for loopback)',
		);
	return url.href;
}

const list = (value) =>
	String(value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

/**
 * Start a distinct relay, or advertise an operator-provided external one.
 * A local relay starts whether or not Tor is up yet (its monitor says), so
 * Tor coming up later, or coming back, needs no restart of this server.
 */
export async function startTorWisp({
	socks5 = '',
	external = '',
	control = '',
	controlPassword = '',
	controlCookie = '',
	probe = 'check.torproject.org:443',
	origins = '',
	trustedProxies = '',
	logLevel = 'error',
	monitor: monitorOptions = {},
} = {}) {
	// A malformed setting turns Tor off with a warning, as a relay that
	// cannot start does: the demo still serves its direct relay, and a
	// typo never crashes it at startup (nor reaches some other egress).
	let socks;
	let controlPort;
	let probeTarget;
	try {
		if (external)
			return {
				external: externalTorWisp(external),
				relay: null,
				dns: null,
				monitor: null,
			};
		if (!socks5) return null;
		socks = parseTorSocks5(socks5);
		controlPort = control ? parseTorControl(control) : null;
		probeTarget =
			!probe || /^(?:0|off)$/i.test(probe) ? null : parseTorProbe(probe);
	} catch (error) {
		console.warn(`Tor Wisp disabled: ${error.message}`);
		return null;
	}
	const allowedOrigins = list(origins);
	const proxies = list(trustedProxies);
	let dns;
	let relay;
	try {
		dns = await openValidationDns();
		relay = new holyWisp({
			port: 0,
			// a crashed relay comes back with this same configuration (still
			// Tor-only); route() answers 503 meanwhile, never another relay
			autoRestart: true,
			proxy: socks.url,
			proxyUDP: 'refuse',
			allowTCP: true,
			allowUDP: false,
			allowDirectIP: false,
			allowPrivateIPs: false,
			allowLoopbackIPs: false,
			allowLinkLocalIPs: false,
			enableTwisp: false,
			serveWebclient: false,
			blacklist: { ports: TOR_BLOCKED_PORTS },
			dnsServers: [dns.address], // never use the system resolver for destinations
			dnsResultOrder: 'ipv4first',
			dnsTtlSeconds: 1,
			dnsTimeoutMs: 1000,
			// Every name resolves to the one placeholder, so a per-destination
			// limit would be one limit for every site and every visitor: those
			// are out of reach. The per-client ones stay (holyWisp's defaults,
			// counted by the address route() is handed, see trustedProxies),
			// and the SYN-flood heuristic is off: Tor's slow or failed
			// circuits look like failed handshakes to it.
			floodProtection: {
				enabled: true,
				maxConnectsPerDestPerSecond: 1000000,
				maxConnectsPerDestPerMinute: 1000000,
				maxConcurrentStreamsPerConnection: 512,
				synFloodSignature: { enabled: false },
			},
			// an onion service's first connection can take tens of seconds
			// (descriptor, introduction, rendezvous); past a minute it fails
			// with a Wisp CLOSE rather than hanging the page
			connectTimeoutMs: 60000,
			// a connection with no stream left and nothing sent goes away
			idleTimeoutSeconds: 300,
			...(allowedOrigins.length && { allowedOrigins }),
			...(proxies.length && { trustedProxies: proxies }),
			maxMessageSize: 262149,
			streamQueueMax: 64 * 1024 * 1024,
			logLevel,
		});
		await relay.start(1);
	} catch (error) {
		relay?.kill();
		if (dns) await dns.close();
		console.warn(`Tor Wisp disabled: ${error.message}`);
		return null;
	}
	// A dead local DNS shim must take the entire Tor relay down, never fall
	// back to the host resolver or to the ordinary Wisp relay.
	dns.socket.on('error', () => relay.kill());
	dns.socket.on('close', () => relay.kill());
	const monitor = createTorMonitor({
		socks,
		control: controlPort,
		password: controlPassword,
		cookieFile: controlCookie,
		probe: probeTarget,
		// what came back through the relay's streams (holyWisp's counters,
		// on this machine): real traffic is the readiness signal without a
		// control port
		traffic: async () => {
			if (!relay.isRunning) return null;
			const stats = await relay.stats();
			return { out: stats.bytes.out, streams: stats.streams.total };
		},
		relayRunning: () => relay.isRunning,
		...monitorOptions,
	});
	await monitor.check();
	return { relay, dns, monitor, external: null };
}
