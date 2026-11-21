// A demo server and a fixture site on free ports for test/firefox/, as
// test/run.mjs starts them for a Chrome suite (its own holyWisp child, which
// exits with it; loopback allowed for the fixture; the content blocker's
// list servers refused and its list the fixture's; no default theme).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixture.mjs';
import { sleep, waitForServer } from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

/** distinct free ports, `count` of them */
async function freePorts(count) {
	const ports = [];
	while (ports.length < count) {
		const port = await freePort();
		if (!ports.includes(port)) ports.push(port);
	}
	return ports;
}

/**
 * `env` adds to the demo server's environment (or a function of its port
 * that gives what to add).
 * `{ port, fixturePort, contentPorts, host, proxy, fixture, stop }`: host is
 * http://localhost:port/ (the isolated host, proxy on 127.0.0.1), proxy
 * http://127.0.0.1:port/ (the same-origin controller)
 */
export async function startServers({ env: extra = {}, slots = 4 } = {}) {
	const [port, fixturePort, ...contentPorts] = await freePorts(2 + slots);
	const fixture = await startFixture(fixturePort);
	const env = {
		...process.env,
		PORT: String(port),
		WISP_ALLOW_LOOPBACK: '1',
		STOMP_ADBLOCK: JSON.stringify({
			lists: [`http://127.0.0.1:${fixturePort}/pages/adblock-run.txt`],
			resources: `http://127.0.0.1:${fixturePort}/pages/adblock-run-resources.json`,
		}),
		WISP_BLOCK_HOSTS: [
			'easylist.to',
			'ublockorigin.github.io',
			'raw.githubusercontent.com',
		].join(','),
		STOMP_ISOLATION: 'off',
		STOMP_SHIELDS_DEFAULTS: '0',
		STOMP_DEFAULT_THEMES: '0',
		STOMP_SITE_POOL: '0',
		STOMP_SLOT_PORTS: contentPorts.length ? contentPorts.join(',') : '0',
		...(typeof extra === 'function' ? extra(port) : extra),
	};
	const asked = typeof extra === 'function' ? extra(port) : extra;
	for (const name of [
		'STOMP_PROXY_ORIGIN',
		'STOMP_WISP_URL',
		'STOMP_TOR_SOCKS5',
		'STOMP_TOR_WISP_URL',
		'STOMP_DEV',
	])
		if (!(name in asked)) delete env[name];
	const server = spawn(process.execPath, [`${root}demo/server.js`], {
		env,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	const listening = new Promise((resolve, reject) => {
		let seen = '';
		server.stdout.on('data', (chunk) => {
			if (seen === null) return;
			seen += chunk;
			if (seen.includes('Listening on:')) {
				seen = null;
				resolve();
			}
		});
		server.once('exit', (code) =>
			reject(new Error(`the demo server exited (${code})`)),
		);
	});
	const stop = () => {
		server.kill();
		fixture.close();
	};
	process.once('exit', () => server.kill());
	try {
		await Promise.race([
			listening,
			sleep(60000).then(() => {
				throw new Error('the demo server never said it listens');
			}),
		]);
		await waitForServer(`http://127.0.0.1:${port}/api/status`);
	} catch (error) {
		stop();
		throw error;
	}
	return {
		port,
		fixturePort,
		contentPorts,
		host: `http://localhost:${port}/`,
		proxy: `http://127.0.0.1:${port}/`,
		fixture: `http://127.0.0.1:${fixturePort}/`,
		stop,
	};
}

// SIGINT and SIGTERM (a timeout) end the process through its exit
// listeners, which stop the servers and the browser it started
for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => process.exit(130));
