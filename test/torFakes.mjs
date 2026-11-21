// Fakes of Tor for the Tor relay's tests (test/tor-wisp.mjs and the
// demo-tor suite): no real Tor and no public network. fakeControl answers
// as Tor's control port does as far as demo/torWisp.js asks it;
// forwardingSocks is a SOCKS5 listener that takes the hostname CONNECTs Tor
// would and connects each to a local fixture instead.
import { createHmac } from 'node:crypto';
import { connect, createServer as createNetServer } from 'node:net';

const close = (server) => new Promise((resolve) => server.close(resolve));

// A Tor control port as far as the monitor uses it: PROTOCOLINFO, one of
// NULL / HASHEDPASSWORD / SAFECOOKIE authentication, GETINFO of the
// bootstrap phase and circuit state, QUIT. `tor.progress` and
// `tor.circuit` are what it reports; `tor.seen` the commands it got.
const SERVER_KEY = 'Tor safe cookie authentication server-to-controller hash';
const CLIENT_KEY = 'Tor safe cookie authentication controller-to-server hash';
export function fakeControl({
	method = 'NULL',
	password = '',
	cookie = null,
} = {}) {
	const tor = { progress: 0, circuit: false, seen: [] };
	const server = createNetServer((socket) => {
		let authed = false;
		let buffer = '';
		let challenge = null;
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			let newline;
			while ((newline = buffer.indexOf('\r\n')) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 2);
				tor.seen.push(line.split(' ')[0]);
				const reply = (text) => socket.write(`${text}\r\n`);
				if (line === 'PROTOCOLINFO 1') {
					reply('250-PROTOCOLINFO 1');
					reply(
						`250-AUTH METHODS=${method}${cookie ? ` COOKIEFILE="${cookie.path}"` : ''}`,
					);
					reply('250-VERSION Tor="0.4.8.0"');
					reply('250 OK');
				} else if (line.startsWith('AUTHCHALLENGE SAFECOOKIE ')) {
					const clientNonce = Buffer.from(line.split(' ')[2], 'hex');
					const serverNonce = Buffer.alloc(32, 7);
					challenge = Buffer.concat([cookie.bytes, clientNonce, serverNonce]);
					const hash = createHmac('sha256', SERVER_KEY)
						.update(challenge)
						.digest('hex');
					reply(
						`250 AUTHCHALLENGE SERVERHASH=${hash.toUpperCase()} SERVERNONCE=${serverNonce.toString('hex').toUpperCase()}`,
					);
				} else if (line.startsWith('AUTHENTICATE')) {
					const given = line.slice('AUTHENTICATE'.length).trim();
					authed =
						method === 'NULL'
							? true
							: method === 'HASHEDPASSWORD'
								? given === JSON.stringify(password)
								: !!challenge &&
									given ===
										createHmac('sha256', CLIENT_KEY)
											.update(challenge)
											.digest('hex');
					reply(authed ? '250 OK' : '515 Authentication failed');
					if (!authed) socket.end();
				} else if (!authed) {
					reply('514 Authentication required.');
					socket.end();
				} else if (line === 'GETINFO status/bootstrap-phase') {
					const done = tor.progress === 100;
					reply(
						`250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=${tor.progress} TAG=${done ? 'done' : 'loading_descriptors'} SUMMARY="${done ? 'Done' : 'Loading relay descriptors'}"`,
					);
					reply('250 OK');
				} else if (line === 'GETINFO status/circuit-established') {
					reply(`250-status/circuit-established=${tor.circuit ? 1 : 0}`);
					reply('250 OK');
				} else if (line === 'QUIT') {
					reply('250 closing connection');
					socket.end();
				} else reply('510 Unrecognized command');
			}
		});
	});
	return {
		tor,
		server,
		listen: () =>
			new Promise((resolve) =>
				server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
			),
		close: () => close(server),
	};
}

/**
 * A SOCKS5 no-auth listener that answers hostname CONNECTs (ATYP 3) only,
 * recording each `{ hostname, port }`, and joins each to `target(hostname,
 * port)` (a `{ host, port }` on this machine, or null to answer "host
 * unreachable"). `listen(port)` and `close()` can be called again and again:
 * Tor going away and coming back on its port.
 */
export function forwardingSocks(target) {
	const requests = [];
	const sockets = new Set();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		let step = 0;
		let pending = Buffer.alloc(0);
		const onData = (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			if (step === 0 && pending.length >= 3) {
				pending = pending.subarray(2 + pending[1]);
				socket.write(Buffer.from([5, 0]));
				step = 1;
			}
			if (step !== 1 || pending.length < 5) return;
			if (pending[1] !== 1 || pending[3] !== 3) {
				socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
				return;
			}
			const length = pending[4];
			if (pending.length < 7 + length) return;
			const hostname = pending.toString('ascii', 5, 5 + length);
			const port = pending.readUInt16BE(5 + length);
			const rest = pending.subarray(7 + length);
			step = 2;
			socket.off('data', onData);
			requests.push({ hostname, port });
			const to = target(hostname, port);
			if (!to) {
				socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
				return;
			}
			const upstream = connect(to.port, to.host, () => {
				socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
				if (rest.length) upstream.write(rest);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			sockets.add(upstream);
			upstream.on('close', () => {
				sockets.delete(upstream);
				socket.destroy();
			});
			upstream.on('error', () => socket.destroy());
			socket.on('close', () => upstream.destroy());
		};
		socket.on('data', onData);
	});
	return {
		requests,
		listen: (port = 0) =>
			new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', () => {
					server.off('error', reject);
					resolve(server.address().port);
				});
			}),
		close: () => {
			for (const socket of sockets) socket.destroy();
			return server.listening ? close(server) : Promise.resolve();
		},
	};
}

/** a port nothing listens on, for now */
export async function freePort() {
	const probe = createNetServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address();
	await close(probe);
	return port;
}
