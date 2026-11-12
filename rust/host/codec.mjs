// The codec module (rust/codec, assets/codec.wasm) against the JavaScript
// side of the wire (src/xorWire.ts), in Node, without a browser: both have
// to write the same text for every input and key, and open what either
// wrote, and refuse what is no seal alike (docs/codec.md). Called the way
// every realm calls them (src/wasm/codec.ts, bundled here with the module
// carried as the bundles carry it), so the glue's pieces, its ASCII fast
// path and its wide path are under test too. Compared over:
//
//   - every URL found in the repository's test data;
//   - generated URLs: hosts (IDN, punycode, IP literals, ports), paths,
//     queries and fragments, with non-ASCII as written and escaped, lone
//     surrogates, data: and blob: URLs, nested marks and sites as the route
//     kinds seal them;
//   - long texts across the module's buffer (12288 bytes a seal, 16384
//     characters an open), ASCII and wide, up to 200 KB;
//   - every length up to 600 of random bytes as text;
//   - what is no seal: every seal above changed in one character, cut to a
//     length no seal has, given set bits a seal leaves clear, and random
//     text.
//
//   node rust/host/codec.mjs            # exit 1 on any difference
//   node rust/host/codec.mjs --bench    # and seals and opens per second
//
// COUNT=<number> generated URLs (100000 by default), SEED=<number>,
// CODEC_WASM names another artifact than assets/codec.wasm. The codec
// suite runs `check` over a smaller corpus.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** the glue, bundled from src with `artifact` carried as build.js carries it */
export async function loadCodec(artifact = `${root}assets/codec.wasm`) {
	const esbuild = await import('esbuild');
	const out = mkdtempSync(join(tmpdir(), 'codec-harness-'));
	await esbuild.build({
		stdin: {
			contents:
				`export * as module from ${JSON.stringify(`${root}src/wasm/codec.ts`)};\n` +
				`export * as wire from ${JSON.stringify(`${root}src/xorWire.ts`)};\n`,
			resolveDir: root,
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		define: {
			'process.env.STOMP_CODEC_WASM': JSON.stringify(
				readFileSync(artifact).toString('base64url'),
			),
			'process.env.STOMP_BUILD': '"harness"',
		},
		outfile: join(out, 'glue.mjs'),
		logLevel: 'silent',
	});
	return import(pathToFileURL(join(out, 'glue.mjs')).href);
}

/** a seeded generator (xorshift32), so a failure can be replayed */
export function random(seed) {
	let state = seed >>> 0 || 0x9e3779b9;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
	return {
		next,
		int: (n) => Math.floor(next() * n),
		pick: (list) => list[Math.floor(next() * list.length)],
	};
}

const HOSTS = [
	'example.com',
	'www.example.co.uk',
	'a.b.c.d.github.io',
	'localhost',
	'127.0.0.1',
	'[::1]',
	'[2001:db8::8a2e:370:7334]',
	'xn--bcher-kva.example',
	'bücher.example',
	'例え.テスト',
	'xn--r8jz45g.xn--zckzah',
	'en.wikipedia.org',
	'www.youtube.com',
	'discord.com',
	'docs.google.com',
	'x.invalid',
];
const SEGMENTS = [
	'',
	'index.html',
	'wiki',
	'Web_proxy',
	'a b',
	'%20',
	'%E2%9C%93',
	'✓',
	'日本語',
	'emoji-😀',
	'..',
	';jsessionid=1',
	'@user',
	'~tilde',
	"it's",
	'$dollar',
	'a:b',
	'x'.repeat(300),
];
const QUERIES = [
	'',
	'?',
	'?q=proxy',
	'?a=1&b=2&c=',
	'?q=%E6%97%A5%E6%9C%AC',
	'?q=日本',
	'?redirect=https%3A%2F%2Fexample.com%2F',
	'?redirect=https://example.com/?x=1#y',
	'?ms=3009',
	`?token=${'A1b2'.repeat(500)}`,
];
const FRAGMENTS = ['', '#', '#top', '#a/b?c', '#日本', '#%20x', '#:~:text=hi'];

/** a URL (or a text a route kind seals) of the kinds STomp routes */
function generated(rng) {
	const kind = rng.int(20);
	if (kind === 0) {
		// a data: URL, short or long, text or base64
		const body = rng.int(2)
			? Buffer.from(
					Array.from({ length: rng.int(20000) }, () => rng.int(256)),
				).toString('base64')
			: encodeURIComponent('<p>héllo</p>'.repeat(rng.int(50)));
		return `data:${rng.pick(['text/html', 'image/png', 'text/javascript;charset=utf-8'])}${rng.int(2) ? ';base64' : ''},${body}`;
	}
	if (kind === 1)
		return `blob:https://${rng.pick(HOSTS)}/${Array.from({ length: 4 }, () =>
			rng.int(0x10000).toString(16).padStart(4, '0'),
		).join('-')}`;
	if (kind === 2)
		// a nested mark (src/partition.ts) and a worker's site, as the kinds seal them
		return rng.int(2)
			? `https://${rng.pick(HOSTS)}${rng.int(2) ? ' cross' : ''}`
			: rng.pick(HOSTS);
	if (kind === 3)
		// lone surrogates and every plane
		return Array.from({ length: rng.int(64) }, () =>
			String.fromCharCode(rng.int(0x10000)),
		).join('');
	const scheme = rng.pick(['https', 'http', 'wss', 'ws', 'ftp']);
	const port = rng.int(5) ? '' : `:${rng.int(65536)}`;
	const path = Array.from({ length: rng.int(6) }, () =>
		rng.pick(SEGMENTS),
	).join('/');
	return `${scheme}://${rng.pick(HOSTS)}${port}/${path}${rng.pick(QUERIES)}${rng.pick(FRAGMENTS)}`;
}

/** every http(s) URL written in the repository's test data */
function repositoryURLs() {
	const found = new Set();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'out' && entry.name !== 'node_modules') walk(path);
			} else if (
				/\.(m?js|html|json|css|txt)$/.test(entry.name) &&
				statSync(path).size < 4e6
			)
				for (const match of readFileSync(path, 'utf8').matchAll(
					/\bhttps?:\/\/[^\s'"`<>()\\]+/g,
				))
					found.add(match[0]);
		}
	};
	walk(`${root}test`);
	return [...found];
}

/** the texts to compare: `count` generated, the repository's, long ones, random bytes */
export function corpus(count, seed = 1) {
	const rng = random(seed);
	const texts = ['', 'a', 'ab', 'abc', 'https://example.com/'];
	texts.push(...repositoryURLs());
	for (let n = 0; n < count; n++) texts.push(generated(rng));
	// across the module's buffers: a seal takes 12288 bytes a piece, an
	// open 16384 characters (wide text is two bytes a character, and one)
	for (const length of [
		6143, 6144, 6145, 12287, 12288, 12289, 16383, 16384, 16385, 24576, 36865,
		200000,
	]) {
		texts.push(`https://example.com/?${'q'.repeat(length - 21)}`);
		texts.push(`https://example.com/?${'é'.repeat(length - 21)}`);
		texts.push('x'.repeat(length));
	}
	for (let length = 0; length <= 600; length++)
		texts.push(
			String.fromCharCode(
				...Array.from({ length }, () =>
					rng.int(4) ? rng.int(128) : rng.int(0x10000),
				),
			),
		);
	return texts;
}

/** a key as generateKey draws one, from the seeded generator */
function key(rng) {
	return [rng.int(0x100000000) | 0, rng.int(0x100000000) | 0];
}

/**
 * Every difference between the module and the JavaScript over `texts`,
 * each under a key of its own (and a few fixed ones), as messages; how
 * many comparisons were made
 */
export function check({ module, wire }, texts, seed = 1) {
	const rng = random(seed ^ 0x5bd1e995);
	const differences = [];
	let compared = 0;
	if (!module.codecInModule()) {
		differences.push('the module did not instantiate: nothing compared');
		return { differences, compared };
	}
	const show = (text) =>
		JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
	const fixed = [
		[0, 0],
		[-1, -1],
		[0x01234567, 0x89abcdef | 0],
	];
	const jsSeal = (text, a, b) => wire.seal(wire.bytesOf(text), a, b);
	const jsOpen = (text, a, b) => {
		const bytes = wire.open(text, a, b);
		return bytes && wire.textOf(bytes);
	};
	const differ = (what, text, one, other) => {
		compared++;
		if (one !== other && differences.length < 50)
			differences.push(
				`${what} ${show(text)}: module ${show(String(one))}, JavaScript ${show(String(other))}`,
			);
	};
	const ALPHABET =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	for (const [n, text] of texts.entries()) {
		const [a, b] = n < fixed.length * 50 ? fixed[n % fixed.length] : key(rng);
		const sealed = module.sealText(text, a, b);
		differ('seal', text, sealed, jsSeal(text, a, b));
		differ('module opens', text, module.openText(sealed, a, b), text);
		differ('JavaScript opens', text, jsOpen(sealed, a, b), text);
		differ(
			'no character outside the alphabet',
			text,
			[...sealed].every((c) => ALPHABET.includes(c)),
			true,
		);
		// what is no seal, refused (or opened) alike
		// a length no seal has
		let cut = `${sealed}A`;
		while (cut.length % 4 !== 1) cut = cut.slice(0, -1);
		const broken = [cut];
		if (sealed.length) {
			const at = rng.int(sealed.length);
			broken.push(
				sealed.slice(0, at) +
					rng.pick(['$', '=', '+', '/', '%', ' ', 'é', '\0']) +
					sealed.slice(at + 1),
			);
			broken.push(
				sealed.slice(0, at) + rng.pick([...ALPHABET]) + sealed.slice(at + 1),
			);
			// the last character with the bits a seal leaves clear set
			const last = ALPHABET.indexOf(sealed.at(-1));
			if (sealed.length % 4 !== 0)
				broken.push(sealed.slice(0, -1) + ALPHABET[last | 1]);
		}
		broken.push(
			String.fromCharCode(
				...Array.from({ length: rng.int(40) }, () => rng.int(128)),
			),
		);
		for (const text of broken)
			differ(
				'open of what may be no seal',
				text,
				module.openText(text, a, b),
				jsOpen(text, a, b),
			);
	}
	return { differences, compared };
}

/** seals and opens per second of `seal` and `open` over `texts` */
export function bench(seal, open, texts, rounds = 5) {
	const sealed = texts.map((text) => seal(text));
	const bytes = texts.reduce((sum, text) => sum + text.length, 0);
	const time = (work) => {
		let best = Infinity;
		for (let round = 0; round < rounds; round++) {
			const started = process.hrtime.bigint();
			work();
			best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
		}
		return best;
	};
	const sealMs = time(() => {
		for (const text of texts) seal(text);
	});
	const openMs = time(() => {
		for (const text of sealed) open(text);
	});
	return {
		texts: texts.length,
		characters: bytes,
		sealMs,
		openMs,
		sealPerText: (sealMs * 1000) / texts.length,
		openPerText: (openMs * 1000) / texts.length,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const glue = await loadCodec(process.env.CODEC_WASM || undefined);
	const seed = Number(process.env.SEED) || 1;
	const texts = corpus(Number(process.env.COUNT) || 100000, seed);
	const started = Date.now();
	const { differences, compared } = check(glue, texts, seed);
	console.log(
		`${texts.length} texts, ${compared} comparisons, ${differences.length} differences (${Date.now() - started} ms)`,
	);
	for (const line of differences) console.log(`  ${line}`);
	if (process.argv.includes('--bench')) {
		const [a, b] = [0x01234567, 0x89abcdef | 0];
		// what routes are: URLs of the generated kinds, the long ones apart
		const urls = texts.filter((text) => text.length < 4096);
		const { module, wire } = glue;
		for (const [name, seal, open] of [
			[
				'module',
				(text) => module.sealText(text, a, b),
				(text) => module.openText(text, a, b),
			],
			[
				'JavaScript',
				(text) => wire.seal(wire.bytesOf(text), a, b),
				(text) => {
					const bytes = wire.open(text, a, b);
					return bytes && wire.textOf(bytes);
				},
			],
		]) {
			const result = bench(seal, open, urls);
			console.log(
				`${name}: ${result.texts} texts (${result.characters} characters): seal ${result.sealMs.toFixed(1)} ms (${result.sealPerText.toFixed(2)} us each), open ${result.openMs.toFixed(1)} ms (${result.openPerText.toFixed(2)} us each)`,
			);
		}
	}
	process.exit(differences.length ? 1 : 0);
}
