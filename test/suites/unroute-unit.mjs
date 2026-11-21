// Routed URLs in error text read back as the page's own, checked in node:
// in a message (no line or column) the route is read whole, in a frame
// (V8's `at` lines, Gecko's `@`) the last two `:digits` are its line and
// column. Under the codec before docs/codec.md a route's own text could end
// in `:digits` (its `:` was one of the codec's characters), and reading
// that as a column decoded the rest to another URL: `?ms=3009` came back as
// `?ms=300:1`, now and then, with the random key a controller drew. The
// sealed route has no `:`, checked here with many keys. Skips when esbuild
// is not installed, as rewriter-unit does.
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
export { addRouteScope, unwrapRoute } from ${JSON.stringify(`${root}src/routeURL.ts`)};
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
	addRouteScope,
	unwrapRoute,
} = await import(`${bundle}?${Date.now()}`);

const codec = new XORCodec('0123456789abcdef');
const origin = 'http://127.0.0.1:8090';
const client = {
	isDOM: false,
	global: { location: { origin } },
	directory: '/stomp/abc/',
	scope: '/stomp/',
	codec,
	url: { url: new URL('https://example.com/') },
	// (src/inject/Client.ts: a served realm's routes are on its own origin)
	originOf: (location) => location.origin,
};
const page = 'https://example.com/pages/import404.js?ms=3009';
const routed = `${origin}/stomp/abc/js:generic/${codec.encode(page)}`;
let colons = 0;
for (let n = 0; n < 2000; n++)
	if (new XORCodec(XORCodec.generateKey()).encode(page).includes(':')) colons++;
ok("no key puts a `:` in a route's own text", colons === 0, String(colons));
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
// the URL it stands for, with its fragment, which the route holds sealed
// (docs/codec.md)
const suffix = (host) => host.split('.').pop();
const target = new URL('https://example.com/a/b?c=d&e=%20f#part');
for (const [name, linkCodec] of [
	['plain', new GenericCodec('')],
	['xor', new XORCodec('0123456789abcdef')],
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
				/^http:\/\/127\.0\.0\.1:8090\/stomp\/~\/[^/?#]+#~[^/?#]+$/.test(
					route,
				) &&
				(name !== 'xor' || !route.includes('part')) &&
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

// A route of a route is the route it stands for (unwrapRoute), and with a
// keyed codec a route of another key (a STomp the page runs: proxy-ception,
// docs/proxyception.md) does not decode. A codec without a key decodes
// every controller's routes alike: told the caller's address, it takes only
// its own id's (and no link route, which names none), and leaves the rest
// to the STomp that made them; untold, as before, any id's.
addRouteScope(origin, '/stomp/');
const real = 'https://example.com/a?b=c';
const routeOf = (routeCodec, id) =>
	new URL(`${origin}/stomp/${id}/html/${routeCodec.encode(real)}`);
for (const [name, ownCodec, innerCodec] of [
	['plain', new GenericCodec(''), new GenericCodec('')],
	['base64', new Base64Codec(''), new Base64Codec('')],
	['xor', new XORCodec('0123456789abcdef'), new XORCodec('fedcba9876543210')],
]) {
	const own = unwrapRoute(routeOf(ownCodec, 'abc'), ownCodec, '/stomp/abc/');
	const inner = unwrapRoute(
		routeOf(innerCodec, 'inner1'),
		ownCodec,
		'/stomp/abc/',
	);
	const innerLink = unwrapRoute(
		new URL(
			linkRoute(
				`${origin}/stomp/`,
				innerCodec,
				'https://a.example',
				new URL(real),
			),
		),
		ownCodec,
		'/stomp/abc/',
	);
	const untold = unwrapRoute(routeOf(ownCodec, 'other'), ownCodec);
	ok(
		`${name}: a route of the caller's own id unwraps, an inner STomp's route and link route do not`,
		own?.href === real &&
			inner === null &&
			(name === 'xor' || innerLink === null) &&
			untold?.href === real,
		JSON.stringify({
			own: own?.href,
			inner: inner?.href,
			innerLink: innerLink?.href,
			untold: untold?.href,
		}),
	);
}
await done();
