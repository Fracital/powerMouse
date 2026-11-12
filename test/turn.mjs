// A small TURN server (RFC 8656) over UDP for the WebRTC suites: long-term
// credentials (401 with a realm and a nonce, then MESSAGE-INTEGRITY), an
// allocation per client address with a relay socket of its own on
// loopback, Refresh, CreatePermission, ChannelBind, Send and Data
// indications and ChannelData. Enough for a relay candidate to carry a
// connection; nothing a public server needs (quotas, nonce expiry, TCP).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';

const MAGIC = 0x2112a442;
const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

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
 * Start the server on loopback. `packets` records every datagram's source
 * (`address:port`) and arrival time; `allocated`, `relayed` and `refused`
 * count what it did. `bindingDelay` (ms) holds each Binding answer back, so
 * that the socket that asked lives long enough for a suite to sample it.
 */
export function startTurn({
	username = 'user',
	credential = 'secret',
	realm = 'stomp.test',
	host = '127.0.0.1',
	bindingDelay = 0,
} = {}) {
	const socket = dgram.createSocket('udp4');
	const nonce = randomBytes(8).toString('hex');
	const key = createHash('md5')
		.update(`${username}:${realm}:${credential}`)
		.digest();
	const allocations = new Map();
	let closed = false;
	const server = {
		port: 0,
		packets: [],
		allocated: 0,
		relayed: 0,
		refused: 0,
		/** the ports of the relay sockets it made */
		relays: new Set(),
		close() {
			closed = true;
			for (const allocation of allocations.values()) allocation.relay.close();
			allocations.clear();
			socket.close();
		},
	};
	const send = (message, from) => socket.send(message, from.port, from.address);

	/** whether the request carries the credentials; answers 401 and returns false otherwise */
	const authorized = (message, attributes, from) => {
		const id = message.subarray(8, 20);
		const integrity = attributes.get(0x0008);
		const refuse = (code, reason) => {
			server.refused++;
			send(
				build((message.readUInt16BE(0) & 0x000f) | 0x0110, id, [
					[0x0009, errorCode(code, reason)],
					[0x0014, Buffer.from(realm)],
					[0x0015, Buffer.from(nonce)],
				]),
				from,
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
		const mac = createHmac('sha1', key).update(signed).digest();
		if (!mac.equals(integrity.value)) return refuse(401, 'Unauthorized');
		return true;
	};

	socket.on('message', (message, from) => {
		const client = `${from.address}:${from.port}`;
		server.packets.push({ from: client, port: from.port, at: Date.now() });
		const allocation = allocations.get(client);
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
			if (!bindingDelay) send(answer, from);
			else
				setTimeout(() => {
					if (!closed) send(answer, from);
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
		const success = (list = []) => send(build(type | 0x0100, id, list), from);
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
						send(Buffer.concat([head, data]), from);
						return;
					}
				send(
					build(0x0017, randomBytes(12), [
						[0x0012, xorAddress(peer.address, peer.port)],
						[0x0013, data],
					]),
					from,
				);
			});
			relay.bind(0, host, () => {
				allocations.set(client, made);
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
			send(
				build((type & 0x000f) | 0x0110, id, [
					[0x0009, errorCode(437, 'Allocation Mismatch')],
				]),
				from,
			);
			return;
		}
		if (type === 0x0004) {
			// Refresh; a lifetime of 0 gives the allocation back
			const asked = attributes.get(0x000d)?.value.readUInt32BE(0);
			if (asked === 0) {
				allocation.relay.close();
				allocations.delete(client);
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
	});
	return new Promise((resolve) =>
		socket.bind(0, '0.0.0.0', () => {
			server.port = socket.address().port;
			resolve(server);
		}),
	);
}
