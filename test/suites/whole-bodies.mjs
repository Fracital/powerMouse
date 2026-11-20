// A short image (64 KB at most by its Content-Length) is read whole by the
// worker before the page is answered, and the HTTP cache, the memory cache
// and the document's repeat keep that one Blob (src/server/rewrites.ts
// wholeResponse), where each store read a branch of the body. Against the
// same page natively:
// - 30 images of 8 KB, one of 60 KB and one of 100 KB (streamed as before)
//   decode;
// - an image whose body breaks off (the origin closes the connection after
//   half its Content-Length) fails, as natively;
// - the document asking again for one of its images decodes it without the
//   origin being asked (natively the renderer's memory cache);
// - a second document of the site decodes them all without the origin being
//   asked (natively the memory cache, here the worker's).
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import {
	done,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const chunk = (type, data) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed) >>> 0);
	return Buffer.concat([length, typed, crc]);
};
/** a 2x2 PNG of about `kb` KB (a comment pads it) */
function png(kb, seed) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(2, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.from([0, seed & 255, 80, 160, seed & 255, 80, 160]);
	const head = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
	]);
	const pad = Math.max(0, kb * 1024 - head.length - 30);
	return Buffer.concat([
		head,
		chunk(
			'tEXt',
			Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(pad, 97)]),
		),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const IMAGES = [
	...Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, kb: 8 })),
	{ id: 'm', kb: 60 },
	{ id: 'l', kb: 100 },
];
/** the image requests the origin got, by run and id */
const asked = new Map();
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/page.html') {
		const run = url.searchParams.get('run');
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(
			`<!doctype html><title>WHOLE BODIES ${url.searchParams.get('step')}</title>${IMAGES.map(
				({ id, kb }) =>
					`<img data-id="${id}" src="/img/${id}.png?kb=${kb}&run=${run}">`,
			).join('')}<img data-id="broken" src="/broken.png?run=${run}">`,
		);
		return;
	}
	if (url.pathname.startsWith('/img/')) {
		const key = `${url.searchParams.get('run')} ${url.pathname}`;
		asked.set(key, (asked.get(key) ?? 0) + 1);
		const body = png(Number(url.searchParams.get('kb')), url.pathname.length);
		res.writeHead(200, {
			'content-type': 'image/png',
			'content-length': body.length,
			'cache-control': 'max-age=3600',
		});
		res.end(body);
		return;
	}
	if (url.pathname === '/broken.png') {
		const body = png(8, 7);
		res.writeHead(200, {
			'content-type': 'image/png',
			'content-length': body.length,
			'cache-control': 'max-age=3600',
		});
		res.write(body.subarray(0, body.length >> 1));
		setTimeout(() => res.socket?.destroy(), 100);
		return;
	}
	res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

/** in the page: each image's state once all have settled, and a repeat of the first */
const read = async () => {
	await Promise.all(
		[...document.images].map((image) =>
			image.complete
				? null
				: new Promise((resolve) => {
						image.onload = image.onerror = resolve;
					}),
		),
	);
	const states = {};
	for (const image of document.images)
		states[image.dataset.id] =
			image.complete && image.naturalWidth === 2 ? 'decoded' : 'failed';
	const repeat = new Image();
	repeat.src = document.images[0].src;
	await repeat.decode().catch(() => {});
	return { states, repeat: repeat.naturalWidth === 2 ? 'decoded' : 'failed' };
};
const summary = ({ states, repeat }) => {
	const decoded = Object.entries(states)
		.filter(([, state]) => state === 'decoded')
		.map(([id]) => id);
	return {
		decoded: decoded.length,
		broken: states.broken,
		m: states.m,
		l: states.l,
		repeat,
	};
};
/** origin requests for the images of `run` */
const origin = (run) =>
	[...asked]
		.filter(([key]) => key.startsWith(`${run} `))
		.reduce((a, [, n]) => a + n, 0);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(`${ORIGIN}page.html?run=native&step=1`);
const native = summary(await nativePage.evaluate(read));
const nativeAsked = origin('native');
await nativePage.goto(`${ORIGIN}page.html?run=native&step=2`);
const nativeAgain = summary(await nativePage.evaluate(read));
const nativeAgainAsked = origin('native') - nativeAsked;
await nativePage.close();
ok(
	'natively the images decode, the broken one fails, a repeat decodes',
	native.decoded === IMAGES.length &&
		native.broken === 'failed' &&
		native.repeat === 'decoded' &&
		nativeAsked === IMAGES.length,
	JSON.stringify({ native, nativeAsked }),
);

const page = await openDemo(browser, PROXY);
const proxiedLoad = async (url) => {
	await submitLanding(page, url);
	for (let i = 0; i < 160; i++) {
		const found = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
		if (
			(await found?.evaluate(() => document.title).catch(() => null)) ===
			`WHOLE BODIES ${new URL(url).searchParams.get('step')}`
		)
			return found;
		await sleep(250);
	}
	return null;
};
let frame = await proxiedLoad(`${ORIGIN}page.html?run=proxied&step=1`);
ok('the proxied page loads', !!frame);
if (frame) {
	const proxied = summary(await frame.evaluate(read));
	const proxiedAsked = origin('proxied');
	ok(
		'proxied: the images decode, the broken one fails and a repeat decodes without the origin, as natively',
		JSON.stringify(proxied) === JSON.stringify(native) &&
			proxiedAsked === IMAGES.length,
		JSON.stringify({ proxied, native, proxiedAsked }),
	);
	frame = await proxiedLoad(`${ORIGIN}page.html?run=proxied&step=2`);
	const again = frame ? summary(await frame.evaluate(read)) : null;
	const againAsked = origin('proxied') - proxiedAsked;
	ok(
		"proxied: the site's second document decodes them all without the origin, as natively",
		JSON.stringify(again) === JSON.stringify(nativeAgain) &&
			againAsked === nativeAgainAsked,
		JSON.stringify({ again, nativeAgain, againAsked, nativeAgainAsked }),
	);
}

server.close();
server.closeAllConnections();
await done(browser);
