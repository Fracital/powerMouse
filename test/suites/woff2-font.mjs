// A real WOFF2 font loaded through the proxy must arrive byte-for-byte as the
// origin served it: Chrome's OTS sanitizer rejects a truncated or byte-altered
// WOFF2 ("Size of decompressed WOFF 2.0 is less than compressed size"), so a
// binary font body must never pass through a text decode/re-encode, nor be
// truncated by the transport. The page fetches each font through the proxy and
// reports its bytes (length + a SHA-256 digest), and builds a FontFace from the
// proxied URL and loads it: load() rejects on an OTS error. A small font (one
// transport chunk) and a larger one (several chunks, over the 64 KiB wisp
// packet size) are both checked, each served as font/woff2 as a real site does.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const FONTS = [
	'real-font.woff2',
	'big-font.woff2',
	'gz-font.woff2',
	'cross-font.woff2',
];
// www.localhost resolves to the same fixture as a same-site, cross-origin host
// (see test/lib.mjs): the cross-origin font is served from it.
const CROSS_BASE = FIXTURE.replace('://127.0.0.1', '://www.localhost').replace(
	/\/$/,
	'',
);
// gz-font is served content-encoding: gzip (the browser decompresses it before
// the page or the sanitizer sees it) and cross-font is big-font fetched from
// another origin: both deliver big-font.woff2's bytes.
const sourceOf = (name) =>
	name === 'gz-font.woff2' || name === 'cross-font.woff2'
		? 'big-font.woff2'
		: name;
const origin = new Map(
	FONTS.map((name) => {
		const bytes = readFileSync(
			fileURLToPath(new URL(`../pages/${sourceOf(name)}`, import.meta.url)),
		);
		return [
			name,
			{
				length: bytes.byteLength,
				hash: createHash('sha256').update(bytes).digest('hex'),
			},
		];
	}),
);

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}pages/css.html`);

let results = null;
for (let i = 0; i < 80; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	if (!frame) continue;
	try {
		results = await frame.evaluate(
			async ({ names, crossBase }) => {
				const out = {};
				for (const name of names) {
					// big-font is also loaded cross-origin (the Google-Fonts pattern:
					// a CORS font from another origin), which routes through the CORS
					// path rather than the same-origin one
					const url =
						name === 'cross-font.woff2'
							? `${crossBase}/pages/big-font.woff2`
							: `/pages/${name}`;
					const got = { url };
					// the font as the page's own fetch sees it, byte for byte
					try {
						const response = await fetch(url);
						got.status = response.status;
						const bytes = new Uint8Array(await response.arrayBuffer());
						got.length = bytes.byteLength;
						got.magic = String.fromCharCode(...bytes.subarray(0, 4));
						const digest = await crypto.subtle.digest('SHA-256', bytes);
						got.hash = [...new Uint8Array(digest)]
							.map((b) => b.toString(16).padStart(2, '0'))
							.join('');
					} catch (error) {
						got.fetchError = String(error);
					}
					// the font as Chrome's sanitizer sees it, through a FontFace
					try {
						const face = new FontFace(`probe-${name}`, `url("${url}")`);
						await face.load();
						got.faceLoaded = true;
					} catch (error) {
						got.faceError = String(
							error && error.message ? error.message : error,
						);
					}
					out[name] = got;
				}
				return out;
			},
			{ names: FONTS, crossBase: CROSS_BASE },
		);
	} catch (error) {
		results = null;
	}
	if (
		results &&
		FONTS.every(
			(n) => results[n] && (results[n].length || results[n].fetchError),
		)
	)
		break;
}

results = results || {};
for (const name of FONTS) {
	const want = origin.get(name);
	const got = results[name] || {};
	ok(
		`the proxied ${name} fetch is byte-identical to the origin`,
		got.length === want.length && got.hash === want.hash,
		JSON.stringify({ want, got }),
	);
	ok(
		`FontFace.load() of the proxied ${name} succeeds (no OTS error)`,
		got.faceLoaded === true,
		JSON.stringify({ faceError: got.faceError }),
	);
}

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
