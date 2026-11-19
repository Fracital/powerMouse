// A zstd body made of more than one frame decodes whole through the proxy,
// as natively. Chrome's decoder (net/filter/zstd_source_stream.cc) reads a
// frame after the one before it ends; the transport's (async-compression's
// ZstdDecoder) stopped at the end of the first and handed on what it had as
// the whole body. A server that compresses a response in parts writes a
// frame per part: Spotify's search answer (api-partner.spotify.com) is
// 185 KB of JSON in frames of 64 KiB, and the page got the first 64 KiB
// alone, failed to parse it and showed "No results found". Gzip with two
// members and a zstd body after a skippable frame are compared too: the
// proxy answers each as natively, whatever that is.
import { createServer } from 'node:http';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

/** JSON-like text of `size` bytes that compresses about as well as an API answer */
function text(size) {
	let seed = 0x5eed1234;
	const random = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 4294967296;
	};
	const parts = [];
	let length = 0;
	while (length < size) {
		const part = `{"name":"item ${Math.floor(random() * 1e6)}","uri":"x:${Math.floor(random() * 36 ** 8).toString(36)}"},`;
		parts.push(part);
		length += part.length;
	}
	return Buffer.from(parts.join('')).subarray(0, size);
}

const plain = text(185 * 1000);
/** `plain` in frames of `size` bytes each, one after another */
const framed = (size, compress) => {
	const out = [];
	for (let at = 0; at < plain.length; at += size)
		out.push(compress(plain.subarray(at, at + size)));
	return Buffer.concat(out);
};
/** a skippable frame (magic 0x184D2A50, 4-byte length) and its content */
const skippable = Buffer.concat([
	Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0]),
	Buffer.from('skip'),
]);
const variants = {
	'zstd, one frame': ['zstd', zstdCompressSync(plain)],
	'zstd, a frame per 64 KiB': [
		'zstd',
		framed(64 * 1024, (part) => zstdCompressSync(part)),
	],
	'zstd after a skippable frame': [
		'zstd',
		Buffer.concat([skippable, zstdCompressSync(plain)]),
	],
	'gzip, a member per 64 KiB': [
		'gzip',
		framed(64 * 1024, (part) => gzipSync(part)),
	],
};

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>ZSTD FRAMES</title><p>zstd frames</p>');
	} else if (url.pathname === '/body') {
		const [encoding, body] = variants[url.searchParams.get('v')] ?? [];
		if (!body) return void res.writeHead(404).end();
		res.writeHead(200, {
			'content-type': 'application/json',
			'content-encoding': encoding,
			'content-length': body.length,
			'cache-control': 'no-store',
			'access-control-allow-origin': '*',
		});
		res.end(body);
	} else res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in a page: how the body reads (its length and first and last bytes) */
const read = async (url) => {
	try {
		const response = await fetch(url, { cache: 'no-store' });
		const buffer = new Uint8Array(await response.arrayBuffer());
		let sum = 0;
		for (const byte of buffer) sum = (sum * 31 + byte) >>> 0;
		return `${response.status} ${buffer.byteLength} bytes, sum ${sum}`;
	} catch (error) {
		return `rejected ${error.name}`;
	}
};

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html`);
const native = {};
for (const name of Object.keys(variants))
	native[name] = await nativePage.evaluate(
		read,
		`${ORIGIN}body?v=${encodeURIComponent(name)}`,
	);
await nativePage.close();
ok(
	`natively, zstd in frames decodes whole (${plain.length} bytes)`,
	native['zstd, a frame per 64 KiB'] === native['zstd, one frame'] &&
		native['zstd, one frame'].includes(` ${plain.length} bytes`),
	JSON.stringify(native),
);

const frameOf = async (page) => {
	for (let i = 0; i < 120; i++) {
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
		const title = await frame?.evaluate(() => document.title).catch(() => null);
		if (title === 'ZSTD FRAMES') return frame;
		await sleep(250);
	}
	return null;
};

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${ORIGIN}page.html`);
	const frame = await frameOf(page);
	ok(`${mode}: the proxied page loads`, !!frame);
	if (!frame) continue;
	for (const name of Object.keys(variants)) {
		const proxied = await frame
			.evaluate(read, `${ORIGIN}body?v=${encodeURIComponent(name)}`)
			.catch((error) => String(error).slice(0, 200));
		ok(
			`${mode}: ${name}: the page reads the body as natively`,
			proxied === native[name],
			`native ${native[name]} proxied ${proxied}`,
		);
	}
	await page.close();
}

server.close();
await done(browser);
