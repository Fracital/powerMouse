// Process-level measurements: CPU time and memory of Chrome's processes
// (through the browser's own SystemInfo.getProcessInfo, which lists every
// process with its PID and CPU time) and of the server side (holyWisp or a
// contender's own server), from /proc.
import { readFile } from 'node:fs/promises';
import { processCPU, processIO } from './net.mjs';

export async function chromeProcesses(browserSession) {
	const { processInfo } = await browserSession.send(
		'SystemInfo.getProcessInfo',
	);
	return processInfo;
}

/** total CPU seconds of every Chrome process, as ms */
export async function chromeCPU(browserSession) {
	const list = await chromeProcesses(browserSession);
	return list.reduce((sum, p) => sum + p.cpuTime * 1000, 0);
}

async function pssKB(pid) {
	try {
		const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
		return Number(text.match(/^Pss:\s+(\d+)/m)[1]);
	} catch {
		return null;
	}
}

/** proportional set size of every Chrome process (and of renderers alone), MB */
export async function chromeMemory(browserSession) {
	const list = await chromeProcesses(browserSession);
	let total = 0;
	let renderers = 0;
	for (const p of list) {
		const kb = await pssKB(p.id);
		if (kb === null) continue;
		total += kb;
		if (p.type === 'renderer') renderers += kb;
	}
	return {
		pss_mb: total / 1024,
		renderer_pss_mb: renderers / 1024,
		processes: list.length,
	};
}

/** CPU ms and bytes read by server-side processes (holyWisp, a Node proxy) */
export async function serverCounters(pids) {
	let cpu = 0;
	let rchar = 0;
	for (const pid of pids) {
		cpu += (await processCPU(pid)) || 0;
		rchar += (await processIO(pid))?.rchar || 0;
	}
	return { cpu, rchar };
}

const sumLo = async () => {
	const read = async (name) =>
		Number(await readFile(`/sys/class/net/lo/statistics/${name}`, 'utf8'));
	return (await read('rx_bytes')) + (await read('tx_bytes'));
};

/**
 * IP bytes this host sent and received over the network, both directions,
 * IPv4 and IPv6: the kernel's IP octet counters minus the loopback
 * interface's. Unlike a NIC's own counters these leave out frames that
 * reach the interface but are not addressed to the host (a virtual
 * machine's bridge floods those, and on the bench host they ran at tens of
 * MB/s). Null where /proc does not have them.
 */
export async function hostNetworkBytes() {
	try {
		const netstat = await readFile('/proc/net/netstat', 'utf8');
		const ip = netstat.split('\n').filter((l) => l.startsWith('IpExt:'));
		const names = ip[0].split(/\s+/);
		const values = ip[1].split(/\s+/).map(Number);
		const v4 =
			values[names.indexOf('InOctets')] + values[names.indexOf('OutOctets')];
		const snmp6 = await readFile('/proc/net/snmp6', 'utf8').catch(() => '');
		const v6field = (name) =>
			Number(snmp6.match(new RegExp(`^${name}\\s+(\\d+)`, 'm'))?.[1] || 0);
		const v6 = v6field('Ip6InOctets') + v6field('Ip6OutOctets');
		return v4 + v6 - (await sumLo());
	} catch {
		return null;
	}
}
