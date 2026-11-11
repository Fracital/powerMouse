// The suffix lookup (rust/suffix, in assets/core.wasm) against tldts, in
// Node, without a browser: the module has to answer what tldts answers for
// the four calls STomp makes (getDomain and getPublicSuffix, each with the
// list's private section and without), for a host, a URL, or whatever a
// page wrote into a cookie's Domain. The module is called the way every
// thread calls it (src/wasm/suffix.ts over src/wasm/thread.ts, bundled
// here), so the glue is under test too. Compared over:
//
//   - every rule of the pinned list (rust/suffix/src/public_suffix_list.dat):
//     the rule, one and two labels under it, each wildcard and exception
//     case, in the list's spelling, in punycode and mixed, with dots and
//     upper case around them;
//   - every host name and URL found in the repository's test data and, when
//     they are there, the corpora in /tmp/stomp-speed;
//   - IDN and punycode forms, IP literals and malformed input;
//   - a seeded fuzz of generated inputs (FUZZ=<count>, a million by
//     default; SEED=<number>);
//   - the list's own test vectors (rust/suffix/tests/test_psl.txt), where
//     tldts and the vectors part ways the module is held to tldts and the
//     vector is shown.
//
//   node rust/host/suffix.mjs            # exit 1 on any difference
//   node rust/host/suffix.mjs --bench    # and lookups per second, sizes,
//                                        # memory and compile time
//
// CORE_WASM names another artifact than assets/core.wasm (the module the
// lookup is a member of).
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const esbuild = await import('esbuild');
const tldts = await import('tldts');

// the glue, bundled from src so this runs what the bundles run
const out = mkdtempSync(join(tmpdir(), 'suffix-harness-'));
await esbuild.build({
	stdin: {
		contents:
			`export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n` +
			`export * as thread from ${JSON.stringify(`${root}src/wasm/thread.ts`)};\n` +
			`export * as suffix from ${JSON.stringify(`${root}src/wasm/suffix.ts`)};\n`,
		resolveDir: root,
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	outfile: join(out, 'glue.mjs'),
	logLevel: 'silent',
});
const { compileModule, thread, suffix } = await import(join(out, 'glue.mjs'));

const artifact = process.env.CORE_WASM || `${root}assets/core.wasm`;
const bytes = readFileSync(artifact);
thread.adoptModule('core', await compileModule(bytes));

/** the four calls STomp makes, as tldts answers them and as the module does */
const CALLS = [
	['getDomain(x)', (x) => tldts.getDomain(x), (x) => suffix.domainOf(x, false)],
	[
		'getDomain(x, { allowPrivateDomains: true })',
		(x) => tldts.getDomain(x, { allowPrivateDomains: true }),
		(x) => suffix.domainOf(x, true),
	],
	[
		'getPublicSuffix(x, { allowPrivateDomains: true })',
		(x) => tldts.getPublicSuffix(x, { allowPrivateDomains: true }),
		(x) => suffix.publicSuffixOf(x, true),
	],
	[
		'getPublicSuffix(x, { allowPrivateDomains: false })',
		(x) => tldts.getPublicSuffix(x, { allowPrivateDomains: false }),
		(x) => suffix.publicSuffixOf(x, false),
	],
];

let compared = 0;
let differences = 0;
let unanswered = 0;
/** the comparisons in which tldts had an answer other than null */
let answered = 0;
const shown = [];

/** one input through the four calls; how many differed */
function compare(input) {
	let differed = 0;
	for (const [name, theirs, ours] of CALLS) {
		compared++;
		const want = theirs(input);
		const got = ours(input);
		if (want !== null) answered++;
		if (got === want) continue;
		differed++;
		differences++;
		if (got === undefined) unanswered++;
		if (shown.length < 40)
			shown.push(
				`${name} of ${JSON.stringify(input)}: tldts ${JSON.stringify(want)}, the module ${JSON.stringify(got)}`,
			);
	}
	return differed;
}

/** a section of the run: its inputs compared, one line of result */
function section(name, inputs) {
	const before = differences;
	const had = answered;
	const start = compared;
	let count = 0;
	for (const input of inputs) {
		compare(input);
		count++;
	}
	console.log(
		`${name}: ${count} inputs, ${compared - start} comparisons (tldts answers ${answered - had}, null the rest), ${differences - before} differences`,
	);
}

// --- the list -----------------------------------------------------------

const list = readFileSync(
	`${root}rust/suffix/src/public_suffix_list.dat`,
	'utf8',
);
const rules = [];
for (const raw of list.split('\n')) {
	const line = raw.trim();
	if (!line || line.startsWith('//')) continue;
	rules.push(line.split(/\s/)[0]);
}

/** a label as a host name carries it (Node's own conversion, not the crate's) */
const ascii = (label) =>
	/[^\x00-\x7f]/.test(label) ? domainToASCII(label) : label;

/** the spellings of a rule's body a host could have: the list's, punycode, and each label the other way round */
function spellings(body) {
	const labels = body.split('.');
	const forms = new Set([body, labels.map(ascii).join('.')]);
	forms.add(labels.map((l, i) => (i % 2 ? ascii(l) : l)).join('.'));
	forms.add(labels.map((l, i) => (i % 2 ? l : ascii(l))).join('.'));
	return forms;
}

/**
 * The rules tldts itself holds, read out of its table (the arrays of
 * tldts/src/data/trie.ts): what the pinned list has to be, both ways. A
 * tldts that knows a rule the list does not, or the reverse, means the pin
 * in rust/suffix/src/pins.env is not the list of the tldts the lockfile pins.
 */
async function tldtsRules() {
	const trie = await import(
		`${root}node_modules/tldts/dist/es6/src/data/trie.js`
	);
	const { nodeFlags, edgeStart, edgeLength, edgeChild, labelText } = trie;
	const { rulesRoot, exceptionsRoot } = trie;
	if (
		!(nodeFlags && edgeStart && edgeLength && edgeChild) ||
		typeof labelText !== 'string' ||
		typeof rulesRoot !== 'number' ||
		typeof exceptionsRoot !== 'number'
	)
		throw new Error(
			"tldts's table is not laid out as this harness reads it (tldts/src/data/trie.ts changed)",
		);
	const offsets = new Uint32Array(edgeLength.length);
	for (let node = 0, offset = 0; node < nodeFlags.length; node++)
		for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
			offsets[e] = offset;
			offset += edgeLength[e];
		}
	const held = new Set();
	const walk = (node, labels, prefix) => {
		if (nodeFlags[node] && labels.length)
			held.add(
				`${prefix}${[...labels].reverse().join('.')} ${nodeFlags[node]}`,
			);
		for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
			labels.push(labelText.slice(offsets[e], offsets[e] + edgeLength[e]));
			walk(edgeChild[e], labels, prefix);
			labels.pop();
		}
	};
	walk(rulesRoot, [], '');
	walk(exceptionsRoot, [], '!');
	return held;
}

/** the list's rules as tldts would hold them: each with its section, and in punycode too */
function listRules() {
	const held = new Set();
	let section = 0;
	for (const raw of list.split('\n')) {
		const line = raw.trim();
		if (line.includes('===BEGIN ICANN DOMAINS===')) section = 1;
		if (line.includes('===BEGIN PRIVATE DOMAINS===')) section = 2;
		if (!line || line.startsWith('//')) continue;
		const rule = line.split(/\s/)[0];
		held.add(`${rule} ${section}`);
		held.add(`${rule.split('.').map(ascii).join('.')} ${section}`);
	}
	return held;
}

function* ruleCases() {
	for (const rule of rules) {
		const exception = rule.startsWith('!');
		for (const body of spellings(exception ? rule.slice(1) : rule)) {
			// a wildcard as a label that is no rule's, and as itself
			const hosts = body.includes('*')
				? [body.replace('*', 'zz9'), body, body.replace('*.', '')]
				: [body];
			if (exception) hosts.push(body.slice(body.indexOf('.') + 1));
			for (const host of hosts) {
				yield host;
				yield `a.${host}`;
				yield `b.a.${host}`;
				yield `zz9.b.a.${host}`;
				yield `.${host}`;
				yield `${host}.`;
				yield host.toUpperCase();
				yield `https://www.${host}:8443/path?query#fragment`;
			}
		}
	}
}

// --- hosts found on disk ------------------------------------------------

const HOST =
	/(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,23}\b/gi;
const URL_LIKE = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>\\`)]{1,200}/gi;

function* files(path, depth = 0) {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return;
	}
	if (stat.isFile()) {
		if (stat.size <= 16 * 1024 * 1024) yield path;
		return;
	}
	if (!stat.isDirectory() || depth > 6) return;
	for (const name of readdirSync(path))
		if (name !== 'node_modules' && name !== 'out')
			yield* files(join(path, name), depth + 1);
}

function found(paths) {
	const hosts = new Set();
	let read = 0;
	for (const path of paths)
		for (const file of files(path)) {
			if (
				/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|wasm|gz|br|zip|pdf|mp4|webm)$/i.test(
					file,
				)
			)
				continue;
			const text = readFileSync(file, 'latin1');
			read++;
			for (const match of text.matchAll(HOST)) hosts.add(match[0]);
			for (const match of text.matchAll(URL_LIKE)) hosts.add(match[0]);
		}
	return { hosts, read };
}

// --- forms --------------------------------------------------------------

const FORMS = [
	// IDN, as written and in punycode, and the two mixed
	'食狮.com.cn',
	'食狮.公司.cn',
	'www.食狮.公司.cn',
	'xn--85x722f.xn--55qx5d.cn',
	'食狮.xn--55qx5d.cn',
	'xn--85x722f.公司.cn',
	'a.個人.香港',
	'a.xn--gmqw5a.香港',
	'a.個人.xn--j6w193g',
	'a.xn--gmqw5a.xn--j6w193g',
	'bücher.example',
	'BÜCHER.example',
	'Bücher.DE',
	'ÉCOLE.Example.COM',
	'a.İstanbul.Example.com',
	'ǅ.Example.COM',
	'ΌΣΟΣ.Example.gr',
	'straße.de',
	'STRASSE.ẞ.de',
	'пример.рф',
	'ПРИМЕР.РФ',
	'www.пример.xn--p1ai',
	'مثال.السعودية',
	'例え.テスト',
	'xn--',
	'xn--a.com',
	'XN--55QX5D.CN',
	'a.Xn--55qx5d.cn',
	'\u{1F600}.example.com',
	'a.\u{1F600}.Example.ws',
	'\ud800.example.com',
	'a.\udc00b.EXAMPLE.co.uk',
	'ａｂｃ.ｃｏｍ',
	'example。com',
	'ex\u00adample.com',
	'ex\u200bample.com',
	`${'é'.repeat(63)}.com`,
	`${'é'.repeat(64)}.com`,
	`${'É'.repeat(63)}.Com`,
	`${'İ'.repeat(63)}.Com`,
	`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.com`,
	`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}.com`,
	// IP literals
	'1.2.3.4',
	'255.255.255.255',
	'256.1.1.1',
	'1.2.3',
	'1.2.3.4.5',
	'01.02.03.04',
	'1.2.3.4.',
	'.1.2.3.4',
	'1.2.3.4:80',
	'http://1.2.3.4:80/x',
	'0x7f.1',
	'2130706433',
	'::',
	'::1',
	'[::1]',
	'[::1]:8080',
	'http://[::1]:8080/x',
	'[2001:DB8::1]',
	'2001:db8::1',
	'2a01:e35::1',
	'[::ffff:1.2.3.4]',
	'::ffff:1.2.3.4',
	'[fe80::1%25eth0]',
	'[example.com]',
	'[Example.COM]',
	'[bücher.De]',
	'[',
	']',
	'[]',
	'[]]',
	'[a]b',
	'x@[::1]',
	']@[a.com',
	'1234:5678:9abc:def0:1234:5678:9abc:def0',
	'1234:5678:9abc:def0:1234:5678:9abc:def0:1',
	'g::1',
	// hosts as callers hand them over
	'localhost',
	'LOCALHOST',
	'localhost:8080',
	'example',
	'com',
	'co.uk',
	'example.co.uk',
	'www.example.co.uk',
	'a.b.c.d.e.f.example.com',
	'example.com.',
	'example.com..',
	'example.com...',
	'.example.com',
	'..example.com',
	'.',
	'..',
	'...',
	'.com',
	'.ck',
	'..ck',
	'.co.uk',
	'www.ck',
	'a.www.ck',
	'b.ck',
	'a.b.ck',
	'city.kawasaki.jp',
	'a.city.kawasaki.jp',
	'x.kawasaki.jp',
	'kawasaki.jp',
	'example.com:443',
	'example.com:',
	'example.com:abc',
	'example.com:80:80',
	'user@example.com',
	'user:pass@example.com',
	'user:pass@example.com:8080',
	'@example.com',
	'a@b@example.com',
	'_dmarc.example.com',
	'_.example.com',
	'-.example.com',
	'a-.example.com',
	'-a.example.com',
	'a--b.example.com',
	'a..example.com',
	'a b.example.com',
	'a%20b.example.com',
	'a*b.example.com',
	'*.example.com',
	'*',
	'*.ck',
	'!www.ck',
	'a.github.io',
	'github.io',
	'a.b.github.io',
	'a.blogspot.com',
	'a.s3.amazonaws.com',
	'a.b.compute.amazonaws.com',
	'a.pages.dev',
	'a.de',
	'de',
	'x.de',
	'.de',
	'a.com',
	'a.org',
	'a.net',
	'a.edu',
	'a.gov',
	'xcom',
	'a.xcom',
	'.com.',
	// URLs
	'https://www.example.co.uk/path',
	'HTTPS://WWW.EXAMPLE.CO.UK/PATH',
	'http://example.com',
	'http:/example.com',
	'http:example.com',
	'http:\\\\example.com\\path',
	'https:\\/\\/example.com',
	'//example.com/path',
	'///example.com',
	'ws://example.com',
	'wss://a.example.com:9000/socket',
	'ftp://ftp.example.org/',
	'file:///etc/passwd',
	'file://host.example.com/share',
	'file:/x',
	'file:host',
	'FILE:\\\\host.example.com\\x',
	'custom://a.example.com/x',
	'cus_tom://a.example.com/x',
	'custom:/a.example.com/x',
	'custom:a.example.com',
	'x-a.b+c://example.com',
	'mailto:user@example.com',
	'mailto:example.com',
	'tel:+123',
	'urn:isbn:123',
	'javascript:alert(1)',
	'data:text/html,<a href="http://example.com">',
	'DATA:text/html,example.com',
	'blob:https://example.com/uuid',
	'about:blank',
	'view-source:https://example.com',
	'https://user:pass@www.example.com:8443/p?q=1#f',
	'https://example.com?q=1',
	'https://example.com#f',
	'https://example.com\\@evil.com',
	'https://example.com/@evil.com',
	'https://evil.com#@example.com',
	'https://a.com:80@b.org',
	'http://',
	'https://:80',
	'https://@',
	'https://#',
	'://example.com',
	':example.com',
	'/example.com',
	'\\example.com',
	'?example.com',
	'#example.com',
	// white space and control characters
	'',
	' ',
	'  ',
	' example.com ',
	'\texample.com\n',
	'exa\tmple.com',
	'exa\nmple.co\r.uk',
	'ht\ttp://example.com',
	'http\n://example.com',
	'h\rttp://example.com',
	'cus\rtom://example.com',
	'cus\ttom://example.com',
	'http://exa\tmple.com/pa\tth',
	'http://example.com/pa\tth',
	'\u0000example.com',
	'example.com\u0000',
	'exam\u0000ple.com',
	'\u000bexample.com\u000c',
	'\u001fexample.com',
	'exa\u00a0mple.com',
	'\ufeffexample.com',
	'EXA\tMPLE.Com',
	'Ä\t.Example.com',
	'http://Ä.Example\n.com:80/x',
	'x@\tÄ.Example.com',
];

// --- the fuzz -----------------------------------------------------------

/** mulberry32: the same inputs for the same seed, on any machine */
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	'www',
	'a',
	'b',
	'mail',
	'cdn',
	'api',
	'static',
	'm',
	'x1',
	'my-site',
	'zz9',
	'_dmarc',
	'xn--55qx5d',
	'xn--gmqw5a',
	'xn--j6w193g',
	'公司',
	'個人',
	'香港',
	'bücher',
	'ÉCOLE',
	'\u{1F600}',
	'*',
	'city',
	'com',
	'co',
	'blogspot',
	'github',
	's3',
	'compute',
	'pages',
];
const STRAY = [
	'a',
	'b',
	'z',
	'0',
	'9',
	'x',
	'n',
	'A',
	'Z',
	'.',
	'.',
	'-',
	'_',
	':',
	'/',
	'\\',
	'@',
	'[',
	']',
	'?',
	'#',
	' ',
	'\t',
	'\n',
	'\r',
	'%',
	'*',
	'!',
	'+',
	'é',
	'É',
	'中',
	'İ',
	'\u{1F600}',
	'\ud800',
	'\u0000',
	'com',
	'co.uk',
	'http',
	'file',
	'data:',
	'xn--',
	'://',
	'//',
];
const SCHEMES = [
	'http://',
	'https://',
	'HTTP://',
	'ws://',
	'wss://',
	'ftp://',
	'file://',
	'file:',
	'http:',
	'https:/',
	'https:\\\\',
	'//',
	'custom://',
	'a+b.c-d://',
	'mailto:',
	'data:',
	'blob:https://',
	' ',
	'\t',
];
const TAILS = [
	'/',
	'/path',
	'?q=1',
	'#f',
	'/a/b?c#d',
	'\\x',
	':80',
	':8080/x',
	':',
	':x',
	'.',
	'..',
	' ',
	'\n',
	'/@b.com',
	'@b.org',
];

function* fuzz(count, seed) {
	const next = random(seed);
	const pick = (from) => from[Math.floor(next() * from.length)];
	const ruleLabels = (rule) =>
		(rule.startsWith('!') ? rule.slice(1) : rule).split('.');
	const label = () => {
		const kind = next();
		if (kind < 0.35) return pick(WORDS);
		if (kind < 0.6) return pick(ruleLabels(pick(rules)));
		let text = '';
		const length = 1 + Math.floor(next() * (next() < 0.05 ? 70 : 8));
		for (let i = 0; i < length; i++)
			text += pick('abcdefghijklmnopqrstuvwxyz0123456789-_');
		return text;
	};
	for (let i = 0; i < count; i++) {
		const kind = next();
		let input;
		if (kind < 0.12) {
			// nothing but stray pieces
			input = '';
			const length = Math.floor(next() * 12);
			for (let j = 0; j < length; j++) input += pick(STRAY);
		} else if (kind < 0.2) {
			// an address, or nearly one
			const part = () =>
				next() < 0.9
					? String(Math.floor(next() * 300))
					: Math.floor(next() * 65536).toString(16);
			if (next() < 0.5)
				input = Array.from({ length: 2 + Math.floor(next() * 4) }, part).join(
					'.',
				);
			else {
				input = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
					next() < 0.2 ? '' : Math.floor(next() * 65536).toString(16),
				).join(':');
				if (next() < 0.5) input = `[${input}]`;
			}
		} else {
			// labels over a rule of the list, or over nothing listed
			const labels = [];
			const depth = Math.floor(next() * 4);
			for (let j = 0; j < depth; j++) labels.push(label());
			const over = next();
			if (over < 0.75) {
				const rule = ruleLabels(pick(rules));
				// sometimes one label short, or in punycode
				if (next() < 0.1) rule.shift();
				labels.push(...(next() < 0.3 ? rule.map(ascii) : rule));
			} else if (over < 0.9) labels.push(label());
			input = labels.join('.');
		}
		// and what a caller or a page does to it
		const twists = next() < 0.5 ? 0 : 1 + Math.floor(next() * 3);
		for (let j = 0; j < twists; j++) {
			const twist = next();
			if (twist < 0.15) input = input.toUpperCase();
			else if (twist < 0.25) {
				const at = Math.floor(next() * (input.length + 1));
				input =
					input.slice(0, at) +
					input.slice(at, at + 3).toUpperCase() +
					input.slice(at + 3);
			} else if (twist < 0.4) input = pick(SCHEMES) + input;
			else if (twist < 0.55) input += pick(TAILS);
			else if (twist < 0.63) input = `.${input}`;
			else if (twist < 0.7)
				input = `${pick(['user', 'u:p', '', 'a@b'])}@${input}`;
			else {
				const at = Math.floor(next() * (input.length + 1));
				input = input.slice(0, at) + pick(STRAY) + input.slice(at);
			}
		}
		yield input;
	}
}

// --- the run ------------------------------------------------------------

const pin = suffix.suffixListPin();
console.log(
	`the module: ${artifact.replace(root, '')}, list ${pin?.commit} of ${pin?.date}; tldts ${JSON.parse(readFileSync(`${root}node_modules/tldts/package.json`, 'utf8')).version}; ${rules.length} rules`,
);
if (
	!pin ||
	!readFileSync(`${root}rust/suffix/src/pins.env`, 'utf8').includes(
		`PSL_COMMIT=${pin.commit}\n`,
	)
) {
	console.log(
		'FAIL the artifact was not built from the list rust/suffix/src/pins.env pins',
	);
	process.exit(1);
}

{
	const theirs = await tldtsRules();
	const ours = listRules();
	const missing = [...theirs].filter((rule) => !ours.has(rule));
	const extra = [...ours].filter((rule) => !theirs.has(rule));
	console.log(
		`the pinned list against tldts's own table: ${ours.size} rules (with their punycode forms) and ${theirs.size}, ${missing.length} only tldts has, ${extra.length} only the list has`,
	);
	for (const rule of [...missing.slice(0, 10), ...extra.slice(0, 10)])
		console.log(
			`  ${missing.includes(rule) ? 'tldts only' : 'the list only'}: ${rule}`,
		);
	if (missing.length || extra.length) {
		differences += missing.length + extra.length;
		console.log(
			'  the list rust/suffix/src/pins.env pins is not the list of this tldts: raise the pin (or the lockfile moved tldts back)',
		);
	}
}
section('the rules of the list', ruleCases());
{
	const { hosts, read } = found([`${root}test`, `${root}demo`, `${root}docs`]);
	section(
		`hosts and URLs in the repository's test data (${read} files)`,
		hosts,
	);
	const corpora = found(['/tmp/stomp-speed']);
	if (corpora.read)
		section(
			`hosts and URLs in /tmp/stomp-speed (${corpora.read} files)`,
			corpora.hosts,
		);
	else console.log('/tmp/stomp-speed: not there, skipped');
}
section('IDN and punycode forms, IP literals, malformed input', FORMS);
const fuzzed = Number(process.env.FUZZ ?? 1_000_000);
const seed = Number(process.env.SEED ?? 20261110);
section(`fuzz, seed ${seed}`, fuzz(fuzzed, seed));

// the list's own vectors: checkPublicSuffix(host, registrable domain), the
// whole list in force
{
	const vectors = readFileSync(`${root}rust/suffix/tests/test_psl.txt`, 'utf8');
	let count = 0;
	let apart = 0;
	let own = 0;
	for (const match of vectors.matchAll(
		/^checkPublicSuffix\('([^']*)', (null|'([^']*)')\);/gm,
	)) {
		count++;
		const want = match[2] === 'null' ? null : match[3];
		const theirs = tldts.getDomain(match[1], { allowPrivateDomains: true });
		const ours = suffix.domainOf(match[1], true);
		if (ours !== theirs) {
			own++;
			differences++;
			console.log(
				`  ${JSON.stringify(match[1])}: tldts ${JSON.stringify(theirs)}, the module ${JSON.stringify(ours)}`,
			);
		} else if (theirs !== want) {
			apart++;
			console.log(
				`  tldts and the module part from the list's vector: ${JSON.stringify(match[1])} is ${JSON.stringify(want)} to the list, ${JSON.stringify(theirs)} to both`,
			);
		}
	}
	console.log(
		`the list's test vectors: ${count} vectors, ${own} differences from tldts, ${apart} where tldts and the module part from the vector`,
	);
}

console.log(
	`${compared} comparisons, ${differences} differences${unanswered ? `, ${unanswered} of them the module not answering` : ''}`,
);
for (const line of shown) console.log(`  ${line}`);

if (process.argv.includes('--bench')) {
	// a million hosts: labels over the list's rules, as a browsing session
	// would ask them
	const next = random(1);
	const hosts = [];
	for (let i = 0; i < 1_000_000; i++) {
		const rule = rules[Math.floor(next() * rules.length)].replace(
			/^!|\*\./g,
			'',
		);
		const depth = Math.floor(next() * 3);
		hosts.push(`${['', 'www.', 'cdn.static.'][depth]}site${i % 5000}.${rule}`);
	}
	// and the hosts of one: two thousand of them, asked over and over
	const session = hosts.map((_, i) => hosts[(i * 7919) % 2000]);
	const time = (work, hosts) => {
		const times = [];
		for (let run = 0; run < 5; run++) {
			const start = performance.now();
			for (const host of hosts) work(host);
			times.push(performance.now() - start);
		}
		return times.sort((a, b) => a - b)[2];
	};
	const rate = (ms) =>
		`${Math.round(hosts.length / (ms / 1000)).toLocaleString('en-US')} per second`;
	console.log('\nlookups, a million hosts, the median of five runs:');
	for (const [name, theirs, ours] of CALLS.slice(0, 3)) {
		console.log(
			`  ${name}, every host another: tldts ${rate(time(theirs, hosts))}, the module ${rate(time(ours, hosts))}`,
		);
		console.log(
			`  ${name}, 2,000 hosts over and over: tldts ${rate(time(theirs, session))}, the module ${rate(time(ours, session))}`,
		);
	}
	const compileTimes = [];
	for (let run = 0; run < 15; run++) {
		const start = performance.now();
		await WebAssembly.compile(bytes);
		compileTimes.push(performance.now() - start);
	}
	const module = await WebAssembly.compile(bytes);
	const instanceTimes = [];
	for (let run = 0; run < 15; run++) {
		const start = performance.now();
		new WebAssembly.Instance(module, { e: { j: () => -1, s: () => -1 } });
		instanceTimes.push(performance.now() - start);
	}
	const median = (times) => times.sort((a, b) => a - b)[times.length >> 1];
	const brotli = brotliCompressSync(bytes, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
	}).length;
	console.log(
		`the artifact: ${bytes.length} bytes, ${brotli} brotli; the list's text ${Buffer.byteLength(list)} bytes`,
	);
	console.log(
		`compile ${median(compileTimes).toFixed(2)} ms, instantiate ${median(instanceTimes).toFixed(3)} ms`,
	);
	console.log(
		`instance memory after ${compared + 15 * hosts.length} lookups: ${thread.withInstance('suffix', (instance) => instance.memoryBytes)} bytes`,
	);
	const long = `https://${'a'.repeat(200000)}.example.com/`;
	suffix.domainOf(long, true);
	console.log(
		`and after one input of ${long.length} characters: ${thread.withInstance('suffix', (instance) => instance.memoryBytes)} bytes`,
	);
}

process.exit(differences ? 1 : 0);
