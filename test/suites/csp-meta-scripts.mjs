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
// modes. The same page under a header policy is the baseline. The
// markup's handlers (onclick, onerror, onload, a body's) and javascript:
// links are judged by the policies in force as the parser inserts them and
// again as they first run, as natively: after a meta in the same piece of
// the markup, in a later one, and before a meta a script inserts.
import { createHash } from 'node:crypto';
import { compareCases, FIELDS } from '../csp-lib.mjs';
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
			.filter((token) =>
				/^(i|in|ix|e|en|eo|di|de|wi|we|fi|fw|img|fx|sty|oc|ob|oe|ol|ju|jt|bo|og|if|wh|jf|jc|jl):/.test(
					token,
				),
			)
			.flatMap((token) => {
				const name = token.slice(token.indexOf(':') + 1);
				// (a let's statements: run, strict, the window's let or none)
				return token.startsWith('jl:')
					? [name, `${name}S`, `${name}G`, `${name}N`]
					: [name];
			}),
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

// Where each violation and report of a script of the parser says its code
// was (`source`: sourceFile, lineNumber, columnNumber): the document's URL
// and where an inline script's text starts in the markup, its lines its
// line feeds (CR LF and a lone CR, `crlf`) and its columns UTF-16 units
// (`wide`), in the first piece of the markup and a later one; an external
// one's names none. A script's violations come in the order the parser
// prepares them. One a script file inserts (through the DOM, by
// document.write) names the inserting call in the file: the service
// worker's rewrite of the file carries the map of itself to the file's
// text.
const PLACED = {
	'where a meta refuses': laid({
		m: NONCE,
		source: true,
		l: [
			'meta',
			'crlf',
			'i:a',
			'wide',
			'i:b',
			'e:c',
			'wide',
			'e:d',
			'in:ok',
			'gap',
			'i:late',
			'e:lateext',
			'body',
			'i:bodyscript',
		],
	}),
	'where a header refuses': laid({
		p: NONCE,
		source: true,
		l: ['crlf', 'i:a', 'wide', 'i:b', 'e:c', 'gap', 'i:late', 'body', 'i:end'],
	}),
	'where a script file inserts': laid({
		m: NONCE,
		source: true,
		l: ['meta', 'fi:filedom', 'fw:filewrite', 'gap', 'body', 'fi:bodydom'],
	}),
};

// A report-only policy's refusals of loads that went out (an image, a
// fetch: the worker's) and of an external script under a list of nonces
// (the inject's) are reported, a report each, as natively (not where:
// docs/csp.md). Chrome's console messages of the loads are not the
// inject's to write, so they are not compared.
const REPORTED = {
	'report-only loads': laid({
		ro: "img-src 'none'; connect-src 'none'; script-src 'nonce-probes'",
		l: ['img:pic', 'fx:fetched', 'e:ext', 'i:plain', 'img:pic2'],
	}),
};

// The markup's handlers and a javascript: link (test/csp-server.mjs
// layout: a button clicked and one never clicked, an image that fails and
// one that loads, a body's onload, a link clicked) under a policy of
// nonces: each refused and reported where natively, the console's message
// Chrome's (an event handler's, a JavaScript URL's). Chrome judges a
// handler as its attribute is set and again as it first runs, a
// javascript: URL as its navigation starts and as it runs, by the policies
// in force then: a handler parsed before a meta a script inserts is
// refused as it runs, and a report-only policy reports each twice.
const HANDLED = ['oc:click', 'oe:fails', 'ol:loads', 'ju:link'];
const HANDLER_CASES = {
	'handlers under a header of nonces': laid({
		p: NONCE,
		l: ['body', ...HANDLED, 'ob:unclicked'],
	}),
	'handlers after a meta in the same piece': laid({
		m: NONCE,
		l: ['meta', 'body', ...HANDLED, 'ob:unclicked'],
	}),
	'handlers a piece after the meta': laid({
		m: NONCE,
		l: ['meta', 'gap', 'body', ...HANDLED],
	}),
	'handlers after a meta in a later piece': laid({
		m: NONCE,
		l: ['gap', 'meta', 'body', ...HANDLED],
	}),
	'handlers after a meta, brotli': laid({
		m: NONCE,
		l: ['meta', 'body', ...HANDLED],
		br: true,
	}),
	'handlers before a meta a script inserts': laid({
		m: NONCE,
		l: ['body', ...HANDLED, 'mi:0'],
	}),
	"a body's onload after a meta": laid({ m: NONCE, l: ['meta', 'bo:onload'] }),
	'a javascript: link of statements after a meta': laid({
		m: NONCE,
		l: ['meta', 'body', 'jt:statements'],
	}),
	"handlers after a meta of 'unsafe-inline'": laid({
		m: "script-src 'unsafe-inline'",
		l: ['meta', 'bo:onload', ...HANDLED],
	}),
	'handlers under a report-only header': laid({
		ro: "script-src 'nonce-probes' 'report-sample'",
		l: ['body', ...HANDLED],
	}),
	'a javascript: link of statements under a report-only header': laid({
		ro: NONCE,
		l: ['body', 'jt:statements'],
	}),
	"handlers under default-src, 'unsafe-inline' with a nonce, script-src-attr":
		laid({
			p: [
				"default-src 'nonce-probes' data:",
				"script-src 'unsafe-inline' 'nonce-probes'",
				"script-src-attr 'none'",
			],
			l: ['body', 'oc:click', 'ju:link'],
		}),
};

const browser = await launch();
await compareCases(browser, CASES, { consoleMessages: true });
await compareCases(browser, STYLE_CASES, { consoleMessages: true });
await compareCases(browser, HANDLER_CASES, { consoleMessages: true });
// Where a handler's violations and a javascript: URL's say its code was,
// and when Chrome judges them (measured, Chrome 157): a handler as the
// parser inserts it (no place; one a document.write wrote, the write) and
// as it is compiled, at its first run or the first read of its property
// (the code that dispatched its event or read it, else the handler's place
// in the markup, where its start tag ends); one that runs before the
// parser's next checkpoint (an iframe's load) is judged as parsed first. A
// javascript: URL is judged as its navigation starts by the policies of
// the document whose code started it, at that code (a frame's violation
// targets the frame's element), and as it runs by its window's, at its
// first line. One of statements runs as a script: a 'use strict' of it is
// a directive and its let is the window's.
const HANDLER_PLACED = {
	'where handlers are judged under a report-only header': laid({
		ro: NONCE,
		source: true,
		l: [
			'body',
			'oc:click',
			'oe:fails',
			'ol:loads',
			'if:frame',
			'og:read',
			'wh:written',
			'ju:link',
		],
	}),
	'where handlers are judged after a meta': laid({
		m: NONCE,
		source: true,
		l: ['meta', 'body', 'oc:click', 'if:frame', 'og:read', 'wh:written'],
	}),
	"where a body's onload is judged under a report-only header": laid({
		ro: NONCE,
		source: true,
		l: ['bo:onload'],
	}),
	'a handler read after a meta a script inserts': laid({
		m: NONCE,
		source: true,
		l: ['body', 'ob:unclicked', 'mi:0', 'og:read'],
	}),
	'a javascript: link into a frame, refused by the linking document': laid({
		m: NONCE,
		source: true,
		l: ['meta', 'body', 'jf:framed'],
	}),
	"a javascript: link into a frame, refused by the frame's": laid({
		m: NONCE,
		source: true,
		l: ['body', 'jc:framed'],
	}),
	'a javascript: link into a frame under a report-only header': laid({
		ro: NONCE,
		source: true,
		l: ['body', 'jf:framed'],
	}),
	'a javascript: link of statements with a let': laid({
		l: ['body', 'jl:lexical'],
	}),
	'a javascript: link of statements with a let under a report-only header':
		laid({ ro: NONCE, source: true, l: ['body', 'jl:lexical'] }),
	'a javascript: link of statements with a let after a meta': laid({
		m: NONCE,
		source: true,
		l: ['meta', 'body', 'jl:lexical'],
	}),
};

await compareCases(browser, HANDLER_PLACED, {
	fields: [...FIELDS, 'sourceFile', 'lineNumber', 'columnNumber'],
	consoleMessages: true,
});
await compareCases(browser, PLACED, {
	fields: [...FIELDS, 'sourceFile', 'lineNumber', 'columnNumber'],
	consoleMessages: true,
});
await compareCases(browser, REPORTED);
await done(browser);
