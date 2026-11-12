// The leak catcher. The proxied rows' browser maps every *.bench.test name to
// this port, so a request a proxied page makes without going through the
// proxy lands here instead of on the fixture server and is counted. Plain
// HTTP is answered with an empty 204; anything else (a TLS hello, a
// WebSocket upgrade) is recorded and closed.
import { createServer } from 'node:net';

export async function startLeakCatcher(port) {
	const hits = [];
	const server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		const record = () => {
			const text = buffer.toString('latin1');
			const line = text.split('\r\n')[0];
			const host = (text.match(/\r\nhost:\s*([^\r\n]+)/i) || [])[1] || null;
			const match = line.match(/^([A-Z]+) (\S+) HTTP/);
			hits.push({
				t: Date.now(),
				method: match ? match[1] : buffer[0] === 0x16 ? 'TLS' : 'RAW',
				url: match ? match[2] : null,
				host,
				referer: (text.match(/\r\nreferer:\s*([^\r\n]+)/i) || [])[1] || null,
			});
		};
		socket.on('data', (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.includes('\r\n\r\n') || buffer[0] === 0x16) {
				record();
				socket.end(
					buffer[0] === 0x16
						? ''
						: 'HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n',
				);
				socket.removeAllListeners('data');
			}
		});
		socket.on('error', () => {});
		socket.setTimeout(5000, () => socket.destroy());
	});
	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	return {
		port,
		hits,
		since: (t) => hits.filter((hit) => hit.t >= t),
		stop: () => new Promise((resolve) => server.close(resolve)),
	};
}
