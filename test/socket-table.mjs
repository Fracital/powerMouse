// Which process holds which socket, read from /proc, for test/sockets.mjs:
// the helpers, and the UDP sampler that runs in a thread of its own (the
// suite's thread stalls for tens of milliseconds at a time under load, and
// a wisp server's stream for one STUN request can open, send and close in
// less). Linux only.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** a process and its descendants, now */
function tree(root) {
	const pids = [root];
	for (let at = 0; at < pids.length; at++) {
		let tasks;
		try {
			tasks = readdirSync(`/proc/${pids[at]}/task`);
		} catch {
			continue;
		}
		for (const task of tasks)
			try {
				for (const child of readFileSync(
					`/proc/${pids[at]}/task/${task}/children`,
					'utf8',
				)
					.trim()
					.split(/\s+/))
					if (child) pids.push(Number(child));
			} catch {
				// the task ended
			}
	}
	return pids;
}

/**
 * Who a process is: 'server' (the demo server or a child of it: its wisp
 * server), 'suite' (the suite's process), 'browser' (a descendant of the
 * suite: every browser it launched) or 'other'
 */
export function owners(serverPid, suitePid) {
	const known = new Map();
	return (pid) => {
		if (known.has(pid)) return known.get(pid);
		let owner = 'other';
		if (pid === serverPid) owner = 'server';
		else if (pid === suitePid) owner = 'suite';
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
				if (at === suitePid) {
					owner = 'browser';
					break;
				}
			}
		known.set(pid, owner);
		return owner;
	};
}

/** local port -> the inodes (`socket:[n]`) of the sockets bound to it now */
export function table(protocol) {
	const ports = new Map();
	for (const name of [protocol, `${protocol}6`]) {
		let text;
		try {
			text = readFileSync(`/proc/net/${name}`, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n').slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10) continue;
			const local = fields[1];
			const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 16);
			if (!ports.has(port)) ports.set(port, new Set());
			ports.get(port).add(`socket:[${fields[9]}]`);
		}
	}
	return ports;
}

/**
 * The owner of each socket inode, found from the file descriptors of the
 * demo server's and the suite's trees (and with `everywhere`, of every
 * process, for one neither holds); a socket no process holds any more
 * (closed a moment ago) has none
 */
export function inodeOwners(serverPid, suitePid) {
	const ownerOf = owners(serverPid, suitePid);
	const found = new Map();
	const searched = new Set();
	const resolve = (inodes, everywhere = false) => {
		const missing = new Set(
			[...inodes].filter(
				(inode) => !found.has(inode) && (everywhere || !searched.has(inode)),
			),
		);
		const passes = [
			() => [...tree(serverPid), ...tree(suitePid)],
			() =>
				everywhere
					? readdirSync('/proc').filter((name) => /^\d+$/.test(name))
					: [],
		];
		for (const pids of passes) {
			if (!missing.size) break;
			for (const pid of pids()) {
				let fds;
				try {
					fds = readdirSync(`/proc/${pid}/fd`);
				} catch {
					continue;
				}
				for (const fd of fds) {
					let link;
					try {
						link = readlinkSync(`/proc/${pid}/fd/${fd}`);
					} catch {
						continue;
					}
					if (!missing.has(link)) continue;
					found.set(link, ownerOf(Number(pid)));
					missing.delete(link);
				}
				if (!missing.size) break;
			}
			for (const inode of missing) searched.add(inode);
		}
	};
	return { found, resolve, ownerOf };
}

// The UDP sampler: every couple of milliseconds, each socket bound to a
// port, by inode, with its owner and when it was first and last seen;
// what changed goes to the suite's thread every 20 ms
if (!isMainThread && workerData?.socketSampler) {
	const { serverPid, suitePid, period } = workerData;
	const { found, resolve } = inodeOwners(serverPid, suitePid);
	const spans = new Map();
	const changed = new Set();
	let running = true;
	parentPort.on('message', (message) => {
		if (message === 'stop') running = false;
	});
	let posted = Date.now();
	const tick = () => {
		if (!running) {
			parentPort.postMessage({ at: Date.now(), spans: [], stopped: true });
			parentPort.close();
			return;
		}
		const now = Date.now();
		const ports = table('udp');
		resolve(new Set([...ports.values()].flatMap((inodes) => [...inodes])));
		for (const [port, inodes] of ports)
			for (const inode of inodes) {
				const owner = found.get(inode);
				if (!owner) continue;
				const key = `${port}/${inode}`;
				const span = spans.get(key);
				if (span) span.to = now;
				else spans.set(key, { port, inode, owner, from: now, to: now });
				changed.add(key);
			}
		if (now - posted >= 20) {
			parentPort.postMessage({
				at: now,
				spans: [...changed].map((key) => spans.get(key)),
			});
			changed.clear();
			posted = now;
		}
		setTimeout(tick, period);
	};
	tick();
}
