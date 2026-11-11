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
export { default as GenericCodec, XORCodec, AESCodec, Base64Codec } from ${JSON.stringify(`${root}src/Codecs.ts`)};
export { linkRoute, parseLinkRoute, opaqueContext } from ${JSON.stringify(`${root}src/visited.ts`)};
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
const {
	unrouteText,
	GenericCodec,
	XORCodec,
	AESCodec,
	Base64Codec,
	linkRoute,
	parseLinkRoute,
	opaqueContext,
} = await import(`${bundle}?${Date.now()}`);

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

// A link's route (src/visited.ts): the browser's history is asked for it
// by its exact text, so every codec writes it the same way each time (the
// aes codec's salt is random for any other route), and it reads back as
// the URL it stands for, with its fragment
const suffix = (host) => host.split('.').pop();
const target = new URL('https://example.com/a/b?c=d&e=%20f#part');
for (const [name, linkCodec] of [
	['plain', new GenericCodec('')],
	['xor', new XORCodec('91')],
	['aes', new AESCodec('a key')],
	['base64', new Base64Codec('')],
])
	for (const context of [
		'https://www.example.com',
		'https://frame.example^https://top.example',
		opaqueContext('k3y9'),
	]) {
		const route = linkRoute(`${origin}/stomp/`, linkCodec, context, target);
		const parsed = parseLinkRoute(route, linkCodec, `${origin}/stomp/`, suffix);
		ok(
			`${name}: a link route of ${context} is the same text each time, and reads back`,
			route === linkRoute(`${origin}/stomp/`, linkCodec, context, target) &&
				/^http:\/\/127\.0\.0\.1:8090\/stomp\/~\/[^/?#]+#part$/.test(route) &&
				parsed?.url.href === target.href &&
				(context.includes('^')
					? parsed.context.frame === 'https://frame.example' &&
						parsed.context.top === 'https://top.example'
					: context.startsWith('null:')
						? parsed.context.frame === 'null' && parsed.context.top === context
						: parsed.context.frame === context &&
							parsed.context.top === 'https://example.com'),
			`${route} ${JSON.stringify(parsed)}`,
		);
	}
const link = linkRoute(
	`${origin}/stomp/`,
	codec,
	'https://example.com',
	target,
);
ok(
	"a link route in a message reads as the page's URL",
	unrouteText(client, `Cannot load ${link} now`) ===
		`Cannot load ${target.href} now`,
	unrouteText(client, `Cannot load ${link} now`),
);
ok(
	'what is no link route is none',
	parseLinkRoute(
		`${origin}/stomp/abc/html/x`,
		codec,
		`${origin}/stomp/`,
		suffix,
	) === null &&
		parseLinkRoute(
			`${origin}/stomp/~/a/b`,
			codec,
			`${origin}/stomp/`,
			suffix,
		) === null &&
		parseLinkRoute(
			`${origin}/stomp/~/${codec.encode('nonsense')}`,
			codec,
			`${origin}/stomp/`,
			suffix,
		) === null,
);
await done();
