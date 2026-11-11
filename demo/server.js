// Minimal host for the STomp demo:
//   /            demo page (demo/public)
//   /suggestions TLD autocomplete for the address bar
//   /api/status  uptime + version for the landing page
//   /stomp/      STomp dist (service worker, inject bundles, controller)
//   /examples/   embedding examples (examples/minimal-host.html)
//   /epoxy/      epoxy transport module
//   /libcurl/    libcurl transport module
//   /fonts/      Montserrat from @fontsource
//   /config.js   deployment config for the page (see the environment below)
//   /wisp/       wisp server the transports tunnel through (holyWisp, the
//                server the production edges run, as a child process),
//                unless STOMP_WISP_URL names an external one
//
// Environment (also read from a .env file next to package.json):
//   PORT                listen port (default 8080)
//   STOMP_WISP_URL      external wisp endpoint, e.g. wss://host/pipe/<key>/;
//                       when set, the built-in /wisp/ is not served and
//                       no holyWisp is started
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
//   STOMP_ECH_DNS       the DNS-over-HTTPS endpoint epoxy asks for HTTPS
//                       records, to offer real Encrypted Client Hello where a
//                       site publishes a config, as Chrome does (default
//                       https://cloudflare-dns.com/dns-query; `off` sends only
//                       GREASE ECH; `?noech` on the page does that for a visit)
//   STOMP_REWRITER      `wasm` runs the Rust rewriters where a thread holds
//                       them (the controller's `rewriter` option); the
//                       JavaScript rewriters otherwise
//   STOMP_ADBLOCK       `0` turns off the built-in content blocker, which
//                       is on by default (the controller's `adblock` option,
//                       docs/adblock.md); a JSON object is that option
//                       (`{"lists":[...],"resources":"..."}`: a mirror of the
//                       lists, or the suites' fixture list, which keeps a
//                       test run off the list servers). `?noadblock` on the
//                       page turns it off for one visit, `?adblock` on, and
//                       the page's Block ads toggle is remembered
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
//   STOMP_DEV           development mode (`npm run dev` sets it): /__dev is a
//                       WebSocket that announces rebuilt bundles and edited
//                       files to the page, which reloads what changed; see
//                       demo/public/pm/dev.js
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { holyWisp } from 'holywisp';
// `with { type: 'json' }` requires Node 22+. That is deliberate: idiots
// running an old, unpatched Node get a SyntaxError here instead of a running
// proxy. Upgrade Node. Don't replace this with createRequire/readFileSync.
import pkg from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { stompPath } = require('../lib/index.cjs');

// deployment settings live in an uncommitted .env next to package.json
try {
	process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
	// no .env: everything comes from the environment or the defaults below
}

const externalWisp = process.env.STOMP_WISP_URL || '';
const proxyOrigin = process.env.STOMP_PROXY_ORIGIN || '';
const dev = !!process.env.STOMP_DEV;

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

const started = Date.now();

const app = express();

// Cross-origin isolation. A proxied page that sends COOP same-origin and an
// embedder policy is cross-origin isolated natively (SharedArrayBuffer, the
// precise clock); its frame here can be only when this page is, which is
// what these two headers on the host's page do. STomp reads that at run time
// and serves every proxied document so that it loads in such a page, isolated
// only when its own headers isolate it natively (docs/same-origin-policy.md).
// The embedder policy is `credentialless`: under either value a frame's
// document needs a policy of its own (the service worker's), and under this
// one what the page loads from another origin (the commit list's avatars)
// loads whether or not it sends a Cross-Origin-Resource-Policy, without
// cookies. The proxy origin's own files say the same and let another origin
// have them: in origin-isolation mode the host's page embeds the
// controller's frame and the proxied frames from there, and a frame of an
// isolated page loads only with an embedder policy and, from another origin,
// with that resource policy.
if (process.env.STOMP_ISOLATION !== 'off')
	app.use((req, res, next) => {
		res.set({
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
			'Cross-Origin-Resource-Policy': 'cross-origin',
		});
		next();
	});

// TLD autocomplete for the address bar, as Powermouse did it: the public
// suffix list is fetched once at startup, and /suggestions ranks suffixes by
// character similarity to whatever the user typed after the last dot.
const FALLBACK_TLDS = [
	'com',
	'net',
	'org',
	'io',
	'dev',
	'co',
	'me',
	'us',
	'uk',
	'ca',
	'de',
	'fr',
	'au',
	'jp',
	'ru',
	'in',
	'br',
	'it',
	'nl',
	'es',
	'edu',
	'gov',
	'info',
	'biz',
	'tv',
	'cc',
	'xyz',
	'app',
	'gg',
	'to',
	'ly',
	'fm',
	'ai',
	'sh',
	'cloud',
	'co.uk',
	'org.uk',
	'com.au',
	'co.jp',
	'com.br',
];
let tldList = FALLBACK_TLDS;

async function loadTlds() {
	try {
		const body = await (
			await fetch('https://publicsuffix.org/list/effective_tld_names.dat', {
				signal: AbortSignal.timeout(8000),
			})
		).text();
		const list = body
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith('//') && !/[*!]/.test(line));
		if (list.length) {
			tldList = list;
			console.log(`Loaded ${list.length} public suffixes`);
		}
	} catch (error) {
		console.warn(
			'Public suffix list unavailable, using the built-in TLDs:',
			error.message,
		);
	}
}
loadTlds();

const similar = (a, b) => {
	const minLength = Math.min(a.length, b.length);
	const maxLength = Math.max(a.length, b.length);
	let equivalency = 0;
	for (let i = 0; i < minLength; i++) if (a[i] === b[i]) equivalency++;
	return equivalency / maxLength;
};

// suffixes that start with what was typed come first, most common first;
// everything else is ranked by character similarity like Powermouse did
const popularity = new Map(FALLBACK_TLDS.map((tld, i) => [tld, i]));
const rank = (tld) => popularity.get(tld) ?? FALLBACK_TLDS.length;

app.get('/suggestions', (req, res) => {
	const input = String(req.query.input || '').slice(0, 256);
	if (!input) return res.status(400).json({ error: 'Invalid domain input' });
	if (input.endsWith('.')) return res.json(['com', 'net', 'org', 'io', 'dev']);
	const matched = input.match(/\.[^./?#\s]{1,16}(?:\.[^./?#\s]{1,16})?$/i);
	if (!matched) return res.json(['com', 'net', 'org', 'io', 'dev']);
	const typed = matched[0].slice(1).toLowerCase();
	const prefixed = tldList
		.filter((tld) => tld.startsWith(typed))
		.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
	const fuzzy = tldList
		.filter((tld) => !tld.startsWith(typed))
		.map((tld) => [similar(typed, tld), tld])
		.sort((a, b) => b[0] - a[0] || rank(a[1]) - rank(b[1]))
		.map(([, tld]) => tld);
	res.json([...prefixed, ...fuzzy].slice(0, 6));
});

// what the page needs to know about this deployment; keys are only present
// when set so the page can keep its local-development defaults otherwise
const pageConfig = {
	...(externalWisp && { wisp: externalWisp }),
	...(process.env.STOMP_PROXY_ORIGIN !== undefined && { proxyOrigin }),
	// on unless turned off; a wisp server without UDP costs it nothing (the
	// transport stays on HTTP/2, docs/http3.md)
	http3: process.env.STOMP_HTTP3 !== '0',
	echDns:
		process.env.STOMP_ECH_DNS === 'off'
			? null
			: process.env.STOMP_ECH_DNS || 'https://cloudflare-dns.com/dns-query',
	...(process.env.STOMP_TEST_TRANSPORT === '1' && { testTransport: true }),
	...(process.env.STOMP_REWRITER === 'wasm' && { rewriter: 'wasm' }),
	...(process.env.STOMP_ADBLOCK === '0'
		? { adblock: false }
		: process.env.STOMP_ADBLOCK?.startsWith('{') && {
				adblock: JSON.parse(process.env.STOMP_ADBLOCK),
			}),
	// startedAt lets the dev client tell a restarted server from a dropped
	// connection: a different value on reconnect means new server code
	...(dev && { dev: true, startedAt: started }),
};
app.get('/config.js', (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.type('application/javascript');
	res.send(`window.STOMP_CONFIG = ${JSON.stringify(pageConfig)};\n`);
});

app.get('/api/status', (req, res) => {
	res.json({
		uptime: (Date.now() - started) / 1000,
		version: pkg.version,
		node: process.version,
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
const fresh = {
	setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
};
const cached = { maxAge: '1d', immutable: false };
app.use(
	express.static(fileURLToPath(new URL('./public/', import.meta.url)), fresh),
);
// One STomp file is not revalidated: the rewriter library, which no inject
// bundle carries. A proxied page whose rewrite needs it and has no copy (a
// worker, a sandboxed frame, any page of `rewriter: 'wasm'` whose module
// declined a script) loads it with a synchronous request, and a
// revalidation there is a round trip the page's script waits for. STomp
// asks for the file as `rewriterLib.js?<hash of its bytes>`, so one URL is
// one file and browsers and CDNs may keep it for good. Only when the hash
// is this file's: a page of the build before a deploy asks by the old
// hash and must not be told to keep the new file under it. The watch build
// has no hash (its files change under one name): nothing is kept.
let libraryHash = { mtimeMs: -1, hash: '' };
function libraryHashOf(path) {
	try {
		const { mtimeMs } = statSync(path);
		if (mtimeMs !== libraryHash.mtimeMs)
			libraryHash = {
				mtimeMs,
				hash: createHash('sha256')
					.update(readFileSync(path))
					.digest('hex')
					.slice(0, 16),
			};
		return libraryHash.hash;
	} catch (error) {
		return '';
	}
}
const stompFiles = {
	setHeaders: (res, path) =>
		res.set(
			'Cache-Control',
			!dev &&
				basename(path) === 'rewriterLib.js' &&
				res.req.originalUrl.endsWith(`?${libraryHashOf(path)}`)
				? 'public, max-age=31536000, immutable'
				: 'no-cache',
		),
};
app.use('/stomp/', express.static(stompPath, stompFiles));
app.use(
	'/examples/',
	express.static(
		fileURLToPath(new URL('../examples/', import.meta.url)),
		fresh,
	),
);
app.use('/epoxy/', express.static(transportDir('epoxy-transport'), fresh));
app.use('/libcurl/', express.static(transportDir('libcurl-transport'), fresh));
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

const server = createServer(app);

server.on('upgrade', (req, socket, head) => {
	if (wisp && req.url.startsWith('/wisp/')) wisp.route(req, socket, head);
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
	if (proxyOrigin) console.log(`Proxy origin: ${proxyOrigin}`);
	if (dev) console.log('Development mode: live reload on /__dev');
});

server.listen({ port });
