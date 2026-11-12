// The xor codec's wire (docs/codec.md): the codec module (rust/codec,
// assets/codec.wasm) and the JavaScript in src/xorWire.ts write the same
// text for every input and key and refuse what is no seal alike, checked in
// node over a corpus of URLs, long and wide texts and broken seals
// (rust/host/codec.mjs runs the large one); every bundle that seals a URL
// carries the module once. In a browser: a proxied top seals in its own
// instance and a frame under it in its top's; no routed address of a page,
// a nested frame or a worker names the site or its path, and a GET form
// without an action lands at a sealed address with its fields as the page
// submitted them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, corpus, loadCodec } from '../../rust/host/codec.mjs';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	OUT,
	PROXY,
	recordRequests,
	sleep,
} from '../lib.mjs';

try {
	await import('esbuild');
} catch (error) {
	console.log('SKIP codec: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const glue = await loadCodec();
const { module, wire } = glue;

// the numbers rust/codec's own tests hold
ok(
	'the stream is the documented one',
	wire.streamWord(0, 0, 0) === 0 &&
		wire.streamWord(0x01234567, 0x89abcdef | 0, 0) >>> 0 === 0x5f5ab57b &&
		wire.streamWord(0x01234567, 0x89abcdef | 0, 1) >>> 0 === 0xb6e3de93 &&
		wire.streamWord(-1, -1, -1) >>> 0 === 0x1c82fd7a,
);
const vector = 'E8EuL-DkzJlw9kj1zVTg6Zz6YJM';
ok(
	'a seal is the documented text, in the module and in JavaScript',
	module.codecInModule() &&
		module.sealText('https://example.com/', 0x01234567, 0x89abcdef | 0) ===
			vector &&
		wire.seal(
			wire.bytesOf('https://example.com/'),
			0x01234567,
			0x89abcdef | 0,
		) === vector,
);

{
	const texts = corpus(5000, 7);
	const { differences, compared } = check(glue, texts, 7);
	ok(
		`the module and the JavaScript agree (${texts.length} texts, ${compared} comparisons)`,
		compared > 0 && differences.length === 0,
		differences.slice(0, 5).join('\n'),
	);
}

// carried as text, once in each bundle that seals (the rewriter library
// inside the document bundle is handed it, not given a copy)
const carried = readFileSync(`${root}assets/codec.wasm`).toString('base64url');
for (const name of [
	'serviceWorker.js',
	'injectDocument.js',
	'injectWorker.js',
]) {
	const text = readFileSync(`${root}dist/${name}`, 'utf8');
	const count = text.split(carried).length - 1;
	ok(`${name} carries the codec module once`, count === 1, String(count));
}

// the route kinds that name a site: sealed, and read back
{
	const out = `${OUT}codec-kinds.mjs`;
	await (
		await import('esbuild')
	).build({
		stdin: {
			contents:
				`export * from ${JSON.stringify(`${root}src/partition.ts`)};\n` +
				`export { XORCodec } from ${JSON.stringify(`${root}src/Codecs.ts`)};\n`,
			resolveDir: root,
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		outfile: out,
		logLevel: 'silent',
	});
	const kinds = await import(`${out}?${Date.now()}`);
	const codec = new kinds.XORCodec(kinds.XORCodec.generateKey());
	const worker = kinds.workerKind('worker', '^https://example.co.uk', codec);
	const mark = kinds.nestedMark('https://example.co.uk', true);
	const nested = `html:nested:${codec.encode(mark)}`;
	ok(
		"a partitioned worker's and a nested document's kinds name their site only sealed",
		/^js:worker:top:[\w-]+$/.test(worker) &&
			!/example/.test(worker) &&
			kinds.workerKindPartition(worker, codec) === '^https://example.co.uk' &&
			!/example/.test(nested) &&
			kinds.kindPartition(nested, 'https://a.test', () => null, codec) !== '',
		JSON.stringify({ worker, nested }),
	);
}

const browser = await launch();
const page = await openDemo(browser, PROXY);
const recorder = await recordRequests(page.context());

/** a routed address's text after the controller's address, '' for one outside it (or none: a frame not yet navigated) */
const routeText = (url) => {
	if (!URL.canParse(url)) return '';
	const match = /^\/stomp\/[^/]+\/(.*)$/.exec(new URL(url).pathname);
	return match ? match[1] : '';
};
// what a route must not show of the fixture's URLs (the route kinds' own
// names, `nested` and `worker`, are not the page's)
const fixture = new URL(FIXTURE);
const CLEAR = new RegExp(
	`localhost|127\\.0\\.0\\.1|${fixture.port}|pages|hist-|nested-child|worker-loc|\\.html|\\.js`,
);

await page.evaluate(() => {
	const element = document.createElement('iframe');
	element.id = 'codec-frame';
	document.body.append(element);
	window.__frame = window.controller.createFrame(element);
});
const frameGo = (url) => page.evaluate((url) => window.__frame.go(url), url);
const seen = new Set();
const note = () => {
	for (const frame of page.frames()) seen.add(frame.url());
	for (const worker of page.workers()) seen.add(worker.url());
};

// a top on one host, two nested frames of another site
await frameGo(`${FIXTURE.replace('127.0.0.1', 'localhost')}pages/nested.html`);
for (
	let i = 0;
	i < 100 && !page.frames().some((frame) => /\/html:nested:/.test(frame.url()));
	i++
)
	await sleep(100);
note();

// where each document seals: a top in its own instance, a frame under it
// (one the page makes, routed or blank) in its top's
await frameGo(`${FIXTURE}pages/hist-1.html`);
await page.evaluate(() => {
	const top = window.__frame.element.contentWindow;
	for (const src of ['/pages/hist-2.html', '']) {
		const frame = top.document.createElement('iframe');
		if (src) frame.src = src;
		top.document.body.append(frame);
	}
});
let runs = null;
for (let i = 0; i < 100 && !runs; i++) {
	runs = await page
		.evaluate(() => {
			const top = window.__frame.element.contentWindow;
			const name = window.controller.config.names.client;
			const [routed, blank] = [...top.document.querySelectorAll('iframe')].map(
				(frame) => frame.contentWindow,
			);
			if (!top[name] || !routed?.[name] || !blank?.[name]) return null;
			if (!/hist-2/.test(routed[name].url.toString())) return null;
			return [top, routed, blank].map((realm) => realm[name].codecRuns);
		})
		.catch(() => null);
	if (!runs) await sleep(100);
}
note();
ok(
	"a proxied top seals in its own instance and the frames under it in its top's",
	JSON.stringify(runs) === JSON.stringify(['own', 'top', 'top']),
	JSON.stringify(runs),
);

// storage written past the bridge's beacons (the ordered fetch), a GET form
// without an action: to the document's own address, then its sealed one,
// the fields the page sees as it submitted them
await page.evaluate(() => {
	const top = window.__frame.element.contentWindow;
	top.localStorage.setItem('codec-key', 'x'.repeat(200000));
	const form = top.document.createElement('form');
	const input = top.document.createElement('input');
	input.name = 'field';
	input.value = 'value';
	form.append(input);
	top.document.body.append(form);
	form.submit();
});
let landed = null;
for (let i = 0; i < 100 && !landed; i++) {
	landed = await page
		.evaluate(() => {
			const top = window.__frame.element.contentWindow;
			const client = top[window.controller.config.names.client];
			return client && client.url.url.search === '?field=value'
				? {
						page: top.document.URL,
						stored: top.localStorage.getItem('codec-key')?.length,
					}
				: null;
		})
		.catch(() => null);
	if (!landed) await sleep(100);
}
note();
const raw = page
	.frames()
	.map((frame) => frame.url())
	.find((url) => routeText(url).startsWith('html/'));
ok(
	'a GET form without an action lands at a sealed address, its fields as submitted',
	new URL(landed?.page ?? 'about:blank').search === '?field=value' &&
		raw &&
		!new URL(raw).search &&
		!/field|value/.test(routeText(raw)),
	JSON.stringify({ landed, raw }),
);
ok(
	'a large storage write reads back',
	landed?.stored === 200000,
	String(landed?.stored),
);

// every address under the controller's the browser loaded or showed: no
// site, no path; a query only where the browser wrote a form's fields after
// a route (one request, answered with the sealed address) or on the
// worker's own API calls, which hold nothing of the page in clear
const addresses = [
	...seen,
	...recorder.log
		.filter((entry) => entry.kind === 'worker')
		.map((entry) => entry.url),
].filter((url) => routeText(url));
const leaks = addresses.filter((url) => {
	const parsed = new URL(url);
	if (CLEAR.test(routeText(url))) return true;
	if (!parsed.search) return false;
	if (/^html(:form)?(:nested:[\w-]+)?\//.test(routeText(url)))
		return parsed.search !== '?field=value';
	return CLEAR.test(decodeURIComponent(parsed.search));
});
ok(
	`no routed address names the site or its path (${addresses.length} addresses)`,
	addresses.length > 10 && leaks.length === 0,
	leaks.slice(0, 10).join('\n'),
);
ok(
	'the routes include nested frames and the ordered storage call',
	addresses.some((url) => /^html:nested:[\w-]+\//.test(routeText(url))) &&
		addresses.some((url) => /^localStorage\/ordered$/.test(routeText(url))),
	[...new Set(addresses.map((url) => routeText(url).split('/')[0]))].join(' '),
);

await done(browser);
