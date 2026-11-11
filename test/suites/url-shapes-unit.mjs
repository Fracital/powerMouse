// A URL's shape survives routing, checked in node with every codec: an
// empty query (`/p?`), an empty fragment (`/p#`), both, an empty query with
// a fragment and a query with an empty fragment come back from their route,
// from their link route (src/visited.ts) and from the codec itself as the
// exact string they were (the URL API's `search` and `hash` read the empty
// ones as nothing; src/urlShape.ts). A codec must hand back the very text it
// was given, whatever its wire format. Skips when esbuild is not installed,
// as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP url-shapes-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}url-shapes-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { default as GenericCodec, XORCodec, AESCodec, Base64Codec } from ${JSON.stringify(`${root}src/Codecs.ts`)};
export { default as StompURL } from ${JSON.stringify(`${root}src/StompURL.ts`)};
export { routeURL, parseRoutedURL } from ${JSON.stringify(`${root}src/routeURL.ts`)};
export { linkRoute, decodeLinkRoute } from ${JSON.stringify(`${root}src/visited.ts`)};
`,
);
const bundle = `${OUT}url-shapes-unit.mjs`;
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
	GenericCodec,
	XORCodec,
	AESCodec,
	Base64Codec,
	StompURL,
	routeURL,
	parseRoutedURL,
	linkRoute,
	decodeLinkRoute,
} = await import(`${bundle}?${Date.now()}`);

const CODECS = {
	generic: new GenericCodec(),
	'xor, a random key': new XORCodec(),
	'xor, key 91': new XORCodec('91'),
	aes: new AESCodec('a key'),
	base64: new Base64Codec(''),
};
const URLS = [
	'https://a.test/p',
	'https://a.test/p?',
	'https://a.test/p#',
	'https://a.test/p?#',
	'https://a.test/p?#f',
	'https://a.test/p?a=1#',
	'https://a.test/p?a=1#f',
	'https://a.test/?',
	'https://a.test/#',
	'https://a.test/p/?#',
	'https://a.test:8443/p%3F?%23=?#?#',
	'https://a.test/p?a?#b#',
];
const origin = 'https://proxy.test';
const scope = '/stomp/';
const directory = `${scope}abc/`;

for (const [name, codec] of Object.entries(CODECS)) {
	const results = {};
	for (const url of URLS) {
		// the codec gives back its input, empty parts and all
		const text = url.replace(/#.*$/s, '');
		const decoded = codec.decode(codec.encode(text));
		const stable = codec.decode(codec.encodeStable(text));
		// a route and back
		const routed = `${origin}${routeURL('html', new StompURL(url, codec, directory))}`;
		let back;
		try {
			back = parseRoutedURL(routed, codec, `${origin}${directory}`).url.url
				.href;
		} catch (error) {
			back = `threw ${error.message}`;
		}
		// a link route and back
		const link = linkRoute(scope, codec, 'context', new URL(url));
		let linked;
		try {
			linked =
				decodeLinkRoute(link.slice(`${scope}~/`.length), codec)?.url.href ??
				null;
		} catch (error) {
			linked = `threw ${error.message}`;
		}
		const wrong = [
			decoded !== text && `encode/decode ${JSON.stringify(decoded)}`,
			stable !== text && `encodeStable/decode ${JSON.stringify(stable)}`,
			back !== url && `route ${JSON.stringify(back)}`,
			linked !== url && `link route ${JSON.stringify(linked)}`,
		].filter(Boolean);
		if (wrong.length) results[url] = wrong;
	}
	ok(
		`${name}: every shape comes back from the codec, its route and its link route as the exact string it was`,
		Object.keys(results).length === 0,
		JSON.stringify(results),
	);
}

await done();
