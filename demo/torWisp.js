// An opt-in Tor-only Wisp relay. holyWisp validates a name with DNS before
// sending the *original hostname* in its SOCKS5 CONNECT (ATYP 3). Giving it
// the ordinary resolver leaks the destination, and makes .onion fail before
// Tor sees it. This loopback DNS server returns a public, never-dialled A
// placeholder for that validation; the only outbound TCP path is SOCKS5.
// It NEVER asks or forwards a question to another DNS server.
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { holyWisp } from 'holywisp';

// A syntactically public address: holyWisp's outbound-address policy rejects
// private/test-net addresses during name validation, including with a proxy.
// This address is never a TCP dial target: proxy is mandatory and all TCP
// streams are proxied by hostname. IP-literal CONNECTs are forbidden.
const VALIDATION_A = Buffer.from([1, 1, 1, 1]);
const BLOCKED_NAMES =
	/(?:^|\.)(?:localhost|local|lan|internal|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

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
	const denied = name.length > 253 || BLOCKED_NAMES.test(name);
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
	const url = new URL(value);
	if (
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

/** SOCKS5 method negotiation only: proves a SOCKS endpoint exists, not that Tor bootstrapped. */
export async function probeTorSocks5({ host, port }, timeoutMs = 1200) {
	await new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		let done = false;
		const finish = (err) => {
			if (done) return;
			done = true;
			socket.destroy();
			if (err) reject(err);
			else resolve();
		};
		socket.setTimeout(timeoutMs, () =>
			finish(new Error('Tor SOCKS5 probe timed out')),
		);
		socket.once('error', finish);
		socket.once('close', () =>
			finish(new Error('Tor SOCKS5 closed during probe')),
		);
		socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
		socket.once('data', (bytes) =>
			finish(
				bytes.length >= 2 && bytes[0] === 5 && bytes[1] === 0
					? null
					: new Error('Tor SOCKS5 refused no-auth negotiation'),
			),
		);
	});
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

/** Start a distinct relay, or advertise an operator-provided external one. */
export async function startTorWisp({
	socks5 = '',
	external = '',
	logLevel = 'error',
} = {}) {
	if (external)
		return { external: externalTorWisp(external), relay: null, dns: null };
	if (!socks5) return null;
	const socks = parseTorSocks5(socks5);
	try {
		await probeTorSocks5(socks);
	} catch (error) {
		console.warn(`Tor Wisp disabled: ${error.message}`);
		return null;
	}
	let dns;
	let relay;
	try {
		dns = await openValidationDns();
		relay = new holyWisp({
			port: 0,
			autoRestart: false, // a dead relay must not silently come back in a different mode
			proxy: socks.url,
			proxyUDP: 'refuse',
			allowTCP: true,
			allowUDP: false,
			allowDirectIP: false,
			allowPrivateIPs: false,
			allowLoopbackIPs: false,
			allowLinkLocalIPs: false,
			dnsServers: [dns.address], // never use the system resolver for destinations
			dnsResultOrder: 'ipv4first',
			dnsTtlSeconds: 1,
			dnsTimeoutMs: 1000,
			floodProtection: { enabled: false },
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
	return { relay, dns, external: null };
}
