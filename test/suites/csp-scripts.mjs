// A page's own script-src and style-src (with their -elem and -attr forms)
// run, refuse and report the page's code as natively (test/csp-server.mjs,
// test/pages/csp-probes.js): inline scripts by 'unsafe-inline', by a nonce
// and by the hash of the page's own text (the proxy rewrites it), scripts
// by URL, 'strict-dynamic', eval, Function, string timers and WebAssembly
// compilation by 'unsafe-eval' and 'wasm-unsafe-eval', event handler
// attributes, inline and linked styles, and the inline code and eval of a
// frame sandboxed to an opaque origin. The proxy's own scripts carry a
// nonce of the document's and run under every policy: the probes would not
// report otherwise. Compared with the page loaded natively, in both modes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compareCases, FIELDS, OTHER } from '../csp-lib.mjs';
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

// every way a script reaches the document (test/pages/csp-probes.js
// scriptBy), its nonce given after its src (-late) or none (-none)
const PATHS = [
	'append',
	'appendChild',
	'insertBefore',
	'replaceChild',
	'replaceWith',
	'replaceChildren',
	'before',
	'after',
	'prepend',
	'insertAdjacentElement',
	'range',
	'nested',
	'fragment',
	'innerHTML',
	'outerHTML',
	'insertAdjacentHTML',
	'write',
	'adoptNode',
	'importNode',
	'template',
	'cloneNode',
	'srcRemoved',
].flatMap((path) => [`script-path-${path}-late`, `script-path-${path}-none`]);
// those that differ from native (EXPECTED)
const COPIED = [
	'script-path-adoptNode-late',
	'script-path-importNode-late',
	'script-path-importNode-none',
	'script-path-template-late',
	'script-path-template-none',
	'script-path-cloneNode-late',
	'script-path-cloneNode-none',
];

// what a frame sandboxed to an opaque origin runs under a policy of its own
// that governs code: it judges its code with the page policy's checks, a
// deferred part it makes from its top's text at its first script
// (src/inject/dom/policyChecks.ts; deferred-refusals takes them away)
const OPAQUE = [
	'self-origin',
	'script-inline',
	'script-inline-nonce',
	'eval',
	'function',
	'timeout-string',
	'handler-attribute',
	'style-inline',
	'style-attribute',
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
	// Cloudflare's interstitial: an inline script with the nonce inserts the
	// challenge's script by a URL of its own origin, which only the nonce
	// lets through, under the same policy in a header and in a meta
	'nonce by property': {
		p: `default-src 'none'; script-src 'nonce-probes' 'unsafe-eval' ${other}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'`,
		m: `default-src 'none'; script-src 'nonce-probes' 'unsafe-eval' ${other}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'`,
		h: 'inline-nonce',
		probes: ['script-self-nonce-property', 'script-self-nonce', 'script-self'],
	},
	'nonce after the src': {
		p: `script-src 'nonce-probes' ${other}`,
		h: 'inline-nonce',
		probes: [
			'script-self-nonce-after-src',
			'script-self-nested-nonce-after-src',
			'script-self-nested',
		],
	},
	'every way a script connects': {
		p: `script-src 'nonce-probes' ${other}`,
		h: 'inline-nonce',
		probes: PATHS.filter((probe) => !COPIED.includes(probe)),
	},
	'a script refused before it connects, copied': {
		p: `script-src 'nonce-probes' ${other}`,
		h: 'inline-nonce',
		probes: COPIED,
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
	// a list that takes nonces judges a stylesheet by its element (the
	// worker cannot: ../../src/cspJudge.ts hostsApply), and its hosts still
	// let one through, by the DOM and in the markup
	'styles by host where the list also takes nonces': {
		p: "style-src 'self' 'nonce-probes'",
		sl: true,
		probes: ['style-self', 'style-other', 'style-inline', 'markup-sheet'],
	},
	'styles by host where the list also takes nonces, style-src-elem': {
		p: "script-src 'nonce-probes'; style-src-elem 'self' 'nonce-probes'",
		h: 'nonce',
		s: true,
		sl: true,
		probes: ['style-self', 'style-other', 'markup-styles', 'markup-sheet'],
	},
	'a markup stylesheet by host where the list also takes nonces, report-only': {
		ro: "style-src 'self' 'nonce-probes'",
		sl: true,
		probes: ['style-self', 'style-other', 'markup-sheet'],
	},
	'a markup stylesheet refused where the list takes nonces': {
		p: "style-src 'nonce-probes' https://elsewhere.invalid",
		sl: true,
		probes: ['style-self', 'markup-sheet'],
	},
	'nonce styles in the markup': {
		p: "style-src 'nonce-probes'",
		s: true,
		probes: ['markup-styles', 'style-inline'],
	},
	// the inject re-inserts a rewritten inline <style> with a script that
	// replaces itself (document.currentScript.outerHTML), serialized into the
	// written page and parsed again: its outerHTML write of the inject's own
	// style must not be refused by the page's require-trusted-types-for, or
	// the style is lost and the page renders unstyled (accounts.google.com)
	'markup styles under require-trusted-types-for': {
		p: "require-trusted-types-for 'script'",
		s: true,
		probes: ['markup-styles', 'style-inline'],
	},
	'opaque frame, nonce': {
		p: "script-src 'nonce-probes'; style-src 'self'",
		h: 'nonce',
		fs: 'allow-scripts',
		probes: OPAQUE,
	},
	'opaque frame, unsafe-inline and unsafe-eval': {
		p: "default-src 'self' 'unsafe-inline' 'unsafe-eval'",
		fs: 'allow-scripts',
		probes: OPAQUE,
	},
	'opaque frame, meta': {
		m: "script-src 'nonce-probes' 'unsafe-eval'; style-src 'unsafe-inline'",
		h: 'nonce',
		fs: 'allow-scripts allow-forms',
		probes: OPAQUE,
	},
	'unsafe-inline styles': {
		p: "style-src 'self' 'unsafe-inline'",
		probes: ['style-inline', 'style-attribute', 'style-other'],
	},
};

// known differences (docs/csp.md, Not yet as natively): a script the page's
// policy refused before it connected keeps no src, so its markup, a copy of
// it, and one judged in another document load nothing
const EXPECTED = {
	'a markup stylesheet refused where the list takes nonces': {
		'markup-sheet':
			'a refused stylesheet link keeps no href, so it has no sheet (natively an empty one)',
	},
	'a script refused before it connects, copied': {
		violations:
			'the copies fire no violation (natively each is judged as it connects), and the scripts of another document fire theirs as their src is set',
		'script-path-adoptNode-late':
			'a script of another document is judged as its src is set there, without the nonce it is given later, and stays refused when it is adopted and connected (natively it loads)',
		'script-path-importNode-late':
			'the script of another document was refused as its src was set; its copy has no src and fires nothing (natively it loads)',
		'script-path-importNode-none':
			'the script of another document was refused as its src was set; its copy has no src and fires nothing (natively an error)',
		'script-path-template-late':
			"the script of a template's content was refused as its src was set; its copy has no src and fires nothing (natively it loads)",
		'script-path-template-none':
			"the script of a template's content was refused as its src was set; its copy has no src and fires nothing (natively an error)",
		'script-path-cloneNode-late':
			"the held script's copy has no src and is not held: it fires nothing (natively it loads)",
		'script-path-cloneNode-none':
			"the held script's copy has no src and is not held: it fires nothing (natively an error)",
	},
};

// A violation the inject fires itself (the browser never gets script-src,
// and judges no other origin's load through the proxy) reads trusted, as the
// browser's own: each listener of the dispatch, a function's, an object's
// handleEvent, the document's and the window's on- handler, is handed the
// one object window.event is, whose members are the prototype's
const IDENTITY = {
	'an enforced script-src and img-src, what a listener is handed': {
		p: "script-src 'self'; img-src 'self'",
		id: true,
		probes: ['script-inline', 'eval', 'handler-attribute', 'img-other'],
	},
	'a report-only script-src and img-src, what a listener is handed': {
		ro: "script-src 'self'; img-src 'self'",
		id: true,
		probes: ['script-inline', 'eval', 'img-other', 'img-self'],
	},
};

// Where each refusal of code made from a string and of a handler says the
// code was (sourceFile, lineNumber, columnNumber): the call of eval,
// Function or the timer, in the probes' script file or, inlined, in the
// page's markup, and the handler's place in the markup it was written in,
// each read through the map of the rewrite of the code that made the call
// (docs/rust-plan.md, position maps)
const PLACED = {
	'where code from a string is refused, in a script file': {
		p: "script-src 'nonce-probes'",
		h: 'nonce',
		probes: ['eval', 'function', 'timeout-string', 'handler-attribute'],
	},
	// a script the page's code inserts: its violation names the inserting
	// call, in the markup (the inline script's map places it) or in the
	// script file, as Chrome judges it as it connects (one that never
	// connects fires nothing)
	'where an inserted script is refused, from the markup': {
		p: `script-src ${probesHash}`,
		h: 'inline-hash',
		probes: [
			'script-inline',
			'script-other',
			'script-self',
			'script-unconnected',
		],
	},
	'where an inserted script is refused, from a script file': {
		p: "script-src 'nonce-probes'",
		h: 'nonce',
		probes: [
			'script-inline',
			'script-other',
			'script-self',
			'script-unconnected',
		],
	},
	'where an inserted script is reported, from a script file': {
		ro: "script-src 'nonce-probes'",
		h: 'nonce',
		probes: [
			'script-inline',
			'script-other',
			'script-self',
			'script-unconnected',
		],
	},
	'where code from a string is refused, in the markup': {
		p: `script-src ${probesHash} ${insertedHash}`,
		h: 'inline-hash',
		probes: ['eval', 'function', 'timeout-string'],
	},
};

const browser = await launch();
await compareCases(browser, CASES, { expected: EXPECTED });
await compareCases(browser, PLACED, {
	fields: [...FIELDS, 'sourceFile', 'lineNumber', 'columnNumber'],
});
await compareCases(browser, IDENTITY, {
	fields: [...FIELDS, 'isTrusted', 'windowEvent', 'methods', 'alike'],
});
await done(browser);
