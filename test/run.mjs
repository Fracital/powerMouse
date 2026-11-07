// Browser test runner: builds nothing, gives every suite in test/suites/ its
// own demo server and fixture site on free ports, runs the suites, prints a
// summary and exits non-zero when any check failed. Up to eight suites run at
// once, fewer on small machines (PARALLEL=n changes that; PARALLEL=1 streams
// each suite's lines as they come). Suites sharing one server starve each
// other on its wisp and fail spuriously, so parallel runs never share a
// server; and past eight at once the mouse-driven and real-site suites start
// to miss their timing windows (measured: 21 at once flakes, 8 does not).
// The slow suites are queued first, so a run takes about as long as the
// slowest one.
//
//   npm test                   all suites
//   npm test -- back escapes   only these (names without .mjs)
//   PARALLEL=1 npm test        one at a time, streaming output
//
// Needs a built dist/ (`npm run build`) and Chrome (CHROME env, default
// /usr/bin/google-chrome). PORT / FIXTURE_PORT pin the ports of a sequential
// run; otherwise free ports are used, so a run never collides with a dev
// server or another run. SHOTS=1 keeps screenshots in test/out/. Suites reach
// real sites (Wikipedia, example.com) through the demo's own wisp, so the
// machine needs network access.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { sleep, waitForServer } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suitesDir = `${root}test/suites/`;
const PARALLEL = Math.max(
	1,
	Number(process.env.PARALLEL) || Math.min(8, availableParallelism()),
);

// the real-site walks and the per-vector escape matrices take minutes
const SLOW = [
	'backwalk-single',
	'escapes-same-origin',
	'escapes-isolated',
	'backwalk-tabs',
	'back',
];
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

if (!existsSync(`${root}dist/serviceWorker.js`)) {
	console.error('dist/ is missing: run `npm run build` first');
	process.exit(2);
}

// suites that drive real sites (Wikipedia) and cannot run on a runner
// without a dependable internet path; SKIP_NETWORK=1 leaves them out
const NETWORK_SUITES = new Set([
	'back',
	'demo',
	'isolation',
	'backwalk-single',
	'backwalk-tabs',
	'backwalk-browser',
]);
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

const wanted = process.argv.slice(2);
const suites = readdirSync(suitesDir)
	.filter((name) => name.endsWith('.mjs'))
	.map((name) => name.slice(0, -4))
	.filter((name) => !wanted.length || wanted.includes(name))
	.filter((name) => {
		if (!SKIP_NETWORK || !NETWORK_SUITES.has(name)) return true;
		console.log(`SKIP ${name} (needs the internet; SKIP_NETWORK=1)`);
		return false;
	});

if (!suites.length) {
	console.error(`no suites match ${wanted.join(', ')}`);
	process.exit(2);
}

/** a port nothing listens on, so two runs (or a dev server) never collide */
function freePort() {
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

const running = new Set();
process.on('SIGINT', () => {
	for (const stop of running) stop();
	process.exit(130);
});

/**
 * A demo server and a fixture site of their own. No STOMP_PROXY_ORIGIN, so
 * localhost:PORT is the isolated host (proxy on 127.0.0.1) and 127.0.0.1:PORT
 * the same-origin controller.
 */
async function startServers() {
	// free ports are picked before they are bound, so two runs starting at once
	// can race for the same one (EADDRINUSE); start over on a fresh pair
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await startServersOnce();
		} catch (error) {
			lastError = error;
			if (!/EADDRINUSE|no server at/.test(String(error))) throw error;
		}
	}
	throw lastError;
}

async function startServersOnce() {
	const pinned = PARALLEL === 1;
	const port = String((pinned && process.env.PORT) || (await freePort()));
	const fixturePort = Number(
		(pinned && process.env.FIXTURE_PORT) || (await freePort()),
	);
	const fixture = await startFixture(fixturePort);
	const env = { ...process.env, PORT: port, WISP_ALLOW_LOOPBACK: '1' };
	delete env.STOMP_PROXY_ORIGIN;
	delete env.STOMP_WISP_URL;
	const server = spawn(process.execPath, [`${root}demo/server.js`], {
		env,
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	const stop = () => {
		running.delete(stop);
		server.kill();
		fixture.close();
	};
	running.add(stop);
	try {
		await waitForServer(`http://127.0.0.1:${port}/api/status`);
	} catch (error) {
		stop();
		throw error;
	}
	return { port, fixturePort, stop };
}

/**
 * One suite as a child process. Its lines are printed as they come when
 * suites run one at a time, and as one block when it finishes when they run
 * in parallel, so the log never interleaves two suites.
 */
function runSuite(name, { port, fixturePort }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [`${suitesDir}${name}.mjs`], {
			env: {
				...process.env,
				PORT: port,
				FIXTURE: `http://127.0.0.1:${fixturePort}/`,
			},
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		const lines = [];
		const emit = (line) => {
			if (PARALLEL === 1) console.log(line);
			else lines.push(line);
		};
		emit(`\n=== ${name} (demo server :${port}, fixture :${fixturePort})`);
		let pass = 0;
		let fail = 0;
		let buffer = '';
		const timer = setTimeout(() => {
			emit(`FAIL ${name}: timed out after ${SUITE_TIMEOUT_MS / 1000}s`);
			fail++;
			child.kill('SIGKILL');
		}, SUITE_TIMEOUT_MS);
		child.stdout.on('data', (chunk) => {
			buffer += chunk;
			const parts = buffer.split('\n');
			buffer = parts.pop();
			for (const line of parts) {
				if (line.startsWith('PASS ')) pass++;
				else if (line.startsWith('FAIL ')) fail++;
				emit(line);
			}
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (buffer) emit(buffer);
			if (PARALLEL > 1) console.log(lines.join('\n'));
			resolve({ pass, fail, code });
		});
	});
}

const results = [];
const queue = [...suites].sort(
	(a, b) =>
		(SLOW.includes(a) ? SLOW.indexOf(a) : SLOW.length) -
		(SLOW.includes(b) ? SLOW.indexOf(b) : SLOW.length),
);
const workers = Array.from(
	{ length: Math.min(PARALLEL, suites.length) },
	async () => {
		while (queue.length) {
			const name = queue.shift();
			const started = Date.now();
			let servers;
			try {
				servers = await startServers();
			} catch (error) {
				console.log(`FAIL ${name}: ${error.message}`);
				results.push({ name, pass: 0, fail: 1, code: 2, seconds: 0 });
				continue;
			}
			const result = await runSuite(name, servers);
			servers.stop();
			results.push({
				name,
				...result,
				seconds: Math.round((Date.now() - started) / 1000),
			});
			await sleep(300);
		}
	},
);
await Promise.all(workers);
results.sort((a, b) => suites.indexOf(a.name) - suites.indexOf(b.name));

console.log('');
console.table(
	results.map(({ name, pass, fail, code, seconds }) => ({
		suite: name,
		pass,
		fail,
		exit: code,
		seconds,
	})),
);
const bad = results.filter((r) => r.fail || r.code !== 0);
console.log(bad.length ? `${bad.length} suite(s) failed` : 'all suites passed');
process.exit(bad.length ? 1 : 0);
