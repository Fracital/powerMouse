// The WebTransport fixture server of the webtransport suite: QUIC, HTTP/3 and
// WebTransport draft 02 as Chrome 152 to 156 speak them, from a Rust crate
// (test/wtserver/, quinn and rustls) built to wasm and committed, so it runs
// here with node:dgram and nothing to install. Its routes and events are
// those of the Go fixture the suite was first measured with (webtransport-go):
//
//   /echo     bidi streams echoed; a uni stream echoed on a new uni stream of
//             the server's; datagrams echoed
//   /push     the server opens a uni stream carrying a JSON report of the
//             CONNECT request, then a bidi stream that writes "server bidi",
//             echoes one read and finishes (and echoes as /echo)
//   /close?code=&reason=&after=   the server closes the session after `after`
//             ms (at once if 0) with that code and reason: the close capsule
//             and FIN, data streams left alone, so the page's `closed` reads
//             the code and reason (and it echoes meanwhile). With
//             &style=gone, first every open stream is stopped and reset with
//             WEBTRANSPORT_SESSION_GONE, as webtransport-go closes
//   /reset?reset=&stop=   each bidi stream, after its first byte: receive
//             side stopped with `stop`, then send side reset with `reset`;
//             each uni stream stopped with `stop` (0 if absent) after its
//             first byte
//   /slow?delay=   each bidi stream is left unread for `delay` ms, then read
//             to its end and answered with the byte count
//   /refuse   403; any other path 404
//   /bridge   the session's bidi streams and datagrams are the host's
//             (`bridge()` below; test/wisp-wt.mjs relays Wisp on them),
//             which may open bidi streams of the server's on it and names
//             the wt-protocol among those offered (the first by default)
//
// On any session route, ?wtp= answers with that wt-protocol value as it is
// (empty for none) and each ?resp=name:value adds a field to the 200;
// ?observe=1 logs what the client does after the server's close ("answer"
// events: how its CONNECT stream ended, a STOP_SENDING on it or every byte
// acknowledged, each with `ms` since the close). Every connection logs a
// "connection" event (no path) with how it ended.
//
// `wt-available-protocols` gets `wt-protocol` for echo-v1 or echo-v2. A session
// that ends any other way (the page closes it, the connection goes) has the
// server's halves of its open streams stopped and reset with
// WEBTRANSPORT_SESSION_GONE.
//
// Events (`path` is always the request's :path, query included):
//   request   every request: method, protocol, authority, status (200, 403,
//             404, 500), before anything else is logged for it
//   connect   a session: method, authority, protocol, scheme, fields (every
//             field as [name, value] in order), settings (the client's
//             SETTINGS as [id in hex, value] in order), remote, wtProtocol
//             (when one was chosen); upgradeError instead when refused (500)
//   closed    code, reason, remote (true: the page's capsule) for a close
//             capsule either way, else cause alone
//   bidi, uni bytes echoed or read, and error, code (the WebTransport code)
//             and remoteError when the stream failed
//   reset     a /reset stream got its first byte and was reset or stopped
//   refused   /refuse
// Stream error codes: WebTransport code n is HTTP/3 code
// 0x52e4a40fa8db + n + floor(n / 0x1e).
//
// The leaf certificate (ECDSA P-256, valid from an hour ago for 10 days, for
// 127.0.0.1, localhost, wt.mixed.test and *.mixed.test) is made at startup
// and signed by the test CA test/wtserver/ca.pem, whose key is
// test/wtserver/ca.key. Native Chrome takes it by `certHash` (a pinned
// serverCertificateHashes value) or with --ignore-certificate-errors-spki-list
// `spki` plus --origin-to-force-quic-on; a client that trusts `caPem` alone
// verifies it as WebPKI does.
import {
	createHash,
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';

const here = new URL('./wtserver/', import.meta.url);
const caPem = readFileSync(new URL('ca.pem', here), 'utf8');
const caKey = createPrivateKey(readFileSync(new URL('ca.key', here), 'utf8'));

let compiled;
let instances = 0;

/** a DER element: tag, length, contents */
function der(tag, ...parts) {
	const body = Buffer.concat(parts);
	const n = body.length;
	let length;
	if (n < 0x80) length = Buffer.from([n]);
	else {
		const bytes = [];
		for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
		length = Buffer.from([0x80 | bytes.length, ...bytes]);
	}
	return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts) => der(0x30, ...parts);

function oid(dotted) {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const out = [a * 40 + b];
	for (const v of rest) {
		const bytes = [v & 0x7f];
		for (let x = v >>> 7; x > 0; x >>>= 7) bytes.unshift(0x80 | (x & 0x7f));
		out.push(...bytes);
	}
	return der(0x06, Buffer.from(out));
}

/** the elements of a DER constructed value, each as its full encoding */
function children(buf) {
	const out = [];
	let i = 0;
	while (i < buf.length) {
		let n = buf[i + 1];
		let head = 2;
		if (n & 0x80) {
			const count = n & 0x7f;
			n = 0;
			for (let k = 0; k < count; k++) n = n * 256 + buf[i + 2 + k];
			head += count;
		}
		out.push({
			tag: buf[i],
			all: buf.subarray(i, i + head + n),
			body: buf.subarray(i + head, i + head + n),
		});
		i += head + n;
	}
	return out;
}

const ca = (() => {
	const cert = Buffer.from(caPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
	const [tbs] = children(children(cert)[0].body);
	const fields = children(tbs.body);
	// [0] version, serial, signature, issuer, validity, subject, spki, [3]
	const subject = fields[5].all;
	let keyId;
	for (const ext of children(
		children(fields.find((f) => f.tag === 0xa3).body)[0].body,
	)) {
		const [id, ...rest] = children(ext.body);
		// subjectKeyIdentifier: an OCTET STRING in the extension's OCTET STRING
		if (id.all.equals(oid('2.5.29.14')))
			keyId = children(rest.at(-1).body)[0].body;
	}
	return { subject, keyId };
})();

function utcTime(date) {
	const iso = date.toISOString();
	return der(
		0x17,
		Buffer.from(
			iso.slice(2, 4) +
				iso.slice(5, 7) +
				iso.slice(8, 10) +
				iso.slice(11, 13) +
				iso.slice(14, 16) +
				iso.slice(17, 19) +
				'Z',
		),
	);
}

/** the leaf: a fresh P-256 key, signed by the test CA */
function makeLeaf() {
	const { publicKey, privateKey } = generateKeyPairSync('ec', {
		namedCurve: 'P-256',
	});
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	const now = Date.now();
	const serial = randomBytes(16);
	serial[0] = (serial[0] & 0x7f) | 0x01;
	const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
	const ext = (id, critical, value) =>
		seq(
			oid(id),
			...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
			der(0x04, value),
		);
	const publicBits = children(children(spki)[0].body)[1].body.subarray(1);
	const tbs = seq(
		der(0xa0, der(0x02, Buffer.from([2]))),
		der(0x02, serial),
		ecdsaSha256,
		ca.subject,
		seq(utcTime(new Date(now - 3600e3)), utcTime(new Date(now + 10 * 86400e3))),
		seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('localhost'))))),
		spki,
		der(
			0xa3,
			seq(
				ext('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))),
				ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
				ext('2.5.29.19', true, seq()),
				ext(
					'2.5.29.14',
					false,
					der(0x04, createHash('sha1').update(publicBits).digest()),
				),
				...(ca.keyId
					? [ext('2.5.29.35', false, seq(der(0x80, ca.keyId)))]
					: []),
				ext(
					'2.5.29.17',
					false,
					seq(
						der(0x87, Buffer.from([127, 0, 0, 1])),
						der(0x82, Buffer.from('localhost')),
						der(0x82, Buffer.from('wt.mixed.test')),
						der(0x82, Buffer.from('*.mixed.test')),
					),
				),
			),
		),
	);
	const signature = sign('sha256', tbs, caKey);
	const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature));
	return {
		cert,
		key: privateKey.export({ type: 'pkcs8', format: 'der' }),
		certHash: createHash('sha256').update(cert).digest('hex'),
		spki: createHash('sha256').update(spki).digest('base64'),
	};
}

/**
 * Starts a server on a UDP socket of its own. `events` fills as the server
 * reports (connect, closed, bidi, uni, reset, refused); `waitFor` resolves
 * with the first event, past or future, that `predicate` takes.
 */
export async function startWebTransportServer({
	host = '127.0.0.1',
	port = 0,
} = {}) {
	compiled ??= WebAssembly.compile(
		readFileSync(new URL('wtserver.wasm', here)),
	);
	// a module instance of the glue per server: the glue keeps its instance
	// in module scope, and a server's state lives in its instance
	const glue = await import(new URL(`wtserver.js?${++instances}`, here).href);
	glue.initSync({ module: await compiled });

	const socket = createSocket(isIPv6(host) ? 'udp6' : 'udp4');
	await new Promise((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(port, host, () => {
			socket.off('error', reject);
			resolve();
		});
	});
	socket.on('error', () => {});
	const bound = socket.address();
	const leaf = makeLeaf();

	const events = [];
	const waiters = new Set();
	const server = new glue.Server(
		leaf.cert,
		leaf.key,
		bound.address,
		bound.port,
		(bytes, address, to) => socket.send(bytes, to, address, () => {}),
		(line) => {
			const event = JSON.parse(line);
			events.push(event);
			for (const w of waiters) w(event);
		},
	);
	socket.on('message', (message, from) =>
		server.recv(message, from.address, from.port),
	);

	let closed = false;
	return {
		port: bound.port,
		certHash: leaf.certHash,
		spki: leaf.spki,
		certPem: `-----BEGIN CERTIFICATE-----\n${leaf.cert.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`,
		/** the leaf's key, for a TCP server of the same name beside it (an h3 origin's) */
		keyPem: `-----BEGIN PRIVATE KEY-----\n${leaf.key.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----\n`,
		caPem,
		events,
		/**
		 * Serves /bridge sessions with `handler(kind, id, value)` (kinds in
		 * test/wtserver/src/bridge.rs): what arrives on their bidirectional
		 * streams and datagrams, answered with the methods below.
		 */
		bridge(handler) {
			server.set_bridge((kind, id, value) => {
				try {
					return handler(
						kind,
						id,
						kind === 'session' || kind === 'closed' || kind === 'protocol'
							? JSON.parse(value)
							: value,
					);
				} catch (error) {
					console.error('wtserver bridge handler:', error);
				}
			});
			return {
				write: (stream, bytes) => server.bridge_write(stream, bytes),
				finish: (stream) => server.bridge_finish(stream),
				reset: (stream, code = 0) => server.bridge_reset(stream, code),
				datagram: (session, bytes) => server.bridge_datagram(session, bytes),
				maxDatagram: (session) => server.bridge_max_datagram(session),
				/** a server bidirectional stream on the session: its handle (-1: gone) */
				openBidi: (session) => server.bridge_open_bidi(session),
				close: (session, code = 0, reason = '') =>
					server.bridge_close(session, code, reason),
			};
		},
		waitFor(predicate, ms = 5000) {
			const seen = events.find(predicate);
			if (seen) return Promise.resolve(seen);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(
						new Error(
							`no such event in ${ms} ms; events: ${JSON.stringify(events)}`,
						),
					);
				}, ms);
				const check = (event) => {
					if (!predicate(event)) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve(event);
				};
				waiters.add(check);
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			server.close();
			// the CONNECTION_CLOSE frames go out on the next turns
			await new Promise((resolve) => setTimeout(resolve, 20));
			socket.close();
			server.free();
		},
	};
}
