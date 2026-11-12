// A site whose HTTPS DNS record advertises Encrypted Client Hello keeps
// loading through epoxy even when the host drops the real-ECH handshake.
//
// Measured 2026-11-12: duckduckgo.com (and other ECH hosts, intermittently)
// closed the TLS connection with no alert when epoxy offered its real-ECH
// ClientHello, where Chrome's hello to the same host was accepted. The drop
// reached epoxy as an UnexpectedEof mid-handshake; epoxy's ECH-rejection
// retry only covered a rustls ServerRejectedEncryptedClientHello, so the EOF
// surfaced and the page never loaded. The demo's ?noech switch (GREASE ECH
// only) reached the site. Epoxy now reconnects once without ECH on that EOF,
// matching ?noech automatically (deploy/epoxy/patches/epoxy-tls/0059).
//
// The fixture is deterministic and needs no internet, so it runs in CI where
// the real host's drop is intermittent. A minimal wisp server dials loopback
// by the port each CONNECT names, so the fixture names resolve nowhere yet
// reach servers of this suite's own. A DoH endpoint answers the HTTPS-record
// query for site.echfix.net with an ech config list whose public name is
// cover.echfix.net, and answers dropall.echfix.net with no ech. Each name's
// TLS front reads the ClientHello's SNI:
//   - site.echfix.net's front drops every hello whose SNI is the ech public
//     name cover.echfix.net (a real-ECH outer hello) with no alert, as the
//     real hosts drop ours, and tunnels a hello whose SNI is the real name
//     (the no-ECH retry) to a TLS backend with a certificate from a CA epoxy
//     trusts. So the site loads only if epoxy stops offering ECH, however
//     many times the connection is retried.
//   - dropall.echfix.net's front drops every hello. No ECH is offered there,
//     so epoxy never retries without ECH and the host stays unreachable: a
//     dropped handshake is recovered only when ECH was the thing dropped.
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createNet, connect as netConnect } from 'node:net';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PROXY } from '../lib.mjs';

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
const COVER = 'cover.echfix.net'; // the ech public name: the real-ECH outer SNI
const DROPALL = 'dropall.echfix.net';
const DOH = 'doh.echfix.net';
const TIMEOUT_MS = 20000;

// --- an ECHConfigList rustls accepts (RFC 9849): a fresh X25519 key, the
// DHKEM(X25519, HKDF-SHA256) KEM and the HKDF-SHA256 / AES-128-GCM suite that
// rustls's ring HPKE offers, with COVER as the public name. The handshake it
// keys is dropped, so the private key is thrown away.
function echConfigList(publicName) {
	const { publicKey } = generateKeyPairSync('x25519');
	const der = publicKey.export({ type: 'spki', format: 'der' });
	const pub = der.subarray(der.length - 32); // the raw 32-byte X25519 point
	const name = Buffer.from(publicName, 'ascii');
	const u16 = (n) => {
		const b = Buffer.alloc(2);
		b.writeUInt16BE(n);
		return b;
	};
	const keyConfig = Buffer.concat([
		Buffer.from([0x2a]), // config_id
		u16(0x0020), // kem_id: DHKEM(X25519, HKDF-SHA256)
		u16(pub.length),
		pub,
		u16(4), // cipher_suites length
		u16(0x0001), // kdf_id: HKDF-SHA256
		u16(0x0001), // aead_id: AES-128-GCM
	]);
	const contents = Buffer.concat([
		keyConfig,
		Buffer.from([64]), // maximum_name_length
		Buffer.from([name.length]),
		name,
		u16(0), // extensions
	]);
	const config = Buffer.concat([u16(0xfe0d), u16(contents.length), contents]);
	return Buffer.concat([u16(config.length), config]);
}

const ECH = echConfigList(COVER);

// --- the SNI (host_name) of a TLS ClientHello, undefined while the record is
// still incomplete, '' once it is parsed and carries none
function parseSNI(buf) {
	if (buf.length < 5) return undefined;
	if (buf[0] !== 0x16) return ''; // not a handshake record
	const recordEnd = 5 + buf.readUInt16BE(3);
	if (buf.length < recordEnd) return undefined;
	let p = 5;
	if (buf[p] !== 0x01) return ''; // not a ClientHello
	const bodyEnd = p + 4 + ((buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]);
	p += 4 + 2 + 32; // handshake header, client_version, random
	p += 1 + buf[p]; // session_id
	p += 2 + buf.readUInt16BE(p); // cipher_suites
	p += 1 + buf[p]; // compression_methods
	if (p + 2 > bodyEnd) return '';
	const extEnd = p + 2 + buf.readUInt16BE(p);
	p += 2;
	while (p + 4 <= extEnd) {
		const type = buf.readUInt16BE(p);
		const len = buf.readUInt16BE(p + 2);
		if (type === 0x0000 && buf[p + 6] === 0x00) {
			const nameLen = buf.readUInt16BE(p + 7);
			return buf.toString('ascii', p + 9, p + 9 + nameLen);
		}
		p += 4 + len;
	}
	return '';
}

// --- a DoH endpoint (RFC 8484): the HTTPS record for SITE carries the ech
// config list, every other name carries none. The query name is read from the
// DNS message in the `dns` parameter.
function dnsName(query) {
	const labels = [];
	for (let at = 12; query[at]; at += query[at] + 1)
		labels.push(query.toString('ascii', at + 1, at + 1 + query[at]));
	return labels.join('.');
}
function dohAnswer(query, withEch) {
	const header = Buffer.from(query.subarray(0, 12));
	header.writeUInt16BE(0x8180, 2); // response, recursion available, NOERROR
	header.writeUInt16BE(1, 4); // one question
	header.writeUInt16BE(withEch ? 1 : 0, 6); // answers
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(0, 10);
	const question = query.subarray(12);
	if (!withEch) return Buffer.concat([header, question]);
	const u16 = (n) => {
		const b = Buffer.alloc(2);
		b.writeUInt16BE(n);
		return b;
	};
	const svcparam = Buffer.concat([u16(5), u16(ECH.length), ECH]); // ech = key 5
	const rdata = Buffer.concat([u16(1), Buffer.from([0]), svcparam]); // ServiceMode
	const answer = Buffer.concat([
		Buffer.from([0xc0, 0x0c]), // name: pointer to the question
		u16(65), // type HTTPS
		u16(1), // class IN
		Buffer.from([0, 0, 1, 0x2c]), // TTL 300
		u16(rdata.length),
		rdata,
	]);
	return Buffer.concat([header, question, answer]);
}
const doh = createHttp((req, res) => {
	const dns = new URL(req.url, 'http://x/').searchParams.get('dns');
	if (!dns) return void res.writeHead(400).end();
	const query = Buffer.from(
		dns.replace(/-/g, '+').replace(/_/g, '/'),
		'base64',
	);
	res.writeHead(200, { 'content-type': 'application/dns-message' });
	res.end(dohAnswer(query, dnsName(query) === SITE));
});

// --- the TLS backend the site front tunnels to, and the body a visit reads
const backend = createHttps({ cert: CERT + CA, key: KEY }, (req, res) => {
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<!doctype html><title>ECH FIXTURE OK</title><p>served</p>');
});

// --- a TLS front that reads each ClientHello's SNI and either drops it with
// no alert (as the real hosts drop our real-ECH hello) or tunnels it to the
// backend. `drop(sni)` decides; `seen` records the SNIs in order.
function makeFront(backendPort, drop) {
	const front = { seen: [], server: null };
	front.server = createNet((socket) => {
		let buf = Buffer.alloc(0);
		let up = null;
		let decided = false;
		socket.on('data', (chunk) => {
			if (decided) return void (up && up.write(chunk));
			buf = Buffer.concat([buf, chunk]);
			const sni = parseSNI(buf);
			if (sni === undefined) return;
			decided = true;
			front.seen.push(sni);
			if (drop(sni)) return void socket.destroy();
			up = netConnect(backendPort, '127.0.0.1');
			up.write(buf);
			up.on('data', (c) => !socket.destroyed && socket.write(c));
			up.on('close', () => socket.destroy());
			up.on('error', () => socket.destroy());
		});
		socket.on('close', () => up && up.destroy());
		socket.on('error', () => up && up.destroy());
	});
	return front;
}

// --- a minimal wisp server: it dials 127.0.0.1 at the port each CONNECT
// names, so a fixture name reaches a loopback server of the suite's own. The
// client is held to wisp v1 (wisp_v2: false), so no extension handshake is
// needed; a generous per-stream window keeps a small page from stalling.
const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const TCP = 0x01;
const WINDOW = 1024;
function wispPacket(type, id, tail = Buffer.alloc(0)) {
	const head = Buffer.alloc(5);
	head[0] = type;
	head.writeUInt32LE(id, 1);
	return Buffer.concat([head, tail]);
}
function continuePacket(id) {
	const n = Buffer.alloc(4);
	n.writeUInt32LE(WINDOW);
	return wispPacket(CONTINUE, id, n);
}
const wispHttp = createHttp();
const wisp = new WebSocketServer({ server: wispHttp });
wisp.on('connection', (client) => {
	client.send(continuePacket(0)); // initial per-stream window
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
			if (packet[5] !== TCP) return closeStream(id, 0x48);
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
// site.echfix.net: drop the real-ECH outer hello (SNI is the public name),
// serve the no-ECH retry (SNI is the real name)
const siteFront = makeFront(backendPort, (sni) => sni === COVER);
// dropall.echfix.net: drop every hello; no ECH is offered here
const dropFront = makeFront(backendPort, () => true);
const sitePort = await listen(siteFront.server);
const dropPort = await listen(dropFront.server);
const dohPort = await listen(doh);
const wispPort = await listen(wispHttp);

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const result = await page.evaluate(
	async ({ ca, wisp, echDns, urls, timeoutMs }) => {
		const { StompController } = await import('/stomp/controller.mjs');
		const registration = await StompController.register('/stomp/');
		const controller = new StompController({
			serviceworker: registration,
			transport: {
				module: '/epoxy/index.mjs',
				// held to wisp v1 for the suite's own wisp server; ech_dns
				// drives real ECH per name
				options: [{ wisp, wisp_v2: false, pem_files: [ca], ech_dns: echDns }],
			},
			directory: '/stomp/',
			codec: 'xor',
		});
		await controller.wait();
		const timeout = () =>
			new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), timeoutMs));
		const out = {};
		for (const [label, url] of Object.entries(urls)) {
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			out[label] = await Promise.race([
				frame
					.go(url)
					.then(() => element.contentDocument?.title ?? '(no title)'),
				timeout(),
			]).catch((error) => String(error).slice(0, 120));
		}
		return out;
	},
	{
		ca: CA,
		wisp: `ws://127.0.0.1:${wispPort}/`,
		echDns: `http://${DOH}:${dohPort}/dns-query`,
		urls: {
			site: `https://${SITE}:${sitePort}/`,
			dropall: `https://${DROPALL}:${dropPort}/`,
		},
		timeoutMs: TIMEOUT_MS,
	},
);

ok(
	'an ECH host that drops the real-ECH handshake loads through the no-ECH fallback',
	result.site === 'ECH FIXTURE OK',
	`title ${JSON.stringify(result.site)}`,
);
ok(
	'the real-ECH outer hello was offered and dropped (SNI was the ech public name)',
	siteFront.seen.includes(COVER),
	`SNIs seen ${JSON.stringify(siteFront.seen)}`,
);
ok(
	'the served connection carried no ECH (SNI was the real name)',
	siteFront.seen.includes(SITE),
	`SNIs seen ${JSON.stringify(siteFront.seen)}`,
);
ok(
	'a dropped handshake with no ECH offered is not recovered (fallback is ECH-only)',
	result.dropall !== 'ECH FIXTURE OK',
	`title ${JSON.stringify(result.dropall)}`,
);
ok('no page errors', errors.length === 0, errors.join(' | '));

wisp.close();
wispHttp.close();
doh.close();
siteFront.server.close();
dropFront.server.close();
backend.close();
await done(browser);
