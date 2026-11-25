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
//   DIAL_DEFAULT=1 npm test    every suite on the demo's default (dialing),
//                              not only the demo's own (dials() below)
//   STOMP_SHARED_BROWSER=1 npm test
//                              one Chrome for the run, not one for each suite
//                              (SHARED_BROWSER below)
//
// Needs a built dist/ (`npm run build`) and Chrome (CHROME env, default
// /usr/bin/google-chrome). PORT / FIXTURE_PORT pin the ports of a sequential
// run; otherwise free ports are used, so a run never collides with a dev
// server or another run. SHOTS=1 keeps screenshots in test/out/. Suites reach
// real sites (Wikipedia, example.com) through the demo's own wisp, so the
// machine needs network access.
import { spawn } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { launchServer, sleep, waitForServer } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const suitesDir = `${root}test/suites/`;
// no default theme (docs/themes.md "The default theme") in any demo server
// of the run, the runner's or one a suite starts, as Playwright starts Chrome
// with --disable-default-apps: a fresh profile would download one from the
// Web Store; webstore-themes names its own for the page it checks it in
process.env.STOMP_DEFAULT_THEMES ??= '0';
// and no demo server of the run asks GitHub's API for the home page's
// commits (they list the checkout's git log, as their suites expect):
// demo-bookmarks points one of its own at a fake GitHub instead
process.env.STOMP_GITHUB_API ??= 'off';
// Native-parity suites must see the host's own navigator and request fields.
process.env.STOMP_LIVE_USER_AGENT ??= '0';

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
	// 78 cases loaded natively and in both modes, each until its landing
	// and its reports: about eight minutes alone
	'top-navigation': 15,
	// about six minutes alone here, one page at a time
	'wpt-indexeddb': 20,
	// a persistent profile with an extension for each of four modes
	'just-call-stomp-audit': 20,
	// some 500 pages natively and proxied, a few dozen of which wait out
	// their harness's timeout (about 11 and 15 minutes proxied, on a loaded
	// runner, besides the native run)
	'wpt-navigation-api': 45,
	'wpt-navigation-api-dial': 45,
};
// what a suite's demo server needs beyond the defaults
const SUITE_ENV = {
	'user-agent': {
		STOMP_LIVE_USER_AGENT: '1',
		STOMP_USER_AGENT:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1234.56 Safari/537.36',
	},
	// a configured user agent, as the public demo always has
	'deferred-refusals-identity': {
		STOMP_LIVE_USER_AGENT: '1',
		STOMP_USER_AGENT:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1234.56 Safari/537.36',
	},
	// epoxy that takes the TURN fixture's certificate authority (TURN over
	// TLS), and the wisp server's streams (WISP_LOG)
	'webrtc-net': { STOMP_TEST_TRANSPORT: '1', WISP_LOG: '1' },
	// the wisp server's streams: the single file reaches nothing but the
	// fixture through it
	'offline-html': { WISP_LOG: '1', STOMP_TOR_CLIENT: 'stand-in' },
	// Tor mode's transport, answered with epoxy (demo/public/test/tor-stand-in.mjs)
	'demo-tor': { STOMP_TOR_CLIENT: 'stand-in' },
	// Tor mode's own client with tor-js replaced by a stand-in the suite
	// breaks on purpose (test/offline-tor-stand-in.mjs), and a directory
	// snapshot the suite writes (TOR_BOOTSTRAP below)
	'demo-tor-fail-closed': {
		STOMP_TOR_CLIENT: 'stand-in-arti',
		TOR_BOOTSTRAP: '1',
	},
	'demo-settings-menu': { STOMP_TOR_CLIENT: 'stand-in' },
	'demo-tor-routes': { STOMP_TOR_CLIENT: 'stand-in' },
	// epoxy plus the fixture hosts of test/mixed-servers.mjs
	'mixed-content': { STOMP_TEST_TRANSPORT: '1' },
	// (strict HTTPS against plain.mixed.test, which has no https)
	'shields-sites': { STOMP_TEST_TRANSPORT: '1' },
	// and the hsts suite's names and address
	hsts: { STOMP_TEST_TRANSPORT: '1' },
	// an https page of the fixture's mixed.test, whose report-to the Reporting
	// API sends only for an https document
	'csp-reports': { STOMP_TEST_TRANSPORT: '1' },
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
	'stand-in-acting': { STOMP_TEST_TRANSPORT: '1' },
	// epoxy that takes the WebTransport fixture's certificate authority
	'webtransport-live': { STOMP_TEST_TRANSPORT: '1' },
	// a discord.com fixture host, so the "Sign in with token" gate matches
	'demo-token': { STOMP_TEST_TRANSPORT: '1' },
	// the Chrome Web Store's host with the suite's port, and its update service
	webstore: { STOMP_TEST_TRANSPORT: '1' },
	'webstore-themes': { STOMP_TEST_TRANSPORT: '1' },
	// the Web Store's update service, for a store install from the page
	'extension-manager': { STOMP_TEST_TRANSPORT: '1' },
	// and the relying party's sites (test/passkeys-rp.mjs)
	passkeys: { STOMP_TEST_TRANSPORT: '1' },
	'passkeys-extensions': { STOMP_TEST_TRANSPORT: '1' },
	'adversarial-passkeys': { STOMP_TEST_TRANSPORT: '1' },
	// the same with the pool on: a slot's worker holds its site's keys
	'site-pool-passkeys': { STOMP_TEST_TRANSPORT: '1', STOMP_SITE_POOL: '5' },
	// and a site that more than 4096 others came after, then another slot
	'site-pool-kept-sites': { STOMP_TEST_TRANSPORT: '1', STOMP_SITE_POOL: '5' },
	// the host's pages cross-origin isolated (the demo server's default)
	'cross-origin-isolation': { STOMP_ISOLATION: 'on' },
	// the same headers in Chrome and in WebKit, where WebKit is installed
	'coi-engines': { STOMP_ISOLATION: 'on' },
	// a page that isolates itself is isolated only in an isolated host
	'performance-clocks': { STOMP_ISOLATION: 'on' },
	// performance.measureUserAgentSpecificMemory() is a cross-origin
	// isolated page's only
	'measured-memory': { STOMP_ISOLATION: 'on' },
	// for its page that sends COOP and COEP
	'sop-escapes': { STOMP_ISOLATION: 'on' },
	// production's host page (its second server runs one without)
	'popup-openers': { STOMP_ISOLATION: 'on' },
	// production's host page: its proxied frames share its renderer
	'hard-reload': { STOMP_ISOLATION: 'on' },
	// a host page that sends COEP, under which a frame without CORP fails
	'remote-frame-failures': { STOMP_ISOLATION: 'on' },
	// the pool's slots (a sixth for the spare check), also in a run that
	// turns the pool off for the rest
	'site-pool': { STOMP_SITE_POOL: '6' },
	// a pool of two (a page's slot and a slot two sites' frames share) and one
	'site-pool-agent': { STOMP_SITE_POOL: '3' },
	// the third site of its fixture (c.localhost)
	'site-pool-sop': { STOMP_TEST_TRANSPORT: '1', STOMP_SITE_POOL: '5' },
	// the pool is off by default: these suites are about it
	'site-pool-fallback': { STOMP_SITE_POOL: '5' },
	'site-pool-isolation': { STOMP_SITE_POOL: '5' },
	'site-pool-sandbox': { STOMP_SITE_POOL: '5' },
	'site-pool-revisit': { STOMP_SITE_POOL: '5' },
	// two tabs of the demo on its own pool, in a run without one too
	'site-pool-tabs': { STOMP_SITE_POOL: '5' },
	// production's host page with a pool (the extensions' tabs on its slots)
	'ext-tab-status': { STOMP_ISOLATION: 'on', STOMP_SITE_POOL: '3' },
	// content scripts in the pool's slots and in dialing's content slots
	'ext-slot-content-scripts': { STOMP_SITE_POOL: '3', STOMP_SLOT_PORTS: '2' },
	// production's host page (cross-origin isolated) with its pool
	'site-pool-coep': { STOMP_ISOLATION: 'on', STOMP_SITE_POOL: '5' },
	// dialing on four content slots of its own (STOMP_SLOT_PORTS), as
	// production's four behind Cloudflare (docs/content-slots.md)
	'jcs-slots': { STOMP_SLOT_PORTS: '4' },
	// dialing's URLs on the host's origin, then again on four content slots
	'dial-urls': { STOMP_SLOT_PORTS: '4' },
	// a dialed document's frames read before they are dialed, on slots too
	'dial-frames': { STOMP_SLOT_PORTS: '4' },
	// the toolbar's dialing checks once more on content slots
	toolbar: { STOMP_SLOT_PORTS: '4' },
	// a dialed tab's history and Navigation API, on content slots too
	'nav-router': { STOMP_SLOT_PORTS: '4' },
	'navigation-api': { STOMP_SLOT_PORTS: '4' },
};
// The demo page dials (docs/dialing.md): every tab's frames are its call
// page, each document written into a fresh one. The suites written for
// frames navigated to their routes (a frame's URL, its history entries,
// what a navigation request carries) run the demo's classic tabs, which
// its server shows with STOMP_DIALING=0: every suite but those of the
// demo's own UI (demo, demo-*) and DIALING_SUITES. A suite that checks both
// ways side by side (CLASSIC_SUITES) runs on a classic server and asks for
// dialing with ?mode=just-call-stomp. DIAL_DEFAULT=1 runs every other
// suite on the page's default too: the matrix that tells which of the
// classic path's suites dialing passes.
const DIALING_SUITES = new Set(['dial-default', 'back', 'pwa', 'offline-html']);
const CLASSIC_SUITES = new Set([
	'top-url-tokens',
	'dial-urls',
	'jcs-slots',
	'toolbar',
	'nav-router',
	'navigation-api',
	'ext-tab-status',
	'just-call-stomp-audit',
	'wpt-navigation-api-dial',
	'demo-tor-routes',
]);
const DIAL_DEFAULT = process.env.DIAL_DEFAULT === '1';
/** whether `name` runs on the demo's default, which dials */
const dials = (name) =>
	!CLASSIC_SUITES.has(name) &&
	(DIAL_DEFAULT ||
		name === 'demo' ||
		name.startsWith('demo-') ||
		DIALING_SUITES.has(name));
/** what a suite's demo server, and one it starts itself, gets for it */
const dialingEnv = (name) => (dials(name) ? {} : { STOMP_DIALING: '0' });
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

// LIST=1 prints the suites the run would run (after SUITES, SHARD and the
// SKIP_* flags), one per line, and starts nothing: what CI's shards hold
const LIST = process.env.LIST === '1';

if (!LIST && !existsSync(`${root}dist/serviceWorker.js`)) {
	console.error('dist/ is missing: run `npm run build` first');
	process.exit(2);
}

// suites that drive real sites (Wikipedia, the public HTTP/3 servers) and
// cannot run on a runner without a dependable internet path; SKIP_NETWORK=1
// leaves them out. A suite whose only site out there is example.com
// (transport-worker, isolation) is no network suite: the gate's switcher
// suites load it as well. back, isolation and xhr walk the fixture's pages
// where they walked Wikipedia (backwalk-single keeps that walk)
const NETWORK_SUITES = new Set([
	'demo',
	'backwalk-single',
	'backwalk-tabs',
	'backwalk-browser',
	'host-api',
	'http3',
]);
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';
// suites whose every check depends on pointer timing and misfires on a
// two-core runner; SKIP_TIMING=1 leaves them out. A suite with a timing
// check among others reads SKIP_TIMING itself and keeps the rest
// (switcher-momentum's flick, switcher-slide's fade)
const TIMING_SUITES = new Set([]);
const SKIP_TIMING = process.env.SKIP_TIMING === '1';
// measurement suites: the timings named measure-*, whose numbers depend on
// the machine; SKIP_MEASUREMENT=1 leaves them out of a gate run. A measure-
// suite whose checks hold on any machine is a gate (GATED): measure-compute
// and measure-hooks check that every kernel computes the same checksum
// natively and proxied (their tables are only printed), measure-shared-timing
// that no entry of the inject's shows in the page's resource timing. The
// vendored web-platform-tests (wpt-*) are gates too: each compares the
// proxied verdicts with the native ones and with its expected-failure list
// (test/wpt.mjs), and a page whose verdict flips from run to run is left out
// by its suite, with the reason (test/wpt/BACKLOG.md). They were all
// measurements until 2026-11-18, and a regression of wpt-cookies-more landed
// unseen; a wpt- suite that is not deterministic yet goes in WPT_MEASUREMENT,
// with its reason. The adversarial corpus is a gate as well: each
// adversarial-* suite lists its open cases, which pass as known open
// (test/adversarial.mjs)
const GATED = new Set([
	'measure-compute',
	'measure-hooks',
	'measure-shared-timing',
]);
const WPT_MEASUREMENT = new Map([]);
const isMeasurement = (name) =>
	(name.startsWith('wpt-') && WPT_MEASUREMENT.has(name)) ||
	(name.startsWith('measure-') && !GATED.has(name));
const SKIP_MEASUREMENT = process.env.SKIP_MEASUREMENT === '1';
// SUITES=<prefix> runs only the suites named with it, SUITES=!<prefix> all
// but those; SHARD=<k>/<n> then keeps the k-th (1-based) of n shards of what
// is left. CI runs the adversarial corpus as a job of its own and the rest
// as ten shards beside it: the rest alone is about five hours of suites. The
// shards are cut by how long each suite took on CI (test/suite-seconds.json,
// each suite's median over recent runs' summary tables, which
// test/suite-seconds.mjs reads; a suite it does not name counts as its
// median), longest first, each to the shard with the least so far (ties to
// the lower shard, equal seconds by name), so every machine cuts the same
// shards and they end together: cut every n-th by name, they took 12 to 31
// minutes, and by numbers recorded before a third of the suites existed, 25
// to 33.
const GROUP = process.env.SUITES ?? '';
const SHARD = /^(\d+)\/(\d+)$/.exec(process.env.SHARD ?? '');
if (process.env.SHARD && (!SHARD || +SHARD[1] < 1 || +SHARD[1] > +SHARD[2])) {
	console.error(
		`SHARD=${process.env.SHARD}: expected <k>/<n> with 1 <= k <= n`,
	);
	process.exit(2);
}
const inGroup = (name) =>
	!GROUP ||
	(GROUP.startsWith('!')
		? !name.startsWith(GROUP.slice(1))
		: name.startsWith(GROUP));

// suites for work that is in the tree but not yet landed: left out of a full
// run (and of GitHub CI, which runs a bare `npm test`) so master stays green,
// and still run when named on the command line. The inject now enforces the
// page's script-src and style-src against the page's own code (csp-scripts);
// Trusted Types enforcement (csp-trusted-types) is the next slice. The browser
// enforces none of the page's script, style or Trusted Types policy, so
// STomp's own inject is never blocked by it.
const PENDING_SUITES = new Map([
	[
		'just-call-stomp-audit',
		'a measurement for the just-call-stomp experiment, run by name',
	],
	[
		'wpt-navigation-api-dial',
		'the Navigation API in the just-call-stomp experiment, run by name',
	],
	[
		'wpt-navigation-api',
		'the Navigation API web-platform-tests, about 30 minutes on CI by itself, run by name',
	],
]);

const wanted = process.argv.slice(2);
const suites = readdirSync(suitesDir)
	.filter((name) => name.endsWith('.mjs'))
	.map((name) => name.slice(0, -4))
	.filter((name) => !wanted.length || wanted.includes(name))
	.filter((name) => wanted.length || inGroup(name))
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

const recorded = JSON.parse(
	readFileSync(`${root}test/suite-seconds.json`, 'utf8'),
);
const recordedValues = Object.values(recorded).sort((a, b) => a - b);
const defaultSeconds = recordedValues[recordedValues.length >> 1] ?? 1;
const expectedSeconds = (name) => recorded[name] ?? defaultSeconds;

if (SHARD && !wanted.length) {
	const [, k, n] = SHARD.map(Number);
	const totals = new Array(n).fill(0);
	const shardOf = new Map();
	for (const name of [...suites].sort(
		(a, b) =>
			expectedSeconds(b) - expectedSeconds(a) || (a < b ? -1 : a > b ? 1 : 0),
	)) {
		const shard = totals.indexOf(Math.min(...totals));
		totals[shard] += expectedSeconds(name);
		shardOf.set(name, shard);
	}
	const kept = suites.filter((name) => shardOf.get(name) === k - 1);
	console.log(
		`SHARD ${k}/${n}: ${kept.length} of ${suites.length} suites, ` +
			`${totals[k - 1]} of ${totals.join(' / ')} recorded seconds`,
	);
	suites.splice(0, suites.length, ...kept);
}

if (!suites.length) {
	console.error(`no suites match ${wanted.join(', ')}`);
	process.exit(2);
}

if (LIST) {
	console.log(suites.join('\n'));
	process.exit(0);
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

// One Chrome for the run's suites instead of one for each: a suite whose
// launch() asks for no flag or option of its own (test/lib.mjs) connects to
// this browser server, and its pages are browser contexts of its own, with
// cookies, storage, service workers, the HTTP cache, HSTS, permissions and
// renderer processes of their own. Each Chrome is a browser process, a GPU,
// network, storage and utility process and their memory before the first
// page (about 90 MB PSS and ten processes), so eight suites at once ran some
// eighty processes before any page. It is off until the suites that fail
// beside others in one browser are found (CT reran 26 of them a run, against
// 6 with a Chrome each): STOMP_SHARED_BROWSER=1 turns it on. A suite that reads or changes something of the whole
// browser keeps its own (OWN_BROWSER), as does a measurement (isMeasurement),
// whose numbers are the browser's alone; a suite that failed runs again with
// its own (RERUN), so a failure that only sharing makes shows as flaky. The
// server is replaced after SHARED_BROWSER_SUITES suites, so whatever a
// browser gathers over hours of suites is not every later suite's, and when
// it dies, for the next suite; the suites still on the old one finish there.
const SHARED_BROWSER = process.env.STOMP_SHARED_BROWSER === '1';
const SHARED_BROWSER_SUITES = 40;
const OWN_BROWSER = new Set([
	// ends every SharedWorker of the browser (Target.closeTarget): every
	// other suite's carrier hosts too
	'carrier-host',
	// counts IndexedDB index reads anywhere in the browser (Tracing), and
	// one tracing session is the browser's
	'jar-kept-domains',
	// sums every renderer of the browser (SystemInfo.getProcessInfo)
	'rtc-cost',
]);
let shared = null;
function sharedServer() {
	const server = { users: 0, served: 0, dead: false, retired: false };
	server.ready = launchServer().then((browser) => {
		browser.process().once('exit', () => (server.dead = true));
		return browser;
	});
	server.ready.catch(() => (server.dead = true));
	return server;
}
function closeShared(server) {
	return server.ready.then((browser) => browser.close()).catch(() => {});
}
/** the shared browser for one run of `name`, or null for one of its own */
async function takeBrowser(name, own) {
	if (!SHARED_BROWSER || own || OWN_BROWSER.has(name) || isMeasurement(name))
		return null;
	if (!shared || shared.dead || shared.served >= SHARED_BROWSER_SUITES) {
		const old = shared;
		shared = sharedServer();
		if (old) {
			old.retired = true;
			if (!old.users) closeShared(old);
		}
	}
	const server = shared;
	server.users++;
	server.served++;
	try {
		return { server, endpoint: (await server.ready).wsEndpoint() };
	} catch (error) {
		console.log(`shared browser failed to start: ${error.message}`);
		releaseBrowser({ server });
		return null;
	}
}
function releaseBrowser(taken) {
	if (!taken) return;
	taken.server.users--;
	if (taken.server.retired && !taken.server.users) closeShared(taken.server);
}
running.add(() => shared && closeShared(shared));

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
	// the site pool's slots (docs/site-pool.md, off by default in the demo):
	// picked here, so the suite knows them (SITE_POOL_PORTS, test/lib.mjs
	// SLOT_PORTS); STOMP_SITE_POOL=5 turns the pool on for the run, a suite's
	// own setting wins
	// (and just call stomp's slots the same way: STOMP_SLOT_PORTS, CONTENT_SLOT_PORTS)
	const pickSlots = async (key, taken = []) => {
		const setting = String(
			SUITE_ENV[name]?.[key] ?? process.env[key] ?? '0',
		).trim();
		const picked = [];
		if (/^\d{1,2}$/.test(setting))
			while (picked.length < Number(setting)) {
				const slot = await freePort();
				if (
					String(slot) !== port &&
					slot !== fixturePort &&
					!picked.includes(slot) &&
					!taken.includes(slot)
				)
					picked.push(slot);
			}
		else if (!/^off$/i.test(setting))
			picked.push(
				...setting
					.split(',')
					.map(Number)
					.filter((slot) => slot > 0),
			);
		return picked;
	};
	const slotPorts = await pickSlots('STOMP_SITE_POOL');
	const contentPorts = await pickSlots('STOMP_SLOT_PORTS', slotPorts);
	const env = {
		...process.env,
		PORT: port,
		WISP_ALLOW_LOOPBACK: '1',
		...blockerEnv(fixturePort),
		STOMP_ISOLATION: process.env.STOMP_ISOLATION || ISOLATION_DEFAULT,
		// the demo seeds a '*' goodies-on shields default in production; the
		// suites run it shields-neutral so a no-entry host's proxied requests
		// match native (mixed-content and the cookie suites compare them). A
		// suite that drives the demo and wants the defaults sets it to '1'.
		STOMP_SHIELDS_DEFAULTS: process.env.STOMP_SHIELDS_DEFAULTS ?? '0',
		...dialingEnv(name),
		...SUITE_ENV[name],
		STOMP_SITE_POOL: slotPorts.length ? slotPorts.join(',') : '0',
		STOMP_SLOT_PORTS: contentPorts.length ? contentPorts.join(',') : '0',
	};
	delete env.STOMP_PROXY_ORIGIN;
	delete env.STOMP_WISP_URL;
	if (dials(name)) delete env.STOMP_DIALING;
	// the demo's default (HTTP/3 on) unless the suite itself pins it
	if (!SUITE_ENV[name]?.STOMP_HTTP3) delete env.STOMP_HTTP3;
	// WISP_LOG: every stream the demo's holyWisp opens and closes, each line
	// after the time it was told here (ms since the epoch), in a file the
	// suite is told of: a stream can open and close between any two looks
	// at the system's sockets
	let wispLog = null;
	if (env.WISP_LOG) {
		delete env.WISP_LOG;
		env.HOLYWISP_LOG_LEVEL = 'debug';
		mkdirSync(`${root}test/out`, { recursive: true });
		wispLog = `${root}test/out/wisp-${port}.log`;
		writeFileSync(wispLog, '');
	}
	// TOR_BOOTSTRAP: the server serves Tor mode's directory snapshot from a
	// directory of its own, empty at first (no snapshot), which the suite
	// is told of and writes snapshots to (scripts/tor-snapshot.mjs publish)
	let torBootstrap = null;
	if (env.TOR_BOOTSTRAP) {
		delete env.TOR_BOOTSTRAP;
		torBootstrap = `${root}test/out/tor-bootstrap-${port}`;
		rmSync(torBootstrap, { recursive: true, force: true });
		mkdirSync(torBootstrap, { recursive: true });
		env.STOMP_TOR_BOOTSTRAP = torBootstrap;
	}
	const server = spawn(process.execPath, [`${root}demo/server.js`], {
		env,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	if (wispLog) {
		let partial = '';
		server.stdout.on('data', (chunk) => {
			const at = Date.now();
			const lines = (partial + chunk).split('\n');
			partial = lines.pop();
			const streams = lines.filter((line) => line.includes(': stream '));
			if (streams.length)
				appendFileSync(
					wispLog,
					streams.map((line) => `${at} ${line}\n`).join(''),
				);
		});
	}
	// ready once this server says it listens: a port probed free can be taken
	// by another run's server (a demo's slots serve the whole app) before
	// this one binds it, and /api/status would then answer from that one
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
			reject(new Error(`EADDRINUSE? the demo server exited (${code})`)),
		);
	});
	listening.catch(() => {});
	const stop = () => {
		running.delete(stop);
		server.kill();
		fixture.close();
		if (torBootstrap) rmSync(torBootstrap, { recursive: true, force: true });
	};
	running.add(stop);
	try {
		await Promise.race([
			listening,
			sleep(60000).then(() => {
				throw new Error(`no server at ${port}: it never said it listens`);
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
		slotPorts,
		contentPorts,
		wispLog,
		torBootstrap,
		stop,
	};
}

/**
 * One suite as a child process. Its lines are printed as they come when
 * suites run one at a time, and as one block when it finishes when they run
 * in parallel, so the log never interleaves two suites.
 */
function runSuite(
	name,
	{ port, fixturePort, slotPorts, contentPorts, wispLog, torBootstrap },
	browser,
) {
	return new Promise((resolve) => {
		const env = { ...process.env };
		delete env.STOMP_BROWSER_WS;
		const child = spawn(process.execPath, [`${suitesDir}${name}.mjs`], {
			env: {
				...env,
				...(browser && { STOMP_BROWSER_WS: browser.endpoint }),
				...blockerEnv(fixturePort),
				...dialingEnv(name),
				PORT: port,
				FIXTURE: `http://127.0.0.1:${fixturePort}/`,
				SITE_POOL_PORTS: slotPorts.join(','),
				CONTENT_SLOT_PORTS: contentPorts.join(','),
				...(wispLog && { WISP_LOG: wispLog }),
				...(torBootstrap && { TOR_BOOTSTRAP_DIR: torBootstrap }),
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

/**
 * one suite with servers of its own, start to finish (`own`: and a browser
 * of its own)
 */
async function runOne(name, own = false) {
	const started = Date.now();
	let servers;
	const browser = takeBrowser(name, own);
	try {
		servers = await startServers(name);
	} catch (error) {
		releaseBrowser(await browser);
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
	const taken = await browser;
	const result = await runSuite(name, servers, taken);
	releaseBrowser(taken);
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
// the slow suites first, then the longest by the record, so no lane is left
// with a long suite started last
const queue = [...suites].sort(
	(a, b) =>
		(SLOW.includes(a) ? SLOW.indexOf(a) : SLOW.length) -
			(SLOW.includes(b) ? SLOW.indexOf(b) : SLOW.length) ||
		expectedSeconds(b) - expectedSeconds(a),
);
const workers = Array.from(
	{ length: Math.min(PARALLEL, suites.length) },
	async () => {
		while (queue.length) results.push(await runOne(queue.shift()));
	},
);
await Promise.all(workers);
// a second run has a browser of its own
if (shared) await closeShared(shared);
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
		const second = await runOne(first.name, true);
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
