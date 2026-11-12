// A page's own script-src and style-src (with their -elem and -attr forms)
// run, refuse and report the page's code as natively (test/csp-server.mjs,
// test/pages/csp-probes.js): inline scripts by 'unsafe-inline', by a nonce
// and by the hash of the page's own text (the proxy rewrites it), scripts
// by URL, 'strict-dynamic', eval, Function, string timers and WebAssembly
// compilation by 'unsafe-eval' and 'wasm-unsafe-eval', event handler
// attributes, inline and linked styles. The proxy's own scripts carry a
// nonce of the document's and run under every policy: the probes would not
// report otherwise. Compared with the page loaded natively, in both modes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compareCases, OTHER } from '../csp-lib.mjs';
import { done, launch } from '../lib.mjs';

const other = OTHER.replace(/\/$/, '');
const sha = (text) =>
	`'sha256-${createHash('sha256').update(text).digest('base64')}'`;
// the probes inline (test/csp-server.mjs `h=inline-hash`), and the text of
// the inline script a probe inserts
const probesHash = sha(
	`\n${readFileSync(new URL('../pages/csp-probes.js', import.meta.url), 'utf8')}\n`,
);
const insertedHash = sha('window.__ran = 1');

const SCRIPTS = [
	'script-self',
	'script-other',
	'script-data',
	'script-blob',
	'script-inline',
	'script-inline-nonce',
];
const CODE = [
	'eval',
	'function',
	'timeout-string',
	'wasm-compile',
	'wasm-module',
	'handler-attribute',
];

const CASES = {
	nonce: {
		p: "script-src 'nonce-probes'",
		h: 'nonce',
		probes: [...SCRIPTS, ...CODE],
	},
	'nonce and strict-dynamic': {
		p: "script-src 'nonce-probes' 'strict-dynamic'",
		h: 'nonce',
		probes: [...SCRIPTS, 'eval'],
	},
	'nonce and the other host': {
		p: `script-src 'nonce-probes' ${other}`,
		h: 'nonce',
		probes: ['script-self', 'script-other', 'script-inline'],
	},
	self: {
		p: "script-src 'self'",
		probes: [...SCRIPTS, ...CODE],
	},
	'unsafe-inline and unsafe-eval': {
		p: "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
		h: 'inline',
		probes: [...SCRIPTS, ...CODE],
	},
	'wasm-unsafe-eval': {
		p: "script-src 'self' 'wasm-unsafe-eval'",
		probes: ['eval', 'wasm-compile', 'wasm-module'],
	},
	hashes: {
		p: `script-src ${probesHash} ${insertedHash}`,
		h: 'inline-hash',
		probes: ['script-inline', 'script-self', 'eval'],
	},
	'report-sample': {
		p: "script-src 'self' 'report-sample'",
		probes: ['script-inline', 'eval', 'function', 'handler-attribute'],
	},
	meta: {
		m: "script-src 'nonce-probes'",
		h: 'nonce',
		probes: ['script-inline', 'script-inline-nonce', 'script-other', 'eval'],
	},
	'report-only': {
		ro: "script-src 'self'",
		probes: ['script-inline', 'script-other', 'eval'],
	},
	// Cloudflare's challenge frame's script policy
	turnstile: {
		p: "default-src 'none'; script-src 'nonce-probes' 'unsafe-eval'; script-src-attr 'none'; worker-src blob:; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'",
		h: 'nonce',
		probes: [
			'fetch-data',
			'eval',
			'function',
			'worker-blob',
			'handler-attribute',
			'script-inline',
			'style-inline',
		],
	},
	styles: {
		p: "style-src 'self'",
		probes: [
			'style-inline',
			'style-attribute',
			'style-cssom',
			'style-self',
			'style-other',
			'style-data',
		],
	},
	'nonce styles in the markup': {
		p: "style-src 'nonce-probes'",
		s: true,
		probes: ['markup-styles', 'style-inline'],
	},
	'unsafe-inline styles': {
		p: "style-src 'self' 'unsafe-inline'",
		probes: ['style-inline', 'style-attribute', 'style-other'],
	},
};

const browser = await launch();
await compareCases(browser, CASES);
await done(browser);
