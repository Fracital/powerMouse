// Dynamic parts of the speed fixtures: generated images, subresources,
// article text and the SPA's JSON API. Pages and assets answer with the
// cache headers an ordinary site sends (HTML revalidated, assets cacheable
// for a day), so a warm load can use the HTTP cache the way it would on the
// web.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { TYPES } from '../../lib/fixture.mjs';

const HERE = new URL('./', import.meta.url);
const WORDS =
	'proxy browser frame request response header cookie origin service worker transport stream rewrite script style image layout paint network cache history storage message window document element attribute property event timer promise module bundle'.split(
		' ',
	);

/** a deterministic pseudo-random generator, so every load gets the same bytes */
function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}
/** a w x h RGB PNG of soft noise around a colour picked by `seed` */
function png(w, h, seed) {
	const rand = rng(seed * 7919);
	const base = [rand() * 200, rand() * 200, rand() * 200];
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++)
			for (let c = 0; c < 3; c++)
				raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.min(
					255,
					base[c] + ((x + y) % 40) + rand() * 30,
				);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function paragraphs(seed, count) {
	const rand = rng(seed);
	const out = [];
	for (let p = 0; p < count; p++) {
		const words = [];
		const n = 60 + Math.floor(rand() * 80);
		for (let i = 0; i < n; i++)
			words.push(WORDS[Math.floor(rand() * WORDS.length)]);
		out.push(words.join(' '));
	}
	return out;
}

const cache = new Map();
function cached(key, make) {
	if (!cache.has(key)) cache.set(key, make());
	return cache.get(key);
}

function send(req, res, body, type, asset) {
	const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
	const headers = {
		'Content-Type': type,
		ETag: etag,
		'Cache-Control': asset ? 'public, max-age=86400' : 'no-cache',
		'Access-Control-Allow-Origin': '*',
		'Timing-Allow-Origin': '*',
	};
	if (req.headers['if-none-match'] === etag) {
		res.writeHead(304, headers).end();
		return true;
	}
	res.writeHead(200, { ...headers, 'Content-Length': body.length });
	res.end(body);
	return true;
}

function page(name) {
	return cached(`page:${name}`, () => readFileSync(new URL(name, HERE)));
}

export function handle(req, res) {
	const url = new URL(req.url, 'http://x');
	const path = url.pathname;
	if (!path.startsWith('/speed/')) return false;
	let m;
	if ((m = path.match(/^\/speed\/img\/(\d+)\.png$/)))
		return send(
			req,
			res,
			cached(path, () => png(480, 320, Number(m[1]) + 1)),
			'image/png',
			true,
		);
	if ((m = path.match(/^\/speed\/r\/js\/(\d+)\.js$/)))
		return send(
			req,
			res,
			cached(path, () =>
				Buffer.from(
					`(function(){var n=${m[1]};var list=[];for(var i=0;i<200;i++){list.push({id:i,name:'item'+n+'-'+i,value:Math.sqrt(i*n)});}window.__speedLoaded=(window.__speedLoaded||0)+1;window['data'+n]=list.filter(function(x){return x.value>3;}).map(function(x){return x.name;});})();\n// ${paragraphs(Number(m[1]), 3).join(' ')}\n`,
				),
			),
			TYPES['.js'],
			true,
		);
	if ((m = path.match(/^\/speed\/r\/css\/(\d+)\.css$/)))
		return send(
			req,
			res,
			cached(path, () =>
				Buffer.from(
					Array.from(
						{ length: 40 },
						(_, i) =>
							`.c${m[1]}-${i} { color: rgb(${i * 5}, ${m[1]}, 90); margin: ${i % 7}px; background: url(/speed/img/${(Number(m[1]) + i) % 8}.png) no-repeat -9999px -9999px; }`,
					).join('\n'),
				),
			),
			TYPES['.css'],
			true,
		);
	if ((m = path.match(/^\/speed\/r\/img\/(\d+)\.png$/)))
		return send(
			req,
			res,
			cached(path, () => png(64, 64, Number(m[1]) + 100)),
			'image/png',
			true,
		);
	if (path === '/speed/article-text.json')
		return send(
			req,
			res,
			cached(path, () => Buffer.from(JSON.stringify(paragraphs(42, 40)))),
			TYPES['.json'],
			false,
		);
	if ((m = path.match(/^\/speed\/api\/item\/(\d+)$/)))
		return send(
			req,
			res,
			cached(path, () =>
				Buffer.from(
					JSON.stringify({
						id: Number(m[1]),
						title: `Route ${m[1]}`,
						rows: paragraphs(Number(m[1]) + 7, 12),
					}),
				),
			),
			TYPES['.json'],
			false,
		);
	if ((m = path.match(/^\/speed\/([\w-]+\.(html|js|css))$/)))
		return send(req, res, page(m[1]), TYPES[`.${m[2]}`], m[2] !== 'html');
	return false;
}
