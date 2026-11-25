// The blocker's module run once on a small engine by a rewrite worker
// (src/rewriteWorker.ts), for the service worker's sake. V8 compiles a wasm
// function the first time it is called, and keeps one copy of a module's
// code for every thread of the process that compiled the same bytes: the
// service worker's first engine load and the first questions it is asked
// (src/server/blocker.ts #load, #warm) compiled 939 functions on its own
// thread, 18 to 22 ms of it (Chrome 159, cold and warm visits alike), just
// as the first navigation's requests came in. A rewrite worker shares the
// controller's process with the service worker and is idle at the start:
// what it calls here is compiled there, and the worker's first load and
// questions compile some 120 functions, 2 to 4 ms. Only the code is
// shared, never the engine: what is built here is dropped. (V8's code cache
// does not help: it keeps only the functions that ran hot enough for the
// optimizing tier, and a compileStreaming of the blocker in the service
// worker that consumed one still compiled the same 939.) Firefox compiles
// all of a module when it is compiled, and gains nothing from this.

/** OP of src/blocker/instance.ts, which is not imported: it brings the suffix list */
const OP = {
	addList: 1,
	build: 2,
	load: 3,
	resources: 4,
	check: 5,
	csp: 6,
	cosmetic: 7,
} as const;

interface WarmExports {
	memory: WebAssembly.Memory;
	a(length: number): number;
	r(ptr: number, length: number, flags: number): number;
	p(): number;
	n(): number;
}

/**
 * one rule of each shape the default lists have, so that loading the engine
 * and asking it walks the code a real engine's does
 */
const LIST = [
	'||ads.warm.invalid^',
	'||track.warm.invalid^$third-party,script',
	'/banner/*$image,domain=warm.invalid|~ok.warm.invalid',
	'@@||ok.warm.invalid^$document',
	'@@||ok.warm.invalid^$generichide',
	'||csp.warm.invalid^$csp=script-src none',
	'||redir.warm.invalid/a.js$script,redirect=noop.js',
	'||redir.warm.invalid/b.gif$image,redirect-rule=1x1.gif',
	'||important.warm.invalid^$important',
	'||rp.warm.invalid^$removeparam=utm_source',
	'/^https?:\\/\\/[a-z]+\\.warm\\.invalid\\/ad[0-9]+/$xmlhttprequest',
	'-advert-$~third-party,stylesheet,font,media,other',
	'.warm.invalid/pixel?$1p,ping',
	'||bad.warm.invalid^$badfilter',
	'||all.warm.invalid^$all',
	'*$script,3p,denyallow=ok.warm.invalid,domain=warm.invalid',
	'##.ad-banner',
	'###ad-slot',
	'##div[id^="ad_"]',
	'warm.invalid##.sponsored',
	'warm.invalid,~ok.warm.invalid##.promo',
	'warm.invalid#@#.ad-banner',
	'warm.invalid##+js(set-constant, foo, true)',
	'warm.invalid##+js(noop.js)',
	'warm.invalid##:has(> .ad)',
	'warm.invalid##.x:style(display: none !important)',
	'warm.invalid#$#body { color: red }',
	'warm.invalid##^script:has-text(ads)',
	'0.0.0.0 hosts.warm.invalid',
].join('\n');

/** resources of the kinds the default resources have (adblock-resources.json) */
const NOOP_JS = 'KGZ1bmN0aW9uKCl7fSkoKTs=';
const RESOURCES = JSON.stringify([
	{
		name: '1x1.gif',
		aliases: [],
		kind: { mime: 'image/gif' },
		content: 'R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
	},
	{
		name: 'noop.js',
		aliases: [],
		kind: { mime: 'application/javascript' },
		content: NOOP_JS,
	},
	{
		name: 'set-constant.js',
		aliases: ['set.js'],
		kind: { mime: 'application/javascript' },
		content: NOOP_JS,
	},
]);

/** the request types the service worker asks about (Blocker #warm) */
const TYPES = [
	'subdocument',
	'script',
	'stylesheet',
	'image',
	'font',
	'xmlhttprequest',
	'media',
	'other',
];

const PAGE = 'https://warm.invalid/';
const CSP_PAGE = 'https://csp.warm.invalid/';
const URLS = [
	'https://other.invalid/a.js',
	'https://ads.warm.invalid/x.js',
	'https://redir.warm.invalid/a.js',
	'https://redir.warm.invalid/b.gif',
	'https://cdn.warm.invalid/banner/1.png',
	'https://rp.warm.invalid/?utm_source=x&a=1',
	'https://x.warm.invalid/ad12',
];

/**
 * Build a small engine with `module`, load it into a fresh instance and ask
 * it what a page's first loads ask; the answers and both instances are
 * dropped. A module that refuses any of it is left as it is: this only
 * ever spares the service worker a compile.
 */
export function warmBlocker(module: WebAssembly.Module): void {
	const encoder = new TextEncoder();
	const make = () => {
		// the registrable domain import: "unknown", as an engine build has it
		// (src/blocker/build.ts)
		const exports = new WebAssembly.Instance(module, { e: { r: () => -1 } })
			.exports as unknown as WarmExports;
		const call = (input: string | Uint8Array, flags: number) => {
			const bytes = typeof input === 'string' ? encoder.encode(input) : input;
			const ptr = exports.a(bytes.length);
			if (bytes.length)
				new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
			return exports.r(ptr, bytes.length, flags);
		};
		return { exports, call };
	};
	try {
		const builder = make();
		builder.call(LIST, OP.addList);
		if (builder.call('', OP.build) !== 0) return;
		const engine = new Uint8Array(
			builder.exports.memory.buffer,
			builder.exports.p(),
			builder.exports.n(),
		).slice();
		const { call } = make();
		if (call(RESOURCES, OP.resources) !== 0) return;
		if (call(engine, OP.load) !== 0) return;
		for (const page of [PAGE, CSP_PAGE])
			call(`${page}\t${PAGE}\tdocument\tget`, OP.check);
		for (const type of TYPES)
			for (const url of URLS) call(`${url}\t${PAGE}\t${type}\tget`, OP.check);
		for (const page of [PAGE, CSP_PAGE]) {
			call(`${page}\t${page}\tdocument\tget`, OP.csp);
			call(page, OP.cosmetic);
		}
	} catch (error) {
		// a trap: nothing was shared that the service worker would not
		// compile itself
	}
}
