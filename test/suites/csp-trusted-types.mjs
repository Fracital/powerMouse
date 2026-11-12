// A page's Trusted Types (`require-trusted-types-for 'script'`, the
// `trusted-types` names) are enforced and reported as natively
// (test/csp-server.mjs `js=tt`, test/pages/csp-tt-probes.js): every sink
// refuses a string with Chrome's TypeError and reports the page's sink and
// value, the page's default policy is called with Chrome's arguments and
// what it returns is what lands, the page's own trusted values pass, and
// policies are made, refused and reported by their names. The proxy writes
// strings into these sinks all the time (the page's rewritten markup, its
// rewritten scripts, eval of rewritten code): none of that may be refused,
// reported or shown to the page's default policy. Compared with the page
// loaded natively, in both modes. Cloudflare's challenge frame sends such a
// policy.
import { compareCases, FIELDS } from '../csp-lib.mjs';
import { done, launch } from '../lib.mjs';

const RTT = "require-trusted-types-for 'script'";

const HTML = [
	'innerHTML',
	'innerHTML-null',
	'innerHTML-object',
	'outerHTML',
	'insertAdjacentHTML',
	'setHTMLUnsafe',
	'parseHTMLUnsafe',
	'parseFromString',
	'createContextualFragment',
	'write',
	'srcdoc',
	'srcdoc-attribute',
];
const SCRIPTS = [
	'script-text',
	'script-textContent',
	'script-innerText',
	'script-innerHTML',
	'script-text-node',
	'script-connected-text',
	'script-src',
	'script-src-attribute',
	'handler',
	'handler-property',
];
const CODE = [
	'eval',
	'eval-indirect',
	'eval-object',
	'function',
	'timeout',
	'timeout-function',
	'worker',
	'javascript-url',
];
const SINKS = [...HTML, ...SCRIPTS, ...CODE];
const TRUSTED = [
	'trusted-html',
	'trusted-script',
	'trusted-url',
	'trusted-handler',
	'trusted-eval',
	'trusted-wrong-type',
	'trusted-empty',
	'trusted-worker',
	'trusted-fragment-script',
];

const ENFORCED = {
	// every sink refuses a string, and the page's own trusted values pass
	enforced: { p: RTT, js: 'tt', probes: [...SINKS, ...TRUSTED, 'readback'] },
	'default policy': {
		p: RTT,
		js: 'tt',
		probes: ['default-pass', ...SINKS, 'readback'],
	},
	// what the default policy returns is what lands, runs or loads
	'default policy that changes the value': {
		p: RTT,
		js: 'tt',
		probes: ['default-tag', ...SINKS],
	},
	'default policy that returns null': {
		p: RTT,
		js: 'tt',
		probes: ['default-null', ...SINKS],
	},
	'default policy that throws': {
		p: RTT,
		js: 'tt',
		probes: ['default-throw', 'innerHTML', 'script-text', 'eval', 'function'],
	},
	'default policy with createHTML only': {
		p: RTT,
		js: 'tt',
		probes: [
			'default-html-only',
			'innerHTML',
			'script-text',
			'handler',
			'eval',
		],
	},
	meta: { m: RTT, js: 'tt', probes: ['innerHTML', 'script-text', 'eval'] },
	'with script-src': {
		p: `${RTT}; script-src 'self' 'unsafe-inline'`,
		js: 'tt',
		probes: ['default-pass', 'eval', 'function', 'timeout', 'script-text'],
	},
	frame: { p: RTT, js: 'tt', probes: ['default-pass', 'frame-innerHTML'] },
	// policy names
	names: {
		p: `${RTT}; trusted-types foo bar`,
		js: 'tt',
		probes: [
			'policy-foo',
			'policy-bar',
			'policy-baz',
			'policy-foo~2',
			'policy-default',
			'readback',
		],
	},
	'names without require-trusted-types-for': {
		p: 'trusted-types foo',
		js: 'tt',
		probes: ['policy-foo', 'policy-baz', 'policy-foo~2', 'innerHTML', 'eval'],
	},
	'allow-duplicates': {
		p: "trusted-types foo 'allow-duplicates'",
		js: 'tt',
		probes: ['policy-foo', 'policy-foo~2', 'policy-bar'],
	},
	"'none'": {
		p: "trusted-types 'none'",
		js: 'tt',
		probes: ['policy-foo', 'policy-default'],
	},
	star: {
		p: 'trusted-types *',
		js: 'tt',
		probes: [
			'policy-foo',
			'policy-foo~2',
			'policy-default',
			'policy-default~2',
		],
	},
	'two policies': {
		p: ['trusted-types foo bar', 'trusted-types bar baz'],
		js: 'tt',
		probes: ['policy-foo', 'policy-bar', 'policy-baz'],
	},
	'no directive': {
		p: RTT,
		js: 'tt',
		probes: [
			'policy-foo',
			'policy-foo~2',
			'policy-empty-name',
			'policy-default',
		],
	},
	// Cloudflare's challenge frame's policy
	turnstile: {
		p: `trusted-types turnstile default; ${RTT}`,
		js: 'tt',
		probes: [
			'readback',
			'innerHTML',
			'script-text',
			'eval',
			'default-pass',
			'innerHTML~2',
			'script-text~2',
			'eval~2',
			'function',
			'timeout',
			'readback~2',
		],
	},
};

// A report-only policy refuses nothing: each sink reports the page's value
// and goes on with it. The inject dispatches the events of the sinks it
// writes itself (the browser would report its rewrite), so they are not
// trusted (docs/csp.md).
const REPORTED = {
	'report-only': {
		ro: RTT,
		js: 'tt',
		probes: [...HTML, 'script-text', 'handler', 'eval', 'function', 'timeout'],
	},
	'report-only, default policy that returns null': {
		ro: RTT,
		js: 'tt',
		probes: ['default-null', 'innerHTML', 'script-text', 'eval'],
	},
	'report-only names': {
		ro: 'trusted-types foo',
		js: 'tt',
		probes: ['policy-foo', 'policy-bar', 'policy-foo~2'],
	},
};

const browser = await launch();
await compareCases(browser, ENFORCED, { fields: [...FIELDS, 'isTrusted'] });
await compareCases(browser, REPORTED);
await done(browser);
