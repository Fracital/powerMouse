// The one wisp server every wisp contender goes through: holyWisp, the same
// binary and the same settings for all of them. Stock settings plus what a
// benchmark host needs: flood protection off (its per-destination limit
// closes the 101st stream a second to one origin, which a page bursting to
// its own host reaches; the holyWisp edges run with it off too), loopback,
// private and literal-IP destinations allowed (the fixture servers), IPv4
// first, TCP_NODELAY, and the harness DNS (lib/dns.mjs) so *.bench.test
// names reach the fixtures.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startDNS } from './dns.mjs';
import { freePort, startProcess, waitForHttp } from './net.mjs';

export const HOLYWISP_SETTINGS = [
	['flood-protection', 'off'],
	['allow-loopback', 'on'],
	['allow-private', 'on'],
	['allow-direct-ip', 'on'],
	['dns-order', 'ipv4first'],
	['tcp-nodelay', 'on'],
	['serve-webclient', 'off'],
	['log-level', 'warn'],
];

export function holyWispVersion(bin) {
	try {
		return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
	} catch (error) {
		return `unknown (${error.message})`;
	}
}

/** starts the DNS server and holyWisp; returns { url, port, pid, dns, args, stop() } */
export async function startHolyWisp({ bin, logDir }) {
	const dns = await startDNS(await freePort());
	const port = await freePort();
	const args = [
		'--host',
		'127.0.0.1',
		'--port',
		String(port),
		...HOLYWISP_SETTINGS.flatMap(([key, value]) => [`--${key}`, value]),
		'--dns-server',
		`127.0.0.1:${dns.port}`,
	];
	const proc = startProcess(bin, args, {
		logFile: join(logDir, 'holywisp.log'),
	});
	await waitForHttp(`http://127.0.0.1:${port}/`, 15000).catch(async (error) => {
		await proc.stop();
		dns.stop();
		throw error;
	});
	return {
		url: `ws://127.0.0.1:${port}/`,
		port,
		pid: proc.pid,
		dns,
		args,
		async stop() {
			await proc.stop();
			dns.stop();
		},
	};
}
