// A document knows its own host's site from its shell: the service worker
// asks the public suffix list when it serves the document and writes the
// answers in (src/siteFacts.ts), so the inject asks no list about the
// document's own host or its top's (src/inject/sites.ts). Before, every
// such question went to the rewriter library and its copy of tldts.
//
// - in node: what the shell carries is the list's answer for a host and for
//   every name above it, over the hosts of the pinned list's rules
//   (wildcards and exceptions among them);
// - in Chrome: a page, a frame of its site on another host, a frame of
//   another site, an srcdoc frame and a frame nested two deep answer their
//   site key, their partition, a cookie's Domain, a `document.domain` write
//   and `frameElement` without asking the list once, with the answers they
//   had; a frame on its way to a host no shell named is still asked about,
//   and answered.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, OUT, PROXY, sleep } from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tldts = await import('tldts');
let esbuild = null;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP site-facts in node: esbuild is not installed');
}

if (esbuild) {
	mkdirSync(OUT, { recursive: true });
	const entry = `${OUT}site-facts-entry.mjs`;
	writeFileSync(
		entry,
		`export * from ${JSON.stringify(`${root}src/siteFacts.ts`)};\n`,
	);
	const bundle = `${OUT}site-facts.mjs`;
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		outfile: bundle,
		logLevel: 'silent',
	});
	const { siteFacts, readSiteFacts } = await import(bundle);
	const lookups = {
		getDomain: (host, privateDomains = false) =>
			tldts.getDomain(host, { allowPrivateDomains: privateDomains }),
		getPublicSuffix: (host, privateDomains = false) =>
			tldts.getPublicSuffix(host, { allowPrivateDomains: privateDomains }),
	};
	const hosts = new Set([
		'localhost',
		'www.localhost',
		'127.0.0.1',
		'[::1]',
		'example.com.',
		'a..b.example.com',
		'x.city.kobe.jp',
		'x.a.kobe.jp',
		'www.ck',
		'a.b.c.d.e.f.g.h.i.j.k.l.m.n.example.co.uk',
	]);
	for (const line of readFileSync(
		`${root}rust/suffix/src/public_suffix_list.dat`,
		'utf8',
	).split('\n')) {
		const rule = line.trim();
		if (!rule || rule.startsWith('//')) continue;
		const name = rule.replace(/^!/, '').replace(/^\*\./, 'w.');
		let host;
		try {
			host = new URL(`http://b.a.${name}/`).hostname;
		} catch (error) {
			continue;
		}
		hosts.add(host);
	}
	let names = 0;
	let none = 0;
	const apart = [];
	for (const host of hosts) {
		const facts = siteFacts(host, lookups);
		if (!facts) {
			none++;
			continue;
		}
		// as the shell carries them
		const read = readSiteFacts(JSON.parse(JSON.stringify(facts)));
		if (!read || read[0][0] !== host) {
			apart.push(host);
			continue;
		}
		for (const [name, [domain, suffix, icann]] of read) {
			names++;
			if (
				domain !== tldts.getDomain(name) ||
				suffix !== tldts.getPublicSuffix(name, { allowPrivateDomains: true }) ||
				icann !== tldts.getPublicSuffix(name)
			)
				apart.push(name);
		}
	}
	ok(
		"what a shell carries is the list's answer for a host and every name above it",
		hosts.size > 9000 && names > 30000 && none === 0 && apart.length === 0,
		`${hosts.size} hosts, ${names} names, ${none} without facts, ${apart.length} apart ${JSON.stringify(apart.slice(0, 5))}`,
	);
	ok(
		'a name under an exception rule is not worked out from the name below it',
		JSON.stringify(readSiteFacts(siteFacts('x.city.kobe.jp', lookups))) ===
			JSON.stringify([
				['x.city.kobe.jp', ['city.kobe.jp', 'kobe.jp', 'kobe.jp']],
				['city.kobe.jp', ['city.kobe.jp', 'kobe.jp', 'kobe.jp']],
				['kobe.jp', ['kobe.jp', 'jp', 'jp']],
				['jp', [null, 'jp', 'jp']],
			]),
		JSON.stringify(readSiteFacts(siteFacts('x.city.kobe.jp', lookups))),
	);
	ok(
		'anything that is not facts is refused',
		readSiteFacts(['a.b', 0, 3, 2, 3, 2, 3]) === null &&
			readSiteFacts(['a.b', 0, 3, 2, 3, 2, 3, 0, 0, 2, 3, 2, 3]) === null &&
			readSiteFacts(['a.b', 0, 3, 2, 3, 2, 3, 0, 3, 2, 3, 2, 3]) === null &&
			readSiteFacts(['a.b', 0, 3, 2, 3, 2, 9, -1, -1, 2, 3, 2, 3]) === null &&
			readSiteFacts('a.b') === null &&
			readSiteFacts([]) === null &&
			siteFacts('', lookups) === null,
	);
}

// in Chrome
const port = new URL(FIXTURE).port;
const TOP = `http://www.localhost:${port}`;
const SAME = `http://a.www.localhost:${port}`;
const OTHER = `http://other.localhost:${port}`;
const ELSEWHERE = `http://elsewhere.localhost:${port}`;
const PAGE = '/pages/site-facts.html';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const clientName = await page.evaluate(async (url) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	await window.controller.createFrame(element).go(url);
	return window.controller.config.names.client;
}, `${TOP}${PAGE}`);

/** the proxied frame whose document is `real` (as its client has it) */
async function frameOf(real, within = page.mainFrame()) {
	for (let i = 0; i < 100; i++) {
		for (const frame of page.frames()) {
			let parent = frame.parentFrame();
			while (parent && parent !== within) parent = parent.parentFrame();
			if (!parent) continue;
			const url = await frame
				.evaluate(
					(name) =>
						document.readyState === 'complete' && window[name]
							? window[name].url.toString()
							: null,
					clientName,
				)
				.catch(() => null);
			if (url === real) return frame;
		}
		await sleep(100);
	}
	throw new Error(`no frame of ${real}`);
}

/** what a document says of its site, and how many questions it took */
const state = (frame) =>
	frame.evaluate((name) => {
		const client = window[name];
		let framed;
		try {
			framed = window.frameElement === null ? 'null' : 'element';
		} catch (error) {
			framed = String(error);
		}
		return {
			siteKey: client.siteKey,
			partition: client.partition,
			framed,
			...client.siteAnswers,
		};
	}, clientName);

const top = await frameOf(`${TOP}${PAGE}`);
await top.evaluate(
	({ same, other, page }) => {
		for (const [id, src] of [
			['same', `${same}${page}`],
			['other', `${other}${page}?frames=1`],
		]) {
			const frame = document.createElement('iframe');
			frame.id = id;
			frame.src = src;
			document.body.append(frame);
		}
		const written = document.createElement('iframe');
		written.id = 'written';
		written.srcdoc = '<p>written</p>';
		document.body.append(written);
	},
	{ same: SAME, other: OTHER, page: PAGE },
);
const same = await frameOf(`${SAME}${PAGE}`, top);
const other = await frameOf(`${OTHER}${PAGE}?frames=1`, top);
// a frame of the top's site inside the frame of another site
await other.evaluate((src) => {
	const frame = document.createElement('iframe');
	frame.src = src;
	document.body.append(frame);
}, `${TOP}${PAGE}?deep=1`);
const deep = await frameOf(`${TOP}${PAGE}?deep=1`, other);
let written = null;
for (let i = 0; i < 100 && !written; i++) {
	for (const frame of top.childFrames())
		if (
			await frame
				.evaluate(
					(name) =>
						!!window[name] && document.body?.textContent.includes('written'),
					clientName,
				)
				.catch(() => false)
		)
			written = frame;
	if (!written) await sleep(100);
}

const topState = await state(top);
ok(
	'a page knows its site key from its shell',
	topState.siteKey === `http://www.localhost:${port}` &&
		topState.partition === '' &&
		topState.known > 0 &&
		topState.asked === 0,
	JSON.stringify(topState),
);
const sameState = await state(same);
ok(
	"a frame of the page's site on another host is of its site, and keyed with it",
	sameState.siteKey === topState.siteKey &&
		sameState.partition === '' &&
		sameState.framed === 'element' &&
		sameState.asked === 0,
	JSON.stringify(sameState),
);
const otherState = await state(other);
ok(
	"a frame of another site is keyed by its top's site, which its shell named",
	otherState.siteKey === `http://other.localhost:${port}` &&
		otherState.partition === '^http://www.localhost' &&
		otherState.framed === 'null' &&
		otherState.asked === 0,
	JSON.stringify(otherState),
);
const deepState = await state(deep);
ok(
	"a frame of the top's site under a frame of another site is keyed apart, and asks nothing",
	deepState.siteKey === topState.siteKey &&
		deepState.partition === '^http://www.localhost' &&
		deepState.framed === 'null' &&
		deepState.asked === 0,
	JSON.stringify(deepState),
);
const writtenState = written ? await state(written) : null;
ok(
	'an srcdoc frame is handed what its parent was told',
	writtenState !== null &&
		writtenState.siteKey === topState.siteKey &&
		writtenState.partition === '' &&
		writtenState.framed === 'element' &&
		writtenState.asked === 0,
	JSON.stringify(writtenState),
);

// a cookie's Domain and a document.domain write, in the frame on a.www.localhost
const writes = await same.evaluate(
	async ({ name, top, elsewhere, page }) => {
		const client = window[name];
		const before = client.siteAnswers.asked;
		const out = {};
		const set = async (cookie) => {
			document.cookie = cookie;
			// the write settles with the jar
			await new Promise((resolve) => setTimeout(resolve, 300));
			return document.cookie;
		};
		out.host = (
			await set('sf_host=1; Domain=a.www.localhost; Path=/')
		).includes('sf_host=1');
		out.parent = (
			await set('sf_parent=1; Domain=www.localhost; Path=/')
		).includes('sf_parent=1');
		out.suffix = (await set('sf_suffix=1; Domain=localhost; Path=/')).includes(
			'sf_suffix=1',
		);
		const domain = (value) => {
			try {
				document.domain = value;
				return 'set';
			} catch (error) {
				return error.message;
			}
		};
		out.domainSuffix = domain('localhost');
		out.domainParent = domain('www.localhost');
		// a Domain that is no name of the host is refused whatever the list
		// says of it, so the list is not asked
		out.foreign = (
			await set('sf_foreign=1; Domain=elsewhere.test; Path=/')
		).includes('sf_foreign=1');
		out.asked = client.siteAnswers.asked - before;
		// a frame on its way to another host: whether that host is of this
		// site decides how its window is held before its document arrives.
		// A name the shell gave is answered from it; any other host is the
		// list's to answer
		const pending = (src) => {
			const frame = document.createElement('iframe');
			frame.src = src;
			document.body.append(frame);
			const asked = client.siteAnswers.asked;
			const held = frame.contentWindow;
			let reads;
			try {
				reads = typeof held.document === 'object' ? 'document' : 'nothing';
			} catch (error) {
				reads = error.name;
			}
			frame.remove();
			return { reads, asked: client.siteAnswers.asked - asked };
		};
		out.named = pending(`${top}${page}?pending=1`);
		out.unnamed = pending(`${elsewhere}${page}?pending=1`);
		return out;
	},
	{ name: clientName, top: TOP, elsewhere: ELSEWHERE, page: PAGE },
);
ok(
	"a cookie for the host or a name above it is kept, one for its public suffix is not: the shell's answers",
	writes.host === true && writes.parent === true && writes.suffix === false,
	JSON.stringify(writes),
);
ok(
	'document.domain refuses the public suffix and takes the name above the host',
	/is a top-level domain/.test(writes.domainSuffix) &&
		writes.domainParent === 'set',
	JSON.stringify(writes),
);
ok(
	'a cookie for a domain that is no name of the host is refused',
	writes.foreign === false,
);
ok('none of which asked the list', writes.asked === 0, String(writes.asked));
ok(
	"a frame on its way to a host the shell named is this site's, and the list is not asked",
	writes.named.reads === 'document' && writes.named.asked === 0,
	JSON.stringify(writes.named),
);
ok(
	'a frame on its way to any other host is asked about, and answered: another site',
	writes.unnamed.reads === 'SecurityError' && writes.unnamed.asked > 0,
	JSON.stringify(writes.unnamed),
);

await done(browser);
