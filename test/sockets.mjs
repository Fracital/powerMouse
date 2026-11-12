// Whose socket sent a packet, for the WebRTC suites.
//
// Every browser a suite launches is a child of the suite's process, and so
// is each of its processes (the network service owns WebRTC's sockets); the
// demo server is the process listening on the proxy's port, and its wisp
// server, which sends the proxied connections' packets, is that process or
// a child of it (the demo runs holyWisp as one). Which process holds a
// socket is read from /proc (the socket's inode in /proc/net, the process
// whose file descriptors hold it, test/socket-table.mjs):
//
// - a fixture asks as each packet or connection arrives (`arrival`), while
//   the socket that sent it is open, if it still is;
// - a thread of its own samples every UDP socket every few milliseconds,
//   for one that sent and closed before the fixture's thread ran (a wisp
//   server's stream for a STUN request can live a few hundred
//   milliseconds, and the suite's thread stalls for as long under load);
//   TCP connections to the fixtures, which outlive any gap, are sampled
//   with `ss`.
//
// A packet is the holder's of its port at the time it can have been sent:
// from when the fixture's thread last ran before it (it arrived no
// earlier) to when it was read. Two holders of the port in that time (a
// port given up and taken again) make it 'ambiguous', none 'unseen': never
// a guess. Linux only: it needs /proc and `ss -p`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { PROXY, sleep } from './lib.mjs';
import { inodeOwners, table } from './socket-table.mjs';

const ss = promisify(execFile);

/** how often the UDP sampler reads the table, ms */
const PERIOD = 2;
/** how often the fixtures' thread notes that it ran, ms */
const TICK = 5;
/** what the time a packet can have been sent from is widened by: the sampler's period and a tick, ms */
const SLACK = 2 * PERIOD + TICK;
const ORDER = ['browser', 'server', 'other', 'suite'];

/**
 * Starts sampling. `arrival(port, protocol)` is called by a fixture as a
 * packet or a connection from `port` arrives, and answers what to keep of
 * it: `{ port, at, since, who }`. `senders(packets, protocol)` tells who
 * sent each of `packets` (such arrivals, or `{ port, at }`): 'browser',
 * 'server' (the demo's wisp server), 'suite' (this process), 'other',
 * 'unseen' or 'ambiguous'; `owner(port, protocol)` tells who holds a port
 * now. `stop()` ends the sampling and answers how many packets were
 * attributed to whom (as `tally` writes it).
 */
export async function watchSockets(proxy = PROXY) {
	const serverPid = Number(
		(
			await ss('ss', ['-Hltnp', `sport = :${new URL(proxy).port}`])
		).stdout.match(/pid=(\d+)/)?.[1],
	);
	if (!serverPid) throw new Error('ss does not show the demo server');
	const { found, resolve, ownerOf } = inodeOwners(serverPid, process.pid);

	// when this thread last ran: a packet read now arrived no earlier
	let ran = Date.now();
	const ticker = setInterval(() => (ran = Date.now()), TICK);

	/** UDP: `port/inode` -> { port, owner, from, to }, from the sampler */
	const udp = new Map();
	let udpUntil = 0;
	const sampler = new Worker(new URL('./socket-table.mjs', import.meta.url), {
		workerData: {
			socketSampler: true,
			serverPid,
			suitePid: process.pid,
			period: PERIOD,
		},
	});
	const stopped = new Promise((done) => {
		sampler.on('message', ({ at, spans, stopped }) => {
			for (const span of spans) udp.set(`${span.port}/${span.inode}`, span);
			udpUntil = at;
			if (stopped) done();
		});
		sampler.on('error', done);
		sampler.on('exit', done);
	});
	sampler.unref();

	/** TCP: `port` -> [{ owner, first, last }] (indexes in `taken`), from `ss` */
	const tcp = new Map();
	const taken = [];
	let sampling = true;
	const watching = (async () => {
		while (sampling) {
			const start = Date.now();
			const { stdout } = await ss('ss', ['-Htanp'], {
				maxBuffer: 1 << 26,
			}).catch(() => ({ stdout: null }));
			if (stdout !== null) {
				const index = taken.push({ start, end: Date.now() }) - 1;
				for (const line of stdout.split('\n')) {
					const local = line.trim().split(/\s+/)[3];
					if (!local) continue;
					const port = Number(local.slice(local.lastIndexOf(':') + 1));
					for (const [, pid] of line.matchAll(/pid=(\d+)/g)) {
						const owner = ownerOf(Number(pid));
						let spans = tcp.get(port);
						if (!spans) tcp.set(port, (spans = []));
						const last = spans.findLast((span) => span.owner === owner);
						if (last && last.last >= index - 1) last.last = index;
						else spans.push({ owner, first: index, last: index });
					}
				}
			}
			await sleep(50);
		}
	})();

	/** who holds the socket at local `port` this moment */
	const holder = (port, protocol) => {
		const inodes = table(protocol).get(port) ?? new Set();
		resolve(inodes, true);
		const who = [...inodes].map((inode) => found.get(inode));
		return ORDER.find((owner) => who.includes(owner)) ?? 'gone';
	};
	const arrival = (port, protocol = 'udp') => ({
		port,
		at: Date.now(),
		since: ran,
		who: holder(port, protocol),
	});

	/** each packet attributed so far, by verdict, once */
	const verdicts = new Map();
	const counted = new WeakSet();
	const senders = (packets, protocol = 'udp') =>
		packets.map((packet) => {
			const verdict = sender(packet, protocol);
			if (!counted.has(packet)) {
				counted.add(packet);
				verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
			}
			return verdict;
		});
	const sender = ({ port, at, since = at, who: told }, protocol) => {
		const who = new Set(told && told !== 'gone' ? [told] : []);
		if (protocol === 'udp') {
			for (const span of udp.values())
				if (
					span.port === port &&
					span.from <= at + SLACK &&
					span.to >= since - SLACK
				)
					who.add(span.owner);
		} else {
			const before = taken.findLastIndex((sample) => sample.end <= since);
			let after = taken.findIndex((sample) => sample.start >= at);
			if (after === -1) after = taken.length - 1;
			for (const span of tcp.get(port) ?? [])
				if (span.first <= after && span.last >= before) who.add(span.owner);
		}
		if (who.size > 1) return 'ambiguous';
		return [...who][0] ?? 'unseen';
	};

	/**
	 * Who holds `port` now: read once a sample has been taken after the
	 * question, so a socket opened a moment ago is in it
	 */
	const owner = async (port, protocol = 'udp') => {
		const at = Date.now();
		while (
			sampling &&
			(protocol === 'udp'
				? udpUntil < at
				: !taken.some((sample) => sample.start >= at))
		)
			await sleep(10);
		return sender({ port, at }, protocol);
	};
	/**
	 * The sockets a kind of process (`server`, `browser`) holds now that are
	 * connected to one of `peers` (`address:port`), by peer: a wisp
	 * server's stream is a socket connected to its remote, so this counts
	 * the streams open to each
	 */
	const connected = async (peers, owner = 'server', protocol = 'udp') => {
		const { stdout } = await ss('ss', [
			protocol === 'udp' ? '-Huanp' : '-Htanp',
		]);
		const counts = Object.fromEntries(peers.map((peer) => [peer, 0]));
		for (const line of stdout.split('\n')) {
			const peer = line.trim().split(/\s+/)[4];
			if (!(peer in counts)) continue;
			if (
				[...line.matchAll(/pid=(\d+)/g)].some(
					([, pid]) => ownerOf(Number(pid)) === owner,
				)
			)
				counts[peer]++;
		}
		return counts;
	};
	return {
		arrival,
		senders,
		owner,
		connected,
		async stop() {
			sampling = false;
			clearInterval(ticker);
			sampler.postMessage('stop');
			await Promise.all([watching, stopped]);
			return tally(
				[...verdicts].flatMap(([verdict, count]) => Array(count).fill(verdict)),
			);
		},
	};
}

/** "2 server, 1 browser" for a list of senders */
export const tally = (list) =>
	Object.entries(
		list.reduce((counts, who) => {
			counts[who] = (counts[who] ?? 0) + 1;
			return counts;
		}, {}),
	)
		.map(([who, count]) => `${count} ${who}`)
		.join(', ') || 'none';
