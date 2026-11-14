// A Range (206 Partial Content) request for a content-encoded resource must
// arrive byte-complete. The origin computes the range over the *compressed*
// representation, so a 206 body is a fragment of the gzip/brotli stream, not a
// whole one. The transport must pass such a partial body through untouched; it
// must not run a content-encoding decoder over the fragment, which ends in an
// UnexpectedEof or a short, truncated body (a truncated font then fails Chrome's
// OTS sanitizer with "Size of decompressed WOFF 2.0 is less than compressed
// size"). This reproduced as the WOFF2 corruption on prod and is fixed in epoxy
// by deploy/epoxy/patches/epoxy-tls/0060: red on the stock build (the decoder
// truncates the partial), green on the rebuilt one (passthrough).
//
// The request goes through an epoxy instance in the page (wisp, TLS-less
// HTTP/1.1 to the loopback fixture), the layer the bug lives in, and gz-font
// (a real woff2 served content-encoding: gzip) is fetched by several byte
// ranges; each delivered range must equal the raw gzip file's bytes for it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, openDemo, PROXY } from '../lib.mjs';

// the raw gzip file the fixture serves (its content-encoding: gzip sidecar makes
// a Range of it a fragment of the compressed stream, as a CDN serves a woff2)
const gz = readFileSync(
	fileURLToPath(new URL('../pages/gz-font.woff2', import.meta.url)),
);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const RANGES = [
	[0, 65535], // from the start, over one 64 KiB packet
	[100000, 160000], // a middle slice
	[gz.length - 40000, gz.length - 1], // to the end
];
const expected = new Map(
	RANGES.map(([from, to]) => {
		const part = gz.subarray(from, to + 1);
		return [`bytes=${from}-${to}`, { length: part.length, hash: sha(part) }];
	}),
);

const wisp = `${PROXY.replace(/^http/, 'ws')}wisp/`;
const url = `${FIXTURE}pages/gz-font.woff2`;

const browser = await launch();
const page = await openDemo(browser, PROXY);

const results = await page.evaluate(
	async ({ url, ranges, wisp }) => {
		const { default: Epoxy } = await import('/epoxy/index.mjs');
		const epoxy = new Epoxy({ wisp });
		await epoxy.init();
		const out = {};
		for (const range of ranges) {
			const got = { range };
			try {
				const response = await epoxy.request(
					new URL(url),
					'GET',
					null,
					[
						['accept', '*/*'],
						['accept-encoding', 'gzip, deflate, br, zstd'],
						['range', range],
					],
					undefined,
				);
				got.status = response.status;
				const reader = response.body.getReader();
				let total = 0;
				const chunks = [];
				try {
					for (;;) {
						const { done: fin, value } = await reader.read();
						if (fin) break;
						total += value.byteLength;
						chunks.push(value);
					}
				} catch (error) {
					got.readError = String(
						error && error.message ? error.message : error,
					);
				}
				got.length = total;
				const all = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					all.set(chunk, offset);
					offset += chunk.byteLength;
				}
				const digest = await crypto.subtle.digest('SHA-256', all);
				got.hash = [...new Uint8Array(digest)]
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
			} catch (error) {
				got.error = String(error && error.message ? error.message : error);
			}
			out[range] = got;
		}
		return out;
	},
	{ url, ranges: [...expected.keys()], wisp },
);

for (const [range, want] of expected) {
	const got = results[range] || {};
	ok(
		`a 206 range (${range}) of the content-encoded font arrives byte-complete, no truncation`,
		got.status === 206 &&
			!got.error &&
			!got.readError &&
			got.length === want.length &&
			got.hash === want.hash,
		JSON.stringify({ want, got }),
	);
}

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
