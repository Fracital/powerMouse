// The scanner module (rust/rwcss, dist/scanner.wasm) against the JavaScript
// it stands in for, in node: with `rewriter: 'wasm'` the module rewrites a
// stylesheet, a declaration list (an element's style) and a single value
// (css-tree's parse and walk, and the URL expression, otherwise), asking
// the thread only what each URL routes to, and finds a document's inline
// scripts and styles (three regular expressions otherwise). The contract is
// identical output, so every input here is rewritten both ways and the two
// are compared byte for byte: hand-written edge cases, every stylesheet and
// page of test/pages, a seeded fuzz of mutations of them (unbalanced
// brackets, cut strings, escapes, comments, non-ASCII, URLs that do not
// parse or are routed already), and with SCANNER_CORPUS=<dir>[:<dir>...]
// every .css file (and every string of a JSON array) under those
// directories. The module answers every one of them itself (a byte order
// mark, a surrogate with no other half, a URL of megabytes, brackets nested
// by the thousand): css-tree is what rewrites when a thread holds no
// module, and nothing here is left to it.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP scanner-parity: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}scanner-parity-entry.mjs`;
writeFileSync(
	entry,
	`export { modifyCSS, rewriteCSSValueURLs } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { rewriteCSSValueURLs as valueInJS } from ${JSON.stringify(`${root}src/cssURLs.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { hasBase, inlineSources } from ${JSON.stringify(`${root}src/prewrite.ts`)};
export { adoptModules } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
export { rewriteStyles, scanMarkup } from ${JSON.stringify(`${root}src/wasm/scanner.ts`)};
`,
);
const bundle = `${OUT}scanner-parity.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	// css-tree reads a data file next to itself: resolved from node_modules
	external: ['css-tree'],
	outfile: bundle,
	logLevel: 'silent',
});
// the document inject's rewriter library, built as build.js builds it (its
// globals injected), with the thread state its copy of the module lives in
const libraryEntry = `${OUT}scanner-parity-library-entry.mjs`;
writeFileSync(
	libraryEntry,
	`export { api } from ${JSON.stringify(`${root}src/rewriterLibDocument.ts`)};
export { adoptModules } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
`,
);
const libraryBundle = `${OUT}scanner-parity-library.mjs`;
await esbuild.build({
	entryPoints: [libraryEntry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	inject: [`${root}src/libGlobals.ts`],
	outfile: libraryBundle,
	logLevel: 'silent',
});
const {
	modifyCSS,
	rewriteCSSValueURLs,
	valueInJS,
	StompURL,
	parseConfig,
	hasBase,
	inlineSources,
	adoptModules,
	scanMarkup,
	rewriteStyles,
} = await import(`${bundle}?${Date.now()}`);

const { codec } = parseConfig({ directory: '/stomp/', codec: 'xor' }, 'k');
const url = new StompURL('https://example.com/dir/sheet.css', codec, '/stomp/');
// the rewriter reports URLs it cannot parse on the console
const quiet = { error: console.error, warn: console.warn };
console.error = () => {};
console.warn = () => {};

{
	const told = {};
	ok(
		'without the module every rewrite and scan is declined, and JavaScript rewrites',
		rewriteStyles('a{b:url(c)}', url, 'stylesheet') === null &&
			scanMarkup('<style>a{}</style>') === null &&
			modifyCSS('a{b:url(c)}', url, 'stylesheet', told) ===
				modifyCSS('a{b:url(c)}', url) &&
			told.by === 'js',
		JSON.stringify(told),
	);
}
const bytes = readFileSync(`${root}dist/scanner.wasm`);
await adoptModules({
	scanner: bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	),
});

/** a rewrite's output, or how it threw */
const attempt = (run) => {
	try {
		return run();
	} catch (error) {
		return `THROWN ${String(error)}`;
	}
};

const tally = { answered: 0, declined: 0, differ: 0 };
const differences = [];
/** texts the module left to JavaScript: there should be none */
const leftToJS = [];
function noteDeclined(text) {
	if (leftToJS.length < 3) leftToJS.push(text.slice(0, 300));
}
/** `text` rewritten by css-tree and by the module: the same? */
function sameStyles(text, context, label) {
	const expected = attempt(() => modifyCSS(text, url, context));
	const told = {};
	const got = attempt(() => modifyCSS(text, url, context, told));
	const answered = told.by === 'wasm';
	// a sheet with nothing to route never reaches the module
	if (answered) tally.answered++;
	else if (told.by === 'js') {
		tally.declined++;
		noteDeclined(text);
	}
	if (got === expected) return answered;
	tally.differ++;
	if (differences.length < 5)
		differences.push({
			label,
			context,
			text: text.slice(0, 2000),
			expected: String(expected).slice(0, 2000),
			got: String(got).slice(0, 2000),
		});
	return answered;
}

const valueTally = { answered: 0, declined: 0, differ: 0 };
/** the url()s of the single value `text` routed by the expression and by the module: the same? */
function sameValue(text, label) {
	const expected = attempt(() => valueInJS(text, url));
	const told = {};
	const got = attempt(() => rewriteCSSValueURLs(text, url, told));
	const answered = told.by === 'wasm';
	if (answered) valueTally.answered++;
	else if (told.by === 'js') {
		valueTally.declined++;
		noteDeclined(text);
	}
	if (got === expected) return answered;
	valueTally.differ++;
	if (differences.length < 5)
		differences.push({ label, context: 'value', text, expected, got });
	return answered;
}

/** an expression's matches as the scanner answers them: where group 1 and group 2 stand */
const matches = (markup, pattern, name) =>
	[...markup.matchAll(pattern)].map((match) => {
		const attributes = match.index + 1 + name.length;
		const end = match.index + match[0].lastIndexOf('</');
		return [
			attributes,
			attributes + match[1].length,
			end - match[2].length,
			end,
		];
	});
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
const markupTally = { compared: 0, differ: 0 };
const markupDifferences = [];
/** the scanner's elements against the expressions' matches, and inlineSources both ways */
function sameMarkup(markup, label) {
	const scanned = scanMarkup(markup);
	markupTally.compared++;
	const expected = JSON.stringify({
		base: hasBase(markup),
		scripts: matches(markup, SCRIPT, 'script'),
		styles: matches(markup, STYLE, 'style'),
		sources: inlineSources(markup),
	});
	const got = JSON.stringify(
		scanned && {
			base: scanned.base,
			scripts: scanned.scripts,
			styles: scanned.styles,
			sources: inlineSources(markup, scanned),
		},
	);
	if (got === expected) return;
	markupTally.differ++;
	if (markupDifferences.length < 5)
		markupDifferences.push({ label, markup, expected, got });
}

// The inject side: a frame's stylesheets and style attributes are rewritten
// by its rewriter library, which takes the module's answer once its copy of
// the thread state holds the module and css-tree's until then.
{
	const library = await import(`${libraryBundle}?${Date.now()}`);
	const context = JSON.stringify([
		'https://example.com/dir/page.html',
		'xor',
		'k',
		'/stomp/',
		null,
		null,
		[],
	]);
	const page = new StompURL(
		'https://example.com/dir/page.html',
		codec,
		'/stomp/',
	);
	const cases = [
		['a { background: url(a.png) } @import "b.css";', 'stylesheet'],
		['background: url(a.png); --x: url(b)', 'declarationList'],
	];
	// an instance is made the first time a rewrite reaches the module
	const Instance = WebAssembly.Instance;
	let made = 0;
	WebAssembly.Instance = function (...args) {
		made++;
		return new Instance(...args);
	};
	const before = cases.map(([text, kind]) =>
		library.api.css(context, text, kind),
	);
	const madeBefore = made;
	await library.adoptModules({
		scanner: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		),
	});
	const after = cases.map(([text, kind]) =>
		library.api.css(context, text, kind),
	);
	WebAssembly.Instance = Instance;
	const expected = cases.map(([text, kind]) => modifyCSS(text, page, kind));
	ok(
		"the inject's rewriter library rewrites by css-tree until it holds the module and in the module from then on, the same",
		madeBefore === 0 &&
			made === 1 &&
			JSON.stringify(before) === JSON.stringify(expected) &&
			JSON.stringify(after) === JSON.stringify(expected) &&
			expected.every((output, i) => output !== cases[i][0]),
		JSON.stringify({ madeBefore, made, before, after, expected }),
	);
}

// stylesheets the module must rewrite itself, each a shape of its own
const SHEETS = [
	'a { background: url(a.png) }',
	'@import "a.css";\n@import url(b.css) screen;\n@IMPORT url(c.css);',
	"@import 'a.css' layer(x) supports(display: grid);",
	'a{b:url( "x y.png" )}c{d:url(x\\ y.png)}',
	'a { background: url(a.png) no-repeat, URL(b.png) !important; color: red }',
	'a { --image: url(a.png); --empty:; --json: { "a": [1, 2] } }',
	'a { background-image: image-set("a.png" 1x, url(b.png) 2x) }',
	'a { background-image: -webkit-image-set(url(a.png) 1x) }',
	'@font-face { font-family: x; src: url(a.woff2) format("woff2"), url("a.woff") }',
	'@font-face { src: local("x"), src("a.woff") }',
	'@media (min-width: 1px) { a { b: url(c) } @supports (x: y) { d { e: url(f) } } }',
	'@namespace svg url(http://www.w3.org/2000/svg);',
	'@charset "utf-8"; a { b: url(c) }',
	'a[href*="url("] { color: red } a:not([src="url(x)"]) { b: c }',
	'.md\\:flex { display: flex } .a\\(b\\) { c: url(d) }',
	'a { b: url(c) } /* } url(d) { */ e { f: url(g) }',
	'/*! kept */ a { b: url(c) } <!-- d { e: url(f) } -->',
	'a { url(x); b: url(c); ; d: url(e) }',
	'a { b: url(c); & d { e: url(f) } &:hover { g: url(h) } }',
	'a { b: var(--x, url(c)); d: expression(url(e)) }',
	'a { *zoom: 1; _b: url(c); $d: url(e); //f: url(g); #h: url(i) }',
	'a { b: url(c) ! important; d: url(e) !ie; f: url(g) ! }',
	'a { b: url(c) } b { c: url(d',
	'a { b: "url(c)" url(d) \'url(e)\' }',
	'a { b: url(c) "unclosed\n d: url(e) }',
	'a { b: url(c d) e; f: url("g" h) }',
	'a { b: url(data:image/png;base64,AAAA) }',
	'a { b: url(#frag) } c { d: url() } e { f: url( ) }',
	'a { b: url(c) }\n@media print { d { e: url(f) }\n',
	'@page :first { margin: 1in; background: url(a) } @page { @top-left { content: url(b) } }',
	'@keyframes x { from { background: url(a) } to { background: url(b) } }',
	'@container (min-width: 1px) { a { b: url(c) } }',
	'@layer a, b; @layer a { c { d: url(e) } }',
	'@scope (.a) to (.b) { c { d: url(e) } }',
	'@starting-style { a { b: url(c) } }',
	'@unknown url(a) { b: url(c) } @other { d { e: url(f) } }',
	'@media screen { a { b: url(c) } } @media { d: url(e) }',
	'a { b: url(c) } @import url(late.css);',
	'a { b: url(\\63 .png) } \\61 { c: url(d) }',
	'a { b: U+26, url(c); d: u+0-7F url(e) }',
	'a { content: "\\201C"; b: url(c) }',
	'a{b:url(c)}\r\nd{e:url(f)}\r\n',
	'﻿a { b: url(c) }',
	'﻿@import "a.css"; a { b: url(c) }',
	'hé { b: url(é.png) } \u{1F600} { c: url(\u{1F600}.png) }',
	'a { b: url(c)\\',
	'a { b: url(c',
	'a { b: url("c',
	'a { b: (url(c)) [url(d)] {url(e)} }',
	'a { b: calc(1px + 2px) url(c) #fff 1e3 -1.5e-3px 50% }',
	'a { b: url(c) } @media',
	'a { b: url(c) } @',
	'a { b: url(c) } @media x',
	'@import',
	'@import ;',
	'@import url(a.css)',
	'a { src: url(a) } b { SRC: Url(b) } c { d: IMAGE-SET("e") }',
	'a { b: url(c); /* d: url(e); */ f: url(g) }',
	'a { b: url(c) }'.repeat(200),
	`a { ${'b: url(c); '.repeat(300)} }`,
	`${'@media x {'.repeat(20)} a { b: url(c) } ${'}'.repeat(20)}`,
	// what the full parsers of a value, a prelude and a selector meet
	'@import url("a.css") layer(base) supports(not (display: grid)) screen and (min-width: 1px);',
	'@import url(a.css) layer supports(selector(a > b)) (width >= 600px), print;',
	'@import "/stomp/css/routed-already"; @import url(/stomp/css/routed-already);',
	'@import "http://[" screen; @import url(http://[); a { b: url(http://[) }',
	'@import \'a\\62 c.css\'; @import "a\\\nb.css"; @import url("a\\"b.css");',
	'@supports (background: url(a)) and (not (src: url("b"))) { c { d: url(e) } }',
	'@supports selector(:has(a)) or font-tech(color-COLRv1) { b { c: url(d) } }',
	'@media (min-resolution: 2dppx) and (400px <= width <= 700px), not all and (aspect-ratio: 16/9) { a { b: url(c) } }',
	'@media screen and (constructor: 1), (toString) { a { b: url(c) } }',
	'@container card (inline-size > 30em) and style(--responsive: true) { a { b: url(c) } }',
	'@scope (.a:has(> img[src="url(x)"])) to (:scope > .b) { c { d: url(e) } }',
	'@layer a.b, c { d { e: url(f) } } @layer url(x) { g { h: url(i) } }',
	'@page wide:first:left { a: url(b) } @nest & > c { d: url(e) }',
	'@font-face { src: url(a.woff2) format(woff2) tech(variations), src("b.woff"), SRC(\'c.woff\'), local(url(d)) }',
	'a { b: image-set("a\\62.png" 1x, \'c d.png\' 2x, url("e.png") type("image/png")) }',
	'a { b: -WEBKIT-IMAGE-SET("a.png" 1x) cross-fade(url(c), "d") }',
	'a { b: url("a b.png") url(\'c"d.png\') url(e\\ f.png) url( g.png ) url("h\\\ni.png") }',
	'a { b: url(  ) url("") url(\'\') url( "" ) }',
	'a { b: url(%E0%A4%A) url(a%20b) url("%7Bc%7D") url(%zz) }',
	'a { b: url(/stomp/routed) url(//other.example/x) url(?q=1) url(../up.png) url(blob:https://example.com/id) url(javascript:void(0)) url(about:blank) }',
	'a { b: URL("c") Url(d) uRl( e ) }',
	'a { b: url(c) url(c) url(c); d: url(c) }',
	'a { b: url(var(--x)) url("c" d) url(e f) url(g\th) }',
	'a { b: url(c\u2028d) url("e\u2029f") url(g\u212ah) }',
	'a { b: -x-y(url(c), "d", [e], {f}) U+1F600-1F64F u+4?? url(g) }',
	'a { --x: { b: url(c) }; --y: [ url(d) ]; --z: url(e) !important; --w:url(f)}',
	'a:is(b, c > d):not(.e)::before, f:nth-child(2n + 1 of .g), h::part(i):hover, j:lang("k", l), m:dir(rtl), n:nth-last-of-type(-n+3), o:host(p), q::slotted(r), s|t, *|u, |v, w:has(+ x ~ y) { z: url(0) }',
	'a[b="c" i], a[b~=c s], a[b|=\'c\'], a[b^=c], a[b$=c], [d|e], [*|f="url(g)"] { h: url(i) }',
	':nth-child(odd), :nth-child(even), :nth-child(+3n-2), :nth-child(-n- 1), :nth-child(n+ 2), :nth-child(3n -1), :nth-child(N), :nth-child(-N+1) { a: url(b) }',
	'a:-moz-any(b)::-webkit-scrollbar:horizontal, :matches(c), :where(d), ::highlight(e), :state(f), :unknown(url(g)), ::unknown("h") { i: url(j) }',
	'50% { a: url(b) } from, to { c: url(d) } 12.5%, a|b { e: url(f) }',
	'a { b: url(c) }\n@media (width: calc(1px + url(d))) and (e: "f") and (g: h(i)) { j { k: url(l) } }',
	'@import url(a.css) (b: url(c)) "d" e(f "g" url(h));',
	'@import url(a.css)\n;@import\t"b.css"\f;@import/**/"c.css"/**/;',
	'@font-face { src: url(a) } @font-face { src: "b" } @x { src: src("c") } d { src: image-set("e") }',
	'a { b: src ("c") image-set ("d") url ("e") }',
	`a { b: url(data:image/svg+xml;base64,${'QUJD'.repeat(20000)}) }`,
	`a { b: url("data:image/png;base64,${'QUJD'.repeat(40000)}") no-repeat; c: url(d) }`,
	'@import url("data:text/css,a%7Bb:url(c)%7D"); @import "data:text/css;base64,YXtiOnVybChjKX0=";',
];
// single values (a presentation attribute, a CSSOM property set)
const VALUES = [
	'url(a.png)',
	'url("a.png") no-repeat, url(\'b.png\')',
	'url( a ) url(  "b"  ) url(\t\'c\'\n)',
	'url(a) url(',
	'url("a) url(b")',
	'url(\'a") url("b\')',
	'url("a"b) url(c"d") url("e\'f")',
	'url("") url(\'\') url() url( )',
	'url(a\nb) url(c\rd) url(e\u2028f) url(g\u2029h)',
	'url(a\\)b) url(c\\ d)',
	'image-set(url(a) 1x, "b" 2x) src("c")',
	'var(--x, url(a)) URL(b) Url(c)',
	'url(http://[) url(//x/y) url(#z) url(data:,a) url(/stomp/routed)',
	'url(%E0%A4%A) url(a%20b) url(%zz)',
	'url(url(a))',
	'xurl(a) -url(b) curl(c)',
	'url(\u00a0a\u00a0) url(\ufeffb\ufeff) url(\u3000c\u1680)',
	'url(é.png) url(\u{1F600}.png) url(\u212a)',
	'\ufeffurl(a)',
	`url(data:image/png;base64,${'QUJD'.repeat(30000)}) url(a)`,
	'none',
	'',
];
// a surrogate with no other half crosses to the module and back as it is
// (UTF-8 has no bytes for one), wherever it stands: in a URL (which the URL
// parser makes U+FFFD, both ways), in a string that is written again as
// JSON, in text that is only copied
const CROSSED = [
	'a { b: url(\ud83d.png) }',
	'a { b: url(c) } \udc00 { d: url(e) }',
	'@import "\ud83d.css"; @import \'a\ude00\ud83d.css\';',
	'a { b: image-set("\ude00.png" 1x, "c\ud83d" 2x); --d: url(\udfff) }',
	'a { b: url("c") } /* \ud800 */ d\udbff { e: url(f\ud83d\ud83d\ude00) }',
	'a { b: url(http://[\ud83d) url(c) "\ud83d',
	'\ud83d',
	'a { b: url(c) }\ud83d',
];
const CROSSED_VALUES = [
	'url(\ud83d.png) url("a\ude00") url(b)',
	'\ude00url(a)\ud83d',
	'url("\ud83d\ude00") url(\ude00\ud83d)',
];
// declaration lists (an element's style attribute)
const LISTS = [
	'background: url(a.png)',
	'color: red; background: url(a.png) no-repeat; --x: url(b)',
	'background: url(a); url(b); c: url(d)',
	'& b { c: url(d) } e: url(f)',
	'@media x { a: url(b) } c: url(d)',
	'a: url(b) !important; c: image-set("d" 1x)',
	'a: url(b',
	';;a:url(b);;',
	'',
];
// a closing bracket with nothing open: css-tree's answer was taken from the
// sheet it parsed before (css-parse-history suite) and the scanner declined
// these; now it is a token like any other for both
const STRAY = [
	'a { b: url(c) } } d { e: url(f) }',
	') a { b: url(c) }',
	'a{b:url(c)} ] ) } @import "d"; e{f:url(g)}',
	'{ b: url(]c) }\0 @media }\0 @media',
];
// what the module once left to css-tree: nesting past a few dozen levels,
// and a URL that begins with a byte order mark (a decoder drops one unless
// told not to)
const ONCE_DECLINED = [
	`${'@media x{'.repeat(70)}a{b:url(c)}`,
	`a{b:${'('.repeat(120)}url(c)${')'.repeat(120)}}`,
	`${'@media x{'.repeat(700)}a{b:url(c)}${'}'.repeat(700)}`,
	`a{b:${'f('.repeat(900)}url(c)${')'.repeat(900)}}`,
	`@supports ${'('.repeat(600)}b:url(c)${')'.repeat(600)}{d{e:url(f)}}`,
	'a { b: url(\ufeffc) }',
	'\ufeff@import "\ufeffa.css"; a { b: url("\ufeff") image-set("\ufeffc") }',
	'\ufffe a { b: url(\ufffec) }',
];
// Nesting past where css-tree's stack ends. Where its parser runs out, the
// rule or value that is too deep is raw text whose url()s the expression
// routes; where its walk of the tree runs out, modifyCSS throws, and its
// callers route the whole text by the expression. The module stops
// recursing at 1,024 levels, always, and what is deeper is raw text: the
// first of the two answers. (From 1,024 levels to where css-tree runs out,
// 1,400 to 3,000 by the shape and by what else is on the stack, css-tree
// still parses and the two spell the routed URL differently: `url(x)` from
// the parse, `url("x")` from the expression. These are well past both.)
// Which of its two answers css-tree gives for a text changes from run to
// run, so each of these holds its URLs in the deep part alone, where the
// two answers are one.
const TOO_DEEP = [
	`${'@media x{'.repeat(6000)}a{b:url(c)}`,
	`${'@media x{'.repeat(6000)}a{b:url(c)}${'}'.repeat(6000)}`,
	`a{b:${'('.repeat(20000)}url(c)`,
	`a{b:${'f('.repeat(20000)}url(c)${')'.repeat(20000)}}d{e:f}`,
	`a{b:${'['.repeat(20000)}url(c)}`,
	`@supports ${'('.repeat(20000)}b:url(c)${')'.repeat(20000)}{d{e:f}}`,
];
// more than the module keeps between calls (its input buffer and the
// scratch a routed URL is answered in are given back past 1 MiB)
const LARGE = [
	`a { b: url(c) } /* ${'x'.repeat(1200000)} */ d { e: url(f) }`,
	`a { b: url("data:image/png;base64,${'QUJD'.repeat(300000)}"); c: url(d) }`,
];
// and some with nothing for the rewriter to route: never handed over
SHEETS.push(
	'a { filter: progid:DXImageTransform.Microsoft.AlphaImageLoader(src="a.png") }',
	'a { b: c } d',
);

{
	let answered = 0;
	const unanswered = [];
	for (const sheet of SHEETS)
		if (sameStyles(sheet, 'stylesheet', 'sheet')) answered++;
		else unanswered.push(sheet);
	for (const list of LISTS)
		if (list && sameStyles(list, 'declarationList', 'list')) answered++;
		else if (list) unanswered.push(list);
	ok(
		'the hand-written stylesheets and declaration lists rewrite the same both ways',
		tally.differ === 0,
		JSON.stringify(differences[0] ?? null),
	);
	const wanted = SHEETS.length - 2 + LISTS.filter((list) => list).length;
	ok(
		'the module rewrites every one of them itself',
		answered === wanted,
		`${answered} of ${wanted} ${JSON.stringify(unanswered.map((text) => text.slice(0, 200)))}`,
	);
	let values = 0;
	const wantedValues = VALUES.filter((value) => value.includes('url(')).length;
	for (const value of VALUES) if (sameValue(value, 'value')) values++;
	ok(
		'the hand-written values route the same both ways, each by the module',
		valueTally.differ === 0 && values === wantedValues,
		`${values} of ${wantedValues} ${JSON.stringify(differences[0] ?? null)}`,
	);
	let crossed = 0;
	for (const sheet of CROSSED)
		if (sameStyles(sheet, 'stylesheet', 'crossed')) crossed++;
	for (const value of CROSSED_VALUES)
		if (sameValue(value, 'crossed value')) crossed++;
	// a text with nothing to route (the lone half) is handed to neither
	const wantedCrossed = CROSSED.length - 1 + CROSSED_VALUES.length;
	ok(
		'a surrogate with no other half crosses to the module and back, and rewrites the same',
		crossed === wantedCrossed && tally.differ === 0 && valueTally.differ === 0,
		`${crossed} of ${wantedCrossed} ${JSON.stringify(differences[0] ?? null)}`,
	);
	let stray = 0;
	for (const sheet of STRAY)
		if (sameStyles(sheet, 'stylesheet', 'stray')) stray++;
	ok(
		'a closing bracket with nothing open is answered, and rewrites the same',
		stray === STRAY.length && tally.differ === 0,
		`${stray} of ${STRAY.length} ${JSON.stringify(differences[0] ?? null)}`,
	);
	let once = 0;
	for (const sheet of ONCE_DECLINED)
		if (sameStyles(sheet, 'stylesheet', 'once declined')) once++;
	ok(
		'deep nesting and a URL that begins with a byte order mark are answered, and rewrite the same',
		once === ONCE_DECLINED.length && tally.differ === 0,
		`${once} of ${ONCE_DECLINED.length} ${JSON.stringify(differences[0] ?? null).slice(0, 600)}`,
	);
	let deep = 0;
	const deepDifferences = [];
	for (const sheet of TOO_DEEP) {
		// as the callers of modifyCSS do when it throws
		let expected;
		let threw = false;
		try {
			expected = modifyCSS(sheet, url);
		} catch (error) {
			threw = true;
			expected = valueInJS(sheet, url);
		}
		const told = {};
		const got = attempt(() => modifyCSS(sheet, url, 'stylesheet', told));
		if (told.by === 'wasm' && got === expected) deep++;
		else
			deepDifferences.push({
				sheet: sheet.slice(0, 40),
				by: told.by,
				threw,
				expected: expected.slice(-80),
				got: got.slice(-80),
			});
	}
	ok(
		"nesting past where css-tree's stack ends is answered by the module, as css-tree or its callers answer it",
		deep === TOO_DEEP.length,
		`${deep} of ${TOO_DEEP.length} ${JSON.stringify(deepDifferences)}`,
	);
	{
		// and the module's answer is always the first of the two: what is too
		// deep is the expression's, the sheet around it is parsed
		const value = `${'f('.repeat(20000)}url(c)${')'.repeat(20000)}`;
		const around = '@import "g.css"; d { e: url(f) }';
		const told = {};
		const got = attempt(() =>
			modifyCSS(`a{b:${value}}${around}`, url, 'stylesheet', told),
		);
		ok(
			'the sheet around a value that is too deep is parsed all the same',
			told.by === 'wasm' &&
				got === `a{b:${valueInJS(value, url)}}${modifyCSS(around, url)}`,
			`${told.by} ${got.slice(-200)}`,
		);
	}
	let large = 0;
	for (const sheet of LARGE)
		if (sameStyles(sheet, 'stylesheet', 'large')) large++;
	// and the small ones after them, in buffers made again
	if (sameStyles(SHEETS[0], 'stylesheet', 'after large')) large++;
	ok(
		'a sheet and a routed URL larger than the module keeps are answered, and rewrite the same',
		large === LARGE.length + 1 && tally.differ === 0,
		`${large} of ${LARGE.length + 1} ${JSON.stringify(differences[0] ?? null).slice(0, 600)}`,
	);
	// css-tree keeps a token's offset in 24 bits: in a sheet past 16,777,215
	// units what follows that point is no longer parsed (a url() there is
	// routed by the expression, an @import's string is left as written and
	// loads from the origin, unproxied). The module's offsets are whole, and
	// it rewrites the sheet to its end.
	const head = 'a { b: url(c) }';
	const tail = 'd { e: url(f) } @import "g.css";';
	const filler = `/*${'x'.repeat(0x1000000)}*/`;
	const told = {};
	const whole = attempt(() =>
		modifyCSS(head + filler + tail, url, 'stylesheet', told),
	);
	ok(
		'a sheet past 16,777,215 units is rewritten to its end by the module',
		told.by === 'wasm' &&
			whole === modifyCSS(head, url) + filler + modifyCSS(tail, url),
		`${told.by} ${whole.length} ${whole.slice(0, 80)} ... ${whole.slice(-120)}`,
	);
}

// the repository's own stylesheets and pages
const pages = `${root}test/pages/`;
const pageSheets = [];
const pageMarkup = [];
for (const name of readdirSync(pages)) {
	if (!/\.(css|html|svg)$/.test(name)) continue;
	const text = readFileSync(pages + name, 'utf8');
	if (name.endsWith('.css')) pageSheets.push(text);
	else {
		pageMarkup.push(text);
		for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi))
			pageSheets.push(match[1]);
		for (const match of text.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi))
			LISTS.push(match[1]);
	}
}
{
	const before = { ...tally };
	for (const sheet of pageSheets) sameStyles(sheet, 'stylesheet', 'page');
	for (const list of LISTS) sameStyles(list, 'declarationList', 'page');
	ok(
		`the ${pageSheets.length} stylesheets of test/pages rewrite the same both ways`,
		tally.differ === before.differ,
		JSON.stringify({
			answered: tally.answered - before.answered,
			declined: tally.declined - before.declined,
			first: differences[0] ?? null,
		}),
	);
}

// markup
const MARKUP = [
	'<script>a()</script><style>b{}</style>',
	'<SCRIPT type="module">a</SCRIPT ><STYLE media=print>b{c:url(d)}</STYLE\n>',
	'<script src=a.js></script><script>b</script><script type=text/plain>c</script>',
	'<scripts>a</scripts><script-x>b</script><style_>c</style>',
	'<script>a</script x><script>b</script>',
	'<script>var s = "<\\/script>"; </scr' + 'ipt><script>c</script>',
	'<script>unclosed <style>a{}</style>',
	'<style>unclosed <script>a</script>',
	'<script',
	'<script>a</script ><script>b</script >',
	'<p>hé \u{1F600}</p><script>a("\u{1F600}")</script><style>é{}</style>',
	'<base href="/x/"><script>a</script>',
	'<BASE target=_top HREF = /x/><script>a</script>',
	'<base target=_top><a href=x><script>a</script>',
	'<basefont href=x><base href=x>',
	'<base data-href=x><base xhref=x><base href>',
	'<base\nhref\n=\n"x"',
	'<script>a</script><script>a</script><style>b</style><style>b</style>',
	'<script>  </script><style>\n</style><script>x</script>',
	'',
];
{
	for (const markup of MARKUP) sameMarkup(markup, 'markup');
	for (const markup of pageMarkup) sameMarkup(markup, 'page');
	ok(
		`${MARKUP.length} hand-written documents and the ${pageMarkup.length} pages of test/pages scan the same both ways`,
		markupTally.differ === 0,
		JSON.stringify(markupDifferences[0] ?? null),
	);
}

// a seeded fuzz: the same inputs on every run
function generator(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function mutate(text, random, tokens) {
	const pick = (list) => list[Math.floor(random() * list.length)];
	let result = text;
	for (let times = 1 + Math.floor(random() * 4); times > 0; times--) {
		const at = Math.floor(random() * (result.length + 1));
		const span = Math.floor(random() * 12);
		switch (Math.floor(random() * 5)) {
			case 0:
				result = result.slice(0, at) + result.slice(at + span);
				break;
			case 1:
			case 2:
				result = result.slice(0, at) + pick(tokens) + result.slice(at);
				break;
			case 3:
				result =
					result.slice(0, at) +
					result.slice(at, at + span * 4) +
					result.slice(at);
				break;
			default:
				result = result.slice(0, at);
		}
	}
	return result;
}
const CSS_TOKENS = [
	...'{}()[];:,!@#&*/\\"\'-+.<>%$ \n\t\r\f\0',
	'url(',
	'URL(',
	'url("',
	'/*',
	'*/',
	'@import ',
	'@media ',
	'@font-face ',
	'image-set(',
	'src(',
	'!important',
	'--x:',
	'<!--',
	'-->',
	'\\\n',
	'\\29 ',
	'u+',
	'1e',
	'é',
	'\u{1F600}',
	'﻿',
	'\ud83d',
	'\ude00',
	'%ED%A0%BD',
	'url(x y\\',
	'((((((((',
	'var(--a,',
	'{}',
	'a{b:url(c)}',
	'#url(',
	'%22',
	'%E0',
	'data:',
	'/stomp/css/',
	'/stomp/',
	'http://[',
	'https://other.example/',
	'layer(',
	'supports(',
	'selector(',
	':not(',
	':nth-child(',
	'2n+1',
	' of ',
	'[a=',
	' and ',
	'<=',
	'\u2028',
	'\u212a',
	'\u00a0',
	'\\',
	'\\"',
];
const MARKUP_TOKENS = [
	...'<>/="\' \n\t',
	'<script',
	'<script>',
	'</script>',
	'</script',
	'<style>',
	'</style>',
	'<style',
	'</STYLE >',
	'<base ',
	' href=',
	'href =',
	' ',
	' ',
	'﻿',
	'\u{1F600}',
	'\ud83d',
	'type=module',
	' src',
];
const ROUNDS = Number(process.env.SCANNER_FUZZ) || 6000;
{
	const before = { ...tally };
	const random = generator(0x5ca11e7);
	const seeds = [...SHEETS, ...pageSheets].filter(
		(sheet) => sheet.length < 4000,
	);
	for (let i = 0; i < ROUNDS; i++) {
		const seed = seeds[Math.floor(random() * seeds.length)];
		sameStyles(mutate(seed, random, CSS_TOKENS), 'stylesheet', `fuzz ${i}`);
	}
	const lists = LISTS.filter((list) => list);
	for (let i = 0; i < ROUNDS / 3; i++) {
		const seed = lists[Math.floor(random() * lists.length)];
		sameStyles(
			mutate(seed, random, CSS_TOKENS),
			'declarationList',
			`fuzz list ${i}`,
		);
	}
	const answered = tally.answered - before.answered;
	const declined = tally.declined - before.declined;
	ok(
		`${ROUNDS + ROUNDS / 3} mutated stylesheets and declaration lists rewrite the same both ways`,
		tally.differ === before.differ,
		JSON.stringify({ answered, declined, first: differences[0] ?? null }),
	);
	ok(
		'the module rewrites every one of them itself',
		answered > ROUNDS / 2 && declined === 0,
		JSON.stringify({ answered, declined, leftToJS }),
	);
}
{
	const before = { ...valueTally };
	const random = generator(0x7a1e5);
	const seeds = [
		...VALUES.filter((value) => value.length < 4000),
		...LISTS.filter((list) => list),
	];
	for (let i = 0; i < ROUNDS; i++) {
		const seed = seeds[Math.floor(random() * seeds.length)];
		sameValue(mutate(seed, random, CSS_TOKENS), `fuzz value ${i}`);
	}
	const answered = valueTally.answered - before.answered;
	const declined = valueTally.declined - before.declined;
	ok(
		`${ROUNDS} mutated values route the same both ways`,
		valueTally.differ === before.differ,
		JSON.stringify({ answered, declined, first: differences[0] ?? null }),
	);
	ok(
		'the module routes every one of them itself',
		answered > ROUNDS / 2 && declined === 0,
		JSON.stringify({ answered, declined, leftToJS }),
	);
}
{
	const before = markupTally.differ;
	const random = generator(0xd0c5);
	const seeds = [
		...MARKUP,
		...pageMarkup.filter((markup) => markup.length < 6000),
	];
	for (let i = 0; i < ROUNDS; i++) {
		const seed = seeds[Math.floor(random() * seeds.length)];
		sameMarkup(mutate(seed, random, MARKUP_TOKENS), `fuzz ${i}`);
	}
	ok(
		`${ROUNDS} mutated documents scan the same both ways`,
		markupTally.differ === before,
		JSON.stringify(markupDifferences[0] ?? null),
	);
}

// real stylesheets, when a corpus is at hand
if (process.env.SCANNER_CORPUS) {
	const sheets = [];
	const walk = (directory) => {
		for (const name of readdirSync(directory)) {
			const path = `${directory}/${name}`;
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.css'))
				sheets.push([path, readFileSync(path, 'utf8')]);
			else if (name.endsWith('.json'))
				try {
					const list = JSON.parse(readFileSync(path, 'utf8'));
					if (Array.isArray(list))
						list.forEach((text, i) => {
							if (typeof text === 'string') sheets.push([`${path}#${i}`, text]);
						});
				} catch (error) {
					// not a list of sheets
				}
		}
	};
	for (const directory of process.env.SCANNER_CORPUS.split(':'))
		walk(directory);
	const before = { ...tally };
	let bytesIn = 0;
	const timed = { js: 0, wasm: 0 };
	const declinedSheets = [];
	for (const [path, text] of sheets) {
		bytesIn += text.length;
		const declinedBefore = tally.declined;
		sameStyles(text, 'stylesheet', path);
		if (tally.declined > declinedBefore) declinedSheets.push(path);
		// each way again, timed (the first pass warmed both)
		let start = performance.now();
		attempt(() => modifyCSS(text, url, 'stylesheet'));
		timed.js += performance.now() - start;
		start = performance.now();
		attempt(() => modifyCSS(text, url, 'stylesheet', {}));
		timed.wasm += performance.now() - start;
	}
	ok(
		`the corpus (${sheets.length} stylesheets, ${(bytesIn / 1e6).toFixed(1)} MB) rewrites the same both ways`,
		tally.differ === before.differ,
		JSON.stringify({
			answered: tally.answered - before.answered,
			declined: tally.declined - before.declined,
			declinedSheets: declinedSheets.slice(0, 8),
			ms: { js: Math.round(timed.js), wasm: Math.round(timed.wasm) },
			first: differences[0]
				? {
						label: differences[0].label,
						expected: differences[0].expected.length,
						got: differences[0].got.length,
					}
				: null,
		}),
	);
}

console.error = quiet.error;
console.warn = quiet.warn;
await done();
