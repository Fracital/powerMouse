// A small TURN server (RFC 8656) for the WebRTC suites, over UDP, TCP or
// TLS: long-term credentials (401 with a realm and a nonce, then
// MESSAGE-INTEGRITY), an allocation per client (a UDP address, or a TCP or
// TLS connection) with a relay socket of its own on loopback, Refresh,
// CreatePermission, ChannelBind, Send and Data indications and ChannelData.
// Enough for a relay candidate to carry a connection; nothing a public
// server needs (quotas, nonce expiry, TCP relays). It can also misbehave:
// `silent` takes every message and answers none, and over TLS `handshake:
// false` takes the TCP connection and never starts TLS, which is how a dead
// or wrong server looks to a browser.
import {
	createHash,
	createHmac,
	randomBytes,
	X509Certificate,
} from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

const MAGIC = 0x2112a442;
const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

// The certificate (P-256, for 127.0.0.1 and localhost, valid until 2126)
// TURN over TLS shows, issued by a test CA whose certificate is
// demo/public/test/turn-ca.pem (the CA's key was thrown away once it had
// signed this). No browser trusts it: a suite tells Chrome the key with
// --ignore-certificate-errors-spki-list and the server's `spki`, and the
// demo's test transport gives epoxy the CA (STOMP_TEST_TRANSPORT=1). Kept
// here, so that the fixture needs no openssl and the key is the same on
// every run. It guards nothing.
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIByDCCAW6gAwIBAgIUX6gfxSjZij3LDRCbgc38WVKof+8wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSU1RvbXAtdGVzdC1UVVJOLUNBMCAXDTI2MTExMTEyNTY0M1oY
DzIxMjYxMDE4MTI1NjQzWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAASV7sTS+wg4UTk+aDn2NYWwkQokv6rt7F1MTnrs2FuF
YE4oJBt4ZCrXhiO1Uy9LL0Gu3jJXZyKaSW84tAP7sepAo4GSMIGPMAwGA1UdEwEB
/wQCMAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBoGA1Ud
EQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAdBgNVHQ4EFgQUnWB1rCClWPaFsy1WDTm4
hvgLBPcwHwYDVR0jBBgwFoAU1QZKXEsJ1L/vQbsXYE0S+I6VCm8wCgYIKoZIzj0E
AwIDSAAwRQIhAPo21w1Z8XV1sKJclAKOXTItEgr//RT71CZgTXISK6kAAiAcQP6A
j0u2vZzTroBU2vh58gP04Q1ES6fA3bcDbDsn+Q==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgByxs9qYzummwYPaN
ROhsimt/hgzs4kIym9vdX44ISbmhRANCAASV7sTS+wg4UTk+aDn2NYWwkQokv6rt
7F1MTnrs2FuFYE4oJBt4ZCrXhiO1Uy9LL0Gu3jJXZyKaSW84tAP7sepA
-----END PRIVATE KEY-----
`;

/** the base64 sha256 of a certificate's public key, as --ignore-certificate-errors-spki-list takes it */
export function spkiOf(certificate) {
	return createHash('sha256')
		.update(
			new X509Certificate(certificate).publicKey.export({
				type: 'spki',
				format: 'der',
			}),
		)
		.digest('base64');
}

function attributesOf(message) {
	const out = new Map();
	let at = 20;
	const end = 20 + message.readUInt16BE(2);
	while (at + 4 <= end && at + 4 <= message.length) {
		const size = message.readUInt16BE(at + 2);
		if (!out.has(message.readUInt16BE(at)))
			out.set(message.readUInt16BE(at), {
				value: message.subarray(at + 4, at + 4 + size),
				at,
			});
		at += 4 + ((size + 3) & ~3);
	}
	return out;
}

function build(type, id, attributes) {
	const parts = attributes.map(([code, value]) => {
		const head = Buffer.alloc(4);
		head.writeUInt16BE(code, 0);
		head.writeUInt16BE(value.length, 2);
		return Buffer.concat([
			head,
			value,
			Buffer.alloc(((value.length + 3) & ~3) - value.length),
		]);
	});
	const body = Buffer.concat(parts);
	const head = Buffer.alloc(20);
	head.writeUInt16BE(type, 0);
	head.writeUInt16BE(body.length, 2);
	head.writeUInt32BE(MAGIC, 4);
	id.copy(head, 8);
	return Buffer.concat([head, body]);
}

/** an XOR address attribute's value (IPv4) */
function xorAddress(address, port) {
	const value = Buffer.alloc(8);
	value.writeUInt8(1, 1);
	value.writeUInt16BE(port ^ 0x2112, 2);
	address
		.split('.')
		.forEach((octet, i) => value.writeUInt8(Number(octet) ^ cookie[i], 4 + i));
	return value;
}
function readXorAddress(value) {
	const octets = [];
	for (let i = 0; i < 4; i++) octets.push(value[4 + i] ^ cookie[i]);
	return { address: octets.join('.'), port: value.readUInt16BE(2) ^ 0x2112 };
}
const errorCode = (code, reason) =>
	Buffer.concat([
		Buffer.from([0, 0, Math.floor(code / 100), code % 100]),
		Buffer.from(reason),
	]);

/**
 * Cuts a TCP or TLS stream into messages (RFC 8656 section 12.5): STUN
 * messages back to back, each as long as its header says, and ChannelData
 * padded to a multiple of 4. Returns the bytes of an unfinished message, or
 * null when the stream holds something that is neither (the caller drops
 * the connection, as nothing after it can be framed).
 */
function frames(buffered, each) {
	let at = 0;
	while (buffered.length - at >= 4) {
		const kind = buffered[at] & 0xc0;
		const length = buffered.readUInt16BE(at + 2);
		let size;
		if (kind === 0x40) size = 4 + ((length + 3) & ~3);
		else if (kind === 0) size = 20 + length;
		else return null;
		if (buffered.length - at < size) break;
		each(buffered.subarray(at, at + size));
		at += size;
	}
	return buffered.subarray(at);
}

/**
 * Start the server on loopback. `transport` is 'udp' (the default), 'tcp'
 * or 'tls' (a turns: URL; the browser trusts the certificate only when told
 * `spki`, see CERTIFICATE); the relay sockets are UDP whatever it is, as a
 * browser asks for (REQUESTED-TRANSPORT 17). `packets` records every
 * datagram's or framed message's source (`address:port`) and arrival time,
 * `connections` every TCP connection's (with `refused`, the
 * error, when its TLS handshake failed); `allocated`, `relayed` and
 * `refused` count what it did. `bindingDelay` (ms) holds each Binding
 * answer back, so that the socket that asked lives long enough for a suite
 * to sample it. `port` 0 takes a free one. `onMessage(message, from)` sees
 * every message as it arrives, to log what a browser sends.
 */
export function startTurn({
	transport = 'udp',
	username = 'user',
	credential = 'secret',
	realm = 'stomp.test',
	host = '127.0.0.1',
	port = 0,
	bindingDelay = 0,
	silent = false,
	handshake = true,
	certificate = CERTIFICATE,
	key = KEY,
	onMessage = null,
} = {}) {
	const nonce = randomBytes(8).toString('hex');
	const longTermKey = createHash('md5')
		.update(`${username}:${realm}:${credential}`)
		.digest();
	const allocations = new Map();
	const streams = new Set();
	let socket;
	let listener;
	let closed = false;
	const server = {
		transport,
		port: 0,
		packets: [],
		connections: [],
		allocated: 0,
		relayed: 0,
		refused: 0,
		/** the ports of the relay sockets it made */
		relays: new Set(),
		/** what --ignore-certificate-errors-spki-list needs to trust it (TLS) */
		spki: transport === 'tls' ? spkiOf(certificate) : null,
		close() {
			closed = true;
			for (const allocation of allocations.values()) allocation.relay.close();
			allocations.clear();
			for (const stream of streams) stream.destroy();
			streams.clear();
			socket?.close();
			listener?.close();
		},
	};

	/** a client of the server: where its answers go and whose allocation it has */
	const datagramClient = (from) => ({
		key: `${from.address}:${from.port}`,
		address: from.address,
		port: from.port,
		send: (message) => socket.send(message, from.port, from.address),
	});

	/** whether the request carries the credentials; answers 401 and returns false otherwise */
	const authorized = (message, attributes, from) => {
		const id = message.subarray(8, 20);
		const integrity = attributes.get(0x0008);
		const refuse = (code, reason) => {
			server.refused++;
			from.send(
				build((message.readUInt16BE(0) & 0x000f) | 0x0110, id, [
					[0x0009, errorCode(code, reason)],
					[0x0014, Buffer.from(realm)],
					[0x0015, Buffer.from(nonce)],
				]),
			);
			return false;
		};
		if (!integrity) return refuse(401, 'Unauthorized');
		if (String(attributes.get(0x0006)?.value) !== username)
			return refuse(401, 'Unauthorized');
		if (String(attributes.get(0x0015)?.value) !== nonce)
			return refuse(438, 'Stale Nonce');
		// the integrity covers the message up to its attribute, with the
		// length counting it
		const signed = Buffer.from(message.subarray(0, integrity.at));
		signed.writeUInt16BE(integrity.at + 24 - 20, 2);
		const mac = createHmac('sha1', longTermKey).update(signed).digest();
		if (!mac.equals(integrity.value)) return refuse(401, 'Unauthorized');
		return true;
	};

	/** the message with a MESSAGE-INTEGRITY attribute, the length counting it */
	const signed = (message) => {
		const out = Buffer.concat([message, Buffer.alloc(24)]);
		out.writeUInt16BE(message.length - 20 + 24, 2);
		const mac = createHmac('sha1', longTermKey)
			.update(out.subarray(0, message.length))
			.digest();
		out.writeUInt16BE(0x0008, message.length);
		out.writeUInt16BE(20, message.length + 2);
		mac.copy(out, message.length + 4);
		return out;
	};

	const handle = (message, from) => {
		server.packets.push({ from: from.key, port: from.port, at: Date.now() });
		onMessage?.(message, from.key);
		if (silent) return;
		const allocation = allocations.get(from.key);
		// ChannelData
		if (message.length >= 4 && (message[0] & 0xc0) === 0x40) {
			const peer = allocation?.channels.get(message.readUInt16BE(0));
			if (!peer) return;
			server.relayed++;
			allocation.relay.send(
				message.subarray(4, 4 + message.readUInt16BE(2)),
				peer.port,
				peer.address,
			);
			return;
		}
		if (message.length < 20 || message.readUInt32BE(4) !== MAGIC) return;
		const type = message.readUInt16BE(0);
		const id = message.subarray(8, 20);
		const attributes = attributesOf(message);
		// a Binding request: the server is asked as a STUN server too
		if (type === 0x0001) {
			const answer = build(0x0101, Buffer.from(id), [
				[0x0020, xorAddress(from.address, from.port)],
			]);
			if (!bindingDelay) from.send(answer);
			else
				setTimeout(() => {
					if (!closed) from.send(answer);
				}, bindingDelay);
			return;
		}
		// a Send indication
		if (type === 0x0016) {
			const peer = attributes.get(0x0012);
			const data = attributes.get(0x0013);
			if (!allocation || !peer || !data) return;
			const to = readXorAddress(peer.value);
			if (!allocation.permissions.has(to.address)) return;
			server.relayed++;
			allocation.relay.send(data.value, to.port, to.address);
			return;
		}
		if (!authorized(message, attributes, from)) return;
		// a browser drops an answer to a signed request unless it is signed
		// with the same key (libwebrtc's StunRequestManager checks it): the
		// allocation would time out with 701 after 40 s of retransmissions
		const success = (list = []) =>
			from.send(signed(build(type | 0x0100, id, list)));
		const lifetime = (seconds) => {
			const value = Buffer.alloc(4);
			value.writeUInt32BE(seconds);
			return [0x000d, value];
		};
		if (type === 0x0003) {
			// Allocate
			if (allocation) {
				success([
					[0x0016, xorAddress(host, allocation.relay.address().port)],
					[0x0020, xorAddress(from.address, from.port)],
					lifetime(600),
				]);
				return;
			}
			const relay = dgram.createSocket('udp4');
			const made = { relay, permissions: new Set(), channels: new Map() };
			relay.on('message', (data, peer) => {
				if (!made.permissions.has(peer.address)) return;
				server.relayed++;
				for (const [channel, bound] of made.channels)
					if (bound.address === peer.address && bound.port === peer.port) {
						const head = Buffer.alloc(4);
						head.writeUInt16BE(channel, 0);
						head.writeUInt16BE(data.length, 2);
						from.send(Buffer.concat([head, data]));
						return;
					}
				from.send(
					build(0x0017, randomBytes(12), [
						[0x0012, xorAddress(peer.address, peer.port)],
						[0x0013, data],
					]),
				);
			});
			relay.bind(0, host, () => {
				// the client went (its connection closed) while this bound
				if (closed || from.gone) {
					relay.close();
					return;
				}
				allocations.set(from.key, made);
				server.allocated++;
				server.relays.add(relay.address().port);
				success([
					[0x0016, xorAddress(host, relay.address().port)],
					[0x0020, xorAddress(from.address, from.port)],
					lifetime(600),
				]);
			});
			return;
		}
		if (!allocation) {
			from.send(
				build((type & 0x000f) | 0x0110, id, [
					[0x0009, errorCode(437, 'Allocation Mismatch')],
				]),
			);
			return;
		}
		if (type === 0x0004) {
			// Refresh; a lifetime of 0 gives the allocation back
			const asked = attributes.get(0x000d)?.value.readUInt32BE(0);
			if (asked === 0) {
				allocation.relay.close();
				allocations.delete(from.key);
				success([lifetime(0)]);
			} else success([lifetime(600)]);
		} else if (type === 0x0008) {
			// CreatePermission
			const peer = attributes.get(0x0012);
			if (peer) allocation.permissions.add(readXorAddress(peer.value).address);
			success();
		} else if (type === 0x0009) {
			// ChannelBind
			const peer = attributes.get(0x0012);
			const channel = attributes.get(0x000c)?.value.readUInt16BE(0);
			if (!peer || channel === undefined) return;
			const to = readXorAddress(peer.value);
			allocation.permissions.add(to.address);
			allocation.channels.set(channel, to);
			success();
		}
	};

	if (transport === 'udp') {
		socket = dgram.createSocket('udp4');
		socket.on('message', (message, from) =>
			handle(message, datagramClient(from)),
		);
		return new Promise((resolve) =>
			socket.bind(port, '0.0.0.0', () => {
				server.port = socket.address().port;
				resolve(server);
			}),
		);
	}
	if (transport !== 'tcp' && transport !== 'tls')
		throw new TypeError(`no TURN transport ${transport}`);

	/** a TCP or TLS connection: one client, its allocation going when it closes */
	const serve = (stream, raw) => {
		streams.add(stream);
		const from = {
			key: `${raw.remoteAddress}:${raw.remotePort}`,
			address: raw.remoteAddress,
			port: raw.remotePort,
			gone: false,
			// over a stream ChannelData is padded to a multiple of 4 (STUN
			// messages always are)
			send: (message) => {
				if (from.gone) return;
				const padding = ((message.length + 3) & ~3) - message.length;
				stream.write(
					padding ? Buffer.concat([message, Buffer.alloc(padding)]) : message,
				);
			},
		};
		let buffered = Buffer.alloc(0);
		stream.on('data', (data) => {
			buffered = frames(Buffer.concat([buffered, data]), (message) =>
				handle(message, from),
			);
			if (buffered === null) stream.destroy();
		});
		stream.on('error', () => {});
		stream.on('close', () => {
			from.gone = true;
			streams.delete(stream);
			const allocation = allocations.get(from.key);
			if (!allocation) return;
			allocation.relay.close();
			allocations.delete(from.key);
		});
	};
	const entries = new Map();
	const accepted = (raw) => {
		const entry = {
			from: `${raw.remoteAddress}:${raw.remotePort}`,
			port: raw.remotePort,
			at: Date.now(),
		};
		entries.set(entry.from, entry);
		server.connections.push(entry);
		raw.on('error', () => {});
	};
	if (transport === 'tls' && handshake)
		listener = tls.createServer({ cert: certificate, key }, (stream) =>
			serve(stream, stream),
		);
	else
		listener = net.createServer((raw) => {
			// a TLS server that never handshakes reads the ClientHello and
			// keeps quiet, as a TURN server behind a dead TLS front does
			if (transport === 'tls') {
				streams.add(raw);
				raw.on('close', () => streams.delete(raw));
				raw.resume();
			} else serve(raw, raw);
		});
	listener.on('connection', accepted);
	// a browser that does not trust the certificate ends the handshake
	// with an alert: the connection records why
	listener.on('tlsClientError', (error, stream) => {
		const entry = entries.get(`${stream.remoteAddress}:${stream.remotePort}`);
		if (entry) entry.refused = error.code ?? error.message;
	});
	return new Promise((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(port, host, () => {
			server.port = listener.address().port;
			resolve(server);
		});
	});
}
