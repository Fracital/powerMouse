// The speedtest suite's app (test/pages/speedtest.html), measuring as
// wisp.baby does: the bytes of each WebSocket message counted as it
// arrives, 150 ms snapshots by performance.now(), the speed from the
// snapshots after the first (the ramp dropped); the upload sends 32 KiB
// messages while at most 4 MiB are buffered, and counts `sent -
// bufferedAmount` every 25 ms. The query names the suite's socket server
// (`ws`, a port of this page's host), the size (`mib`) and a copy of
// livestats.js on another site (`third`), which the page imports too.
import { loaded, mbps } from './livestats.js';

const report = window.__speed;
report.ran = true;
report.livestats = loaded;
const query = new URLSearchParams(location.search);
const base = `ws://${location.hostname}:${query.get('ws')}`;
const size = Number(query.get('mib')) * 1048576;
const SNAPSHOT_MS = 150;

function download() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`${base}/down?bytes=${size}`);
		socket.binaryType = 'arraybuffer';
		let bytes = 0;
		let taken = 0;
		let start = 0;
		let last = 0;
		const snapshots = [];
		let timer = 0;
		socket.onopen = () => {
			start = last = performance.now();
			timer = setInterval(() => {
				const now = performance.now();
				snapshots.push({ bytes: bytes - taken, ms: now - last });
				taken = bytes;
				last = now;
			}, SNAPSHOT_MS);
		};
		socket.onmessage = (event) => {
			bytes += event.data.byteLength;
		};
		socket.onerror = () => reject(new Error('the download socket failed'));
		socket.onclose = () => {
			clearInterval(timer);
			const end = performance.now();
			snapshots.push({ bytes: bytes - taken, ms: end - last });
			const counted = snapshots.slice(1);
			const sum = (key) => counted.reduce((n, s) => n + s[key], 0);
			resolve({
				bytes,
				ms: Math.round(end - start),
				mbps: sum('ms') > 0 ? mbps(sum('bytes'), sum('ms')) : 0,
				snapshots: snapshots.length,
				empty: snapshots.filter((s) => s.bytes === 0).length,
			});
		};
	});
}

function upload() {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`${base}/up?bytes=${size}`);
		const chunk = new Uint8Array(32768);
		let sent = 0;
		let left = 0;
		let start = 0;
		let all = 0;
		let maxBuffered = 0;
		let poll = 0;
		socket.onopen = () => {
			start = performance.now();
			const pump = () => {
				while (sent < size && socket.bufferedAmount < 4 * 1048576) {
					socket.send(chunk);
					sent += chunk.length;
				}
				maxBuffered = Math.max(maxBuffered, socket.bufferedAmount);
				if (sent < size) setTimeout(pump, 4);
			};
			pump();
			poll = setInterval(() => {
				left = Math.max(left, sent - socket.bufferedAmount);
				if (left >= size && !all) all = performance.now() - start;
			}, 25);
		};
		socket.onerror = () => reject(new Error('the upload socket failed'));
		socket.onmessage = (event) => {
			// the server had every byte
			clearInterval(poll);
			const ms = performance.now() - start;
			socket.close();
			resolve({
				pageMs: Math.round(all || ms),
				serverMs: JSON.parse(event.data).ms,
				mbps: mbps(size, all || ms),
				maxBuffered,
			});
		};
	});
}

(async () => {
	try {
		report.third = await import(query.get('third')).then(
			(module) => (module.loaded ? 'loaded' : 'empty'),
			() => 'failed',
		);
		report.down = await download();
		document.getElementById('speed').textContent = report.down.mbps.toFixed(1);
		report.up = await upload();
	} catch (error) {
		report.error = String(error);
	}
	report.done = true;
})();
