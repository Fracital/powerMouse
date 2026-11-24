// A DNS server for the built-in holyWisp. The relay resolves names itself
// (its own resolver plus /etc/hosts) and never asks the system, so a name
// Chrome answers from the hosts file or from the *.localhost rule
// (nss-myhostname: any name under .localhost is loopback, RFC 6761) is
// NXDOMAIN there. Public DNS is NXDOMAIN for those too. This server is what
// the relay is pointed at: it answers with what getaddrinfo would, which is
// what the browser itself resolves, loopback included.
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';

/** how long the relay may cache an answer we built (it is not a zone) */
const TTL = 30;
const UDP_MAX = 512;

/**
 * The name a question asks, and the offset just after its type and class.
 * Compression pointers are followed. Null when the packet is not one
 * question we can read.
 */
function question(buf) {
	if (buf.length < 12 || buf.readUInt16BE(4) !== 1) return null;
	const labels = [];
	let offset = 12;
	let hops = 0;
	let end = 12;
	let jumped = false;
	while (offset < buf.length && hops < 16) {
		const len = buf[offset];
		if (len === 0) {
			if (!jumped) end = offset + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			if (offset + 1 >= buf.length) return null;
			if (!jumped) end = offset + 2;
			jumped = true;
			offset = ((len & 0x3f) << 8) | buf[offset + 1];
			hops++;
			continue;
		}
		if (len & 0xc0) return null;
		offset++;
		if (offset + len > buf.length) return null;
		labels.push(buf.subarray(offset, offset + len).toString('latin1'));
		offset += len;
		if (!jumped) end = offset;
	}
	if (offset >= buf.length || buf[offset] !== 0) return null;
	if (!jumped) end = offset + 1;
	if (end + 4 > buf.length) return null;
	return {
		name: labels.join('.').replace(/\.$/, '').toLowerCase(),
		type: buf.readUInt16BE(end),
		end: end + 4,
	};
}

/** an answer of `addresses` (A or AAAA, whichever `type` asked), or NODATA */
function reply(query, asked, addresses) {
	const fit = [];
	// the question is copied whole; each answer is a pointer plus 10 plus the address
	let size = asked.end;
	const width = asked.type === 28 ? 16 : 4;
	for (const address of addresses) {
		if (size + 12 + width > UDP_MAX) break;
		fit.push(address);
		size += 12 + width;
	}
	const out = Buffer.alloc(size);
	query.copy(out, 0, 0, asked.end);
	const rd = query.readUInt16BE(2) & 0x0100;
	// standard response, recursion available, the recursion bit the query sent
	out.writeUInt16BE(0x8180 | rd, 2);
	out.writeUInt16BE(1, 4);
	out.writeUInt16BE(fit.length, 6);
	out.writeUInt16BE(0, 8);
	out.writeUInt16BE(0, 10);
	let offset = asked.end;
	for (const address of fit) {
		out.writeUInt16BE(0xc00c, offset);
		out.writeUInt16BE(asked.type, offset + 2);
		out.writeUInt16BE(1, offset + 4);
		out.writeUInt32BE(TTL, offset + 6);
		out.writeUInt16BE(width, offset + 10);
		offset += 12;
		if (asked.type === 28) {
			const groups = expand6(address);
			for (let i = 0; i < 8; i++) out.writeUInt16BE(groups[i], offset + i * 2);
		} else {
			const parts = address.split('.');
			for (let i = 0; i < 4; i++) out[offset + i] = Number(parts[i]);
		}
		offset += width;
	}
	return out;
}

/** eight groups of an IPv6 address getaddrinfo spelled, compressed or not */
function expand6(address) {
	const [head, tail] = address.split('::');
	const left = head ? head.split(':').map((part) => parseInt(part, 16)) : [];
	const right = tail ? tail.split(':').map((part) => parseInt(part, 16)) : [];
	const groups = Array(8).fill(0);
	for (let i = 0; i < left.length; i++) groups[i] = left[i];
	for (let i = 0; i < right.length; i++)
		groups[8 - right.length + i] = right[i];
	return groups;
}

function nxdomain(query) {
	const out = Buffer.from(query);
	const rd = query.readUInt16BE(2) & 0x0100;
	out.writeUInt16BE(0x8183 | rd, 2);
	return out.subarray(0, Math.min(out.length, UDP_MAX));
}

/**
 * Listen on 127.0.0.1, any port. The relay is told this address
 * (`dnsServers`). Resolves once the socket is bound.
 */
export function listenLocalhostDns() {
	const socket = createSocket('udp4');
	socket.on('message', (msg, from) => {
		void answer(socket, msg, from);
	});
	// a late lookup must not crash the demo
	socket.on('error', () => {});
	return new Promise((resolve, reject) => {
		socket.once('error', reject);
		socket.bind(0, '127.0.0.1', () => {
			socket.removeListener('error', reject);
			resolve({
				address: `127.0.0.1:${socket.address().port}`,
				close: () => socket.close(),
			});
		});
	});
}

async function answer(socket, msg, from) {
	const asked = question(msg);
	if (!asked) return;
	// A and AAAA only; anything else (HTTPS, for instance) is no answer of
	// ours, and a name we cannot read is left unanswered rather than wrong
	if (asked.type !== 1 && asked.type !== 28) return;
	let records;
	try {
		records = await lookup(asked.name, { all: true, verbatim: true });
	} catch (error) {
		if (error && error.code === 'ENOTFOUND')
			socket.send(nxdomain(msg), from.port, from.address);
		return;
	}
	const family = asked.type === 28 ? 6 : 4;
	const addresses = records
		.filter((record) => record.family === family)
		.map((record) => record.address);
	socket.send(reply(msg, asked, addresses), from.port, from.address);
}
