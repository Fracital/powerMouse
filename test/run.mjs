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
//   RERUN=0 npm test           no second run, alone, for a suite that failed
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
	'sandbox-restrictions',
];
// how long a suite may run before it is killed: ten minutes, more for the
// suites that need it (the WPT referrer-policy matrix at WPT_CONCURRENCY=1
// takes about twelve), and SUITE_TIMEOUT=<minutes> for every suite of a run
const SUITE_TIMEOUT_MINUTES = {
	'wpt-referrer-policy': 25,
	// waits for every frame's report, up to minutes on a busy runner
	'sandbox-restrictions': 20,
	// three browsers with a profile each, every visit and 17 contexts in
	// each: about three minutes alone
	visited: 20,
	// a dozen kinds of page, each loaded natively and in both modes, one
	// battery of frames and workers after another
	'cross-origin-isolation': 30,
};
// what a suite's demo server needs beyond the defaults
const SUITE_ENV = {
	// epoxy that takes the TURN fixture's certificate authority (TURN over TLS)
	'webrtc-net': { STOMP_TEST_TRANSPORT: '1' },
	// epoxy plus the fixture hosts of test/mixed-servers.mjs
	'mixed-content': { STOMP_TEST_TRANSPORT: '1' },
	// and the default-port sites of the visited suite
	visited: { STOMP_TEST_TRANSPORT: '1' },
	// the fixture's https origin through the test transport, and a wisp that
	// refuses UDP: the demo's default HTTP/3 has to fall back
	'demo-http3': { STOMP_TEST_TRANSPORT: '1', WISP_NO_UDP: '1' },
	// and the sites under a private suffix of test/private-sites.mjs
	samesite: { STOMP_TEST_TRANSPORT: '1' },
	'sop-partitions': { STOMP_TEST_TRANSPORT: '1' },
	'site-facts': { STOMP_TEST_TRANSPORT: '1' },
	'agent-cluster': { STOMP_TEST_TRANSPORT: '1' },
	// a discord.com fixture host, so the "Sign in with token" gate matches
	'demo-token': { STOMP_TEST_TRANSPORT: '1' },
	// the host's pages cross-origin isolated (the demo server's default)
	'cross-origin-isolation': { STOMP_ISOLATION: 'on' },
	// for its page that sends COOP and COEP
	'sop-escapes': { STOMP_ISOLATION: 'on' },
};
// where the content blocker's default lists and resources live
// (src/blocker/types.ts DEFAULT_LISTS, DEFAULT_RESOURCES)
const LIST_SERVERS = [
	'easylist.to',
	'ublockorigin.github.io',
	'raw.githubusercontent.com',
];
// the content blocker is on by default, with lists on the list servers. A
// test run asks nothing of those: the demo page's controller names the
// fixture's list instead (test/pages/adblock-run.txt), so the engine runs in
// every suite that drives the demo, and the wisp server refuses the list
// servers, so a controller a suite builds itself, which says nothing of the
// blocker, runs as a host does whose lists cannot be had (the proxy without
// the blocker). A suite gets the same, for a demo server it starts itself
// (demo-http3). STOMP_ADBLOCK=0 runs the demo without the blocker
const blockerEnv = (fixturePort) => ({
	STOMP_ADBLOCK:
		process.env.STOMP_ADBLOCK ??
		JSON.stringify({
			lists: [`http://127.0.0.1:${fixturePort}/pages/adblock-run.txt`],
			resources: `http://127.0.0.1:${fixturePort}/pages/adblock-run-resources.json`,
		}),
	WISP_BLOCK_HOSTS: LIST_SERVERS.join(','),
});
// The demo server's pages are cross-origin isolated unless it is told not to
// be, and the suites run it without: once the host's page sends COOP
// same-origin, Chrome hands a frame of another origin no window for the
// popups it opens (`window.open` returns null; docs/same-origin-policy.md,
// "Cross-origin isolation"), and the suites open real popups from the
// isolated mode's frames. cross-origin-isolation and sop-escapes run the
// isolated host; STOMP_ISOLATION=on in the environment runs any suite under
// one.
const ISOLATION_DEFAULT = 'off';
const suiteTimeoutMs = (name) =>
	(Number(process.env.SUITE_TIMEOUT) || SUITE_TIMEOUT_MINUTES[name] || 10) *
	60 *
	1000;

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
	'host-api',
	'xhr',
	'transport-worker',
	'http3',
]);
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';
// suites whose checks depend on pointer timing (a flick's measured velocity)
// and misfire on a two-core runner; SKIP_TIMING=1 leaves them out
const TIMING_SUITES = new Set(['switcher-momentum']);
const SKIP_TIMING = process.env.SKIP_TIMING === '1';
// measurement suites (the adversarial corpus, the vendored web-platform-tests,
// the timings named measure-*) report every known leak, every expected WPT
// failure and numbers that depend on the machine on purpose;
// SKIP_MEASUREMENT=1 leaves them out of a gate run
const isMeasurement = (name) =>
	name.startsWith('adversarial-') ||
	name.startsWith('wpt-') ||
	name.startsWith('measure-');
const SKIP_MEASUREMENT = process.env.SKIP_MEASUREMENT === '1';

// suites for work that is in the tree but not yet landed: left out of a full
// run (and of GitHub CI, which runs a bare `npm test`) so master stays green,
// and still run when named on the command line. The inject now enforces the
// page's script-src and style-src against the page's own code (csp-scripts);
// Trusted Types enforcement (csp-trusted-types) is the next slice. The browser
// enforces none of the page's script, style or Trusted Types policy, so
// STomp's own inject is never blocked by it.
const PENDING_SUITES = new Map([
	[
		'csp-trusted-types',
		'CSP stage 2: page Trusted-Types enforcement, not yet landed',
	],
]);

const wanted = process.argv.slice(2);
const suites = readdirSync(suitesDir)
	.filter((name) => name.endsWith('.mjs'))
	.map((name) => name.slice(0, -4))
	.filter((name) => !wanted.length || wanted.includes(name))
	.filter((name) => {
		if (PENDING_SUITES.has(name) && !wanted.includes(name)) {
			console.log(`PENDING ${name} (${PENDING_SUITES.get(name)})`);
			return false;
		}
		if (SKIP_NETWORK && NETWORK_SUITES.has(name)) {
			console.log(`SKIP ${name} (needs the internet; SKIP_NETWORK=1)`);
			return false;
		}
		if (SKIP_TIMING && TIMING_SUITES.has(name)) {
			console.log(`SKIP ${name} (pointer timing; SKIP_TIMING=1)`);
			return false;
		}
		if (SKIP_MEASUREMENT && isMeasurement(name)) {
			console.log(`SKIP ${name} (measurement; SKIP_MEASUREMENT=1)`);
			return false;
		}
		return true;
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
async function startServers(name) {
	// free ports are picked before they are bound, so two runs starting at once
	// can race for the same one (EADDRINUSE); start over on a fresh pair
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await startServersOnce(name);
		} catch (error) {
			lastError = error;
			if (!/EADDRINUSE|no server at/.test(String(error))) throw error;
		}
	}
	throw lastError;
}

async function startServersOnce(name) {
	const pinned = PARALLEL === 1;
	const port = String((pinned && process.env.PORT) || (await freePort()));
	// a probe's port is free again once it closes, so the second probe can
	// hand back the first: the fixture then takes the demo server's port, the
	// server fails to bind, and the readiness check passes on the fixture
	// (which answers any path), so the suite runs against the wrong server
	let fixturePort = Number(
		(pinned && process.env.FIXTURE_PORT) || (await freePort()),
	);
	while (String(fixturePort) === port) fixturePort = await freePort();
	const fixture = await startFixture(fixturePort);
	// the epoxy transport sends a request over a pooled connection the server
	// already closed for idling (node closes them after 5 s) and the request
	// hangs (CHANGELOG known limitations). The web-platform-tests pages are a
	// measurement of cookie and header behaviour, and a page that stalls on it
	// or not depending on how long the page before it took is noise there; the
	// other suites keep node's default
	if (name.startsWith('wpt-')) fixture.keepAliveTimeout = 10 * 60 * 1000;
	const env = {
		...process.env,
		PORT: port,
		WISP_ALLOW_LOOPBACK: '1',
		...blockerEnv(fixturePort),
		STOMP_ISOLATION: process.env.STOMP_ISOLATION || ISOLATION_DEFAULT,
		...SUITE_ENV[name],
	};
	delete env.STOMP_PROXY_ORIGIN;
	delete env.STOMP_WISP_URL;
	// the demo's default (HTTP/3 on) unless the suite itself pins it
	if (!SUITE_ENV[name]?.STOMP_HTTP3) delete env.STOMP_HTTP3;
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
				...blockerEnv(fixturePort),
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
		// the first failed checks, for the note a flaky suite leaves
		const failures = [];
		const failed = (line) => {
			fail++;
			if (failures.length < 3) failures.push(line.slice(5, 205));
		};
		const timeoutMs = suiteTimeoutMs(name);
		const timer = setTimeout(() => {
			const line = `FAIL ${name}: timed out after ${timeoutMs / 1000}s`;
			emit(line);
			failed(line);
			child.kill('SIGKILL');
		}, timeoutMs);
		child.stdout.on('data', (chunk) => {
			buffer += chunk;
			const parts = buffer.split('\n');
			buffer = parts.pop();
			for (const line of parts) {
				if (line.startsWith('PASS ')) pass++;
				else if (line.startsWith('FAIL ')) failed(line);
				emit(line);
			}
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (buffer) emit(buffer);
			if (PARALLEL > 1) console.log(lines.join('\n'));
			resolve({ pass, fail, code, failures });
		});
	});
}

/** one suite with servers of its own, start to finish */
async function runOne(name) {
	const started = Date.now();
	let servers;
	try {
		servers = await startServers(name);
	} catch (error) {
		console.log(`FAIL ${name}: ${error.message}`);
		return {
			name,
			pass: 0,
			fail: 1,
			code: 2,
			failures: [`${name}: ${error.message}`.slice(0, 200)],
			seconds: 0,
		};
	}
	const result = await runSuite(name, servers);
	servers.stop();
	await sleep(300);
	return {
		name,
		...result,
		seconds: Math.round((Date.now() - started) / 1000),
	};
}

const failedRun = (result) => result.fail > 0 || result.code !== 0;

const results = [];
const queue = [...suites].sort(
	(a, b) =>
		(SLOW.includes(a) ? SLOW.indexOf(a) : SLOW.length) -
		(SLOW.includes(b) ? SLOW.indexOf(b) : SLOW.length),
);
const workers = Array.from(
	{ length: Math.min(PARALLEL, suites.length) },
	async () => {
		while (queue.length) results.push(await runOne(queue.shift()));
	},
);
await Promise.all(workers);
results.sort((a, b) => suites.indexOf(a.name) - suites.indexOf(b.name));

// A suite that failed runs once more, alone, once the others are done: beside
// other suites on a small or busy machine a check can miss its window with
// nothing wrong in the proxy. One that then passes is flaky, which is
// reported (as a warning on a GitHub runner) and does not fail the run; one
// that fails again is a failure. A flaky suite is still a bug to fix, in the
// suite or in the proxy. RERUN=0 turns the second run off
const RERUN = process.env.RERUN !== '0';
const annotate = process.env.GITHUB_ACTIONS === 'true';
// a workflow command is one line, and `::` inside it would start another
const oneLine = (text) => text.replace(/\s+/g, ' ').replaceAll('::', ': :');
if (RERUN)
	for (const first of results.filter(failedRun)) {
		console.log(`\nRERUN ${first.name}, alone`);
		const second = await runOne(first.name);
		first.rerun = failedRun(second) ? 'failed' : 'passed';
		first.seconds += second.seconds;
		if (first.rerun === 'passed' && annotate)
			console.log(
				`::warning title=Flaky suite ${oneLine(first.name)}::` +
					oneLine(
						`failed beside other suites, passed alone: ${first.failures.join(' | ')}`,
					),
			);
	}

console.log('');
console.table(
	results.map(({ name, pass, fail, code, seconds, rerun }) => ({
		suite: name,
		pass,
		fail,
		exit: code,
		seconds,
		...(RERUN ? { rerun: rerun ?? '' } : {}),
	})),
);
const flaky = results.filter((r) => r.rerun === 'passed');
const bad = results.filter((r) => failedRun(r) && r.rerun !== 'passed');
if (flaky.length)
	console.log(
		`${flaky.length} flaky suite(s), failed then passed alone: ${flaky
			.map((r) => r.name)
			.join(', ')}`,
	);
console.log(bad.length ? `${bad.length} suite(s) failed` : 'all suites passed');
process.exit(bad.length ? 1 : 0);
