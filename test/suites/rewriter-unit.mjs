// The JS rewriter's output, checked in node: src/rewriteJS.ts is bundled with
// esbuild into test/out/ and run directly, so a shape can be asserted on the
// generated code itself (what the browser suites cannot see). Skips with a
// message when esbuild is not installed (a tarball install).
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
	`export { modifyJS, postMessageMethod, routeJS } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
export { planSplit, splitSources, stitch } from ${JSON.stringify(`${root}src/splitRewrite.ts`)};
export { routeHTML, modifyHTML, modifyRefresh, parseRefresh } from ${JSON.stringify(`${root}src/rewriteHTML.ts`)};
export { parseDataURI, createDataURI } from ${JSON.stringify(`${root}src/routeURL.ts`)};
export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
export { keepEmbedded, originalSource, sourceKey } from ${JSON.stringify(`${root}src/functionSource.ts`)};
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
} = await import(`${bundle}?${Date.now()}`);

const config = { directory: '/stomp/', codec: 'xor' };
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
const rewrite = (source, type, extra) => unmarked(marked(source, type, extra));
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
	const out = rewrite('a?.b.location.c; a?.b().top.x; (a?.b).location.c');
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
			!/note|block/.test(out) &&
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
			/\$s\$j\.get\(top, 'top'\)\.x/.test(decoded(js)) &&
			/^data:text\/javascript;base64,/.test(b64) &&
			/\$s\$j\.get\(top, 'top'\)/.test(
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
		/^["']use strict["'];["']other["'];if \(!\("[^"]+" in globalThis\) && !globalThis\.createClient\)/.test(
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
	// every way of posting a message goes through the caller's access API
	const out = rewrite(
		"w.postMessage(m, '*'); w?.postMessage(m); w.postMessage.call(w2, m, o); w.postMessage.apply(w2, list); Reflect.apply(w.postMessage, w2, list); port.postMessage(m); x.postmessage(m)",
	);
	ok(
		'postMessage calls in every shape go through the access API',
		/\$s\$j\.post\(w,\s*\[\s*m,\s*'\*'\s*\]\)/.test(out) &&
			/\$s\$j\.post\(w,\s*\[\s*m\s*\],\s*true\)/.test(out) &&
			/\$s\$j\.post\(w2,\s*\[\s*m,\s*o\s*\]\)/.test(out) &&
			(out.match(/\$s\$j\.post\(w2,\s*list\)/g) || []).length === 2 &&
			/\$s\$j\.post\(port,\s*\[\s*m\s*\]\)/.test(out) &&
			/x\.postmessage\(m\)/.test(out) &&
			parses(out),
		out,
	);
}
{
	// an `in` whose key is or may be a helper name asks the access API (the
	// helpers are on the window, natively nothing is); a literal key of
	// anything else, a private name and for...in are left as they are
	const out = rewrite(
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
	const top = rewrite(
		"var location = 'x'; var {a, location} = o; var [location] = l;",
	);
	const inner = rewrite('function f() { var location = 1; }');
	const mod = rewrite("var location = 'x';", 'genericModule');
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
	const targets = rewrite(
		'[location] = a; ({location} = o); ({a: location = 1} = o); [...location] = a; for (location of a); for (location in o);',
	);
	const members = rewrite(
		"[top.location] = a; ({a: window['location']} = o); for (frames[0].location of a);",
	);
	const kept = [
		['[a[i], a[j]] = [b, c];', '[a[i], a[j]] = [\n    b,\n    c\n];'],
		['({x: a.top, y: [b]} = o);', '({\n    x: a.top,\n    y: [b]\n} = o);'],
		['for (a.top of b);', 'for (a.top of b);'],
		['for (k in o) f(k);', 'for (k in o)\n    f(k);'],
		['function f([location]) {}', 'function f([location]) {\n}'],
		['try {} catch ({location}) {}', 'try {\n} catch ({location}) {\n}'],
	];
	ok(
		'a location an assignment pattern or a loop head writes routes',
		(targets.match(/\$s\$j\.ref1\(location, t\$v =>/g) || []).length === 6 &&
			/location: \$s\$j\.ref1\(/.test(targets) &&
			/\.value = 1/.test(targets) &&
			/for \(\$s\$j\.ref1\(location, t\$v =>\s*\(location = t\$v\)\)\.value of a\)/.test(
				targets,
			) &&
			members.includes(
				"[$s$j.ref2($s$j.get(top, 'top'), 'location').value] = a",
			) &&
			members.includes("a: $s$j.ref2(window, 'location').value") &&
			members.includes(
				"for ($s$j.ref2($s$j.get2(frames, 0, '(frames[0])'), 'location').value of a)",
			) &&
			kept.every(([code, out]) => rewrite(code) === out) &&
			parses(targets) &&
			parses(members),
		JSON.stringify([targets, members, kept.map(([code]) => rewrite(code))]),
	);
	// a literal index read can be a child window of another proxied site:
	// routed like a computed key; a call, a construction, a write, an update,
	// a delete or a tag through an index stays as written, and so does a key
	// that is no array index
	{
		const routed = ['frames[0]', "parent['1']", 'x = w[2].document'].map(
			(code) => rewrite(code),
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
				kept.every((code) => !rewrite(code).includes('$s$j')),
			JSON.stringify([routed, kept.map((code) => rewrite(code))]),
		);
	}
	// a classic script's var outside a function, in a block or a loop head,
	// assigns the window's location like one at the top; its initialiser is
	// rewritten like any expression
	const nested = rewrite(
		'{ var location = top.a; } if (x) var location = b; for (var location of a) f(); for (var [location] in o); for (var location = c, i = 0; i < 1; i++);',
	);
	const local = rewrite(
		'function f() { { var location = 1; } for (var location of a); } class A { static { var location = 1; } }',
	);
	ok(
		'a var binding of location outside any function routes the assignment',
		(nested.match(/\$s\$j\.set1\(location, 'location'/g) || []).length === 5 &&
			nested.includes("var $s$jl0 = $s$j.get(top, 'top').a;") &&
			/for \(var \$s\$jl0 of a\) \{\s*\$s\$j\.set1\(location/.test(nested) &&
			/for \(var \$s\$jl0 = c, i = 0, \$s\$jl1 = \(\$s\$j\.set1/.test(nested) &&
			!/set1/.test(local) &&
			parses(nested),
		JSON.stringify([nested, local]),
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
	const out = rewrite('top; location.href; eval(x)');
	ok(
		'reads of unforgeables go through the access API',
		/\$s\$j\.get\(top, 'top'\)/.test(out) && parses(out),
		out,
	);
}
{
	const out = rewrite("import('./m.js')");
	ok(
		'a classic script passes its own URL as the import base',
		out.includes("$s$j.import('https://example.com/a.js', './m.js')"),
		out,
	);
	const module = rewrite("import('./m.js')", 'genericModule');
	ok(
		'a module passes import.meta.url and defines import.meta.resolve',
		module.includes('$s$j.import(import.meta.url,') &&
			module.includes('import.meta.resolve = '),
		module,
	);
}
{
	const out = rewrite('const { a: { top: t } } = o;');
	ok(
		'a nested pattern wraps its source with the keys to follow',
		/\$s\$j\.pattern\(o, \{\s*'a': \{\s*'top': true\s*\}\s*\}\)/.test(out) &&
			parses(out),
		out,
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
	const kept = rewrite('function f({ top: t }, b = t) {}');
	ok(
		'a pattern a later parameter refers to is left alone',
		/function f\(\{\s*top: t\s*\}, b = t\)/.test(kept) && parses(kept),
		kept,
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
}
console.warn = warn;

// `o[k] = v` becomes set2(o, k, operate, v): the value is an expression like
// any other, so `top`, `location` and the rest inside it are rewritten too
// (they were handed to set2 raw: `cache[key] = top` stored the real top)
{
	const value = rewrite('o[k] = top');
	const nested = rewrite('o[k] = { a: () => location.href }');
	const compound = rewrite('o[k] += location.href');
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
	const generic = rewrite(
		'o[k] = location.href; top.postMessage(1)',
		'generic',
		{ names },
	);
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
			expression.includes('("<p>x</p>")') &&
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
	const whole = (script) => modifyJS(script, url, config, 'generic');
	const split = (script, parts) => {
		const plan = planSplit(script, parts);
		if (!plan) return null;
		const sources = splitSources(script, plan);
		const part = (text, source) =>
			modifyJS(text, url, config, 'generic', '', true, source);
		return stitch(
			part(sources.skeleton, sources.skeletonSource),
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
	for (const [name, script] of [
		['the runtime form', runtime],
		['a chunk', chunk],
		['a Closure module', closure],
		['a sloppy Closure-shaped module', sloppy],
	])
		for (const parts of [2, 4])
			ok(
				`${name} split in ${parts} is the whole's rewrite byte for byte`,
				split(script, parts) === whole(script),
				`${String(split(script, parts)).slice(0, 120)}`,
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
await done();
