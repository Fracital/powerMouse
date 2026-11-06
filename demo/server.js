// Minimal host for the Stomp demo:
//   /            demo page (demo/public)
//   /suggestions TLD autocomplete for the address bar
//   /api/status  uptime + version for the landing page
//   /stomp/      Stomp dist (service worker, inject bundles, controller)
//   /epoxy/      epoxy transport module
//   /libcurl/    libcurl transport module
//   /fonts/      Montserrat from @fontsource
//   /config.js   deployment config for the page (see the environment below)
//   /wisp/       wisp server the transports tunnel through, unless
//                STOMP_WISP_URL names an external one
//
// Environment (also read from a .env file next to package.json):
//   PORT                listen port (default 8080)
//   STOMP_WISP_URL      external wisp endpoint, e.g. wss://host/pipe/<key>/;
//                       when set, the built-in /wisp/ is not served
//   STOMP_PROXY_ORIGIN  origin that serves the proxy for isolation mode; empty
//                       or unset runs the same-origin controller (README,
//                       "Origin isolation")
//   WISP_ALLOW_LOOPBACK let the built-in wisp reach loopback/private hosts
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import express from 'express';
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

// the transports only export their dist entry; serve its directory
const transportDir = (name) =>
	dirname(fileURLToPath(import.meta.resolve(`@mercuryworkshop/${name}`)));

// wisp refuses loopback/private destinations by default; opt in for local testing
if (process.env.WISP_ALLOW_LOOPBACK) {
	wisp.options.allow_loopback_ips = true;
	wisp.options.allow_private_ips = true;
}

const started = Date.now();

const app = express();

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
app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url))));
app.use('/stomp/', express.static(stompPath));
app.use('/epoxy/', express.static(transportDir('epoxy-transport')));
app.use('/libcurl/', express.static(transportDir('libcurl-transport')));
// self-hosted font for the page (no Google Fonts round-trip)
app.use(
	'/fonts/montserrat/',
	express.static(
		dirname(require.resolve('@fontsource/montserrat/package.json')) + '/files',
	),
);

const server = createServer(app);

server.on('upgrade', (req, socket, head) => {
	if (!externalWisp && req.url.startsWith('/wisp/'))
		wisp.routeRequest(req, socket, head);
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
	if (proxyOrigin) console.log(`Proxy origin: ${proxyOrigin}`);
});

server.listen({ port });
