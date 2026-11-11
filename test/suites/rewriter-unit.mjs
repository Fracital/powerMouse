// The JS rewriter's output, checked in node: src/rewriteJS.ts is bundled with
// esbuild into test/out/ and run directly, so a shape can be asserted on the
// generated code itself (what the browser suites cannot see). Skips with a
// message when esbuild is not installed (a tarball install).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP rewriter-unit: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}rewriter-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { cannotRewrite, modifyJS, postMessageMethod, routeJS } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { planSplit, splitSources, stitch } from ${JSON.stringify(`${root}src/splitRewrite.ts`)};
export { routeHTML, modifyHTML, modifyRefresh, parseRefresh } from ${JSON.stringify(`${root}src/rewriteHTML.ts`)};
export { parseDataURI, createDataURI } from ${JSON.stringify(`${root}src/routeURL.ts`)};
export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { keepEmbedded, originalSource, sourceKey } from ${JSON.stringify(`${root}src/functionSource.ts`)};
export { inlineSources, packRewrite, PrewrittenTable, scriptPreamble } from ${JSON.stringify(`${root}src/prewrite.ts`)};
export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};
export { adoptModule } from ${JSON.stringify(`${root}src/wasm/thread.ts`)};
`,
);
const bundle = `${OUT}rewriter-unit.mjs`;
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
	cannotRewrite,
	modifyJS,
	planSplit,
	splitSources,
	stitch,
	postMessageMethod,
	routeJS,
	routeHTML,
	modifyHTML,
	modifyRefresh,
	parseRefresh,
	parseDataURI,
	createDataURI,
	modifyCSS,
	StompURL,
	parseConfig,
	keepEmbedded,
	sourceKey,
	originalSource,
	inlineSources,
	packRewrite,
	PrewrittenTable,
	scriptPreamble,
	compileModule,
	adoptModule,
} = await import(`${bundle}?${Date.now()}`);

// STOMP_REWRITER=wasm: the same checks with the wasm rewriter answering
// (rust/rwjs, the committed artifact), which splices its rewrites into the
// script's own text where the JavaScript rewriter prints its tree. A check
// of what a rewrite does holds for both; one of how the output is spelled
// states each backend's spelling.
const WASM = process.env.STOMP_REWRITER === 'wasm';
if (WASM)
	adoptModule(
		'core',
		await compileModule(readFileSync(`${root}assets/core.wasm`)),
	);
const config = {
	directory: '/stomp/',
	codec: 'xor',
	...(WASM && { rewriter: 'wasm' }),
};
const parsed = parseConfig(config, 'k');
const url = new StompURL('https://example.com/a.js', parsed.codec, '/stomp/');
// the rewriter warns on the console about a script it cannot parse
const warn = console.warn;
console.warn = () => {};
// the marks that let a function read back as written (src/functionSource.ts),
// and the statement that keeps the script's text: taken out where a check
// is about the shape of the rewritten code
const unmarked = (out) =>
	out
		.replace(
			/typeof (\S+?)!=="undefined"&&\1\.src\("[0-9a-z]+","[^"]*",function\(\)\{\/\*[^*]*\*\/\}\);/,
			'',
		)
		.replace(/\/\*[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+\*\//g, '');
const marked = (source, type = 'generic', extra = {}) =>
	modifyJS(source, url, { ...config, ...extra }, type);
// A check of how a rewrite is spelled is written in the JavaScript
// rewriter's spelling (what its printer makes of the tree). The wasm
// rewriter's output is the page's own text with the rewrites spliced in, so
// in its run such a check (`shape`) parses that output and prints it the
// same way first: it holds when the two are the same program, which is the
// contract between the backends (the wasm spelling itself is pinned in
// rust/rwjs's own tests and in the wasm-artifact suite). What does not
// parse is compared as it is.
let spelled = (out) => out;
if (WASM) {
	const { parse } = await import('meriyah');
	const { generate } = await import('@javascript-obfuscator/escodegen');
	spelled = (out, source, type) => {
		const lines = source.split('\n').length;
		try {
			const tree = parse(out, {
				module: type === 'genericModule' || type === 'workerModule',
				next: true,
				globalReturn: true,
				webcompat: true,
			});
			// (a `debugger` is rewritten to an empty statement, which the
			// JavaScript rewriter prints and so is kept)
			return generate(
				tree,
				source.length / lines > 200 ? { format: { compact: true } } : undefined,
			);
		} catch (error) {
			return out;
		}
	};
}
const rewrite = (source, type, extra) => unmarked(marked(source, type, extra));
/** `rewrite`, in the JavaScript rewriter's spelling whichever backend made it */
const shape = (source, type, extra) =>
	spelled(rewrite(source, type, extra), source, type);
const parses = (code) => {
	try {
		new Function(code);
		return true;
	} catch (error) {
		return false;
	}
};
{
	// a minified library comes back minified, about its own size (indented
	// and broken into lines it was up to twice that); code written to be read
	// keeps one statement per line, so a stack's line numbers stay near the
	// page's own. Its text is kept once beside the code, for its functions'
	// sources (src/functionSource.ts), which doubles what goes to the page
	const source = readFileSync(`${root}test/pages/vendor-three.min.js`, 'utf8');
	const full = marked(source);
	const out = unmarked(full);
	const readable = rewrite(
		'function f() {\n\tconst a = 1;\n\treturn a;\n}\nf();',
	);
	ok(
		'a minified library is rewritten to about its own size (twice that with its text), readable code keeps its lines',
		out.length < source.length * 1.25 &&
			full.length < source.length * 2.4 &&
			parses(full) &&
			readable.split('\n').length >= 4,
		`${source.length} -> ${out.length} (${full.length} with its text); ${JSON.stringify(readable)}`,
	);
}

{
	// an unforgeable reached through an earlier optional link keeps the
	// chain's short-circuit: get2 gets the flag and the rest stays optional
	const out = shape('a?.b.location.c; a?.b().top.x; (a?.b).location.c');
	ok(
		'an optional chain stays optional past an unforgeable link',
		/get2\(a\?\.b, 'location', '\(a\?\.b\.location\)', true\)\?\.c/.test(out) &&
			/get2\(a\?\.b\(\), 'top', '\(a\?\.b\(\)\.top\)', true\)\?\.x/.test(out) &&
			/get2\(a\?\.b, 'location', '\(\(a\?\.b\)\.location\)'\)\.c/.test(out) &&
			parses(out),
		out,
	);
}
{
	// the two comments DevTools reads survive: the name as written, the map
	// routed against the script (a data: map as it is); other comments go
	const out = rewrite(
		'x; // note\n/* block */\n//# sourceURL=named.js\n//# sourceMappingURL=app.js.map',
	);
	const inline = rewrite(
		'y;\n//# sourceMappingURL=data:application/json;base64,e30=',
	);
	ok(
		'sourceURL is kept and sourceMappingURL is routed',
		/\n\/\/# sourceURL=named\.js/.test(out) &&
			/\n\/\/# sourceMappingURL=\/stomp\/binary\/\S+$/.test(out) &&
			// (the JavaScript rewriter prints no other comment; the wasm one
			// leaves the page's text as it is)
			(WASM ? /note[^]*block/.test(out) : !/note|block/.test(out)) &&
			/sourceMappingURL=data:application\/json;base64,e30=$/.test(inline) &&
			parses(out),
		JSON.stringify([out, inline]),
	);
	// V8 names the script after the comment, so a stack shows it
	let stack = '';
	try {
		(0, eval)(
			rewrite('throw new Error("named")\n//# sourceURL=named-by-comment.js'),
		);
	} catch (error) {
		stack = error.stack;
	}
	ok(
		'a stack names the script after its sourceURL comment',
		/named-by-comment\.js/.test(stack),
		stack,
	);
}
{
	// a data: body is percent-encoded (RFC 2397): decoded before the rewrite,
	// encoded again after; a base64 body the same way
	const full = { ...config, ...parsed };
	const js = routeJS(
		new StompURL(new URL('data:text/javascript,top.x%3B'), url),
		url,
		full,
		'generic',
	);
	const b64 = routeJS(
		new StompURL(
			new URL(
				`data:text/javascript;base64,${Buffer.from('top.x').toString('base64')}`,
			),
			url,
		),
		url,
		full,
		'generic',
	);
	const html = routeHTML(
		new StompURL(
			new URL('data:text/html,%3Cscript%3Etop.x%3C%2Fscript%3E'),
			url,
		),
		url,
		full,
		false,
		false,
	);
	const decoded = (uri) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
	ok(
		'data: bodies are percent-decoded before rewriting and encoded again',
		/^data:text\/javascript,/.test(js) &&
			/\$s\$j\.get\(top, ['"]top['"]\)\.x/.test(decoded(js)) &&
			/^data:text\/javascript;base64,/.test(b64) &&
			/\$s\$j\.get\(top, ['"]top['"]\)/.test(
				Buffer.from(b64.split(',')[1], 'base64').toString(),
			) &&
			/^data:text\/html,/.test(html) &&
			// the shell carries the decoded document; its scripts are rewritten
			// by the page's inject at load
			/injectDocument\.js/.test(decoded(html)) &&
			/top\.x/.test(decoded(html)),
		JSON.stringify([js, decoded(html).slice(0, 200)]),
	);
}
{
	// the directive prologue stays first: before the worker bootstrap and
	// before a caller's preamble; a module keeps its body as it is
	const worker = rewrite("'use strict';\n'other';\nx = top;", 'worker');
	const inline = modifyJS(
		"'use strict';\nx = top;",
		url,
		{ ...config, ...parsed },
		'generic',
		'document.currentScript.textContent = "x";',
	);
	const mod = rewrite("'use strict';\nexport const a = top;", 'genericModule');
	ok(
		'the directive prologue comes before the worker bootstrap and a preamble',
		/^["']use strict["'];\s*["']other["'];if \(!\("[^"]+" in globalThis\) && !globalThis\.createClient\)/.test(
			worker,
		) &&
			/^["']use strict["'];document\.currentScript\.textContent = "x";/.test(
				inline,
			) &&
			/^import\.meta\.url/.test(mod) &&
			parses(inline),
		JSON.stringify([
			worker.slice(0, 80),
			inline.slice(0, 80),
			mod.slice(0, 40),
		]),
	);
}
{
	// the refresh value is parsed like the browser does: any case for `url`,
	// quotes dropped, a comma separator, a URL without `url=`, a bare time
	const cases = {
		'5; url=/a': ['5', '/a'],
		'5;URL=/a': ['5', '/a'],
		"0; url='/a b'": ['0', '/a b'],
		'3 , url = "/a"': ['3', '/a'],
		'4; /plain': ['4', '/plain'],
		7: ['7', null],
		'  2;url=https://other.example/x': ['2', 'https://other.example/x'],
	};
	const got = Object.fromEntries(
		Object.entries(cases).map(([value]) => {
			const parsed = parseRefresh(value);
			return [value, [parsed.time, parsed.url]];
		}),
	);
	const full = { ...config, ...parsed };
	const routed = modifyRefresh('5;URL="/a"', url, full);
	ok(
		'refresh values are parsed like the browser and the URL routed',
		JSON.stringify(got) === JSON.stringify(cases) &&
			/^5; url=\/stomp\/html\//.test(routed) &&
			modifyRefresh('7', url, full) === '7' &&
			modifyRefresh('1; url=javascript:x', url, full) === '1; url=javascript:x',
		JSON.stringify([got, routed]),
	);
}
{
	// every way of posting a message goes through the caller's access API: a
	// call is `post`, and any other way to another window's postMessage is a
	// read of it (`.call`, `.apply`, `Reflect.apply`, a detached copy), which
	// the access API answers with a function of the caller's realm
	const out = shape(
		"w.postMessage(m, '*'); w?.postMessage(m); w.postMessage.call(w2, m, o); w.postMessage.apply(w2, list); Reflect.apply(w.postMessage, w2, list); const pm = w.postMessage; port.postMessage(m); x.postmessage(m)",
	);
	ok(
		'postMessage calls in every shape go through the access API',
		/\$s\$j\.post\(w,\s*\[\s*m,\s*'\*'\s*\],\s*false,\s*'w\.postMessage\(0, 0\)'\)/.test(
			out,
		) &&
			/\$s\$j\.post\(w,\s*\[\s*m\s*\],\s*true,\s*'/.test(out) &&
			/\$s\$j\.call3\(w,\s*'postMessage',\s*'call',\s*\[\s*w2,\s*m,\s*o\s*\],\s*'/.test(
				out,
			) &&
			/\$s\$j\.call3\(w,\s*'postMessage',\s*'apply',\s*\[\s*w2,\s*list\s*\],\s*'/.test(
				out,
			) &&
			/Reflect\.apply\(\$s\$j\.get2\(w,\s*'postMessage',\s*'/.test(out) &&
			/pm\s*=\s*\$s\$j\.get2\(w,\s*'postMessage',\s*'/.test(out) &&
			/\$s\$j\.post\(port,\s*\[\s*m\s*\],\s*false,\s*'/.test(out) &&
			/x\.postmessage\(m\)/.test(out) &&
			parses(out),
		out,
	);
}
{
	// an `in` whose key is or may be a helper name asks the access API (the
	// helpers are on the window, natively nothing is); a literal key of
	// anything else, a private name and for...in are left as they are
	const out = shape(
		"'$s$j' in window; k in o; `${k}` in o; o.k in top; '$P$s' in w; 'x' in o; 0 in a; class C { #p; m(o) { return #p in o; } } for (k in o);",
	);
	ok(
		'an in that may find a helper name goes through the access API',
		/\$s\$j\.has\('\$s\$j',\s*window\)/.test(out) &&
			/\$s\$j\.has\(k,\s*o\)/.test(out) &&
			/\$s\$j\.has\(`[^`]*`,\s*o\)/.test(out) &&
			/\$s\$j\.has\(o\.k,\s*\$s\$j\.get\(top,\s*'top'\)\)/.test(out) &&
			/\$s\$j\.has\('\$P\$s',\s*w\)/.test(out) &&
			/'x' in o/.test(out) &&
			/\b0 in a/.test(out) &&
			/#p in o/.test(out) &&
			/for \(k in o\)/.test(out) &&
			(out.match(/\.has\(/g) || []).length === 5 &&
			parses(out),
		out,
	);
}
{
	// a top-level `var` binding location in a classic script assigns the
	// window's location: bound to a temporary and routed like `location = v`;
	// inside a function, or in a module, left alone
	const top = shape(
		"var location = 'x'; var {a, location} = o; var [location] = l;",
	);
	const inner = shape('function f() { var location = 1; }');
	const mod = shape("var location = 'x';", 'genericModule');
	ok(
		'a top-level var binding of location routes the assignment',
		(top.match(/\$s\$j\.set1\(location, 'location'/g) || []).length === 3 &&
			/var \$s\$jl0 = 'x'/.test(top) &&
			/location: \$s\$jl0/.test(top) &&
			/var \[\$s\$jl0\] = l/.test(top) &&
			!/set1/.test(inner) &&
			/var location = 'x';$/.test(mod) &&
			parses(top),
		JSON.stringify([top, inner]),
	);
	// a location the pattern or loop head of an assignment writes is a
	// reference: it becomes the member `$s$j.ref1(location, setter).value`
	// (`ref2(object, key)` for `x.location`), whose write routes; bindings
	// and other targets stay as written (a member target named `top` was a
	// get2 call, which is no assignment target)
	const targets = shape(
		'[location] = a; ({location} = o); ({a: location = 1} = o); [...location] = a; for (location of a); for (location in o);',
	);
	const members = shape(
		"[top.location] = a; ({a: window['location']} = o); for (frames[0].location of a);",
	);
	const kept = [
		// (a member whose key is known only when it runs is a reference too:
		// the key may be `location`)
		[
			'[a[i], a[j]] = [b, c];',
			'[$s$j.ref2(a, i).value, $s$j.ref2(a, j).value] = [\n    b,\n    c\n];',
		],
		['[a[0], a.x] = [b, c];', '[a[0], a.x] = [\n    b,\n    c\n];'],
		['({x: a.top, y: [b]} = o);', '({\n    x: a.top,\n    y: [b]\n} = o);'],
		['for (a.top of b);', 'for (a.top of b);'],
		['for (k in o) f(k);', 'for (k in o)\n    f(k);'],
		['function f([location]) {}', 'function f([location]) {\n}'],
		// (a catch clause's pattern is read through the access API, like a
		// parameter's)
		[
			'try {} catch ({location}) {}',
			"try {\n} catch ($s$jc) {\n    let {location} = $s$j.pattern($s$jc, { 'location': true }, '{location}=$s$jc');\n}",
		],
	];
	ok(
		'a location an assignment pattern or a loop head writes routes',
		(targets.match(/\$s\$j\.ref1\(location, t\$v =>/g) || []).length === 6 &&
			/location: \$s\$j\.ref1\(/.test(targets) &&
			/\.value = 1/.test(targets) &&
			/for \(\$s\$j\.ref1\(location, t\$v =>\s*\(?location = t\$v\)?\)\.value of a\)/.test(
				targets,
			) &&
			members.includes(
				"[$s$j.ref2($s$j.get(top, 'top'), 'location').value] = a",
			) &&
			members.includes("a: $s$j.ref2(window, 'location').value") &&
			members.includes(
				"for ($s$j.ref2($s$j.get2(frames, 0, '(frames[0])'), 'location').value of a)",
			) &&
			kept.every(([code, out]) => shape(code) === out) &&
			parses(targets) &&
			parses(members),
		JSON.stringify([targets, members, kept.map(([code]) => shape(code))]),
	);
	// `eval` as a pattern's target is a reference too, whose write the access
	// API keeps the eval itself (`[eval] = [saved]` stored the stand-in)
	// (compared without white space and parentheses, which the generator
	// puts around an arrow's assignment as it prints the tree)
	const loose = (text) => text.replace(/[\s()]+/g, '');
	const evals = shape('[eval] = [e]; ({ eval } = o); for (eval of a);');
	ok(
		'an eval an assignment pattern or a loop head writes keeps it the eval',
		loose(evals).includes(
			loose("[$s$j.ref1(eval, t$v => eval = t$v, 'eval').value] = [e];"),
		) &&
			loose(evals).includes(
				loose("{eval: $s$j.ref1(eval, t$v => eval = t$v, 'eval').value}"),
			) &&
			loose(evals).includes(
				loose("for ($s$j.ref1(eval, t$v => eval = t$v, 'eval').value of a)"),
			) &&
			parses(evals),
		evals,
	);
	// a literal index read can be a child window of another proxied site:
	// routed like a computed key; a call, a construction, a write, an update,
	// a delete or a tag through an index stays as written, and so does a key
	// that is no array index
	{
		const routed = ['frames[0]', "parent['1']", 'x = w[2].document'].map(
			(code) => shape(code),
		);
		const kept = [
			'a[0] = 1;',
			'a[0]++;',
			'a[0](x);',
			'new a[0]();',
			'delete a[0];',
			'a[0]`t`;',
			'a[1.5];',
			"a['01'];",
		];
		ok(
			'a literal index read goes through the access API, nothing else by index does',
			routed[0].startsWith('$s$j.get2(frames, 0, ') &&
				routed[1].startsWith("$s$j.get2(parent, '1', ") &&
				routed[2].startsWith('x = $s$j.get2(w, 2, ') &&
				routed[2].endsWith(').document;') &&
				kept.every((code) => !shape(code).includes('$s$j')),
			JSON.stringify([routed, kept.map((code) => shape(code))]),
		);
	}
	// a classic script's var outside a function, in a block or a loop head,
	// assigns the window's location like one at the top; its initialiser is
	// rewritten like any expression
	const nested = shape(
		'{ var location = top.a; } if (x) var location = b; for (var location of a) f(); for (var [location] in o); for (var location = c, i = 0; i < 1; i++);',
	);
	const local = shape(
		'function f() { { var location = 1; } for (var location of a); } class A { static { var location = 1; } }',
	);
	ok(
		'a var binding of location outside any function routes the assignment',
		(nested.match(/\$s\$j\.set1\(location, 'location'/g) || []).length === 5 &&
			nested.includes("var $s$jl0 = $s$j.get(top, 'top').a;") &&
			/for \(var \$s\$jl0 of a\) \{\s*\$s\$j\.set1\(location/.test(nested) &&
			/for \(var \$s\$jl0 = c, i = 0, \$s\$jl1 = \(?\$s\$j\.set1/.test(
				nested,
			) &&
			!/set1/.test(local) &&
			parses(nested),
		JSON.stringify([nested, local]),
	);
	// a loop whose head is that var and whose source the access API iterates
	// is replaced twice; the source stays the walk's through both
	const twice = shape(
		'for (var location of ((s = top), top.list)) f(top); for (var location of o[k]);',
	);
	ok(
		'a loop replaced for its head and for its source has its source rewritten',
		twice.includes(
			"of $s$j.iter((s = $s$j.get(top, 'top'), $s$j.get(top, 'top').list), 'of', '(s = top), top.list')",
		) &&
			twice.includes("of $s$j.iter($s$j.get2(o, k, '(o[k])'), 'of', 'o[k]')") &&
			parses(twice),
		twice,
	);
	// a base64 data: body is UTF-8 text
	const uri = createDataURI({
		mime: 'text/css',
		attributes: ['base64'],
		data: 'a::after { content: "é ✓" }',
	});
	ok(
		'a base64 data: body round-trips as UTF-8',
		parseDataURI(uri.slice('data:'.length)).data ===
			'a::after { content: "é ✓" }' && /^data:text\/css;base64,/.test(uri),
		JSON.stringify([uri, parseDataURI(uri.slice(5)).data]),
	);
}
{
	// a block under a malformed at-rule prelude is raw text to the parser:
	// its url()s are routed all the same
	const css = modifyCSS(
		'@media screen and (min-width: 100px { a { background: url(/z) } } b { background: url(/w) }',
		url,
	);
	ok(
		'url()s inside a raw block the parser could not shape are routed',
		(css.match(/\/stomp\/binary\//g) || []).length === 2 &&
			!/background: url\(\/z\)/.test(css),
		css,
	);
}
{
	// a stylesheet is parsed with its values, preludes and selectors as raw
	// text, and only a piece that could hold a URL is parsed in full: every
	// shape a URL comes in is still routed, and the rest is left byte for byte
	const routes = (css) => [
		(css.match(/\/stomp\/binary\//g) || []).length,
		(css.match(/\/stomp\/css\//g) || []).length,
	];
	const cases = [
		['a{background:url(x.png)}', [1, 0]],
		['a{background:URL( "x.png" ) !important}', [1, 0]],
		['@import "imp.css";', [0, 1]],
		["@import 'a.css' layer(x) supports(display:grid);", [0, 1]],
		['@import url(imp.css) screen;', [0, 1]],
		['a{} @import "late.css";', [0, 1]],
		['a{background-image:image-set("a.png" 1x, url(b.png) 2x)}', [2, 0]],
		['@font-face{src:url(a.woff2) format("woff2"),local(x)}', [1, 0]],
		['a{--x:url(a.png);--y: url( "b.png" )}', [2, 0]],
		['@media (min-width:1px){a{background:url(a.png)}}', [1, 0]],
		['@supports (background:url(a.png)){a{b:c}}', [1, 0]],
		['@container style(--x: url(a.png)){a{b:url(c.png)}}', [2, 0]],
		['a[href="url(x)"]{background:url(y.png)}', [1, 0]],
		['a{background:url(a.png); b{background:url(c.png)}}', [2, 0]],
		['a{content:"url(not)";color:red}', [0, 0]],
	];
	const wrong = cases
		.map(([css, want]) => [css, routes(modifyCSS(css, url)), want])
		.filter(([, got, want]) => got.join() !== want.join());
	const untouched = 'a{color:red}\n@media (x){b{margin:0 !important}}';
	ok(
		'every shape a URL takes in a stylesheet is routed, and a sheet without one is left as written',
		wrong.length === 0 && modifyCSS(untouched, url) === untouched,
		JSON.stringify(wrong),
	);
	ok(
		'a style attribute (a declaration list) routes its url()s the same way',
		routes(
			modifyCSS(
				'background:url(a.png);--x:url(b.png);color:red',
				url,
				'declarationList',
			),
		).join() === '2,0',
	);
	if (process.env.SKIP_TIMING !== '1') {
		// a large sheet with a single url(): the full parse it replaces was
		// nearly all of the rewrite (YouTube's 3 MB stylesheet took 2 s, the
		// lazy parse 0.13 s); a ratio to css-tree's full parse of the same text,
		// so a slow runner does not change the verdict
		const { parse } = await import('css-tree');
		const rules = [];
		for (let i = 0; i < 12000; i++)
			rules.push(
				`ytd-rich-grid-renderer[is-two-columns] #contents>ytd-rich-item-renderer.r${i}:not([hidden]):hover,.a${i} .b>.c~d{margin:var(--m${i % 9},${i % 9}px) calc(1px + ${i % 7}%);color:var(--yt-spec-text-primary,#0f0f0f);transition:opacity .2s cubic-bezier(.4,0,.2,1),transform .3s;font:500 1.4rem/2rem "YouTube Sans",Roboto,sans-serif}`,
			);
		rules.splice(6000, 0, '.icon{background:url(/icon.png) no-repeat}');
		const sheet = rules.join('\n');
		// the best of three, alternating, so a busy machine slows both alike
		const time = (fn) => {
			const start = performance.now();
			fn();
			return performance.now() - start;
		};
		let full = Infinity;
		let lazy = Infinity;
		let out = '';
		for (let i = 0; i < 3; i++) {
			full = Math.min(
				full,
				time(() => parse(sheet, { positions: true })),
			);
			lazy = Math.min(
				lazy,
				time(() => (out = modifyCSS(sheet, url))),
			);
		}
		ok(
			'a large stylesheet with one url() rewrites in a fraction of a full parse of it',
			lazy < full * 0.75 && routes(out).join() === '1,0',
			JSON.stringify({
				bytes: sheet.length,
				full: Math.round(full),
				lazy: Math.round(lazy),
			}),
		);
	}
}
{
	// testharness's fetch_tests_from_window(win) posts to the window it was
	// given; after a blocked window.open that is null, and the rewritten call
	// must fail the way the original does (it threw "Function.prototype.apply
	// was called on undefined" from inside the access API)
	const access = {
		post: (target, args, optional) => {
			const method = postMessageMethod(target, optional);
			return method === undefined
				? undefined
				: Reflect.apply(method, target, args);
		},
		poster: (target) =>
			postMessageMethod(target, true) === undefined
				? undefined
				: (...args) => access.post(target, args, true),
	};
	const run = (code, remote) => {
		try {
			return String(new Function('remote', '$s$j', code)(remote, access));
		} catch (error) {
			return `${error.constructor.name}: ${error.message}`;
		}
	};
	const shapes = [
		"remote.postMessage({ type: 'getmessages' }, '*')",
		"return remote?.postMessage({ type: 'getmessages' }, '*')",
		// an argument that does work goes in the lazy form (poster)
		"return remote?.postMessage(JSON.stringify({ type: 'getmessages' }), '*')",
	];
	const receivers = [null, undefined, { postMessage: () => 'posted' }];
	const got = [];
	const want = [];
	for (const source of shapes)
		for (const remote of receivers) {
			want.push(run(source, remote));
			got.push(run(rewrite(source), remote));
		}
	// a receiver whose postMessage is not callable throws a TypeError too
	// (V8 names the expression in the message; the access API cannot)
	const uncallable = run(rewrite(shapes[0]), { postMessage: 1 });
	ok(
		'a rewritten postMessage call on null or undefined throws like the original',
		JSON.stringify(got) === JSON.stringify(want) &&
			/^TypeError: /.test(uncallable),
		JSON.stringify({ got, want, uncallable }),
	);
}
{
	const out = rewrite('debugger; if (a) debugger; x: debugger; { debugger }');
	ok(
		'debugger statements are removed',
		!/debugger/.test(out) && parses(out),
		out,
	);
}
{
	const out = shape('top; location.href; eval(x)');
	ok(
		'reads of unforgeables go through the access API',
		/\$s\$j\.get\(top, 'top'\)/.test(out) && parses(out),
		out,
	);
}
{
	const out = shape("import('./m.js')");
	ok(
		'a classic script passes its own URL as the import base',
		out.includes("$s$j.import('https://example.com/a.js', './m.js')"),
		out,
	);
	const module = shape("import('./m.js')", 'genericModule');
	ok(
		'a module passes import.meta.url and defines import.meta.resolve',
		module.includes('$s$j.import(import.meta.url,') &&
			module.includes('import.meta.resolve = '),
		module,
	);
}
{
	const out = shape('const { a: { top: t } } = o;');
	ok(
		'a nested pattern wraps its source with the keys to follow',
		/\$s\$j\.pattern\(o, \{\s*'a': \{\s*'top': true\s*\}\s*\}, '\{ a: \{ top: t \} \} = o'\)/.test(
			out,
		) && parses(out),
		out,
	);
}
{
	// an operation V8 would name in its message by printing a helper's call
	// (`$s$j.get(...).foo is not a function`) is the access API's, given the
	// page's text to name instead; anything else is left as it was
	const shapes = {
		'location.foo()': `$s$j.call2($s$j.get(location, 'location'), 'foo', [], 'location.foo()');`,
		'o[k].x(a)': `$s$j.call3(o, k, 'x', [a], 'o[k].x(0)');`,
		'location.x.y(a)': `$s$j.call2($s$j.get(location, 'location').x, 'y', [a], 'location.x.y(0)');`,
		'top.x(f())': `$s$j.method($s$j.get(top, 'top'), false, false, 'top.x(0)')?.('x')?.(f());`,
		'top()': `$s$j.fcall($s$j.get(top, 'top'), [], 'top()');`,
		'o[k](a)(b)': `$s$j.fcall($s$j.call2(o, k, [a], 'o[k](0)'), [b], 'o[k](a)(0)');`,
		'new location.x()': `$s$j.new2($s$j.get(location, 'location'), 'x', [], 'new (location.x)()');`,
		'new top()': `$s$j.fnew($s$j.get(top, 'top'), [], 'new (top)()');`,
		'[...location]': `[...$s$j.iter($s$j.get(location, 'location'), 'spread', 'location')];`,
		'f(...o[k])': `f(...$s$j.iter($s$j.get2(o, k, '(o[k])'), 'args', 'o[k]'));`,
		'for (x of top);': `for (x of $s$j.iter($s$j.get(top, 'top'), 'of', 'top'));`,
		'const [a] = o[k];': `const [a] = $s$j.iter($s$j.get2(o, k, '(o[k])'), 'array', 'o[k]');`,
		'[a] = o[k];': `[a] = $s$j.iter($s$j.get2(o, k, '(o[k])'), 'assign', 'o[k]');`,
		'const { a } = top.x;': `const {a} = $s$j.coerce($s$j.get(top, 'top').x, '{ a } = top.x');`,
		// which links of a chain short-circuit (1 the object's, 2 the call's)
		'o?.[k]();': `$s$j.call2(o, k, [], 'o?.[k]()', 1);`,
		'o[k]?.();': `$s$j.call2(o, k, [], 'o[k]?.()', 2);`,
		// a?.[k].x: an undefined a[k] throws reading x, as natively
		'o?.[k].x;': `$s$j.lazy(o)?.(k).x;`,
		// untouched: nothing in them is a helper's
		'a.b.c(d); new A.B(); [...a.b]; for (x of a()); const { a } = b.c;': `a.b.c(d);\nnew A.B();\n[...a.b];\nfor (x of a());\nconst {a} = b.c;`,
	};
	const got = Object.fromEntries(
		Object.keys(shapes).map((source) => [source, shape(source)]),
	);
	const wrong = Object.keys(shapes).filter(
		(source) =>
			got[source].replace(/\s+/g, ' ') !== shapes[source].replace(/\s+/g, ' '),
	);
	ok(
		'an operation that would name a helper in its error is the access API',
		wrong.length === 0,
		wrong.map((source) => `${source} => ${got[source]}`).join(' | '),
	);
}
{
	const out = rewrite('const f = ({ top: t }, b) => t;');
	ok(
		'a destructured parameter moves into the body as var',
		/\(\$s\$ja0, b\) => \{\s*var \{\s*top: t\s*\} = \$s\$j\.pattern\(\$s\$ja0/.test(
			out,
		) && parses(out),
		out,
	);
	// a later parameter that refers to a name the pattern binds follows it
	// into the body; its own parameter keeps a default, so the function's
	// length is what it was
	const later = shape(
		'function f({ top: t }, b = t, c, [d = t] = [], ...[e = t]) {}',
	);
	ok(
		'a parameter that refers to a hoisted pattern is taken in the body after it',
		later.includes(
			'function f($s$ja0, $s$ja1 = void 0, c, $s$ja3 = void 0, ...$s$ja4) {',
		) &&
			// (the text the error names is the backend's own)
			later
				.replace(/'\{[^']*\}=\$s\$ja0'/, "'{top:t}=$s$ja0'")
				.includes(
					"var {top: t} = $s$j.pattern($s$ja0, { 'top': true }, '{top:t}=$s$ja0'), b = $s$ja1 === void 0 ? t : $s$ja1, [d = t] = $s$ja3 === void 0 ? [] : $s$ja3, [e = t] = $s$ja4;",
				) &&
			parses(later),
		later,
	);
}
{
	const source = 'var 1 = 2;';
	ok(
		'a script the rewriter cannot parse comes back as it was',
		rewrite(source) === source,
	);
	const strict = rewrite(source, 'generic', { allowInvalidJs: false });
	ok(
		'allowInvalidJs: false turns it into a thrown SyntaxError',
		/^throw new SyntaxError\("Stomp could not rewrite https:\/\/example\.com\/a\.js: /.test(
			strict,
		) && parses(strict),
		strict,
	);
	// one the browser would run must not run unrewritten: the JavaScript
	// rewriter's parser refuses a reserved word of strict code as a name in a
	// generator, which V8 takes in sloppy code
	const js = { rewriter: 'js' };
	// one the browser would run must not run unrewritten, where the rewrite
	// fails (its parser takes what V8 takes: what is left is a rewrite that
	// throws, which this calls as the rewriter does)
	const jsConfig = { ...config, ...js };
	const taken = 'function* g() { implements = 1 }\ntop.location = "/x";';
	const refused = cannotRewrite(taken, url, jsConfig, 'generic', 'a test');
	ok(
		'one the browser would run goes with an end no browser compiles',
		parses(taken) &&
			refused.startsWith(taken) &&
			refused.includes('#STomp_could_not_rewrite_this_script') &&
			!parses(refused),
		refused,
	);
	const module = cannotRewrite(
		'a() = 1;\ntop.x = 1;',
		url,
		jsConfig,
		'genericModule',
		'a test',
	);
	ok(
		'so does a module (V8 takes a call assigned to, a ReferenceError when it runs)',
		module.includes('#STomp_could_not_rewrite_this_script'),
		module,
	);
	ok(
		'one the browser refuses goes as it came',
		cannotRewrite('var 1 = 2;', url, jsConfig, 'generic', 'a test') ===
			'var 1 = 2;',
	);
	ok(
		'a part of a split script it cannot rewrite comes back as it went',
		modifyJS('var 1 = 2;', url, jsConfig, 'generic', '', true) === 'var 1 = 2;',
	);
	// and its parser (vendor/meriyah, patched) takes what V8 takes and
	// meriyah refused: each of these is rewritten
	for (const [what, source, type = 'generic'] of [
		[
			'a reserved word of strict code as a name in a generator',
			'function* g() { implements = 1; var static; }\ntop.x = 1;',
		],
		[
			'a call assigned to in strict code',
			'"use strict"; f() = top;',
			'generic',
		],
		['a call assigned to in a module', 'a()++;\nx = top;', 'genericModule'],
		[
			'super() assigned to',
			'class A extends B { constructor() { super() = 1 } }\nx = top;',
		],
		[
			'a string that is no directive',
			"'use strict'\n.length; with (o) x = top;",
		],
		['a prologue that ended', "'\\01' + 1; 'use strict'; with (o) x = top;"],
		[
			'sloppy code after a strict function',
			'function f() { "use strict" } x = top + 010;',
		],
		['sloppy code after a class', 'class A {} x = top + 010;'],
		[
			'__proto__ twice in a loop head',
			'for ({ __proto__: a, __proto__: b } of top);',
		],
		['a template tagged by a template', 'x = top`\\xg``\\1`;'],
		['in in import() in a loop head', 'for (import(a in top);;);'],
		['#a in o as an element', 'class A { #a; m() { return [#a in top]; } }'],
		[
			'an optional private chain assigned to',
			'class A { #a; m() { this?.#a = top; } }',
		],
		['using static in sloppy code', 'function f() { using static = top; }'],
		[
			'an escaped await as a function name in an async function',
			'async function f() { return (function aw\\u0061it() { return top; }); }',
		],
		[
			'an escaped eval bound in strict code',
			'class A { m(\\u0065val) { return top; } }',
		],
	]) {
		const out = rewrite(source, type, js);
		ok(
			`rewritten, not refused: ${what}`,
			!out.includes('STomp_could_not_rewrite') &&
				out !== source &&
				/\$s\$j/.test(out),
			out,
		);
	}
	// a name written with an escape is printed as written
	const lets = rewrite('for (l\\u0065t of a);', 'generic', js);
	ok(
		'a name written with an escape is printed as the page wrote it',
		lets.includes('l\\u0065t') && parses(lets),
		lets,
	);
	const evals = rewrite('class A { m() { \\u0065val = top } }', 'generic', js);
	ok(
		'and an escaped eval assigned to, which V8 13.7 takes in a method',
		!/(^|[^\\\w])eval\s*=[^=]/.test(evals) &&
			evals.includes('\\u0065val') &&
			parses(evals),
		evals,
	);
}
console.warn = warn;

// vendor/meriyah/meriyah.mjs is the package's dist/meriyah.mjs with
// vendor/meriyah/meriyah.patch applied (and a header): held while the
// package installed is the one the patch names
{
	const { createHash } = await import('node:crypto');
	const patch = readFileSync(`${root}vendor/meriyah/meriyah.patch`, 'utf8');
	const upstream = readFileSync(
		`${root}node_modules/meriyah/dist/meriyah.mjs`,
		'utf8',
	);
	const named = /sha256 ([0-9a-f]+)\s+([0-9a-f]+)\)/.exec(patch);
	const digest = createHash('sha256').update(upstream).digest('hex');
	if (named && digest === named[1] + named[2]) {
		// the hunks, in order, each its context and removals replaced
		const lines = upstream.split('\n');
		const out = [];
		let at = 0;
		let fits = true;
		for (const hunk of patch.split(/^@@ /m).slice(1)) {
			const [, from] = /^-(\d+)/.exec(hunk);
			const body = hunk.split('\n').slice(1);
			while (at < +from - 1) out.push(lines[at++]);
			for (const line of body) {
				if (line.startsWith('+')) out.push(line.slice(1));
				else if (line.startsWith('-') || line.startsWith(' ')) {
					if (lines[at] !== line.slice(1)) fits = false;
					if (line.startsWith(' ')) out.push(lines[at]);
					at++;
				}
			}
		}
		while (at < lines.length) out.push(lines[at++]);
		const vendored = readFileSync(`${root}vendor/meriyah/meriyah.mjs`, 'utf8');
		ok(
			'the vendored meriyah is the package with its patch',
			fits && vendored.endsWith(`\n\n${out.join('\n')}`),
		);
	} else console.log('(the installed meriyah is not the one the patch names)');
}

// `o[k] = v` becomes set2(o, k, operate, v): the value is an expression like
// any other, so `top`, `location` and the rest inside it are rewritten too
// (they were handed to set2 raw: `cache[key] = top` stored the real top)
{
	const value = shape('o[k] = top');
	const nested = shape('o[k] = { a: () => location.href }');
	const compound = shape('o[k] += location.href');
	ok(
		'a computed member assignment rewrites the value it assigns',
		value.includes("$s$j.get(top, 'top')") &&
			nested.includes("$s$j.get(location, 'location')") &&
			compound.includes("$s$j.get(location, 'location')"),
		[value, nested, compound].join('\n'),
	);
}

// helper names: a config's own names replace the four defaults everywhere the
// rewriter emits them (the access API, the worker preamble, the HTML shell)
{
	const names = {
		access: 'qA',
		globalProxy: 'qB',
		globalName: 'qC',
		client: 'qD',
	};
	const generic = shape('o[k] = location.href; top.postMessage(1)', 'generic', {
		names,
	});
	const worker = rewrite('self.onmessage = () => location.href', 'worker', {
		names,
	});
	const shell = modifyHTML('<p>x</p>', url, { ...config, names }, false);
	ok(
		'a config with its own helper names is rewritten with them',
		generic.includes("qA.get(location, 'location')") &&
			generic.includes('qA.post(') &&
			!generic.includes('$s$j') &&
			worker.includes('qD.apply()') &&
			worker.includes('"qD" in globalThis') &&
			!worker.includes('$P$s') &&
			shell.includes('qD.loadHTML(') &&
			shell.includes('"qD" in globalThis') &&
			!shell.includes('$P$s'),
		[generic, worker, shell].join('\n'),
	);
}

// a data: script whose body holds a `?` (a dynamic import of a URL with a
// query, what the WPT referrer-policy pages do): the URL parser files the
// tail under `search`, and the rewriter must keep it
{
	const data = new StompURL(
		'data:text/javascript,import("https://example.com/s.py?a=1&b=2");',
		url,
	);
	const routed = routeJS(data, url, config, 'generic');
	const body = decodeURIComponent(routed.slice(routed.indexOf(',') + 1));
	ok(
		'a data: script keeps the part of its body after a question mark',
		body.includes('s.py?a=1&b=2') &&
			parses(body) &&
			!body.includes('could not rewrite'),
		body,
	);
}

// a javascript: URL whose body is one expression passes a string value
// through the client (the shell); statements keep their own completion value
{
	const page = new StompURL(
		'https://example.com/p.html',
		parsed.codec,
		'/stomp/',
	);
	const expression = routeHTML(
		new StompURL("javascript:'<p>x</p>'", page),
		page,
		config,
	);
	const statements = routeHTML(
		new StompURL('javascript:var a = 1; a', page),
		page,
		config,
	);
	ok(
		'a single-expression javascript: URL hands a string value to the client; statements are left as they are',
		expression.startsWith('javascript:((r,c)=>') &&
			expression.includes('.javascriptDocument(r,document.URL)') &&
			/\((["'])<p>x<\/p>\1\)/.test(expression) &&
			!statements.includes('javascriptDocument'),
		[expression, statements].join('\n'),
	);
}
{
	// a module worker's static imports run before its body loads the client:
	// each is routed as a worker module, which loads it itself (once); a
	// page module's stay page modules
	const worker = rewrite(
		"import './a.js';\nexport * from './b.js';",
		'workerModule',
	);
	const page = rewrite("import './a.js';", 'genericModule');
	ok(
		"a module worker's imports are worker modules",
		(worker.match(/\/js:workerModule\//g) ?? []).length === 2 &&
			page.includes('/js:genericModule/') &&
			!page.includes('/js:workerModule/'),
		[worker, page].join('\n'),
	);
}
{
	// every kind of literal the rewriter reprints keeps its value: a BigInt
	// came out as a Number (escodegen prints one only from raw text, which
	// the parse did not keep), the rest round-trip
	const show = (v) =>
		typeof v === 'string'
			? `string ${[...v].map((c) => c.charCodeAt(0).toString(16))}`
			: v instanceof RegExp
				? `regexp ${v.source} ${v.flags}`
				: `${typeof v} ${String(v)}`;
	const kinds = [
		'0n',
		'0x9e3779b185ebca87n',
		'0o17n',
		'0b101n',
		'1_000_000n',
		'123456789012345678901234567890n',
		'0x9e3779b185ebca87n * 3n',
		'typeof 0n',
		'/[\\p{L}--[a-z]]/v',
		'/(?<n>a)/d',
		'9007199254740993',
		'5e-324',
		'1.7976931348623157e308',
		'"a\\ud800b\\udc00"',
		'"\\u2028\\u2029"',
	];
	for (const kind of kinds) {
		const source = `return ${kind};`;
		const out = rewrite(source);
		const native = show(new Function(source)());
		let rewritten;
		try {
			rewritten = show(new Function(out)());
		} catch (error) {
			rewritten = String(error);
		}
		ok(
			`the literal ${kind} keeps its value`,
			rewritten === native,
			`${native} -> ${rewritten}: ${JSON.stringify(out)}`,
		);
	}
	// a BigInt a rewritten expression carries along (the main walk never
	// reaches it) keeps its n
	const carried = rewrite('o[k] = 9n; x = a[k] * 2n; location = 7n;');
	ok(
		'a BigInt inside a rewritten expression stays a BigInt',
		/\b9n\b/.test(carried) &&
			/\b2n\b/.test(carried) &&
			/\b7n\b/.test(carried) &&
			parses(carried),
		carried,
	);
}
{
	// a large webpack bundle split across the rewrite workers is put back
	// together byte for byte as one rewrite of the whole makes it: the
	// runtime form (an IIFE declaring its module table) and a chunk
	// (`.push([[ids], {modules}])`); what is not that shape, or has a module
	// that could see a name of the window's bound around it, is not split
	// `preamble`: a document's inline script, rewritten with its client's
	// preamble, which the skeleton carries (rewritePool's rewriteInline)
	// (a split is the JavaScript rewriter's: its parts are stitched by what
	// its printer makes of them, and the wasm rewriter, which takes a bundle
	// whole in less time than the split's plan, is never handed one. The
	// whole it is compared with is the JavaScript rewriter's in either run)
	const whole = (script, preamble = '') =>
		modifyJS(
			script,
			url,
			{ ...config, rewriter: undefined },
			'generic',
			preamble,
		);
	const split = (script, parts, preamble = '') => {
		const plan = planSplit(script, parts);
		if (!plan) return null;
		const sources = splitSources(script, plan);
		const part = (text, source, first = '') =>
			modifyJS(text, url, config, 'generic', first, true, source);
		return stitch(
			part(sources.skeleton, sources.skeletonSource, preamble),
			sources.parts.map((text, i) => part(text, sources.partSources[i])),
			plan,
		);
	};
	const runtime = readFileSync(`${root}test/pages/split-bundle.js.bin`, 'utf8');
	const chunk =
		'(self.webpackChunk=self.webpackChunk||[]).push([["c"],{' +
		Array.from(
			{ length: 40 },
			(_, i) =>
				`${i}:(e,t,n)=>{e.exports=[location.href,top,o[k${i}],w.postMessage(${i}n,"*"),eval("${i}")]}`,
		).join(',') +
		'}]);' +
		' '.repeat(4000);
	// a Closure module bundle (YouTube's kevlar_base, Google Docs): split into
	// runs of statements, here one sloppy, with statements a line break ends
	// without a semicolon and function declarations in a try block
	const closure = readFileSync(
		`${root}test/pages/split-closure.js.bin`,
		'utf8',
	);
	const sloppy =
		'(function(_){var window=this;' +
		Array.from({ length: 40 }, (_, i) =>
			i % 5 === 0
				? `_.a${i}=top\n`
				: `_.b${i}=function(){return location.href+${i}};`,
		).join('') +
		'try{' +
		Array.from(
			{ length: 40 },
			(_, i) => `function f${i}(){return eval("${i}")}_.c${i}=f${i};`,
		).join('') +
		'}catch(e){}}).call(this,{});';
	// a program that is one module chunk after another (CNN's 3.5 MB inline
	// script): split into runs of its own statements, with a "use strict"
	// that is no directive, declarations, `this`, and statements a line break
	// ends without a semicolon
	const program =
		'window.modules=[];var shared=this;function helper(){return top}' +
		Array.from({ length: 40 }, (_, i) =>
			i === 7
				? `"use strict";(self.modules=self.modules||[]).push([["${i}"],{${i}:(i,s,E)=>{s.exports=[location.href,o[k${i}]]}}])\n`
				: i % 6 === 0
					? `shared.m${i}=window.parent\n`
					: `(self.modules=self.modules||[]).push([["${i}"],{${i}:(i,s,E)=>{s.exports=[location.href,top,o[k${i}],w.postMessage(${i},"*"),eval("${i}")]}}]);`,
		).join('') +
		'mount(helper());';
	ok(
		'a program of module chunks is split, into runs of its statements',
		planSplit(program, 4)?.kind === 'statements',
	);
	for (const [name, script] of [
		['the runtime form', runtime],
		['a chunk', chunk],
		['a Closure module', closure],
		['a sloppy Closure-shaped module', sloppy],
		['a program of module chunks', program],
	])
		for (const parts of [2, 4])
			ok(
				`${name} split in ${parts} is the whole's rewrite byte for byte`,
				split(script, parts) === whole(script),
				`${String(split(script, parts)).slice(0, 120)}`,
			);
	// a document's inline script: its preamble is the skeleton's
	for (const [name, script] of [
		['a program of module chunks', program],
		['a Closure module', closure],
	])
		ok(
			`${name} inline, split in 4, is the whole's rewrite with its preamble byte for byte`,
			split(script, 4, scriptPreamble(script)) ===
				whole(script, scriptPreamble(script)),
			`${String(split(script, 4, scriptPreamble(script))).slice(0, 120)}`,
		);
	const notSplit = [
		[
			'an IIFE that binds location around its modules',
			'(()=>{var location=1,r={1(e){e.exports=location},2(e){},3(e){},4(e){}};})();',
		],
		[
			'a table entry that is not a module function',
			'(()=>{var r={1(e){},2:5,3(e){},4(e){}};})();',
		],
		['two statements', 'a();b();'],
		['no module table', '(()=>{var r=1;})();'],
		// `var location = url` outside any function navigates, and is routed;
		// in a run, rewritten inside a function, it declared a local and was
		// left as written, so the stitched whole navigated past the proxy
		[
			'a program of module chunks that declares location with var',
			program.replace('mount(', 'var location="/next";mount('),
		],
		[
			'a program of module chunks that declares location with var in a block',
			program.replace(
				'mount(',
				'try{var {location}={location:"/next"}}catch(e){}mount(',
			),
		],
	];
	for (const [name, script] of notSplit)
		ok(`not split: ${name}`, planSplit(script, 2) === null, script);
}
{
	// every function a script defines reads back as the page wrote it: the
	// script run as written and as the service worker writes it (its text
	// handed to the access API by the statement before its code), printed
	// readable and compact: every form the browser suite's fixture has, and
	// every class, method, getter and function three.js exports
	const toString = Function.prototype.toString;
	const access = new Proxy(
		{ src: keepEmbedded, get: (value) => value, get2: (o, k) => o[k] },
		{ get: (target, key) => target[key] ?? ((value) => value) },
	);
	const readBack = (fn) => {
		const raw = toString.call(fn);
		return originalSource(raw) ?? raw;
	};
	const run = (code, helper) => {
		const got = {};
		const window = { __put: (prefix, fns) => Object.assign(got, fns) };
		new Function('window', '$s$j', 'location', 'top', code)(
			window,
			helper,
			{ href: '', hash: '' },
			window,
		);
		return got;
	};
	const fixture = readFileSync(
		`${root}test/pages/function-source.js.bin`,
		'utf8',
	);
	const native = run(fixture);
	for (const [name, out] of [
		['readable', marked(fixture)],
		['compact', modifyJS(fixture, url, config, 'generic', '', true)],
	]) {
		const proxied = run(out, access);
		const wrong = Object.keys(native).filter(
			(key) => readBack(proxied[key]) !== toString.call(native[key]),
		);
		ok(
			`every form of function reads back as written (${name})`,
			Object.keys(native).length > 40 && wrong.length === 0,
			wrong
				.map((key) => `${key}: ${JSON.stringify(readBack(proxied[key]))}`)
				.join('; '),
		);
	}
	const three = readFileSync(`${root}test/pages/vendor-three.min.js`, 'utf8');
	const load = (code, helper) => {
		// its UMD wrapper puts THREE on globalThis
		const self = {};
		new Function('globalThis', 'console', '$s$j', code)(
			self,
			{ warn() {} },
			helper,
		);
		return self.THREE;
	};
	const before = load(three);
	// a page that hands over a holder of its own under the script's key,
	// before the script runs, changes nothing
	keepEmbedded(
		sourceKey(three),
		'\u0001\u0002\u0003\u0004\u0005\u0006',
		// shaped like the rewriter's, so only its text tells it apart
		new Function('return function(){/*not three.js*/}')(),
	);
	const after = load(marked(three), access);
	const pairs = [];
	for (const name of Object.keys(before)) {
		if (typeof before[name] !== 'function') continue;
		pairs.push([name, before[name], after[name]]);
		for (const owner of ['prototype', null]) {
			const a = owner ? before[name][owner] : before[name];
			const b = owner ? after[name][owner] : after[name];
			if (!a) continue;
			for (const key of Object.getOwnPropertyNames(a))
				for (const part of ['value', 'get', 'set']) {
					const fn = Object.getOwnPropertyDescriptor(a, key)[part];
					if (typeof fn === 'function' && key !== 'constructor')
						pairs.push([
							`${name}.${key}`,
							fn,
							Object.getOwnPropertyDescriptor(b, key)?.[part],
						]);
				}
		}
	}
	const wrong = pairs.filter(
		([, a, b]) => typeof b !== 'function' || readBack(b) !== toString.call(a),
	);
	ok(
		`every function three.js exports reads back as written, a holder the page handed over first notwithstanding (${pairs.length - wrong.length}/${pairs.length})`,
		pairs.length > 1000 && wrong.length === 0,
		wrong
			.slice(0, 3)
			.map(([key]) => key)
			.join(', '),
	);
}
{
	// a document's inline scripts and styles, found in its markup for the
	// worker to rewrite (src/prewrite.ts): the client looks them up by kind
	// and text, and a script the page inserts again gets the rewrite without
	// the preamble, which must be what the rewriter makes of it bare
	const markup = [
		'<script>var a = location.href;</script>',
		'<script type="module">import "./m.js"; top.x = 1;</script>',
		'<SCRIPT TYPE="text/javascript">"use strict"; function f() { return top; }</SCRIPT>',
		'<script type="text/template">location</script>',
		'<script src="x.js"></script>',
		'<script language="javascript">window.b = 2;</script>',
		'<script type="importmap">{}</script>',
		'<style>.a{background:url(a.png)}</style>',
		'<script>var a = location.href;</script>',
	].join('\n');
	const found = inlineSources(markup);
	ok(
		'the inline scripts that run, by kind, each text once, and the styles, with where each first stands in the markup',
		JSON.stringify(found.scripts.map(([kind]) => kind)) ===
			JSON.stringify(['c', 'm', 'c', 'c']) &&
			found.styles.length === 1 &&
			found.scripts.every(
				([, source, start, end]) => markup.slice(start, end) === source,
			) &&
			found.styles.every(
				([source, start, end]) => markup.slice(start, end) === source,
			) &&
			found.scripts[0][2] === markup.indexOf('var a'),
		JSON.stringify(found),
	);
	// The table names a text by where it stands in the markup, and carries a
	// rewrite without the preamble and the holder statement, which the client
	// makes again from the text: each rewrite comes back byte for byte, as
	// the document's own and bare, classic and module, functions or none
	const sources = [
		['c', 'var a = location.href; function g(x) { return top[x]; }'],
		['c', '"use strict"; function f() { return top; }'],
		['c', "'use strict';\n'another';\nwindow.q = () => location;"],
		['c', 'x = top; /* */ y = "*\\u2028<";'],
		['m', 'import "./m.js"; export function h() { return location; }'],
		['m', 'top.y = 1;'],
	];
	const access = '$s$j';
	const doc = sources
		.map(([kind, source]) =>
			kind === 'm'
				? `<script type="module">${source}</script>`
				: `<script>${source}</script>`,
		)
		.join('\n');
	const rewriteOf = (kind, source, bare = false) =>
		kind === 'm'
			? modifyJS(source, url, config, 'genericModule')
			: modifyJS(
					source,
					url,
					config,
					'generic',
					bare ? '' : scriptPreamble(source),
				);
	const table = new PrewrittenTable(
		{
			url: url.toString(),
			scripts: inlineSources(doc).scripts.map(([kind, source, start, end]) => [
				kind,
				start,
				end,
				...packRewrite(kind, source, rewriteOf(kind, source), access),
			]),
			styles: [],
		},
		doc,
		access,
	);
	const packedSizes = sources.map(([kind, source]) => {
		const [rest, at] = packRewrite(
			kind,
			source,
			rewriteOf(kind, source),
			access,
		);
		return at === -1 ? 'whole' : rest.length < rewriteOf(kind, source).length;
	});
	const wrong = sources.filter(
		([kind, source]) =>
			table.script(kind === 'm', source) !== rewriteOf(kind, source) ||
			(kind === 'c' &&
				table.script(false, source, true) !== rewriteOf(kind, source, true)),
	);
	ok(
		'a prewritten script comes back as its rewrite, and without its preamble as the bare rewrite, byte for byte',
		wrong.length === 0 &&
			table.script(true, sources[0][1]) === undefined &&
			table.script(false, 'var a = 1;') === undefined &&
			packedSizes.slice(0, 4).every((smaller) => smaller === true),
		JSON.stringify({ wrong, packedSizes }),
	);
}
{
	// a direct eval's arguments stand twice in its rewrite (for the real
	// eval, and for a function the page named eval): rewritten both times.
	// They were left as written, so `eval(top.x)` read the real top
	const out = shape('eval(o[k], top)');
	ok(
		"a direct eval's arguments are rewritten in both of its branches",
		(out.match(/\$s\$j\.get2\(o, k, /g) || []).length === 2 &&
			(out.match(/\$s\$j\.get\(top, 'top'\)/g) || []).length === 2 &&
			parses(out),
		out,
	);
}
{
	// `super` is no value to hand the access API: the output did not parse
	const own = rewrite('class A extends B { m() { super.postMessage(1); } }');
	ok(
		"super.postMessage stays the class's own call",
		/super\.postMessage\(1\)/.test(own) && parses(own),
		own,
	);
}
{
	// `delete top` is strict code's early error, and eval code is strict by
	// a caller no rewrite sees: the name stays as written, so V8 refuses it
	// there as it does natively (and answers false in sloppy code, as it
	// does natively). The access API in its place compiled, and ran
	const out = shape('delete top; x = delete (location); delete top.a');
	let refused = false;
	try {
		new Function(`'use strict';${out}`);
	} catch (error) {
		refused = error instanceof SyntaxError;
	}
	ok(
		'delete of a bare name stays as written, for strict code to refuse',
		/delete top;/.test(out) && /delete \(?location\)?;/.test(out) && refused,
		out,
	);
}
{
	// early errors (rust/host/early.mjs): what V8 refuses to compile is
	// handed back as it was or rewritten into what V8 still refuses, never
	// into a script that runs; what V8 takes is rewritten, never handed
	// back unrewritten and never broken. Held for the wasm rewriter on
	// every text of rust/host/early-errors.txt in every place it is tried;
	// the JavaScript rewriter's shortfalls are the table's other column.
	// The verdicts are this node's V8's, and the file records 13.6's: under
	// another the table is printed and not held (the early-errors suite
	// holds it to Chrome)
	const harness = spawnSync(process.execPath, [`${root}rust/host/early.mjs`], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	const out = harness.stdout ?? '';
	for (const line of out.split('\n').slice(0, 24)) console.log(`  ${line}`);
	const recorded = process.versions.v8.startsWith('13.6.');
	if (!recorded)
		console.log(
			`  not held: this node's V8 is ${process.versions.v8}, the verdicts are 13.6's`,
		);
	ok(
		'early errors: the wasm rewriter never turns a script V8 refuses into one that runs, nor a script V8 takes into one it refuses or one that goes out unrewritten',
		!recorded || harness.status === 0,
		out.split('\n').slice(24).join('\n').slice(0, 4000) +
			(harness.stderr ?? ''),
	);
}
{
	// the access API calls the target's own postMessage, which is the
	// subclass's where the page asked for the parent's
	const own = shape(
		'class A extends B {\nm() {\nsuper.postMessage.call(this, top);\nsuper.postMessage.apply(this, [top]);\nReflect.apply(super.postMessage, this, [top]);\nw.postMessage.call(v, 1);\n}\n}',
	);
	ok(
		"super.postMessage.call, .apply and Reflect.apply of it stay the class's own calls",
		own.includes("super.postMessage.call(this, $s$j.get(top, 'top'))") &&
			own.includes("super.postMessage.apply(this, [$s$j.get(top, 'top')])") &&
			own.includes(
				"Reflect.apply(super.postMessage, this, [$s$j.get(top, 'top')])",
			) &&
			// (another window's is read through the access API, and called)
			own.includes("$s$j.call3(w, 'postMessage', 'call', [") &&
			parses(own),
		own,
	);
}
{
	// what a rewrite stands around is the page's code too. The value a bare
	// location, top or eval is assigned, a dynamic import's specifier and
	// options and the pattern of a declaration whose source is wrapped were
	// printed as written: a `top` there was the real one, a function there
	// ran unrewritten, an eval there was no direct eval
	const count = (out, text) => out.split(text).length - 1;
	const assigned = shape(
		'location = top; location += o[k]; top = (function () { return top; })(); eval &&= location; location = eval(x);',
	);
	ok(
		'the value assigned to a bare location, top or eval is rewritten',
		assigned.includes("$s$j.get(top, 'top'), '(location = top)')") &&
			assigned.includes("$s$j.get2(o, k, '(o[k])'), '(location += o[k])')") &&
			/return \$s\$j\.get\(top, 'top'\);/.test(assigned) &&
			assigned.includes(
				"$s$j.get(location, 'location'), '(eval &&= location)')",
			) &&
			assigned.includes(
				"$s$j.isEval(eval) ? eval($s$j.evalScope(x)) : eval(x), '(location = eval(x))')",
			) &&
			parses(assigned),
		assigned,
	);
	const imported = shape('import(top); import(o[k], { with: top.x });');
	ok(
		"a dynamic import's specifier and options are rewritten",
		imported.includes(
			"$s$j.import('https://example.com/a.js', $s$j.get(top, 'top'))",
		) &&
			imported.includes(
				"($s$j.get2(o, k, '(o[k])'), { with: $s$j.get(top, 'top').x })",
			),
		imported,
	);
	const patterns = shape(
		"const { [(t = top, 'k')]: z, top: u = top } = o; const [a = top] = o[k]; function f({ top: t = top }) {}",
	);
	ok(
		'the computed keys and defaults of a pattern whose source is wrapped are rewritten',
		count(patterns, "$s$j.get(top, 'top')") === 4 &&
			count(patterns, '$s$j.pattern(') === 2 &&
			patterns.includes(
				"$s$j.iter($s$j.get2(o, k, '(o[k])'), 'array', 'o[k]')",
			) &&
			parses(patterns),
		patterns,
	);
}
{
	// a computed key is an expression like any other, wherever it stands: an
	// identifier there was taken for a name, so `{ [location]: 1 }` had the
	// real location's URL for its key. What a class extends is one too
	const count = (out, text) => out.split(text).length - 1;
	const keys = shape(
		'x = { [location]: 1, location: 2 };\nclass A extends top { [location]() {} static [location] = 1; location = 2; top() {} }\nconst { [location]: a, top: b } = o;\ndelete o[location];\n[o[location]] = l;\nclass B extends A { m() { return super[location] + super.location; } }',
	);
	ok(
		'a computed key named location or top is rewritten, a plain name is not',
		count(keys, "[$s$j.get(location, 'location')]") === 5 &&
			keys.includes(
				"[$s$j.ref2(o, $s$j.get(location, 'location')).value] = l;",
			) &&
			count(keys, "$s$j.get(location, 'location')") === 7 &&
			keys.includes("($s$j.key($s$j.get(location, 'location')))") &&
			keys.includes("extends $s$j.get(top, 'top') {") &&
			keys.includes('location: 2') &&
			keys.includes('location = 2;') &&
			keys.includes('top() {') &&
			keys.includes('super.location') &&
			parses(keys),
		keys,
	);
}
{
	// a statement that is a string in parentheses is an expression, not a
	// directive: printed bare it turned a sloppy script or function strict.
	// A directive written with an escape is printed as written (its value
	// may be "use strict" where its text is not). Checked on the parsed
	// output, as each backend prints it (the generator that spells the wasm
	// output for `shape` drops those very parentheses)
	const { parse } = await import('meriyah');
	/** each list's leading strings, as a directive or an expression, by raw text */
	const prologues = (code, module = false) => {
		const lists = [];
		const visit = (node) => {
			if (!node || typeof node !== 'object') return;
			if (Array.isArray(node)) return node.forEach(visit);
			if (node.type === 'Program' || node.type === 'BlockStatement') {
				const strings = [];
				for (const statement of node.body) {
					if (
						statement.type !== 'ExpressionStatement' ||
						statement.expression.type !== 'Literal' ||
						typeof statement.expression.value !== 'string'
					)
						continue;
					strings.push(
						typeof statement.directive === 'string'
							? `directive ${statement.directive}`
							: `expression ${statement.expression.value}`,
					);
				}
				if (strings.length) lists.push(strings.join(', '));
			}
			for (const key in node) if (key !== 'range') visit(node[key]);
		};
		try {
			visit(parse(code, { module, next: true, webcompat: true }));
		} catch (error) {
			return [`does not parse: ${error}`];
		}
		return lists;
	};
	const show = JSON.stringify;
	// what the page meant: a function called plainly has a `this` in sloppy code
	const sloppy = (prologue) =>
		new Function(
			rewrite(
				`${prologue}\nreturn (function () { return this; })() !== undefined;`,
			),
		)();
	const top = rewrite("('use strict'); x = top");
	const inner = rewrite(
		"function f() {\n('use strict');\nreturn this;\n}\nconst g = () => {\n( 'use strict' );\n};\nclass A {\nm() {\n(\"use asm\");\n}\n}",
	);
	const module = rewrite("('use strict'); top;", 'genericModule');
	ok(
		'a parenthesised string statement keeps its parentheses, at the top of a script, a function and a module',
		show(prologues(top)) === show(['expression use strict']) &&
			top.includes('$s$j.get(top') &&
			show(prologues(inner)) ===
				show([
					'expression use strict',
					'expression use strict',
					'expression use asm',
				]) &&
			show(prologues(module, true)) === show(['expression use strict']) &&
			sloppy("('use strict');") &&
			sloppy("( 'use strict' )") &&
			!sloppy("'use strict';") &&
			[top, inner].every(parses),
		show([top, inner, module]),
	);
	const escaped = rewrite("'use\\x20strict'; x = top");
	const escapedInner = rewrite(
		"function f() {\n'use\\x20strict';\nreturn top;\n}",
	);
	ok(
		'a directive with an escape is printed as written',
		show(prologues(escaped)) === show(['directive use\\x20strict']) &&
			show(prologues(escapedInner)) === show(['directive use\\x20strict']) &&
			sloppy("'use\\x20strict';") &&
			[escaped, escapedInner].every(parses),
		show([escaped, escapedInner]),
	);
	const real = rewrite(
		"'use strict'; function f() {\n\"use strict\";\n'b';\n('c');\n'd';\n}",
	);
	const hoisted = rewrite(
		"function f({ top: t }) {\n'a';\n('use strict');\nreturn t;\n}",
	);
	ok(
		'a directive stays one, and what follows the first parenthesised string is left as it is',
		show(prologues(real)) ===
			show([
				'directive use strict',
				'directive use strict, directive b, expression c, expression d',
			]) &&
			show(prologues(hoisted)) ===
				show(['directive a, expression use strict']) &&
			/'a';\s*var /.test(hoisted) &&
			hoisted.includes('$s$j.pattern($s$ja0') &&
			[real, hoisted].every(parses),
		show([real, hoisted]),
	);
}
{
	// `super.top` is the window's own when the home object's prototype and
	// `this` are the window, and `super.eval(code)` the real eval: what
	// `super` reads goes through `get`, a call keeps its `this`, a write goes
	// through arrows that keep `super`. Any other name is left as it is
	const forms = shape(
		[
			'o = {',
			'm(k) {',
			'return [super.top, super[k], super["location"], super.x, super[0]];',
			'},',
			'c(k) {',
			'return [super.eval(c), super[k](a, top), super.top?.(a), super.x(top)];',
			'},',
			'w(k) {',
			'super.location = u;',
			'super[k] += top;',
			'super[k]++;',
			'[super.location, super[k]] = a;',
			'super.x = top;',
			'return super.top`x`;',
			'},',
			'};',
		].join('\n'),
	);
	// (compared without white space and parentheses: the generator breaks
	// an arrow's line, and puts an arrow's assignment in parentheses as it
	// printed the tree, or not as it reprints the wasm output)
	const tight = (text) => text.replace(/[\s()]+/g, '');
	const has = (text) => tight(forms).includes(tight(text));
	ok(
		'super.top, super[k] and super.eval() go through the access API',
		has(
			"return [$s$j.get(super.top, 'top'), (t$p => ($s$j.get(super[t$p], t$p)))($s$j.key(k)), $s$j.get(super['location'], 'location'), super.x, super[0]];",
		) &&
			has(
				"$s$j.smethod($s$j.get(super.eval, 'eval'), this, 'super.eval(0)')(c)",
			) &&
			has(
				"$s$j.smethod((t$p => ($s$j.get(super[t$p], t$p)))($s$j.key(k)), this, 'super[k](0, 0)')(a, $s$j.get(top, 'top'))",
			) &&
			has(
				"$s$j.smethod($s$j.get(super.top, 'top'), this, 'super.top?.(0)', true)?.(a)",
			) &&
			has("super.x($s$j.get(top, 'top'))") &&
			parses(forms),
		forms,
	);
	ok(
		'a write to super.location or super[k] goes through the access API',
		has(
			"$s$j.sset('location', this, t$p => super[t$p], (t$p, t$v) => (super[t$p] = t$v), (t$t, t$p, t$v) => (t$t[t$p] = t$v), u);",
		) &&
			has(
				"$s$j.sset($s$j.key(k), this, t$p => super[t$p], (t$p, t$v) => (super[t$p] = t$v), (t$t, t$p, t$v) => (t$t[t$p] += t$v), $s$j.get(top, 'top'));",
			) &&
			has('(t$t, t$p, t$v) => t$t[t$p]++, undefined);') &&
			has(
				"[$s$j.sref('location', this, t$p => super[t$p], (t$p, t$v) => (super[t$p] = t$v)).value, $s$j.sref($s$j.key(k), this,",
			) &&
			has("super.x = $s$j.get(top, 'top');") &&
			has('return super.top`x`;') &&
			parses(forms),
		forms,
	);
}
{
	// a pattern reads its keys with no member expression to rewrite wherever
	// it stands: under an array pattern, a computed key, a rest element, in a
	// loop head, a catch clause, a parameter list. Its source is wrapped
	const tight = (text) => text.replace(/\s+/g, '');
	const shows = (source, expected) => {
		const out = shape(source);
		return tight(out).includes(tight(expected)) && parses(out) ? '' : out;
	};
	const wrong = [
		[
			'const [{ top: t }] = a;',
			"const [{top: t}] = $s$j.pattern($s$j.iter(a, 'array', 'a'), { '[]': [{ 'top': true }] });",
		],
		[
			'[, { top: t }] = a;',
			"[, {top: t}] = $s$j.pattern($s$j.iter(a, 'assign', 'a'), { '[]': [0, { 'top': true }] });",
		],
		[
			'const { a: [{ top: t }], [k]: { location: l }, b } = o;',
			"= $s$j.pattern(o, { '{}': [{ '[]': [{ 'top': true }] }, { 'location': true }, 0] }, '{ a: [{ top: t }], [k]: { location: l }, b } = o');",
		],
		[
			'const [x, ...[{ top: t }]] = a;',
			"const [x, [{top: t}]] = $s$j.pattern($s$j.iter(a, 'array', 'a'), { '[]': [0, [{ '[]': [{ 'top': true }] }]] });",
		],
		[
			'for (const { top: t } of a) f(t);',
			"for (const $s$jf of a) { const {top: t} = $s$j.pattern($s$jf, { 'top': true }, '{top:t}=$s$jf'); f(t); }",
		],
		[
			'for ({ top: t } of a);',
			"for (const $s$jf of a) { ({top: t} = $s$j.pattern($s$jf, { 'top': true }, '({top:t}=$s$jf)')); ; }",
		],
		[
			'try { g(); } catch ({ top: t }) { h(t); }',
			"catch ($s$jc) { let {top: t} = $s$j.pattern($s$jc, { 'top': true }, '{top:t}=$s$jc'); h(t); }",
		],
		[
			'function f(...[{ top: t }]) {}',
			"function f(...$s$ja0) { var [{top: t}] = $s$j.pattern($s$j.iter($s$ja0, 'array', '$s$ja0'), { '[]': [{ 'top': true }] }); }",
		],
		[
			'function f([{ top: t }]) {}',
			"function f($s$ja0) { var [{top: t}] = $s$j.pattern($s$j.iter($s$ja0, 'array', '$s$ja0'), { '[]': [{ 'top': true }] }); }",
		],
		// nothing to wrap: left as written
		['for (const [k, v] of a) f(k);', 'for (const [k, v] of a) f(k);'],
		['for (const { x, y } of a) f(x);', 'for (const {x, y} of a) f(x);'],
		['try { g(); } catch ({ message }) {}', 'catch ({message}) {'],
		['const [a, ...b] = c;', 'const [a, ...b] = c;'],
		['for (const { top: t } in o);', 'for (const {top: t} in o);'],
	]
		.map(([source, expected]) => shows(source, expected))
		.filter(Boolean);
	ok(
		'a pattern under an array pattern, a computed key or a rest, in a loop head, a catch clause and a parameter list has its source wrapped',
		wrong.length === 0,
		wrong.join(' | '),
	);
}
{
	// the `.call`, `.apply` and `Reflect.apply` forms of a post read the
	// method through the access API, from the expression the page read it
	// from, evaluated once and first; arguments an apply ignores are not
	// dropped
	const posts = shape(
		'f().postMessage.call(w, top);\nx.postMessage.apply(w, [1], g());\nReflect.apply(a.b.postMessage, w, [1]);\nReflect.apply(x.postMessage, w, [1], g());\nx.postMessage.call(w, 1);',
	);
	ok(
		'the method expression of postMessage.call, .apply and Reflect.apply is evaluated',
		/\$s\$j\.call3\(f\(\), 'postMessage', 'call', \[\s*w,\s*\$s\$j\.get\(top, 'top'\)\s*\]/.test(
			posts,
		) &&
			posts.includes(
				"$s$j.method($s$j.get2(x, 'postMessage', '(x.postMessage)'), false, false, 'x.postMessage.apply(0, 0, 0)')?.('apply')?.(w, [1], g());",
			) &&
			posts.includes(
				"Reflect.apply($s$j.get2(a.b, 'postMessage', '(a.b.postMessage)'), w, [1]);",
			) &&
			posts.includes(
				"Reflect.apply($s$j.get2(x, 'postMessage', '(x.postMessage)'), w, [1], g());",
			) &&
			/\$s\$j\.call3\(x, 'postMessage', 'call', \[\s*w,\s*1\s*\]/.test(posts) &&
			parses(posts),
		posts,
	);
}
{
	// three shapes the generator printed without the parentheses they need,
	// which lost the whole script: a member call in its lazy form with
	// something chained onto it that an optional chain cannot have, what a
	// class extends, and an `export default` of an expression that begins
	// with `function` or `class`
	const { parse } = await import('meriyah');
	const lazy = shape(
		'this.items[i].find(x.y).value = 1;\no[k].m(f()).n++;\nnew (o[k].m(f()))();\no[k].m(f())`x`;\nfor (o[k].m(f()).x of a);\no[k].m(f());',
	);
	const heritage = rewrite(
		'async function g() {\nclass A extends (await f()) {}\nreturn class extends (a || b) {};\n}\nclass B extends (-top) {}\nclass C extends top {}\nclass D extends f(top).x {}',
	);
	const exported = rewrite(
		'export default (function () {\nreturn top;\n})();',
		'genericModule',
	);
	const member = rewrite('export default (class {}).name;', 'genericModule');
	const assigning =
		'({ k: 1 })[k] ||= ([o.a] = []);\nf({ k: 1 }, ([a] = b));\nnew F([1], ({ top: t } = w));\nfor (;; [a, b] = [b, a]);\n[a] = b;\nc, ([a] = b), d;';
	const patterns = rewrite(assigning);
	const declared = rewrite('export default function () {}', 'genericModule');
	const asModule = (code) => {
		try {
			parse(code, { module: true, next: true });
			return true;
		} catch (error) {
			return false;
		}
	};
	ok(
		'a lazy member call with a member assigned, a tag or a new on it is printed in parentheses',
		lazy.includes("'this.items[i].find(0)')?.('find')?.(x.y)).value = 1;") &&
			lazy.includes("?.('m')?.(f())).n++;") &&
			lazy.includes("?.('m')?.(f()))`x`;") &&
			lazy.includes("\n$s$j.method($s$j.get2(o, k, '(o[k])'), false, false,") &&
			parses(lazy),
		lazy,
	);
	// (what the parentheses are for is checked on each backend's own output:
	// that it parses, in V8 and as a module, and is the program the page
	// wrote, with its reads rewritten; the generator `shape` spells the wasm
	// output with drops the very parentheses checked)
	const tree = (code, module = false) =>
		parse(code, { module, next: true, webcompat: true });
	const reads = (code) =>
		(code.match(/\$s\$j\.get\(top, ['"]top['"]\)/g) || []).length;
	const supers = [];
	JSON.stringify(tree(heritage), (key, value) => {
		if (key === 'superClass' && value) supers.push(value.type);
		return value;
	});
	// (only those the page wrote: a script V8 refuses for their absence
	// stays one it refuses)
	const refused = [
		'class A extends B++ {}',
		'f({ a: 1 }, [b] = c)',
		'new F({ a: 1 }, [b] = c)',
	].filter((code) => parses(rewrite(code)));
	ok(
		'and puts none where the page wrote none, so V8 refuses what it refuses natively',
		refused.length === 0,
		refused.join(' | '),
	);
	ok(
		'what a class extends keeps its parentheses',
		JSON.stringify(supers) ===
			JSON.stringify([
				'AwaitExpression',
				'LogicalExpression',
				'UnaryExpression',
				'CallExpression',
				'MemberExpression',
			]) &&
			reads(heritage) === 3 &&
			parses(heritage),
		heritage,
	);
	const tight = (text) => text.replace(/\s+/g, '');
	const statements = tree(patterns).body.map(
		(statement) => statement.expression,
	);
	ok(
		'a destructuring assignment that is or becomes an argument is printed in parentheses',
		statements[0].arguments?.[3]?.left?.type === 'ArrayPattern' &&
			statements[1].arguments[1].left.type === 'ArrayPattern' &&
			statements[2].arguments[1].left.type === 'ObjectPattern' &&
			tight(shape(assigning)).includes(
				tight("{top: t} = $s$j.pattern(w, { 'top': true },"),
			) &&
			!/\(\[a, b\] =/.test(patterns) &&
			parses(patterns),
		patterns,
	);
	const defaults = [exported, member, declared].map(
		(code) => tree(code, true).body.at(-1).declaration?.type,
	);
	ok(
		'export default of an expression that begins with function or class is printed in parentheses',
		JSON.stringify(defaults) ===
			JSON.stringify([
				'CallExpression',
				'MemberExpression',
				'FunctionDeclaration',
			]) &&
			reads(exported) === 1 &&
			[exported, member, declared].every(asModule),
		JSON.stringify([exported, member, declared]),
	);
}
{
	// The fuzz (test/pages/rewriter-fuzz.js): a payload that reads `top`
	// and `location` in code of its own, in every expression slot of every
	// node kind the parser produces, alone and one template inside another.
	// What the rewriter prints must parse, hold the payload, and read no
	// `top` or `location` but through the access API: a replacement that
	// prints a child as the page wrote it shows here, whatever the node.
	// (adversarial-fuzz runs the same cases in a proxied page.)
	const fuzz = await import('../pages/rewriter-fuzz.js');
	const { parse } = await import('meriyah');
	const fields = fuzz.nodeFields(
		readFileSync(
			new URL(
				'../../node_modules/meriyah/dist/types/estree.d.ts',
				import.meta.url,
			),
			'utf8',
		),
	);
	const reached = fuzz.reached(parse);
	const unreached = Object.keys(fields).filter((slot) => !reached.has(slot));
	const unknown = [
		...unreached.filter((slot) => !(slot in fuzz.EXEMPT)),
		...Object.keys(fuzz.EXEMPT).filter((slot) => !unreached.includes(slot)),
	];
	ok(
		"every field of the parser's node kinds that holds a node is reached by a fuzz template or exempt by name",
		Object.keys(fields).length > 100 && unknown.length === 0,
		unknown.join(' '),
	);
	const warn = console.warn;
	const problem = (made) => {
		const module = made.kind === 'MODULE';
		let fellBack = '';
		console.warn = (message) => {
			fellBack = String(message);
		};
		let out;
		try {
			out = marked(made.code, module ? 'genericModule' : 'generic');
		} finally {
			console.warn = warn;
		}
		// a script no browser runs (a strict-mode error in a class body or a
		// module) is fine whatever comes of it: handed back as it came, or
		// rewritten by the wasm rewriter, whose parser takes some of those
		let runs = !module && parses(made.code);
		if (module)
			try {
				parse(made.code, { module, next: true, webcompat: true });
				runs = true;
			} catch (error) {
				runs = false;
			}
		if (!runs) return '';
		// one that runs and was handed back was not rewritten
		if (fellBack) return fellBack;
		let tree;
		try {
			tree = parse(out, { module, next: true, webcompat: true });
		} catch (error) {
			return `does not parse: ${error}`;
		}
		// (the browser's parser refuses what this one takes, a destructuring
		// assignment after a literal in a call's arguments for one)
		if (!module && !parses(out) && parses(made.code))
			return 'does not parse in the browser';
		const { problems, payloads } = fuzz.unrewritten(tree);
		if (/__fz\(|__fzT`/.test(made.code) && payloads === 0)
			problems.push('the payload is gone');
		return problems.join('; ');
	};
	const failures = (cases) =>
		cases
			.map((made) => [made.name, problem(made)])
			.filter(([, found]) => found)
			.map(([name, found]) => `${name}: ${found}`);
	const payloads = [...fuzz.SHAPES, ...fuzz.BARE];
	const alone = payloads.flatMap((payload) => fuzz.single(() => payload));
	const aloneFailures = failures(alone);
	ok(
		'fuzz: a payload in any slot of any node kind comes out rewritten',
		alone.length > 2000 && aloneFailures.length === 0,
		`${aloneFailures.length} of ${alone.length}: ${aloneFailures.slice(0, 5).join(' | ')}`,
	);
	// the same cases every run
	const next = fuzz.random(0x570a9);
	const nested = fuzz.pairs(
		6000,
		next,
		() => payloads[Math.floor(next() * payloads.length)],
	);
	const nestedFailures = failures(nested);
	ok(
		'fuzz: and in a template inside another (seeded)',
		nested.length === 6000 && nestedFailures.length === 0,
		`${nestedFailures.length} of ${nested.length}: ${nestedFailures.slice(0, 5).join(' | ')}`,
	);
}
await done();
