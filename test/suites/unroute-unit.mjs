// Routed URLs in error text read back as the page's own, checked in node
// with a codec key pinned so a route's own text ends in `:digits` (the xor
// codec's `:` is one of its characters): in a message (no line or column)
// the route is read whole, in a frame (V8's `at` lines, Gecko's `@`) the
// last two `:digits` are its line and column. Reading the route's own `:1`
// as a column decoded the rest to another URL: `?ms=3009` came back as
// `?ms=300:1`, now and then, with the random key a controller drew. Skips
// when esbuild is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP unroute-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}unroute-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { unrouteText } from ${JSON.stringify(`${root}src/inject/modules/Unroute.ts`)};
export { XORCodec } from ${JSON.stringify(`${root}src/Codecs.ts`)};
`,
);
const bundle = `${OUT}unroute-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['css-tree'],
	outfile: bundle,
	logLevel: 'silent',
});
const { unrouteText, XORCodec } = await import(`${bundle}?${Date.now()}`);

// xor 9, every character: '0' encodes to ':' and '9' to '1', so a URL
// ending in 3009 ends its route in `::1`
const codec = new XORCodec('91');
const origin = 'http://127.0.0.1:8090';
const client = {
	isDOM: false,
	global: { location: { origin } },
	directory: '/stomp/abc/',
	scope: '/stomp/',
	codec,
	url: { url: new URL('https://example.com/') },
};
const page = 'https://example.com/pages/import404.js?ms=3009';
const routed = `${origin}/stomp/abc/js:generic/${codec.encode(page)}`;
ok(
	"the pinned key makes the route's own text end in :digits",
	/:\d+$/.test(routed),
	routed.slice(-20),
);
for (const [name, text, expected] of [
	[
		'a message',
		`Failed to fetch dynamically imported module: ${routed}`,
		`Failed to fetch dynamically imported module: ${page}`,
	],
	[
		'a message with text after the URL',
		`Cannot load ${routed} now`,
		`Cannot load ${page} now`,
	],
	[
		'a V8 frame in parentheses',
		`    at f (${routed}:12:34)`,
		`    at f (${page}:12:34)`,
	],
	[
		'a V8 frame without a name',
		`    at ${routed}:12:34`,
		`    at ${page}:12:34`,
	],
	['a Gecko frame', `f@${routed}:12:34`, `f@${page}:12:34`],
	[
		'a whole stack',
		`Error: at ${routed}\n    at g (${routed}:1:2)\n    at ${routed}:3:4`,
		`Error: at ${page}\n    at g (${page}:1:2)\n    at ${page}:3:4`,
	],
])
	ok(
		`${name}: the page's URL, its line and column kept`,
		unrouteText(client, text) === expected,
		JSON.stringify(unrouteText(client, text)),
	);
// one call site's text, as a stack formatter gets it (no `at`): a location
ok(
	"one frame's text: the page's URL, its line and column kept",
	unrouteText(client, `Object.thrower (${routed}:6:40)`, true) ===
		`Object.thrower (${page}:6:40)`,
	unrouteText(client, `Object.thrower (${routed}:6:40)`, true),
);
await done();
