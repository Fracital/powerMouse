// The JS rewriter's output, checked in node: src/rewriteJS.ts is bundled with
// esbuild into test/out/ and run directly, so a shape can be asserted on the
// generated code itself (what the browser suites cannot see). Skips with a
// message when esbuild is not installed (a tarball install).
import { mkdirSync, writeFileSync } from 'node:fs';
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
export { routeHTML, modifyHTML, modifyRefresh, parseRefresh } from ${JSON.stringify(`${root}src/rewriteHTML.ts`)};
export { parseDataURI, createDataURI } from ${JSON.stringify(`${root}src/routeURL.ts`)};
export { modifyCSS } from ${JSON.stringify(`${root}src/rewriteCSS.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { parseConfig } from ${JSON.stringify(`${root}src/config.ts`)};
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
} = await import(`${bundle}?${Date.now()}`);

const config = { directory: '/stomp/', codec: 'xor' };
const parsed = parseConfig(config, 'k');
const url = new StompURL('https://example.com/a.js', parsed.codec, '/stomp/');
// the rewriter warns on the console about a script it cannot parse
const warn = console.warn;
console.warn = () => {};
const rewrite = (source, type = 'generic', extra = {}) =>
	modifyJS(source, url, { ...config, ...extra }, type);
const parses = (code) => {
	try {
		new Function(code);
		return true;
	} catch (error) {
		return false;
	}
};

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
		/^["']use strict["'];["']other["'];if \(!globalThis\.createClient\)/.test(
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
await done();
