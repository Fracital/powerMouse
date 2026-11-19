// Epoxy's `ech_dns` answers (a name's HTTPS record, for its ECH config) are
// kept as Chrome 157's host cache keeps them, and across a reload
// (src/transport/echCache.ts, deploy/epoxy epoxy-transport 0060, epoxy-tls
// 0080):
//  - by network partition: a name asked for one partition is asked again
//    for another, and not again for the same one (Chrome asks a name again
//    for each top-level site, and for a frame cross-site to its top;
//    measured against a DNS server that counted the queries);
//  - across a reload, from IndexedDB, with the config's bytes as they came;
//  - never past the answer's TTL: a record's TTL, a NODATA's SOA negative
//    TTL (min of the SOA's TTL and its MINIMUM), and nothing kept at all
//    for a NODATA without an SOA.
// The fixture is ech-fallback's: a wisp server that dials loopback by the
// CONNECT's port, a DoH endpoint of the suite's own (it counts the queries
// per name), and TLS servers for the fixture names that close each
// connection after its answer, so every request makes a new connection and
// asks for the name's record unless it is kept.
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createNet, connect as netConnect } from 'node:net';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PROXY, sleep } from '../lib.mjs';

// a test CA and a certificate it issued for the fixture names (P-256, valid
// until 2126); epoxy trusts the CA through its pem_files option
const CA = `-----BEGIN CERTIFICATE-----
MIIBjzCCATWgAwIBAgIUYboLSpQ9zGD0aFL1QqKkVwe0zpAwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRc3RvbXAgZWNoIHRlc3QgQ0EwIBcNMjYxMTEyMDIxMTQwWhgP
MjEyNjEwMTkwMjExNDBaMBwxGjAYBgNVBAMMEXN0b21wIGVjaCB0ZXN0IENBMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUwQYPjBCXnoVfih/Qs76XBbh8IdwQYts
Kss7NKZLSwAgzGg49BhQp64KfmHa3pi3f4ccY8NMD94HHL9hG1nxk6NTMFEwHQYD
VR0OBBYEFFwhKxEdX2+yJ1wMBjYYeX6uTPw7MB8GA1UdIwQYMBaAFFwhKxEdX2+y
J1wMBjYYeX6uTPw7MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIh
ANEIk2tsG23aifgfGWPGtVOjBCje2TdgNw39K4nQY8cIAiAD1hNUeN13dCHxgegn
EWK7LhIyf5zLUhngAGyl3LvsSg==
-----END CERTIFICATE-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIB2jCCAX+gAwIBAgIUb653NgdB+hj04gTau7tra+tbxQwwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRc3RvbXAgZWNoIHRlc3QgQ0EwIBcNMjYxMTEyMDIxMTQwWhgP
MjEyNjEwMTkwMjExNDBaMBoxGDAWBgNVBAMMD3NpdGUuZWNoZml4Lm5ldDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABLrDe5afbiCA9Dkoy2zHVfiPvaMCm/+S7E5e
Y4Cv6nJLeSXbEb8gYOYmZBZbZu2bof67yXHhZwiFjQj+/yRWXVejgZ4wgZswLAYD
VR0RBCUwI4IPc2l0ZS5lY2hmaXgubmV0ghBwbGFpbi5lY2hmaXgubmV0MAkGA1Ud
EwQCMAAwCwYDVR0PBAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQW
BBRjU88fBw+ZIfx1mLyS3U1Aq3odCTAfBgNVHSMEGDAWgBRcISsRHV9vsidcDAY2
GHl+rkz8OzAKBggqhkjOPQQDAgNJADBGAiEAh9TY6V/GxmsKtmLG6q/tZjRYgcxw
ipNPkYSbGtzS/48CIQD4ofPK+4PpjhoKhWu2FjeGOcxRcOry/sCtnAQvhwIT2g==
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINIt6xhNMElhcQZ46jbtuQjm9N2t3kXw+1zVAAfIpSd2oAoGCCqGSM49
AwEHoUQDQgAEusN7lp9uIID0OSjLbMdV+I+9owKb/5LsTl5jgK/qckt5JdsRvyBg
5iZkFltm7Zuh/rvJceFnCIWNCP7/JFZdVw==
-----END EC PRIVATE KEY-----
`;

const SITE = 'site.echfix.net';
const COVER = 'cover.echfix.net';
const PLAIN = 'plain.echfix.net';
const DOH = 'doh.echfix.net';
const TIMEOUT_MS = 20000;

function echConfigList(publicName) {
	const { publicKey } = generateKeyPairSync('x25519');
	const der = publicKey.export({ type: 'spki', format: 'der' });
	const pub = der.subarray(der.length - 32);
	const name = Buffer.from(publicName, 'ascii');
	const keyConfig = Buffer.concat([
		Buffer.from([0x2a]),
		u16(0x0020),
		u16(pub.length),
		pub,
		u16(4),
		u16(0x0001),
		u16(0x0001),
	]);
	const contents = Buffer.concat([
		keyConfig,
		Buffer.from([64]),
		Buffer.from([name.length]),
		name,
		u16(0),
	]);
	const config = Buffer.concat([u16(0xfe0d), u16(contents.length), contents]);
	return Buffer.concat([u16(config.length), config]);
}
function u16(n) {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
}
function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
}
const ECH = echConfigList(COVER);

// --- the DoH endpoint: SITE has an HTTPS record with ECH (TTL 300); PLAIN
// answers as `plain` says: NODATA with an SOA whose TTL and MINIMUM are
// given (the negative TTL is the smaller), or NODATA with no SOA
const asked = new Map();
let plain = { soaTtl: 300, minimum: 300 };
function dnsName(query) {
	const labels = [];
	for (let at = 12; query[at]; at += query[at] + 1)
		labels.push(query.toString('ascii', at + 1, at + 1 + query[at]));
	return labels.join('.');
}
function dohAnswer(query, name) {
	const header = Buffer.from(query.subarray(0, 12));
	header.writeUInt16BE(0x8180, 2);
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(0, 6);
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(0, 10);
	const question = query.subarray(12);
	if (name === SITE) {
		header.writeUInt16BE(1, 6);
		const svcparam = Buffer.concat([u16(5), u16(ECH.length), ECH]);
		const rdata = Buffer.concat([u16(1), Buffer.from([0]), svcparam]);
		const answer = Buffer.concat([
			Buffer.from([0xc0, 0x0c]),
			u16(65),
			u16(1),
			u32(300),
			u16(rdata.length),
			rdata,
		]);
		return Buffer.concat([header, question, answer]);
	}
	if (!plain.soaTtl) return Buffer.concat([header, question]);
	header.writeUInt16BE(1, 8);
	const mname = Buffer.from([2, 0x6e, 0x73, 0xc0, 0x0c]); // ns.<name>
	const rname = Buffer.from([1, 0x68, 0xc0, 0x0c]); // h.<name>
	const rdata = Buffer.concat([
		mname,
		rname,
		u32(1),
		u32(7200),
		u32(900),
		u32(1209600),
		u32(plain.minimum),
	]);
	const soa = Buffer.concat([
		Buffer.from([0xc0, 0x0c]),
		u16(6),
		u16(1),
		u32(plain.soaTtl),
		u16(rdata.length),
		rdata,
	]);
	return Buffer.concat([header, question, soa]);
}
const doh = createHttp((req, res) => {
	const dns = new URL(req.url, 'http://x/').searchParams.get('dns');
	if (!dns) return void res.writeHead(400).end();
	const query = Buffer.from(
		dns.replace(/-/g, '+').replace(/_/g, '/'),
		'base64',
	);
	const name = dnsName(query);
	asked.set(name, (asked.get(name) ?? 0) + 1);
	res.writeHead(200, { 'content-type': 'application/dns-message' });
	res.end(dohAnswer(query, name));
});
const count = (name) => asked.get(name) ?? 0;

// --- TLS: each answer closes its connection
const backend = createHttps({ cert: CERT + CA, key: KEY }, (req, res) => {
	res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
	res.end('ok');
});
/** a front that drops a hello whose SNI is the ECH public name (the outer hello of real ECH), so SITE loads by epoxy's no-ECH retry */
function front(backendPort) {
	return createNet((socket) => {
		let buf = Buffer.alloc(0);
		let up = null;
		socket.on('data', (chunk) => {
			if (up) return void up.write(chunk);
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return;
			if (buf.includes(Buffer.from(COVER))) return void socket.destroy();
			up = netConnect(backendPort, '127.0.0.1');
			up.write(buf);
			up.on('data', (c) => !socket.destroyed && socket.write(c));
			up.on('close', () => socket.destroy());
			up.on('error', () => socket.destroy());
		});
		socket.on('close', () => up && up.destroy());
		socket.on('error', () => up && up.destroy());
	});
}

// --- ech-fallback's wisp server (v1)
const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
function wispPacket(type, id, tail = Buffer.alloc(0)) {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32LE(id, 1);
	return Buffer.concat([head, tail]);
}
function continuePacket(id) {
	const n = Buffer.alloc(4);
	n.writeUInt32LE(1024);
	return wispPacket(CONTINUE, id, n);
}
const wispHttp = createHttp();
const wisp = new WebSocketServer({ server: wispHttp });
wisp.on('connection', (client) => {
	client.send(continuePacket(0));
	const streams = new Map();
	const closeStream = (id, reason) => {
		if (!streams.delete(id)) return;
		if (client.readyState === client.OPEN)
			client.send(wispPacket(CLOSE, id, Buffer.from([reason])));
	};
	client.on('message', (data) => {
		const packet = Buffer.from(data);
		if (packet.length < 5) return;
		const id = packet.readUInt32LE(1);
		if (packet[0] === CONNECT) {
			if (packet[5] !== 0x01) return closeStream(id, 0x48);
			const socket = netConnect(packet.readUInt16LE(6), '127.0.0.1');
			streams.set(id, socket);
			socket.on('connect', () => client.send(continuePacket(id)));
			socket.on('data', (chunk) => {
				if (client.readyState === client.OPEN)
					client.send(wispPacket(DATA, id, chunk));
			});
			socket.on('close', () => closeStream(id, 0x02));
			socket.on('error', () => closeStream(id, 0x03));
		} else if (packet[0] === DATA) {
			const socket = streams.get(id);
			if (socket && !socket.destroyed) socket.write(packet.subarray(5));
			if (client.readyState === client.OPEN) client.send(continuePacket(id));
		} else if (packet[0] === CLOSE) {
			const socket = streams.get(id);
			streams.delete(id);
			if (socket) socket.destroy();
		}
	});
	client.on('close', () => {
		for (const socket of streams.values()) socket.destroy();
	});
});

const listen = (server) =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	});
const backendPort = await listen(backend);
const tlsPort = await listen(front(backendPort));
const dohPort = await listen(doh);
const wispPort = await listen(wispHttp);

const browser = await launch();
const errors = [];

/** a controller in `page` whose epoxy asks the suite's DoH endpoint, in its worker or in the page */
async function start(page, host) {
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await page.evaluate(
		async ({ ca, wisp, echDns, host }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					options: [{ wisp, wisp_v2: false, pem_files: [ca], ech_dns: echDns }],
					host,
				},
				directory: '/stomp/',
				codec: 'xor',
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			window.controller = controller;
		},
		{
			ca: CA,
			wisp: `ws://127.0.0.1:${wispPort}/`,
			echDns: `http://${DOH}:${dohPort}/dns-query`,
			host,
		},
	);
}

/** a request of the host's own to `name` in the network partition `partition`: "ok" or why not */
const get = (page, name, partition) =>
	page.evaluate(
		async ({ url, partition, timeoutMs }) => {
			const timeout = new Promise((resolve) =>
				setTimeout(() => resolve('TIMEOUT'), timeoutMs),
			);
			const asked = window.controller.transport
				.request(
					new URL(url),
					'GET',
					null,
					[['$stomp$network', partition]],
					undefined,
				)
				.then(async (response) => {
					const text = await new Response(response.body).text();
					return text === 'ok' ? 'ok' : `status ${response.status}`;
				});
			return Promise.race([asked, timeout]).catch((error) =>
				String(error).slice(0, 160),
			);
		},
		{
			url: `https://${name}:${tlsPort}/?${Date.now()}`,
			partition,
			timeoutMs: TIMEOUT_MS,
		},
	);

/** what this origin keeps (echCache.ts): its entries, by key */
const kept = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				const request = indexedDB.open('stomp-ech', 1);
				request.onupgradeneeded = () =>
					request.result.createObjectStore('answers');
				request.onerror = () => resolve({});
				request.onsuccess = () => {
					const store = request.result
						.transaction('answers')
						.objectStore('answers');
					const keys = store.getAllKeys();
					const values = store.getAll();
					values.onsuccess = () => {
						request.result.close();
						const out = {};
						keys.result.forEach((key, at) => {
							const { ech, until } = values.result[at];
							out[key] = {
								ech: ech ? btoa(String.fromCharCode(...ech)) : null,
								inMs: until - Date.now(),
							};
						});
						resolve(out);
					};
				};
			}),
	);

for (const host of ['worker', 'page']) {
	asked.clear();
	plain = { soaTtl: 300, minimum: 120 };
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	const A = `https://a.example same-site ${host}`;
	const B = `https://b.example same-site ${host}`;
	const AX = `https://a.example cross-site ${host}`;
	await start(page, host);

	const first = [await get(page, SITE, A), await get(page, PLAIN, A)];
	const again = [await get(page, SITE, A), await get(page, PLAIN, A)];
	ok(
		`${host}: a partition asks each name once, its next connections take what it was told`,
		[...first, ...again].every((r) => r === 'ok') &&
			count(SITE) === 1 &&
			count(PLAIN) === 1,
		JSON.stringify({ first, again, asked: [...asked] }),
	);

	const other = [await get(page, PLAIN, B), await get(page, PLAIN, AX)];
	ok(
		`${host}: another top-level site and a context cross-site to the first ask again`,
		other.every((r) => r === 'ok') && count(PLAIN) === 3,
		JSON.stringify({ other, asked: [...asked] }),
	);

	const store = await kept(page);
	const site = store[`${A}\n${SITE}`];
	const neg = store[`${A}\n${PLAIN}`];
	ok(
		`${host}: kept by partition and name, the config's bytes as they came, for the record's TTL and the SOA's negative TTL`,
		site?.ech === ECH.toString('base64') &&
			site.inMs > 290000 &&
			site.inMs <= 300000 &&
			neg?.ech === null &&
			neg.inMs > 110000 &&
			neg.inMs <= 120000,
		JSON.stringify(store),
	);

	// a reload: a new transport (its worker, or the page's), the answers kept
	await start(page, host);
	const reloaded = [await get(page, SITE, A), await get(page, PLAIN, B)];
	ok(
		`${host}: after a reload the names are not asked again`,
		reloaded.every((r) => r === 'ok') &&
			count(SITE) === 1 &&
			count(PLAIN) === 3,
		JSON.stringify({ reloaded, asked: [...asked] }),
	);

	// a negative TTL of 3 s (the SOA's MINIMUM under its TTL): kept for it
	// across a reload, asked again once it ran out, in the realm and after
	// a reload alike
	const C = `https://c.example same-site ${host}`;
	plain = { soaTtl: 600, minimum: 3 };
	const before = count(PLAIN);
	await get(page, PLAIN, C);
	await start(page, host);
	await get(page, PLAIN, C);
	const within = count(PLAIN) - before;
	await sleep(3500);
	await get(page, PLAIN, C);
	const expired = count(PLAIN) - before;
	await start(page, host);
	await get(page, PLAIN, C);
	const reloadedAfter = count(PLAIN) - before;
	ok(
		`${host}: an answer is kept for its TTL and not past it, in the realm and across a reload`,
		within === 1 && expired === 2 && reloadedAfter === 2,
		JSON.stringify({ within, expired, reloadedAfter }),
	);

	// NODATA without an SOA: nothing to keep it by
	const D = `https://d.example same-site ${host}`;
	plain = { soaTtl: 0 };
	const bare = count(PLAIN);
	await get(page, PLAIN, D);
	await get(page, PLAIN, D);
	const noSoa = count(PLAIN) - bare;
	const stored = await kept(page);
	ok(
		`${host}: an answer with no TTL to keep it by is not kept`,
		noSoa === 2 && !(`${D}\n${PLAIN}` in stored),
		JSON.stringify({ noSoa, keys: Object.keys(stored) }),
	);
	await context.close();
}

wisp.close();
wispHttp.close();
doh.close();
backend.close();
await done(browser, errors);
