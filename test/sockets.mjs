// Whose socket sent a packet, for the WebRTC suites.
//
// Every browser a suite launches is a child of the suite's process, and so
// is each of its processes (the network service owns WebRTC's sockets); the
// demo server is the process listening on the proxy's port, and its wisp
// server, which sends the proxied connections' packets, is that process or
// a child of it (the demo runs holyWisp as one). `ss` lists each local port
// with the processes that hold it: sampled while the probes run, it tells
// which of the two sent a packet a fixture got. A browser's socket lives as
// long as its connection gathers or checks, far longer than a sample.
// Linux only: it needs `ss -p` and /proc.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { PROXY, sleep } from './lib.mjs';

const ss = promisify(execFile);

/**
 * Starts sampling. `senders(packets, protocol)` tells who sent each of
 * `packets` ([{ port, at }], the source port and when it arrived): 'browser',
 * 'server' (the demo's wisp server), 'suite' (this process), 'other' or
 * 'unseen'; `owner(port, protocol)` tells who holds a port now. `stop()`
 * ends the sampling.
 */
export async function watchSockets(proxy = PROXY) {
	const serverPid = Number(
		(
			await ss('ss', ['-Hltnp', `sport = :${new URL(proxy).port}`])
		).stdout.match(/pid=(\d+)/)?.[1],
	);
	if (!serverPid) throw new Error('ss does not show the demo server');
	const owners = new Map();
	function ownerOf(pid) {
		if (owners.has(pid)) return owners.get(pid);
		let owner = 'other';
		if (pid === serverPid) owner = 'server';
		else if (pid === process.pid) owner = 'suite';
		else
			for (let at = pid, depth = 0; at > 1 && depth < 32; depth++) {
				try {
					const stat = readFileSync(`/proc/${at}/stat`, 'utf8');
					at = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
				} catch {
					break;
				}
				if (at === serverPid) {
					owner = 'server';
					break;
				}
				if (at === process.pid) {
					owner = 'browser';
					break;
				}
			}
		owners.set(pid, owner);
		return owner;
	}
	// Each protocol is sampled on its own (listing TCP takes several times as
	// long): `samples` is when each sample started and ended, `held` the runs
	// of consecutive samples in which a kind of process held a port
	const samples = { udp: [], tcp: [] };
	/** `udp:port` or `tcp:port` -> [{ owner, first, last }] (indexes in `samples`) */
	const held = new Map();
	let sampling = true;
	async function watch(protocol, flags) {
		while (sampling) {
			const start = Date.now();
			const { stdout } = await ss('ss', [flags], {
				maxBuffer: 1 << 26,
			}).catch(() => ({ stdout: null }));
			if (stdout !== null) {
				const index = samples[protocol].push({ start, end: Date.now() }) - 1;
				for (const line of stdout.split('\n')) {
					const local = line.trim().split(/\s+/)[3];
					if (!local) continue;
					const key = `${protocol}:${local.slice(local.lastIndexOf(':') + 1)}`;
					for (const [, pid] of line.matchAll(/pid=(\d+)/g)) {
						const owner = ownerOf(Number(pid));
						let spans = held.get(key);
						if (!spans) held.set(key, (spans = []));
						const last = spans.findLast((span) => span.owner === owner);
						if (last && last.last >= index - 1) last.last = index;
						else spans.push({ owner, first: index, last: index });
					}
				}
			}
			await sleep(50);
		}
	}
	const samplers = [watch('udp', '-Huanp'), watch('tcp', '-Htanp')];
	/**
	 * The port's holder is read from the samples around the packet, from the
	 * last one that ended before it to the first one that started after it:
	 * a socket that outlives the gap between two samples is in one of them
	 * (a fixture that answers at once should wait a little so that every
	 * socket does).
	 */
	const senders = (packets, protocol = 'udp') => {
		const taken = samples[protocol];
		return packets.map(({ port, at }) => {
			const before = taken.findLastIndex((sample) => sample.end <= at);
			let after = taken.findIndex((sample) => sample.start >= at);
			if (after === -1) after = taken.length - 1;
			const who = (held.get(`${protocol}:${port}`) ?? [])
				.filter((span) => span.first <= after && span.last >= before)
				.map((span) => span.owner);
			for (const owner of ['browser', 'server', 'other', 'suite'])
				if (who.includes(owner)) return owner;
			return 'unseen';
		});
	};
	/**
	 * Who holds `port` now: read once a sample has been taken that started
	 * after the question, so a socket opened a moment ago is in it
	 */
	const owner = async (port, protocol = 'udp') => {
		const at = Date.now();
		while (sampling && !samples[protocol].some((sample) => sample.start >= at))
			await sleep(25);
		return senders([{ port, at }], protocol)[0];
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
		senders,
		owner,
		connected,
		async stop() {
			sampling = false;
			await Promise.all(samplers);
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
