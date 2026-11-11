// The built-in blocker's engine (rust/block, assets/blocker.wasm), run in
// node the way the service worker runs it (src/server/blocker.ts bundled
// from src): the lists and the resources come through the fetch the worker
// is given (here the fixture files in test/pages, never a download), the
// engine is compiled from them, and it answers for requests by their real
// URLs, types and parties, for a document's `$csp=` policies and for its
// cosmetic resources. No browser: the adblock suite proves the same through
// the proxy. `ADBLOCK_BENCH_LIST=<file>` also times a list of real size.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP adblock-engine: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const pages = `${root}test/pages/`;

mkdirSync(OUT, { recursive: true });
const entry = `${OUT}adblock-engine-entry.mjs`;
writeFileSync(
	entry,
	`export { Blocker } from ${JSON.stringify(`${root}src/server/blocker.ts`)};\n` +
		`export { carriedCsp } from ${JSON.stringify(`${root}src/blocker/csp.ts`)};\n` +
		`export { requestTypeOf, resolveAdblockOptions } from ${JSON.stringify(`${root}src/blocker/types.ts`)};\n` +
		`export { BlockerInstance, OP } from ${JSON.stringify(`${root}src/blocker/instance.ts`)};\n` +
		`export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n`,
);
const bundle = `${OUT}adblock-engine.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	outfile: bundle,
	logLevel: 'silent',
});
const {
	Blocker,
	carriedCsp,
	requestTypeOf,
	resolveAdblockOptions,
	BlockerInstance,
	OP,
	compileModule,
} = await import(bundle);

const module = await compileModule(readFileSync(`${root}dist/blocker.wasm`));

// the worker's fetch through the transport, answered from the fixture files
const SITE = 'http://127.0.0.1:8084';
const OTHER = 'http://localhost:8084';
const fetched = [];
const fromPages = async (url) => {
	fetched.push(url);
	const file = /\/pages\/([\w.-]+)$/.exec(new URL(url).pathname)?.[1];
	try {
		return new Response(readFileSync(`${pages}${file}`));
	} catch (error) {
		return new Response('missing', { status: 404 });
	}
};
const init = (lists, extra = {}) => ({
	lists,
	resources: `${SITE}/pages/adblock-resources.json`,
	refreshMs: 24 * 3600_000,
	...extra,
});

const blocker = new Blocker(
	init([
		{ url: `${SITE}/pages/adblock-list.txt`, trusted: true },
		{ url: `${SITE}/pages/adblock-untrusted.txt` },
		{ url: `${SITE}/pages/adblock-missing.txt` },
	]),
	fromPages,
	async () => module,
);
ok(
	'the engine is built from the lists it could fetch',
	await blocker.settled(),
);
ok(
	'the lists and the resources were fetched through the given fetch',
	fetched.length === 4 &&
		fetched.includes(`${SITE}/pages/adblock-list.txt`) &&
		fetched.includes(`${SITE}/pages/adblock-resources.json`),
	fetched.join(' '),
);

const page = `${SITE}/pages/adblock.html`;
const decide = (path, destination, extra = {}) =>
	blocker.decide({
		url: path.startsWith('http') ? path : `${SITE}${path}`,
		source: page,
		destination,
		navigation: false,
		topLevel: false,
		method: 'GET',
		...extra,
	});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok(
	'a listed script is blocked',
	same(decide('/pages/adblock-blocked.js', 'script'), { block: true }),
);
ok('an unlisted request goes out', decide('/pages/hdr.json', 'empty') === null);
ok(
	'an exception rule lets its request out',
	decide('/pages/adblock-allowed.js', 'script') === null,
);
ok(
	'the exception is for its type only',
	same(decide('/pages/adblock-allowed.js', 'image'), { block: true }),
);
ok(
	'a rule for images blocks the image',
	same(decide('/pages/adblock-pixel.svg', 'image'), { block: true }),
);
ok(
	'and not the same URL as a fetch',
	decide('/pages/adblock-pixel.svg', 'empty') === null,
);
ok(
	'a rule for XHR blocks a fetch (an empty destination)',
	same(decide('/pages/adblock-typed.json', ''), { block: true }) &&
		same(decide('/pages/adblock-typed.json', 'empty'), { block: true }),
);
ok(
	'and not the same URL as an image, a style or a script',
	['image', 'style', 'script', 'font', 'video'].every(
		(destination) => decide('/pages/adblock-typed.json', destination) === null,
	),
);
ok(
	'a third-party rule lets the first party through',
	decide('/pages/adblock-third.js', 'script') === null,
);
ok(
	'and blocks the request to another site',
	same(decide(`${OTHER}/pages/adblock-third.js`, 'script'), { block: true }),
);
ok(
	'a request with no known source is a third party',
	same(decide('/pages/adblock-third.js', 'script', { source: '' }), {
		block: true,
	}),
);
ok(
	'a $domain rule applies under the page it names only',
	decide('/pages/adblock-domain.js', 'script') === null &&
		same(
			decide('/pages/adblock-domain.js', 'script', {
				source: `${OTHER}/pages/adblock.html`,
			}),
			{ block: true },
		),
);
ok(
	'a subdocument rule blocks a nested navigation',
	same(decide('/pages/adblock-frame.html', 'iframe', { navigation: true }), {
		block: true,
	}),
);
ok(
	'and not the top-level document, which is its own first party',
	decide('/pages/adblock-frame.html', 'iframe', {
		navigation: true,
		topLevel: true,
		source: '',
	}) === null,
);
const redirected = decide('/pages/adblock-redirect.js', 'script');
ok(
	'$redirect answers with the resource and its type',
	redirected?.resource?.type === 'application/javascript' &&
		new TextDecoder().decode(redirected.resource.body).includes("'use strict'"),
	JSON.stringify(redirected && Object.keys(redirected)),
);
ok(
	'$removeparam rewrites the URL, keeping the other parameters',
	same(decide('/pages/adblock-param.json?utm_source=x&keep=1', 'empty'), {
		url: `${SITE}/pages/adblock-param.json?keep=1`,
	}),
	JSON.stringify(
		decide('/pages/adblock-param.json?utm_source=x&keep=1', 'empty'),
	),
);
ok(
	'a URL with nothing to remove is left alone',
	decide('/pages/adblock-param.json?keep=1', 'empty') === null,
);
ok(
	'a beacon is a ping',
	same(
		decide('/pages/adblock-blocked.js', '', { ping: true, method: 'POST' }),
		{
			block: true,
		},
	),
);

// the request types, as a content blocker in the browser names them
const types = {
	script: 'script',
	worker: 'script',
	style: 'stylesheet',
	image: 'image',
	font: 'font',
	audio: 'media',
	video: 'media',
	track: 'media',
	object: 'object',
	embed: 'object',
	iframe: 'subdocument',
	'': 'xmlhttprequest',
	empty: 'xmlhttprequest',
	manifest: 'other',
	unknown: 'other',
};
ok(
	'every destination has its list type',
	Object.entries(types).every(
		([destination, type]) => requestTypeOf(destination, false, false) === type,
	) &&
		requestTypeOf('iframe', true, true) === 'document' &&
		requestTypeOf('iframe', true, false) === 'subdocument',
);

// the document's side: $csp, cosmetic rules, scriptlets
ok(
	'a $csp policy the proxy can enforce is carried, one that would stop the shell is not',
	blocker.documentCsp(`${SITE}/pages/adblock-csp.html`, null) ===
		"worker-src 'none'",
	String(blocker.documentCsp(`${SITE}/pages/adblock-csp.html`, null)),
);
ok(
	'a document with no $csp rule gets none',
	blocker.documentCsp(page, null) === null,
);
const csp = (text) => carriedCsp(text);
ok(
	'carried policies: keyword and scheme sources only, never a host',
	csp("img-src 'none'") === "img-src 'none'" &&
		csp('img-src data: blob:') === 'img-src data: blob:' &&
		csp('img-src example.com') === null &&
		csp("script-src 'self' example.com; worker-src 'none'") ===
			"worker-src 'none'",
);
ok(
	'a script policy is carried only when the shell, the bundle and eval still run',
	csp("script-src 'self'") === null &&
		csp("script-src 'unsafe-inline' 'self'") === null &&
		csp("script-src 'unsafe-inline' 'unsafe-eval' *") ===
			"script-src 'unsafe-inline' 'unsafe-eval' *" &&
		csp("script-src 'unsafe-inline' 'unsafe-eval' 'self' 'nonce-abc'") ===
			null &&
		csp("default-src 'none'") === null,
);
ok(
	'sandbox, frame-ancestors and reporting are never carried',
	csp('sandbox allow-scripts') === null &&
		csp("frame-ancestors 'none'") === null &&
		csp('report-uri /x') === null &&
		csp("connect-src 'none'") === null &&
		csp("connect-src 'self'") === "connect-src 'self'",
);

const rewrites = [];
const rewrite = (script) => {
	rewrites.push(script);
	return `/*rewritten*/${script}`;
};
const cosmetic = blocker.cosmetic(page, rewrite);
ok(
	'the site rules and the generic rules that are not a class or an id come with the document',
	cosmetic.hide.includes('.adblock-specific') &&
		cosmetic.hide.includes('div[data-adblock-generic]') &&
		!cosmetic.hide.includes('.adblock-generic') &&
		!cosmetic.generichide,
	JSON.stringify(cosmetic.hide),
);
const procedural = cosmetic.procedural.map((json) => JSON.parse(json));
ok(
	'procedural and action filters come parsed, not as selectors',
	procedural.length === 6 &&
		procedural.some(
			(filter) =>
				filter.selector[0].arg === 'div' &&
				filter.selector[1].type === 'has-text' &&
				filter.selector[1].arg === 'Sponsored by',
		) &&
		procedural.some((filter) => filter.action?.type === 'remove') &&
		procedural.some(
			(filter) =>
				filter.action?.type === 'style' &&
				filter.action.arg === 'color: rgb(1, 2, 3) !important',
		) &&
		procedural.some(
			(filter) =>
				filter.action?.type === 'remove-attr' &&
				filter.action.arg === 'data-track',
		) &&
		procedural.some(
			(filter) =>
				filter.action?.type === 'remove-class' &&
				filter.action.arg === 'tracked',
		) &&
		procedural.some((filter) => filter.selector[1]?.type === 'upward'),
	JSON.stringify(procedural),
);
ok(
	'the scriptlets are one script, rewritten once',
	cosmetic.script.startsWith('/*rewritten*/') &&
		cosmetic.script.includes('function spyFetch') &&
		cosmetic.script.includes('spyFetch("__adblockSpy")') &&
		rewrites.length === 1 &&
		blocker.cosmetic(page, rewrite).script === cosmetic.script &&
		rewrites.length === 1,
	`${rewrites.length} rewrites`,
);
ok(
	'a trusted list gets a trusted scriptlet, another list does not',
	cosmetic.script.includes('trustedMark("__adblockTrusted")') &&
		!cosmetic.script.includes('__adblockUntrusted') &&
		cosmetic.script.includes('setFlag("__adblockFlag")'),
);
ok(
	'the generic rules of the classes and ids a document uses are answered',
	same(
		blocker
			.classIds(
				['adblock-generic', 'adblock-late', 'nothing'],
				['adblock-generic-id'],
				[],
			)
			.sort(),
		['#adblock-generic-id', '.adblock-generic', '.adblock-late'],
	),
);
const otherPage = blocker.cosmetic(`${OTHER}/pages/adblock.html`, rewrite);
ok(
	'another site gets no site rule, no scriptlet, and its exception',
	!otherPage.hide.includes('.adblock-specific') &&
		otherPage.procedural.length === 0 &&
		otherPage.script === '' &&
		otherPage.exceptions.includes('.adblock-generic') &&
		same(
			blocker.classIds(
				['adblock-generic', 'adblock-late'],
				[],
				otherPage.exceptions,
			),
			['.adblock-late'],
		),
	JSON.stringify(otherPage),
);

// nothing fetched: the blocker stays off, and says why
const none = new Blocker(
	init([{ url: `${SITE}/pages/adblock-missing.txt` }]),
	fromPages,
	async () => module,
);
ok(
	'with no list fetched the blocker stays off',
	(await none.settled()) === false &&
		none.ready === false &&
		none.decide({
			url: `${SITE}/pages/adblock-blocked.js`,
			source: page,
			destination: 'script',
			navigation: false,
			topLevel: false,
			method: 'GET',
		}) === null &&
		none.cosmetic(page, rewrite) === null &&
		/no filter list/.test(none.lastError ?? ''),
	String(none.lastError),
);
const noResources = new Blocker(
	init([{ url: `${SITE}/pages/adblock-list.txt` }], {
		resources: `${SITE}/pages/adblock-missing.json`,
	}),
	fromPages,
	async () => module,
);
ok(
	'and with no resources',
	(await noResources.settled()) === false &&
		/resources/.test(noResources.lastError ?? ''),
	String(noResources.lastError),
);
const noModule = new Blocker(
	init([{ url: `${SITE}/pages/adblock-list.txt` }]),
	fromPages,
	async () => null,
);
ok(
	'and when the module never reached the thread, which the next controller retries',
	(await noModule.settled()) === false &&
		noModule.failed === true &&
		blocker.failed === false &&
		/module/.test(noModule.lastError ?? ''),
	String(noModule.lastError),
);

// a prebuilt engine: what one instance serialized, another loads
const builder = new BlockerInstance(module);
builder.call(readFileSync(`${pages}adblock-list.txt`), OP.addList);
ok('a list compiles to a serialized engine', builder.call('', OP.build) === 0);
const serialized = builder.bytes();
const prebuilt = new Blocker(
	init([], { engine: `${SITE}/pages/adblock-engine.dat` }),
	async (url) =>
		url.endsWith('.dat') ? new Response(serialized) : fromPages(url),
	async () => module,
);
ok(
	'a prebuilt engine is loaded in place of the lists',
	(await prebuilt.settled()) &&
		same(
			prebuilt.decide({
				url: `${SITE}/pages/adblock-blocked.js`,
				source: page,
				destination: 'script',
				navigation: false,
				topLevel: false,
				method: 'GET',
			}),
			{ block: true },
		),
	String(prebuilt.lastError),
);
const garbage = new BlockerInstance(module);
ok(
	'bytes that are no engine are refused, and the instance lives',
	garbage.call(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), OP.load) !== 0 &&
		garbage.call('', OP.drop) === 0,
);

// the options a host gives, resolved
const defaults = resolveAdblockOptions(true);
ok(
	'`true` names the default lists, all https, and a day between refreshes',
	defaults.lists.length > 3 &&
		defaults.lists.every((list) => list.url.startsWith('https://')) &&
		defaults.resources.startsWith('https://') &&
		defaults.refreshMs === 24 * 3600_000 &&
		resolveAdblockOptions(false) === null &&
		resolveAdblockOptions(undefined) === null,
);
const given = resolveAdblockOptions({
	lists: [
		'https://a.example/list.txt',
		{ url: 'https://b.example/l', trusted: true },
	],
	refresh: 6,
});
ok(
	'a list given as a string is untrusted',
	same(given.lists, [
		{ url: 'https://a.example/list.txt' },
		{ url: 'https://b.example/l', trusted: true },
	]) && given.refreshMs === 6 * 3600_000,
	JSON.stringify(given),
);

// timings, on the fixture list and on a list of real size when one is named
const time = (label, run, times) => {
	const started = performance.now();
	for (let i = 0; i < times; i++) run(i);
	const each = ((performance.now() - started) / times) * 1000;
	console.log(`INFO ${label}: ${each.toFixed(1)} us`);
	return each;
};
const perCheck = time(
	'a network check (fixture list)',
	(i) => decide(`/assets/${i % 97}/app.${i}.js`, 'script'),
	20000,
);
ok('a network check takes well under a millisecond', perCheck < 500);
const bench = process.env.ADBLOCK_BENCH_LIST;
if (bench) {
	const text = readFileSync(bench);
	const instance = new BlockerInstance(module);
	let started = performance.now();
	instance.call(text, OP.addList);
	instance.call('', OP.build);
	console.log(
		`INFO ${bench}: ${text.length} bytes compiled in ${(performance.now() - started).toFixed(0)} ms, ${(instance.memoryBytes / 1048576).toFixed(1)} MB of memory`,
	);
	const engine = instance.bytes();
	const loaded = new BlockerInstance(module);
	started = performance.now();
	loaded.call(engine, OP.load);
	console.log(
		`INFO the serialized engine: ${engine.length} bytes, loaded in ${(performance.now() - started).toFixed(1)} ms, ${(loaded.memoryBytes / 1048576).toFixed(1)} MB of memory`,
	);
	time(
		'a network check',
		(i) =>
			loaded.call(
				`https://cdn${i % 50}.site.example/path/${i}.js\thttps://www.example.com/\tscript\tget`,
				OP.check,
			),
		20000,
	);
	time(
		"a document's cosmetic resources",
		(i) => loaded.call(`https://site${i}.example.com/page`, OP.cosmetic),
		500,
	);
}

await done();
