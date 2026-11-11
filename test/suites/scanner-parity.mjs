// The scanner module (rust/rwcss, dist/scanner.wasm) against the JavaScript
// it stands in for, in node: with `rewriter: 'wasm'` the service worker has
// the scanner find the pieces of a stylesheet that modifyCSS looks into
// (css-tree's lazy parse and walk otherwise) and a document's inline
// scripts and styles (three regular expressions otherwise). The contract is
// identical output, so every input here is rewritten both ways and the two
// are compared byte for byte: hand-written edge cases, every stylesheet and
// page of test/pages, a seeded fuzz of mutations of them (unbalanced
// brackets, cut strings, escapes, comments, non-ASCII), and with
// SCANNER_CORPUS=<dir>[:<dir>...] every .css file (and every string of a
// JSON array) under those directories. The scanner may decline an input
// (the JavaScript scan then does it); how often is reported, and the
// hand-written cases it must answer are checked to be answered.
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
	`export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { hasBase, inlineSources } from ${JSON.stringify(`${root}src/prewrite.ts`)};
export { adoptModules } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
export { scanMarkup, scanStyles } from ${JSON.stringify(`${root}src/wasm/scanner.ts`)};
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
const {
	modifyCSS,
	StompURL,
	parseConfig,
	hasBase,
	inlineSources,
	adoptModules,
	scanMarkup,
	scanStyles,
} = await import(`${bundle}?${Date.now()}`);

const { codec } = parseConfig({ directory: '/stomp/', codec: 'xor' }, 'k');
const url = new StompURL('https://example.com/dir/sheet.css', codec, '/stomp/');
// the rewriter reports URLs it cannot parse on the console
const quiet = { error: console.error, warn: console.warn };
console.error = () => {};
console.warn = () => {};

ok(
	'without the module every scan is declined',
	scanStyles('a{b:url(c)}', 'stylesheet') === null &&
		scanMarkup('<style>a{}</style>') === null,
);
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
/** `text` rewritten by css-tree's scan and by the scanner's: the same? */
function sameStyles(text, context, label) {
	const expected = attempt(() => modifyCSS(text, url, context));
	let answered = false;
	const got = attempt(() =>
		modifyCSS(text, url, context, (script, kind) => {
			const pieces = scanStyles(script, kind);
			answered = pieces !== null;
			return pieces;
		}),
	);
	// a sheet with nothing to route never reaches a scan
	if (answered) tally.answered++;
	else if (expected !== text || /url\(|image-set|src\(|import|\\/i.test(text))
		tally.declined++;
	if (got === expected) return answered;
	tally.differ++;
	if (differences.length < 5)
		differences.push({ label, context, text, expected, got });
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

// stylesheets the scanner must answer, each a shape of its own
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
// inputs whose answer css-tree takes from an earlier parse: declined
const DECLINED = ['a { b: url(c) } } d { e: url(f) }', ') a { b: url(c) }'];
// and some with nothing for the rewriter to route: never scanned
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
		'the scanner answers every one of them',
		answered === wanted,
		`${answered} of ${wanted} ${JSON.stringify(unanswered)}`,
	);
	let declined = 0;
	for (const sheet of DECLINED)
		if (!sameStyles(sheet, 'stylesheet', 'declined')) declined++;
	ok(
		'a closing bracket with nothing open is declined, and rewrites the same',
		declined === DECLINED.length && tally.differ === 0,
		`${declined} of ${DECLINED.length}`,
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
	'var(--a,',
	'{}',
	'a{b:url(c)}',
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
	const seeds = [
		...SHEETS,
		...pageSheets.filter((sheet) => sheet.length < 4000),
	];
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
		'the scanner answers most of them',
		answered > declined,
		JSON.stringify({ answered, declined }),
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
		if (
			!sameStyles(text, 'stylesheet', path) &&
			/url\(|image-set|src\(|import|\\/i.test(text)
		)
			declinedSheets.push(path);
		// each way again, timed (the first pass warmed both)
		let start = performance.now();
		attempt(() => modifyCSS(text, url, 'stylesheet'));
		timed.js += performance.now() - start;
		start = performance.now();
		attempt(() => modifyCSS(text, url, 'stylesheet', scanStyles));
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
