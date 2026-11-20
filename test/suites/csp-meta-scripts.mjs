// A page's script-src delivered by a <meta http-equiv="Content-Security-
// Policy"> judges the scripts that come after it as natively, the parser's
// and the ones a script inserts, inline and by URL: by a nonce, a hash,
// 'strict-dynamic' and 'unsafe-inline' (test/csp-server.mjs layout,
// test/pages/csp-meta-recorder.js). A meta first in the head, one in a
// later piece of a head that arrives in two (the shell goes out before the
// meta came), one a script inserts, one in the body (ignored), two metas
// and a meta beside a header. What comes before a meta runs. Each script
// that ran, its load and error events, the violations, the csp-violation
// reports a ReportingObserver is handed (the `reports` probe) and the
// console's messages are compared with the page loaded natively, in both
// modes. The same page under a header policy is the baseline.
import { createHash } from 'node:crypto';
import { compareCases } from '../csp-lib.mjs';
import { ranText } from '../csp-server.mjs';
import { done, launch } from '../lib.mjs';

const sha = (text) =>
	`'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const NONCE = "script-src 'nonce-probes'";
// every kind of script the layout has (test/csp-server.mjs layout)
const ALL = [
	'i:plain',
	'in:nonced',
	'ix:wrong',
	'e:ext',
	'en:extnonce',
	'eo:other',
	'di:dominline',
	'de:domext',
	'wi:writeinline',
	'we:writeext',
];
/** a case whose probes are its layout's scripts and the reports */
const laid = (spec) => ({
	...spec,
	probes: [
		...spec.l
			.filter((token) => /^(i|in|ix|e|en|eo|di|de|wi|we|sty):/.test(token))
			.map((token) => token.slice(token.indexOf(':') + 1)),
		'reports',
	],
});

const CASES = {
	'a header, a nonce': laid({ p: NONCE, l: ALL }),
	'a meta first in the head, a nonce': laid({ m: NONCE, l: ['meta', ...ALL] }),
	'what comes before the meta': laid({
		m: NONCE,
		l: ['i:before', 'e:beforeext', 'meta', 'i:after', 'e:afterext'],
	}),
	'a meta in the body': laid({
		m: NONCE,
		l: ['body', 'meta', 'i:after', 'e:afterext'],
	}),
	'a meta in a later piece of the head': laid({
		m: NONCE,
		l: [
			'i:before',
			'gap',
			'meta',
			'i:after',
			'e:afterext',
			'in:nonced',
			'body',
			'i:bodyafter',
		],
	}),
	'a meta a script inserts': laid({
		m: NONCE,
		l: [
			'i:before',
			'mi:0',
			'i:after',
			'e:afterext',
			'in:nonced',
			'body',
			'i:bodyafter',
			'wi:writeinline',
		],
	}),
	'a meta a script inserts in a later piece of the head': laid({
		m: NONCE,
		l: [
			'i:before',
			'gap',
			'mi:0',
			'i:after',
			'e:afterext',
			'in:nonced',
			'body',
			'i:bodyafter',
		],
	}),
	'a meta, a hash': laid({
		m: `script-src ${sha(ranText('hashed'))}`,
		l: ['meta', 'i:hashed', 'i:plain', 'e:ext'],
	}),
	'a meta, a nonce and strict-dynamic': laid({
		m: "script-src 'nonce-probes' 'strict-dynamic'",
		l: ['meta', ...ALL],
	}),
	'a meta, unsafe-inline': laid({
		m: "script-src 'self' 'unsafe-inline'",
		l: [
			'meta',
			'i:plain',
			'e:ext',
			'eo:other',
			'di:dominline',
			'wi:writeinline',
		],
	}),
	'a meta, unsafe-inline and a nonce': laid({
		m: "script-src 'unsafe-inline' 'nonce-probes'",
		l: ['meta', 'i:plain', 'in:nonced', 'e:ext'],
	}),
	'two metas': laid({
		m: ["script-src 'unsafe-inline' 'self'", NONCE],
		l: [
			'meta:0',
			'i:first',
			'e:firstext',
			'meta:1',
			'i:second',
			'in:nonced',
			'e:secondext',
		],
	}),
	'a meta, report-sample': laid({
		m: "script-src 'nonce-probes' 'report-sample'",
		l: ['meta', 'i:plain', 'e:ext'],
	}),
	'a meta under a header': laid({
		p: "script-src 'nonce-probes' 'unsafe-inline' 'self'",
		m: "script-src 'unsafe-inline' 'self'",
		l: ['i:before', 'meta', 'i:plain', 'in:nonced', 'e:ext'],
	}),
};

// The page's inline styles under a policy of nonces: the inject writes each
// style of the markup through a script of its own (DOMContentHooks), which
// the page's policy must not judge (the browser never sees it). Each style
// is there and applies, and nothing is refused or logged, as natively, in a
// page that comes whole, in two pieces, and brotli-compressed in two.
const STYLES = "script-src 'nonce-probes'; style-src 'unsafe-inline'";
const STYLED = ['sty:sa', 'in:nonced', 'body', 'sty:sb', 'i:plain'];
const STYLED_LATER = [
	'sty:sa',
	'gap',
	'sty:sb',
	'in:nonced',
	'body',
	'sty:sc',
	'i:plain',
];
const STYLE_CASES = {
	'styles under a header of nonces': laid({ p: STYLES, l: STYLED }),
	'styles under a header of nonces, in two pieces': laid({
		p: STYLES,
		l: STYLED_LATER,
	}),
	'styles under a header of nonces, brotli in two pieces': laid({
		p: STYLES,
		l: STYLED_LATER,
		br: true,
	}),
	'styles under a meta of nonces': laid({ m: STYLES, l: ['meta', ...STYLED] }),
	'styles under a meta of nonces, in two pieces': laid({
		m: STYLES,
		l: ['meta', ...STYLED_LATER],
	}),
	'styles under a meta of nonces, brotli in two pieces': laid({
		m: STYLES,
		l: ['meta', ...STYLED_LATER],
		br: true,
	}),
	'styles under strict-dynamic': laid({
		p: "script-src 'nonce-probes' 'strict-dynamic'; style-src 'unsafe-inline'",
		l: [...STYLED, 'di:dominline'],
	}),
};

const browser = await launch();
await compareCases(browser, CASES, { consoleMessages: true });
await compareCases(browser, STYLE_CASES, { consoleMessages: true });
await done(browser);
