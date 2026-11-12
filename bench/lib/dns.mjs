// The harness's DNS server, which holyWisp asks (its `dns-server` option):
// names under .bench.test are the local fixture servers (127.0.0.1), every
// other question is forwarded as it is to the system's first nameserver and
// the answer relayed back. Only holyWisp uses it; the browser never does.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

const SUFFIX = '.bench.test';

function systemNameserver() {
	try {
		const conf = readFileSync('/etc/resolv.conf', 'utf8');
		const match = conf.match(/^nameserver\s+(\S+)/m);
		if (match && !match[1].includes(':')) return match[1];
	} catch {
		// fall through
	}
	return '1.1.1.1';
}

/** the question's name, type and where the question section ends */
function parseQuestion(msg) {
	let offset = 12;
	const labels = [];
	while (offset < msg.length) {
		const len = msg[offset];
		if (len === 0) break;
		labels.push(msg.subarray(offset + 1, offset + 1 + len).toString('ascii'));
		offset += len + 1;
	}
	offset += 1;
	const type = msg.readUInt16BE(offset);
	return { name: labels.join('.').toLowerCase(), type, end: offset + 4 };
}

function localAnswer(msg, question) {
	const header = Buffer.from(msg.subarray(0, 12));
	// QR, opcode copied, AA, RD copied, RA
	header[2] = 0x84 | (msg[2] & 0x01);
	header[3] = 0x80;
	const isA = question.type === 1;
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(isA ? 1 : 0, 6);
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(0, 10);
	const parts = [header, msg.subarray(12, question.end)];
	if (isA)
		parts.push(
			Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 127, 0, 0, 1]),
		);
	return Buffer.concat(parts);
}

/** starts the server on 127.0.0.1:<port>; returns { port, stop() } */
export async function startDNS(port) {
	const upstream = systemNameserver();
	const server = createSocket('udp4');
	const pending = new Map();
	const forward = createSocket('udp4');
	forward.on('message', (msg) => {
		const key = msg.readUInt16BE(0);
		const client = pending.get(key);
		if (!client) return;
		pending.delete(key);
		const reply = Buffer.from(msg);
		reply.writeUInt16BE(client.id, 0);
		server.send(reply, client.port, client.address);
	});
	let nextId = 1;
	server.on('message', (msg, rinfo) => {
		if (msg.length < 12) return;
		let question;
		try {
			question = parseQuestion(msg);
		} catch {
			return;
		}
		if (question.name === 'bench.test' || question.name.endsWith(SUFFIX)) {
			server.send(localAnswer(msg, question), rinfo.port, rinfo.address);
			return;
		}
		const id = nextId++ & 0xffff;
		pending.set(id, {
			id: msg.readUInt16BE(0),
			port: rinfo.port,
			address: rinfo.address,
		});
		setTimeout(() => pending.delete(id), 10000).unref();
		const out = Buffer.from(msg);
		out.writeUInt16BE(id, 0);
		forward.send(out, 53, upstream);
	});
	await new Promise((resolve) => forward.bind(0, '0.0.0.0', resolve));
	await new Promise((resolve) => server.bind(port, '127.0.0.1', resolve));
	return {
		port,
		upstream,
		stop: () => {
			server.close();
			forward.close();
		},
	};
}
