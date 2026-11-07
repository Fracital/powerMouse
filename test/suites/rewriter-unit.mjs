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
	`export { modifyJS } from ${JSON.stringify(`${root}src/rewriteJS.ts`)};
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
	outfile: bundle,
	logLevel: 'silent',
});
const { modifyJS, StompURL, parseConfig } = await import(
	`${bundle}?${Date.now()}`
);

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
await done();
