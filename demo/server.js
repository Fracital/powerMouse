// Minimal host for the STomp demo:
//   /            demo page (demo/public)
//   /api/status  uptime, version and build (dist/build.json) for the page
//   /stomp/      STomp dist (service worker, inject bundles, controller)
//   /stomp/sync-relay POST: one HTTP request a proxied page makes
//                synchronously, performed here and answered whole as JSON
//                (demo/syncRelay.js). It serves only where the browser lets
//                nothing else answer during the wait (WebKit, where a
//                synchronous request skips the service worker and freezes
//                every worker of the page's process). The host does TLS for
//                these requests itself and sees them in the clear; they
//                still leave through the Wisp relay below
//   /stomp/sync-relay/held/<token> such a page's script written into a
//                frame the worker does not control: the load waits here
//                until the page posts the copy the worker made
//   /examples/   embedding examples (examples/minimal-host.html)
//   /epoxy/      epoxy transport module
//   /libcurl/    libcurl transport module
//   /fonts/      Montserrat from @fontsource
//   /config.js   deployment config for the page (see the environment below)
//   /wisp-tor/   opt-in, Tor-only SOCKS5 Wisp gateway (TCP only; no UDP)
//   /offline.html the demo and STomp in one HTML file (build/offline.html,
//                which `npm run build` writes, and this server too when it
//                is missing or another tree's), and /offline.html.sha256
//   /wisp/       wisp server the transports tunnel through (holyWisp, the
//                server the production edges run, as a child process),
//                unless STOMP_WISP_URL names an external one
//
// Environment (also read from a .env file next to package.json):
//   PORT                listen port (default 8080)
//   STOMP_WISP_URL      external wisp endpoint, e.g. wss://host/pipe/<key>/;
//                       when set, the built-in /wisp/ is not served and
//                       no holyWisp is started
//   STOMP_TOR_SOCKS5   opt-in loopback Tor SOCKS5, e.g. socks5h://127.0.0.1:9050.
//                       Separately starts a TCP-only /wisp-tor/ relay and a
//                       loopback DNS validation shim: no public DNS lookups.
//                       The relay takes connections only while Tor is ready
//                       (/api/tor says; README "Tor routing").
//   STOMP_TOR_CONTROL  optional Tor control port for readiness, 127.0.0.1:PORT
//                       or unix:/path; STOMP_TOR_CONTROL_PASSWORD or
//                       STOMP_TOR_CONTROL_COOKIE (a SAFECOOKIE file) if needed
//   STOMP_TOR_PROBE    without a control port, the host:port a SOCKS CONNECT
//                       through Tor probes (check.torproject.org:443); `off`
//   STOMP_TOR_ORIGINS  optional comma-separated page origins the Tor relay
//                       accepts WebSockets from
//   STOMP_TOR_TRUSTED_PROXIES reverse proxies (CIDRs) whose X-Forwarded-For
//                       the Tor relay's per-client limits believe
//   STOMP_TOR_WISP_URL optional operator-provided wss:// Tor Wisp URL, instead
//                       of a local relay; operator must verify its Tor egress
//   STOMP_PROXY_ORIGIN  origin that serves the proxy for isolation mode; empty
//                       or unset runs the same-origin controller (README,
//                       "Origin isolation")
//   WISP_ALLOW_LOOPBACK let the built-in wisp reach loopback/private hosts
//   WISP_NO_UDP         the built-in wisp refuses UDP streams (HTTP/3 then
//                       falls back to the transport's TCP connections)
//   WISP_BLOCK_HOSTS    hostnames the built-in wisp refuses, comma separated
//                       (a test run names the content blocker's list servers:
//                       no suite's controller reaches them)
//   HOLYWISP_LOG_LEVEL  the built-in holyWisp's log level (default error;
//                       debug shows every stream), printed on stdout
//   HOLYWISP_BIN        a holyWisp executable to run instead of the one the
//                       `holywisp` package ships for this platform
//   STOMP_HTTP3         `0` turns off HTTP/3 (the epoxy descriptor's `http3`,
//                       on by default: Chrome speaks it to the sites that
//                       offer it, and some judge a session by it,
//                       docs/http3.md); `?http3=0` on the page turns it off
//                       for one visit, `?http3` on for one
//   STOMP_OFFLINE_FILE  where /offline.html is served from and built into
//                       (default build/offline.html)
//   STOMP_ECH_DNS       the DNS-over-HTTPS endpoint epoxy asks for HTTPS
//                       records, to offer real Encrypted Client Hello where a
//                       site publishes a config, as Chrome does (default
//                       https://cloudflare-dns.com/dns-query; `off` sends only
//                       GREASE ECH; `?noech` on the page does that for a visit)
//   STOMP_WISP_WEBTRANSPORT whether epoxy carries Wisp over the relay's
//                       WebTransport session (the descriptor's
//                       `webTransport`, docs/webtransport.md "Wisp over
//                       WebTransport"). On unless `0`: the transport dials
//                       a wss: wisp URL as https: on its own host and path,
//                       else looks for /webtransport.json on the wisp URL's
//                       origin (this server forwards the built-in holyWisp's
//                       when it serves one), opens the session and the
//                       WebSocket together and rides the session when it is
//                       up about as soon, the WebSocket otherwise (UDP
//                       blocked, no session). A URL names the session instead (a relay
//                       with a public name and certificate:
//                       https://holywisp.fracit.al/...), or, ending in
//                       .json, its discovery document. `?wt=0` or `?wt` on
//                       the page decides for one visit
//   STOMP_SITE_POOL     the site pool's slots (docs/site-pool.md): more
//                       ports to answer on, a list (`8082,8083`) or a number
//                       of free ports to take (`5`; default `0` or `off`:
//                       no pool, every site on the page's own origin). A page
//                       that reaches this server directly (its own port, or
//                       a loopback name) shows every proxied site from one of
//                       them; `?nopool` leaves the pool out for a visit
//   STOMP_SITE_POOL_PUBLIC the slots' ports as the browser reaches them
//                       through a front (a list, `2053,2083`): a page served
//                       through one gets these on its own host name, and a
//                       request whose Host (or X-Forwarded-Port) names one
//                       of them is a slot's. Unset: a page that came through
//                       a front has no pool
//   STOMP_ADBLOCK       `0` turns off the built-in content blocker, which
//                       is on by default (the controller's `adblock` option,
//                       docs/adblock.md); a JSON object is that option
//                       (`{"lists":[...],"resources":"..."}`: a mirror of the
//                       lists, or the suites' fixture list, which keeps a
//                       test run off the list servers). `?noadblock` on the
//                       page turns it off for one visit, `?adblock` on, and
//                       the page's Block ads toggle is remembered
//   STOMP_DEFAULT_THEMES the Chrome Web Store themes a new profile has
//                       installed and not shown, Web Store ids separated by
//                       commas (`0` or empty: none; unset: the page's own
//                       default, Shooting Star (pink), docs/themes.md); the
//                       test suites run with `0`
//   STOMP_TEST_TRANSPORT `1` swaps epoxy for /test/mixed-transport.mjs, which
//                       reaches the suites' fixture hosts (mixed-content's,
//                       visited's, and test/private-sites.mjs's names under
//                       a private suffix; test runs only: test/run.mjs sets
//                       it for the suites that need it)
//   STOMP_REPO          the GitHub repository whose commits the home page
//                       lists (default Fracital/powerMouse, read from this
//                       checkout's own git log)
//   GITHUB_TOKEN        optional; raises GitHub's limit for the commit list's
//                       avatars from 60 to 5000 requests an hour
//   STOMP_ISOLATION     `off` serves the pages without the headers that make
//                       them cross-origin isolated (COOP same-origin and an
//                       embedder policy, below): no proxied page is isolated
//                       then, whatever it sends
//   STOMP_SYNC_RELAY    `0` turns off /stomp/sync-relay (it then answers 404),
//                       which is on by default. With it on, the host does
//                       TLS for a WebKit page's synchronous requests and sees
//                       them in the clear: in WebKit nothing in the browser
//                       can answer such a request while the page waits, so
//                       the page sends it here (over the same Wisp relay as
//                       everything else, the built-in holyWisp or
//                       STOMP_WISP_URL)
//   STOMP_DIAL_DIRECTORY the service worker scope of the dialing mode
//                       (?mode=just-call-stomp), where every dialed frame's
//                       URL is the call page: a neutral path such as
//                       `/a1b2c3d4/` (default: one minted when the server
//                       starts, and the Tor mode's another). Its call page's
//                       name is STOMP_DIAL_PAGE (default: minted too,
//                       `<8 hex>.html`). Neither names the proxy, the page or
//                       the route, so the URL the browser has for a frame
//                       says nothing
//   STOMP_DEV           development mode (`npm run dev` sets it): /__dev is a
//                       WebSocket that announces rebuilt bundles and edited
//                       files to the page, which reloads what changed; see
//                       demo/public/pm/dev.js
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { holyWisp } from 'holywisp';
// `with { type: 'json' }` requires Node 22+. That is deliberate: idiots
// running an old, unpatched Node get a SyntaxError here instead of a running
// proxy. Upgrade Node. Don't replace this with createRequire/readFileSync.
import pkg from '../package.json' with { type: 'json' };
import { keyOfOffline, offlineKey } from '../scripts/offline-key.mjs';
import { heldLoads, syncRelay } from './syncRelay.js';
import { startTorWisp } from './torWisp.js';

const require = createRequire(import.meta.url);
const { stompPath } = require('../lib/index.cjs');

// deployment settings live in an uncommitted .env next to package.json
try {
	process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
	// no .env: everything comes from the environment or the defaults below
}

const externalWisp = process.env.STOMP_WISP_URL || '';
const wispWebTransport = process.env.STOMP_WISP_WEBTRANSPORT || '1';
const webTransportOn = wispWebTransport !== '0';
const proxyOrigin = process.env.STOMP_PROXY_ORIGIN || '';
const dev = !!process.env.STOMP_DEV;
// the dialing mode's scopes and call page (STOMP_DIAL_DIRECTORY,
// STOMP_DIAL_PAGE): neutral names, minted per start as a host mints its
// asset names per build
const mint = () => randomBytes(4).toString('hex');
const DIAL = (() => {
	const given = process.env.STOMP_DIAL_DIRECTORY;
	const directory = given && /^\/[\w-]+\/$/.test(given) ? given : `/${mint()}/`;
	const page = /^[\w.-]+$/.test(process.env.STOMP_DIAL_PAGE ?? '')
		? process.env.STOMP_DIAL_PAGE
		: `${mint()}.html`;
	return { directory, torDirectory: `/${mint()}/`, page };
})();

// the transports only export their dist entry; serve its directory
const transportDir = (name) =>
	dirname(fileURLToPath(import.meta.resolve(`@mercuryworkshop/${name}`)));

// The built-in /wisp/ is holyWisp, the server behind wss://holywisp.fracit.al/,
// so a local run relays the way stomp.fracit.al does. The settings that change
// what a page sees are the edges' (abulxt roles/edge_wisp): flood protection
// off (its per-destination limit closes the 101st stream a second to one
// origin, which a page bursting to its own host reaches), messages of at
// most 256 KiB (a larger one closes the WebSocket with 1009; epoxy writes
// 64 KiB packets, wisp-message-size), a 64 MiB stream queue, literal IPs
// allowed, IPv4 first.
let wisp = null;
if (!externalWisp) {
	// loopback/private destinations are refused unless asked for (the test
	// fixtures and `npm run dev` ask)
	const local = !!process.env.WISP_ALLOW_LOOPBACK;
	wisp = new holyWisp({
		// any free port, on 127.0.0.1: route() below is the only way in, and
		// test/run.mjs runs many demo servers at once
		port: 0,
		allowDirectIP: true,
		allowLoopbackIPs: local,
		allowPrivateIPs: local,
		// UDP (HTTP/3) is relayed unless refused, as an edge with `allow-udp =
		// off` does
		allowUDP: !process.env.WISP_NO_UDP,
		...(process.env.WISP_BLOCK_HOSTS && {
			blacklist: { hostnames: process.env.WISP_BLOCK_HOSTS.split(',') },
		}),
		floodProtection: { enabled: false },
		maxMessageSize: 262149,
		streamQueueMax: 64 * 1024 * 1024,
		dnsResultOrder: 'ipv4first',
		tcpNoDelay: true,
		logLevel: process.env.HOLYWISP_LOG_LEVEL || 'error',
		// its UDP listener on the same port number, on 127.0.0.1; a wrapper
		// that does not know the option starts no listener, and the page
		// stays on the WebSocket
		...(webTransportOn && { webTransport: true }),
	});
	// The child does not outlive this process: `holywisp` stops it on exit and
	// on SIGINT/SIGTERM/SIGHUP, and it stops itself when its stdin pipe from
	// here closes (SIGKILL, a crash).
	try {
		await wisp.start(1);
	} catch (error) {
		console.error(`${error.message}
Set STOMP_WISP_URL to use an external wisp server instead.`);
		process.exit(1);
	}
}
// The Tor relay is distinct from /wisp/ and never falls back to it. A local
// instance uses its OWN DNS resolver, confined to a synthetic loopback DNS
// responder: holyWisp still resolves before SOCKS but never leaks a hostname.
const torWisp = await startTorWisp({
	socks5: process.env.STOMP_TOR_SOCKS5,
	external: process.env.STOMP_TOR_WISP_URL,
	control: process.env.STOMP_TOR_CONTROL,
	controlPassword: process.env.STOMP_TOR_CONTROL_PASSWORD,
	controlCookie: process.env.STOMP_TOR_CONTROL_COOKIE,
	probe: process.env.STOMP_TOR_PROBE,
	origins: process.env.STOMP_TOR_ORIGINS,
	trustedProxies: process.env.STOMP_TOR_TRUSTED_PROXIES,
	logLevel: process.env.HOLYWISP_LOG_LEVEL || 'error',
});
// whether /wisp-tor/ takes a new connection: the relay runs and Tor is ready
const torAccepting = () =>
	!!torWisp?.relay?.isRunning && torWisp.monitor.accepting();
// the WebSockets the local Tor relay was handed: when Tor stops being ready
// they are closed, so what is in flight on them fails at once instead of
// waiting out a connect timeout, and the transport's next connection waits
// for Tor (refused until then, never sent to /wisp/)
const torSockets = new Set();
torWisp?.monitor?.on('change', ({ state }) => {
	if (state === 'ready' || state === 'unknown') return;
	for (const socket of torSockets) socket.destroy();
	torSockets.clear();
});

// the built-in holyWisp has a WebTransport listener the page can reach only
// when the `holywisp` package and its binary know the option and it serves
// its discovery document (its self-made certificate's hashes): a binary
// that answers every path with its banner is no document; without one the
// page is not told to look for it (an external relay is always looked at)
const webTransport =
	webTransportOn &&
	(!wisp ||
		(await fetch(`http://127.0.0.1:${wisp.port}/webtransport.json`)
			.then((answer) => (answer.ok ? answer.json() : null))
			.then(
				(document) => Array.isArray(document?.hashes),
				() => false,
			)));

const started = Date.now();

const app = express();

// Cross-origin isolation. A proxied page that sends COOP same-origin and an
// embedder policy is cross-origin isolated natively (SharedArrayBuffer, the
// precise clock); its frame here can be only when this page is, which is
// what these two headers on the host's page do. STomp reads that at run time
// and serves every proxied document so that it loads in such a page, isolated
// only when its own headers isolate it natively (docs/same-origin-policy.md).
// The embedder policy is `require-corp`, the value every browser with one
// honours: WebKit (Safari, every browser on iOS) has no `credentialless`,
// and a page that sends it is not isolated there, nor is any proxied page
// in it. What the page loads from another origin (the commit list's
// avatars) sends a Cross-Origin-Resource-Policy, and the service worker
// serves the proxied documents with the same value (src/isolation.ts
// SERVED_EMBEDDER_POLICY). The proxy origin's own files say the same and let another origin
// have them: in origin-isolation mode the host's page embeds the
// controller's frame and the proxied frames from there, and a frame of an
// isolated page loads only with an embedder policy and, from another origin,
// with that resource policy.
// The site pool (docs/site-pool.md): the ports of STOMP_SITE_POOL, once they
// are bound, and those of STOMP_SITE_POOL_PUBLIC. Everything a pool port
// answers asks for an agent cluster keyed by its origin: the ports of one
// host are one site to the browser, which gives one of them a process of its
// own only when its documents ask (docs/process-model.md), the first of them
// included, and the first is the controller frame, a file of this server.
// Told by the Host header, so a front that forwards every port to one does
// not hide it.
const poolPorts = [];
const publicPoolPorts = (process.env.STOMP_SITE_POOL_PUBLIC ?? '')
	.split(',')
	.map((text) => parseInt(text))
	.filter((number) => number > 0 && number < 65536);
// the port the browser asked: the Host header's, or behind a front that
// forwards the slots' ports to this one and drops the port from Host (an
// OpenResty `proxy_set_header Host $host`), the X-Forwarded-Port it sets,
// heard only for the public slot ports
const hostPort = (req) => {
	const port = /:(\d+)$/.exec(req.headers.host ?? '')?.[1];
	const forwarded = Number(req.headers['x-forwarded-port']);
	if (publicPoolPorts.includes(forwarded)) return forwarded;
	return port ? Number(port) : null;
};
app.use((req, res, next) => {
	const port = hostPort(req);
	if (port && (poolPorts.includes(port) || publicPoolPorts.includes(port)))
		res.set('Origin-Agent-Cluster', '?1');
	next();
});
/**
 * the slots' ports for a page asked for with `req`: the bound ones when the
 * browser reaches this server directly (the page's port is this server's,
 * or its name is a loopback one, through a local front too), the public ones
 * through a front that serves them, else none (a front that forwards only
 * its own port: a slot of another port would not answer)
 */
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w-]+\.localhost)$/;
function slotPorts(req) {
	const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
	const port = hostPort(req);
	if (
		poolPorts.length &&
		(port === server.address()?.port || LOOPBACK.test(hostname))
	)
		return poolPorts;
	return publicPoolPorts;
}

if (process.env.STOMP_ISOLATION !== 'off')
	app.use((req, res, next) => {
		res.set({
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'cross-origin',
		});
		next();
	});

// what the page needs to know about this deployment; keys are only present
// when set so the page can keep its local-development defaults otherwise
const pageConfig = {
	...(externalWisp && { wisp: externalWisp }),
	...(process.env.STOMP_PROXY_ORIGIN !== undefined && { proxyOrigin }),
	// on unless turned off; a wisp server without UDP costs it nothing (the
	// transport stays on HTTP/2, docs/http3.md)
	// The UI must only offer Tor when the dedicated Tor gateway is ready.
	// An external gateway's Tor egress is the deployer's responsibility.
	...(torWisp?.external && { torWisp: torWisp.external }),
	http3: process.env.STOMP_HTTP3 !== '0',
	// the dialing mode's scopes and call page (STOMP_DIAL_DIRECTORY)
	dial: DIAL,
	echDns:
		process.env.STOMP_ECH_DNS === 'off'
			? null
			: process.env.STOMP_ECH_DNS || 'https://cloudflare-dns.com/dns-query',
	...(process.env.STOMP_TEST_TRANSPORT === '1' && { testTransport: true }),
	// the protective shields are on by default for every site (the demo seeds a
	// '*' default entry, src/controller/shields.ts DEFAULT_SHIELDS). The native-
	// parity test suites run the demo with STOMP_SHIELDS_DEFAULTS=0, so a no-
	// entry host stays shields-neutral and their proxied requests match native
	// (upgrade and third-party cookies untouched); unset in production.
	shieldsDefaults: process.env.STOMP_SHIELDS_DEFAULTS !== '0',
	// the default themes (docs/themes.md "The default theme"): unset, the
	// page's own list
	...(process.env.STOMP_DEFAULT_THEMES !== undefined && {
		defaultThemes: process.env.STOMP_DEFAULT_THEMES.split(',')
			.map((id) => id.trim())
			.filter((id) => /^[a-p]{32}$/.test(id)),
	}),
	...(process.env.STOMP_ADBLOCK === '0'
		? { adblock: false }
		: process.env.STOMP_ADBLOCK?.startsWith('{') && {
				adblock: JSON.parse(process.env.STOMP_ADBLOCK),
			}),
	// startedAt lets the dev client tell a restarted server from a dropped
	// connection: a different value on reconnect means new server code
	...(dev && { dev: true, startedAt: started }),
	...(webTransport && {
		webTransport:
			wispWebTransport === '1'
				? true
				: /\.json(?:$|[?#])/.test(wispWebTransport)
					? { discovery: wispWebTransport }
					: { url: wispWebTransport },
	}),
};
// the built-in holyWisp's discovery document, on the wisp URL's origin where
// the transport looks for it; a document that names no `url` would send the
// session to this server's port, so it names holyWisp's own
if (wisp && webTransport)
	app.get('/webtransport.json', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		res.set('Access-Control-Allow-Origin', '*');
		try {
			const answer = await fetch(
				`http://127.0.0.1:${wisp.port}/webtransport.json`,
			);
			if (!answer.ok) return res.sendStatus(answer.status);
			const body = await answer.json();
			res.json({ ...body, url: body.url || `https://127.0.0.1:${wisp.port}/` });
		} catch {
			res.sendStatus(502);
		}
	});
app.get('/config.js', (req, res) => {
	const sitePool = slotPorts(req);
	// a configured relay is advertised whatever Tor's state: the page asks
	// /api/tor and says what it is, and its loads fail until Tor is ready
	const localTor = torWisp?.relay ? { torWisp: '/wisp-tor/' } : {};
	res.set('Cache-Control', 'no-store');
	res.type('application/javascript');
	res.send(
		`window.STOMP_CONFIG = ${JSON.stringify({ ...pageConfig, ...localTor, transports: transportPaths(), ...(sitePool.length && { sitePool }) })};\n`,
	);
});

// the build being served (build.js writes dist/build.json: the version, the
// build id, the commit it was built from and that commit's date), read on
// each request, as a rebuild replaces it under a running server
function servedBuild() {
	try {
		return JSON.parse(readFileSync(join(stompPath, 'build.json'), 'utf8'));
	} catch {
		return null;
	}
}
// Tor's state for the page (README "Tor routing"): `off` without a Tor relay,
// `unknown` for an operator's external one (its Tor is not visible here),
// else the monitor's (down, bootstrapping, ready, unknown) with Tor's own
// bootstrap progress and summary when its control port is configured. No
// address, port or setting of the relay is in it. Asking may start a check,
// at most one a second however many ask.
app.get('/api/tor', (req, res) => {
	res.set('Cache-Control', 'no-store');
	if (!torWisp) return res.json({ state: 'off' });
	if (torWisp.external)
		return res.json({ state: 'unknown', via: 'external', checked: null });
	const status = torWisp.monitor.refresh();
	res.json(
		torWisp.relay.isRunning
			? status
			: { ...status, state: 'down', summary: 'Tor relay is not running' },
	);
});
app.get('/api/status', (req, res) => {
	res.json({
		uptime: (Date.now() - started) / 1000,
		version: pkg.version,
		node: process.version,
		build: servedBuild(),
	});
});
// the repository's latest commits, for the home page. This checkout's own
// git log answers: at once, never rate limited, and exactly what is deployed
// (terp deploys a git checkout); avatars come from GitHub's avatar host by
// email, which is not the API and has no limit. GitHub's API is asked only
// when there is no checkout (an installed package, or STOMP_REPO naming
// another repository): in the background, one request at a time, at most
// every ten minutes, conditionally (an unchanged list is a 304), never again
// before a refusal's reset time, and its last answer is kept on disk so a
// restart (every deploy) starts from it. An address gets 60 API requests an
// hour without GITHUB_TOKEN; reloads and many visitors at once cost none.
const DEFAULT_REPO = 'Fracital/powerMouse';
const commitsRepo = process.env.STOMP_REPO || DEFAULT_REPO;
const COMMITS = 30;
const githubToken = process.env.GITHUB_TOKEN;
const commitsFile = join(
	tmpdir(),
	`stomp-demo-commits-${commitsRepo.replace(/[^\w.-]/g, '_')}.json`,
);
// what GitHub last said: its list, an avatar per author email, its ETag
let github = {
	checkedAt: 0,
	retryAt: 0,
	etag: null,
	error: null,
	commits: [],
	avatars: {},
};
try {
	github = { ...github, ...JSON.parse(readFileSync(commitsFile, 'utf8')) };
} catch {
	// nothing kept yet
}
let githubAsking = null;
function askGitHub() {
	const now = Date.now();
	if (githubAsking || now - github.checkedAt < 600000 || now < github.retryAt)
		return githubAsking;
	githubAsking = (async () => {
		try {
			const answer = await fetch(
				`https://api.github.com/repos/${commitsRepo}/commits?per_page=${COMMITS}`,
				{
					headers: {
						'user-agent': 'stomp-demo',
						accept: 'application/vnd.github+json',
						...(github.etag && { 'if-none-match': github.etag }),
						...(githubToken && { authorization: `Bearer ${githubToken}` }),
					},
					signal: AbortSignal.timeout(8000),
				},
			);
			github.checkedAt = Date.now();
			if (answer.status === 304) github.error = null;
			else if (answer.ok) {
				const list = await answer.json();
				for (const entry of list) {
					const email = entry.commit.author?.email;
					if (email && entry.author?.avatar_url)
						github.avatars[email] = entry.author.avatar_url;
				}
				github.commits = list.map((entry) => {
					const who = entry.commit.author || entry.commit.committer || {};
					return {
						sha: entry.sha.slice(0, 7),
						url: entry.html_url,
						message: entry.commit.message.split('\n')[0],
						author: who.name || entry.author?.login || 'unknown',
						avatar: entry.author?.avatar_url || null,
						date: who.date || null,
					};
				});
				github.etag = answer.headers.get('etag');
				github.error = null;
			} else {
				// rate limited (403/429) or refused: wait for its reset time
				const reset = Number(answer.headers.get('x-ratelimit-reset')) * 1000;
				const after = Number(answer.headers.get('retry-after')) * 1000;
				github.retryAt =
					reset > Date.now() ? reset : Date.now() + (after || 600000);
				github.error = `GitHub answered ${answer.status}`;
			}
			await writeFile(commitsFile, JSON.stringify(github)).catch(() => {});
		} catch (error) {
			// unreachable: ask again in five minutes
			github.checkedAt = Date.now() - 300000;
			github.error = error.message;
		} finally {
			githubAsking = null;
		}
	})();
	return githubAsking;
}
const run = promisify(execFile);
const checkout = fileURLToPath(new URL('..', import.meta.url));
let local = { at: 0, commits: null };
async function localCommits() {
	if (commitsRepo !== DEFAULT_REPO) return null;
	if (Date.now() - local.at < 30000) return local.commits;
	let commits = null;
	try {
		const { stdout } = await run(
			'git',
			[
				'-C',
				checkout,
				'log',
				`-${COMMITS}`,
				'--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
			],
			{ timeout: 5000 },
		);
		commits = stdout
			.split('\x1e')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [sha, author, email, date, message] = line.split('\x1f');
				return { sha, author, email, date, message };
			});
	} catch {
		// no git, or not a checkout
	}
	local = { at: Date.now(), commits };
	return commits;
}
// an author's avatar: GitHub's for that email (the page adds `&s=` for size)
function avatarOf(email) {
	if (github.avatars[email]) return github.avatars[email];
	const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
	if (noreply)
		return `https://avatars.githubusercontent.com/u/${noreply[1]}?v=4`;
	return email
		? `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}`
		: null;
}
app.get('/api/commits', async (req, res) => {
	const ours = await localCommits();
	let commits;
	if (ours?.length)
		commits = ours.map((commit) => ({
			sha: commit.sha.slice(0, 7),
			url: `https://github.com/${commitsRepo}/commit/${commit.sha}`,
			message: commit.message,
			author: commit.author,
			avatar: avatarOf(commit.email),
			date: commit.date,
		}));
	else {
		const asking = askGitHub();
		if (!github.commits.length) await asking;
		if (!github.commits.length)
			return res
				.status(502)
				.json({ error: github.error || 'no answer from GitHub yet' });
		commits = github.commits;
	}
	res.set('Cache-Control', 'public, max-age=60');
	res.json({
		repo: commitsRepo,
		url: `https://github.com/${commitsRepo}`,
		commits,
	});
});
// The page, its scripts and the STomp bundles change with every deploy and
// are fetched once per visit anyway: no-cache makes browsers revalidate and
// keeps CDNs (Cloudflare caches .js by default) from serving a stale service
// worker or shell against a new build. The transports are too: their URLs
// never change, so a day of max-age kept the previous epoxy (TLS, HTTP/2,
// HTTP/3) in browsers and Cloudflare for a day after a pin bump. Fonts never
// change and may be cached.
// A file asked for by the hash of its bytes is the exception: that URL
// names one file, and is kept for good (KEPT) when the hash is the file's
// own. A page of the build before a deploy asks by the old hash and must
// not be told to keep the new file under it: it gets the file no-cache, as
// it would by its plain name. The watch build has no hash (its files change
// under one name): nothing is kept.
const fresh = {
	setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
};
const cached = { maxAge: '1d', immutable: false };
const KEPT = 'public, max-age=31536000, immutable';
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
// (`?<hash>`, or a first parameter of its own: `controllerFrame.html?<hash>&script=`)
const askedByHash = (res, path) => {
	const asked = /\?([0-9a-f]{16})(?:&|$)/.exec(res.req.originalUrl);
	return !dev && !!asked && asked[1] === hashOf(path);
};
// The page names the scripts, the stylesheet and the images it loads from
// /stomp/ and /pm/ by the hash of each file (`/stomp/Controller.js?<hash>`),
// so a reload revalidates the page and none of them. The page itself stays
// no-cache: it is what says which hashes are current, and a kept copy would
// go on naming the last build's files after a deploy. (/config.js is
// no-store: it is made for each request.)
function stampedPage() {
	return readFileSync(join(publicDir, 'index.html'), 'utf8').replace(
		/\b(src|href)="\/(stomp|pm)\/([\w./-]+)"/g,
		(whole, attribute, root, file) => {
			const hash = hashOf(
				root === 'stomp' ? join(stompPath, file) : join(publicDir, 'pm', file),
			);
			return hash ? `${attribute}="/${root}/${file}?${hash}"` : whole;
		},
	);
}
if (!dev)
	app.get(['/', '/index.html'], (req, res) => {
		res.set('Cache-Control', 'no-cache');
		res.type('html');
		// (an ETag of the stamped text: an unchanged page is a 304)
		res.send(stampedPage());
	});
// offline.html (scripts/build-offline.mjs): the demo and STomp in one HTML
// file, which the home page's Download saves with the page's wisp server
// written in, and which a host that vendors the page fetches from here
// (STOMP_ASSETS.offline, from any origin: CORS, the ETag readable). `npm run
// build` writes it, and this server makes it itself, in the background, when
// the file is missing or names another tree's key (scripts/offline-key.mjs),
// so a deploy that copies only dist/ serves the current one. Until it is
// there the routes answer 503 with Retry-After; a failed build is tried
// again a minute on. Served with an ETag of its SHA-256 and revalidated each
// time, as a deploy changes it under the same name.
const offlineFile = process.env.STOMP_OFFLINE_FILE
	? resolve(process.env.STOMP_OFFLINE_FILE)
	: join(checkout, 'build/offline.html');
const offline = { kept: null, building: null, failedAt: 0, failure: '' };
const OFFLINE_RETRY_MS = 60_000;

/** build offline.html into offlineFile, unless a build runs or just failed */
function buildOffline() {
	if (offline.building || Date.now() - offline.failedAt < OFFLINE_RETRY_MS)
		return;
	console.log(`offline.html: building ${offlineFile}`);
	offline.building = new Promise((done) =>
		execFile(
			process.execPath,
			[join(checkout, 'scripts/build-offline.mjs'), '--out', offlineFile],
			{ cwd: checkout, maxBuffer: 1 << 20 },
			(error, stdout, stderr) => {
				offline.building = null;
				if (error) {
					offline.failedAt = Date.now();
					offline.failure = String(stderr || error.message)
						.trim()
						.split('\n')
						.slice(-3)
						.join(' ');
					console.error(`offline.html: the build failed: ${offline.failure}`);
				} else {
					offline.failedAt = 0;
					console.log(stdout.trim());
				}
				done();
			},
		),
	);
}

/** the file as it is now, when it is this checkout's; else null, and a build starts */
async function offlineHtml() {
	const info = await stat(offlineFile).catch(() => null);
	if (
		info &&
		offline.kept?.mtimeMs === info.mtimeMs &&
		offline.kept.size === info.size
	)
		return offline.kept;
	if (info) {
		const bytes = await readFile(offlineFile);
		const named = keyOfOffline(bytes.subarray(0, 2048).toString('utf8'));
		if (named && named === offlineKey(checkout)) {
			offline.kept = {
				mtimeMs: info.mtimeMs,
				size: info.size,
				bytes,
				sha256: createHash('sha256').update(bytes).digest('hex'),
			};
			return offline.kept;
		}
	}
	buildOffline();
	return null;
}
offlineHtml().catch((error) =>
	console.error('offline.html: not read:', error.message),
);
const offlineRoute = (answer) => async (req, res) => {
	res.set({
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'ETag',
	});
	const kept = await offlineHtml().catch(() => null);
	if (!kept) {
		res.status(503).type('text/plain');
		res.set({
			'Cache-Control': 'no-store',
			'Retry-After': offline.failedAt ? '60' : '5',
		});
		res.send(
			offline.failedAt
				? `offline.html could not be built here (${offline.failure}); it is tried again in a minute\n`
				: 'offline.html is being built; ask again in a few seconds\n',
		);
		return;
	}
	res.set({ 'Cache-Control': 'no-cache', ETag: `"${kept.sha256}"` });
	answer(res, kept);
};
app.get(
	'/offline.html',
	offlineRoute((res, kept) => {
		res.type('html');
		res.attachment('offline.html');
		res.send(kept.bytes);
	}),
);
app.get(
	'/offline.html.sha256',
	offlineRoute((res, kept) => {
		res.type('text/plain');
		res.send(`${kept.sha256}  offline.html\n`);
	}),
);
app.use(
	express.static(publicDir, {
		setHeaders: (res, path) =>
			res.set('Cache-Control', askedByHash(res, path) ? KEPT : 'no-cache'),
	}),
);
// Some STomp files are asked for by their hash. One is the rewriter
// library, which no inject bundle carries. A proxied page whose rewrite needs it and has no
// copy (a worker, a sandboxed frame, any page of `rewriter: 'wasm'` whose
// module declined a script) loads it with a synchronous request, and a
// revalidation there is a round trip the page's script waits for. STomp
// asks for the file as `rewriterLib.js?<hash of its bytes>`, so one URL is
// one file and browsers and CDNs may keep it for good. The other is the
// rewriter's wasm core module, asked for the same way
// (`core.wasm?<hash of its bytes>`): a proxied top whose first task
// rewrites before the controller's compiled module reaches it fetches the
// module with a synchronous request too. The document bundles are asked
// for so as well (`injectDocument.js?<hash of its bytes>`), a parser-blocking
// script of every proxied document's shell; the service worker keeps them
// itself, and this spares its fetch of one a revalidation. The controller
// asks for the workers it starts and the blocker's module so
// (`transportWorker.js?<hash>`, src/version.ts TRANSPORT_WORKER): a reload
// of the page starts its transport without a revalidation of the worker
// first; isolation mode's frame and the site pool's are asked for so too
// (`controllerFrame.html?<hash>&script=controllerFrame.js%3F<hash>`). And
// the page names its own scripts so (stampedPage above).
// The blocker's engine snapshot (`adblock-snapshot.dat.gz?<hash of its
// bytes>`), which a first visit's worker loads, is kept so too, and is
// answered as the bytes it is (the worker decompresses it), never as a
// gzip encoding.
const keptFiles = [
	'rewriterLib.js',
	'core.wasm',
	'injectDocument.js',
	'injectDocumentFull.js',
	'transportWorker.js',
	'rewriteWorker.js',
	'blocker.wasm',
	'Controller.js',
	'SearchBuilder.js',
	'omnibox.js',
	'controllerFrame.html',
	'controllerFrame.js',
	'siteFrame.js',
	'adblock-snapshot.dat.gz',
];
const fileHashes = new Map();
function hashOf(path) {
	try {
		const { mtimeMs } = statSync(path);
		let known = fileHashes.get(path);
		if (known?.mtimeMs !== mtimeMs) {
			known = {
				mtimeMs,
				hash: createHash('sha256')
					.update(readFileSync(path))
					.digest('hex')
					.slice(0, 16),
			};
			fileHashes.set(path, known);
		}
		return known.hash;
	} catch (error) {
		return '';
	}
}
const stompFiles = {
	setHeaders: (res, path) => {
		if (path.endsWith('.dat.gz'))
			res.set('Content-Type', 'application/octet-stream');
		res.set(
			'Cache-Control',
			keptFiles.includes(basename(path)) && askedByHash(res, path)
				? KEPT
				: 'no-cache',
		);
	},
};
// The same dist must be served at BOTH service-worker scopes. Tor's separate
// scope keeps an old ordinary controller from handling a Tor navigation.
const STOMP_SCOPES = [
	'/stomp/',
	'/stomp-tor/',
	DIAL.directory,
	DIAL.torDirectory,
];
// The sync relay (demo/syncRelay.js): a WebKit page's synchronous request,
// which nothing in the page's browser can answer while the page waits, done
// here over the same Wisp relay the transports use
if (process.env.STOMP_SYNC_RELAY !== '0') {
	app.post(
		['/stomp/sync-relay', `${DIAL.directory}sync-relay`],
		...syncRelay(() => externalWisp || `ws://127.0.0.1:${wisp.port}/wisp/`),
	);
	// and the loads of the scripts such a page writes into a frame the
	// worker does not control, held until their copies come
	app.all(
		[
			'/stomp/sync-relay/held/:token',
			`${DIAL.directory}sync-relay/held/:token`,
		],
		...heldLoads(),
	);
	// Never serve Tor-scoped synchronous requests through the ordinary Wisp
	// connection, even when Tor went down between a page load and this call.
	// The two wispClient() closures have independent connections and pools.
	app.post(
		['/stomp-tor/sync-relay', `${DIAL.torDirectory}sync-relay`],
		(_req, res, next) => {
			if (torWisp?.external || torAccepting()) return next();
			res.set('Cache-Control', 'no-store');
			res.status(503).json({ error: 'Tor Wisp is unavailable' });
		},
		...syncRelay(
			() =>
				torWisp?.external ||
				(torAccepting()
					? `ws://127.0.0.1:${torWisp.relay.port}/wisp/`
					: 'ws://127.0.0.1:1/unavailable-tor-relay'),
		),
	);
	// Pure host-side held script bytes have no upstream connection; keep
	// their tokens separate from the ordinary scope's held script tokens.
	app.all(
		[
			'/stomp-tor/sync-relay/held/:token',
			`${DIAL.torDirectory}sync-relay/held/:token`,
		],
		...heldLoads(),
	);
}
app.use(STOMP_SCOPES, express.static(stompPath, stompFiles));
// A routed script request that reaches this host instead of the service
// worker comes from a document the worker does not control: an about:blank
// frame or popup the page built (an ad network's cookie-sync frame is the
// common one). Chrome hands such a document no controller, so its subresource
// loads skip the worker and fall through here, where the address names no
// file and the static handler above has already missed it. Answering a script
// route with the host's text/html error page makes Chrome refuse the script
// for its MIME type ("not executable, and strict MIME type checking is
// enabled") and log it; an empty JavaScript body lets the load fail quietly,
// as the blocked load it is. A page the worker controls never reaches here:
// the worker answers its own routes.
app.use(STOMP_SCOPES, (req, res, next) => {
	if (
		(req.method === 'GET' || req.method === 'HEAD') &&
		/^\/[^/]+\/js:[^/]+\//.test(req.path)
	) {
		res.set('Content-Type', 'text/javascript; charset=utf-8');
		res.set('Cache-Control', 'no-store');
		res.end();
		return;
	}
	next();
});
// A proxied page at the top of a tab of its own (a popup, a link opened in a
// new tab) that the user reloads with Ctrl+Shift+R: Chrome sends a forced
// reload past the service worker, so the page's address reaches this host,
// which has no file there ("Cannot GET"), where natively the page comes
// back. The answer is a page that reloads once more, plainly, which the
// worker answers when it is active. Only a forced reload's request (no-cache)
// gets it: the plain reload sends max-age=0, so a worker that does not answer
// it ends at the error page rather than in a loop.
const RELOAD_THROUGH_WORKER = `<!doctype html><meta charset="utf-8"><title></title><script>
navigator.serviceWorker?.getRegistration(location.href).then((registration) => {
	if (registration?.active) location.reload();
});
</script>`;
app.use(STOMP_SCOPES, (req, res, next) => {
	if (
		req.method === 'GET' &&
		req.headers['sec-fetch-mode'] === 'navigate' &&
		req.headers['sec-fetch-dest'] === 'document' &&
		/(^|,)\s*no-cache\s*(,|$)/.test(req.headers['cache-control'] ?? '') &&
		/^\/[^/]+\/html[^/]*\//.test(req.path)
	) {
		res.status(404);
		res.set('Content-Type', 'text/html; charset=utf-8');
		res.set('Cache-Control', 'no-store');
		res.end(RELOAD_THROUGH_WORKER);
		return;
	}
	next();
});
app.use(
	'/examples/',
	express.static(
		fileURLToPath(new URL('../examples/', import.meta.url)),
		fresh,
	),
);
// The transports are asked for under the hash of their package's files
// (`/epoxy/<hash>/index.mjs`, config.js `transports`), kept for good when it
// is the hash of the files there now. A path segment, not a query: a
// module's own URLs are relative to it (epoxy's epoxy.wasm, h3/stomp_h3.js
// and stomp-h3's wasm) and keep its directory but not its query, and the one
// hash names all of them, so a module never meets another build's wasm.
// Under another hash (a page of the build before a deploy) the files are
// served no-cache, as under the plain names, which keep working.
function filesHash(dir) {
	const hash = createHash('sha256');
	const add = (path) => {
		for (const name of readdirSync(join(dir, path)).sort()) {
			const file = path ? `${path}/${name}` : name;
			if (statSync(join(dir, file)).isDirectory()) add(file);
			else hash.update(`${file}\0${hashOf(join(dir, file))}\0`);
		}
	};
	try {
		add('');
		return hash.digest('hex').slice(0, 16);
	} catch {
		return '';
	}
}
function transportFiles(name) {
	const dir = transportDir(name);
	const plain = express.static(dir, fresh);
	const versioned = express.static(dir, {
		setHeaders: (res) =>
			res.set('Cache-Control', res.locals.keptTransport ? KEPT : 'no-cache'),
	});
	return (req, res, next) => {
		const asked = /^\/([0-9a-f]{16})(\/.*)$/.exec(req.url);
		if (!asked) return plain(req, res, next);
		const url = req.url;
		res.locals.keptTransport = !dev && asked[1] === filesHash(dir);
		req.url = asked[2];
		versioned(req, res, (error) => {
			req.url = url;
			next(error);
		});
	};
}
/** where the page loads each transport from (config.js `transports`) */
const transportPaths = () =>
	dev
		? {}
		: {
				epoxy: `/epoxy/${filesHash(transportDir('epoxy-transport'))}/`,
				libcurl: `/libcurl/${filesHash(transportDir('libcurl-transport'))}/`,
			};
app.use('/epoxy/', transportFiles('epoxy-transport'));
app.use('/libcurl/', transportFiles('libcurl-transport'));
// self-hosted font for the page (no Google Fonts round-trip)
app.use(
	'/fonts/montserrat/',
	express.static(
		dirname(require.resolve('@fontsource/montserrat/package.json')) + '/files',
		cached,
	),
);

// Development only: a WebSocket that tells the page what changed. build.js
// POSTs each finished rebuild here, and demo/public is watched for edits.
// Nothing of this exists without STOMP_DEV.
let devSockets = null;
if (dev) {
	const { WebSocketServer } = await import('ws');
	devSockets = new WebSocketServer({ noServer: true });
	const broadcast = (event) => {
		const data = JSON.stringify(event);
		for (const socket of devSockets.clients)
			if (socket.readyState === socket.OPEN) socket.send(data);
	};
	devSockets.on('connection', (socket) => {
		socket.send(JSON.stringify({ type: 'hello', startedAt: started }));
	});

	const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
	app.post('/__dev/changed', express.json(), (req, res) => {
		// only the build on this machine gets to reload the page
		if (!loopback.has(req.socket.remoteAddress)) return res.sendStatus(403);
		const { outputs = [], errors = 0, messages = [] } = req.body || {};
		broadcast({ type: 'dist', outputs, errors, messages });
		res.sendStatus(204);
	});

	// editors save in bursts (write, rename, chmod): one event per path per burst
	const pending = new Map();
	watch(
		fileURLToPath(new URL('./public/', import.meta.url)),
		{ recursive: true },
		(_eventType, filename) => {
			if (!filename) return;
			const path = '/' + filename.split(sep).join('/');
			clearTimeout(pending.get(path));
			pending.set(
				path,
				setTimeout(() => {
					pending.delete(path);
					broadcast({ type: 'static', path });
				}, 50),
			);
		},
	);
}

// The ordinary HTTP path must never act as a transport or a fallback.
app.get('/wisp-tor/', (_req, res) => {
	res.set('Cache-Control', 'no-store');
	res.sendStatus(torAccepting() ? 426 : 503);
});

const server = createServer(app);

server.on('upgrade', (req, socket, head) => {
	if (req.url?.startsWith('/wisp-tor/')) {
		if (torAccepting()) {
			torSockets.add(socket);
			socket.once('close', () => torSockets.delete(socket));
			torWisp.relay.route(req, socket, head);
		} else {
			// never use /wisp/ while Tor is not ready: a plain refusal the
			// transport reports as a failed connection, at once
			socket.end(
				'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n',
			);
		}
	} else if (wisp && req.url.startsWith('/wisp/'))
		wisp.route(req, socket, head);
	else if (devSockets && req.url === '/__dev')
		devSockets.handleUpgrade(req, socket, head, (ws) =>
			devSockets.emit('connection', ws, req),
		);
	else socket.end();
});

let port = parseInt(process.env.PORT || '');
if (isNaN(port)) port = 8080;

server.on('listening', () => {
	const address = server.address();
	console.log('Listening on:');
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	if (externalWisp) console.log(`Wisp: ${externalWisp}`);
	else
		console.log(`Wisp: holyWisp on 127.0.0.1:${wisp.port} (pid ${wisp.pid})`);
	if (torWisp?.external)
		console.log(`Tor Wisp: external ${torWisp.external} (operator-managed)`);
	else if (torWisp?.relay)
		console.log(
			`Tor Wisp: /wisp-tor/ (local SOCKS5, TCP only), Tor ${torWisp.monitor.snapshot().state}`,
		);
	if (proxyOrigin) console.log(`Proxy origin: ${proxyOrigin}`);
	if (dev) console.log('Development mode: live reload on /__dev');
});

// the site pool's ports answer as the main one does (no wisp of their own:
// the transport is the host page's); bound before it, so whoever waits for
// the main port finds them
const pool = (process.env.STOMP_SITE_POOL ?? '0').trim();
const poolWanted = /^off$/i.test(pool)
	? []
	: /^\d{1,2}$/.test(pool)
		? Array.from({ length: Number(pool) }, () => 0)
		: pool
				.split(',')
				.map((text) => parseInt(text))
				.filter((number) => number > 0);
for (const wanted of poolWanted) {
	const slot = createServer(app);
	await new Promise((resolve, reject) => {
		slot.once('error', reject);
		slot.listen({ port: wanted }, resolve);
	});
	poolPorts.push(slot.address().port);
}
if (poolPorts.length) console.log(`Site pool ports: ${poolPorts.join(', ')}`);

server.listen({ port });
