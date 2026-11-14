// The rewrite cache is kept under the rewriter's generation (src/version.ts
// REWRITE_GENERATION, a digest of the bytes a rewrite's output depends on:
// the wasm core, the codec module, the light library). A worker that
// activates adopts the store (RewriteCache.adopt): it keeps every entry when
// the generation is the same, so a revisit after a deploy that did not touch
// the rewriter comes back warm, and drops the whole store when the generation
// differs, so output from a build whose rewriter differs is never served.
// The generation is part of the key besides, so even an entry that outlived
// an adopt (it never should) could not be matched under another generation.
// Run in node against the real RewriteCache over a stand-in Cache API store;
// the service worker calls adopt on activate (src/server/serviceWorker.ts),
// and the browser suites rewrite-cache and rewrite-cache-bytes cover the live
// path within one generation.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP rewrite-generation: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const bundle = `${OUT}rewrite-generation.mjs`;
await esbuild.build({
	entryPoints: [`${root}src/server/rewriteCache.ts`],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});

// a stand-in Cache API: one named store, its entries by the URL they were put
// under, each response cloned in and out so a kept copy is never read and a
// match hands back a fresh one, as the real one does
class StandInCache {
	#entries = new Map();
	async match(request) {
		const url = typeof request === 'string' ? request : request.url;
		const held = this.#entries.get(url);
		return held ? held.clone() : undefined;
	}
	async put(request, response) {
		const url = typeof request === 'string' ? request : request.url;
		this.#entries.set(url, response.clone());
	}
	async keys() {
		return [...this.#entries.keys()].map((url) => ({ url }));
	}
	async delete(request) {
		const url = typeof request === 'string' ? request : request.url;
		return this.#entries.delete(url);
	}
}
const stores = new Map();
globalThis.caches = {
	async open(name) {
		let store = stores.get(name);
		if (!store) stores.set(name, (store = new StandInCache()));
		return store;
	},
	async delete(name) {
		return stores.delete(name);
	},
};

const { RewriteCache } = await import(bundle);

const G1 = 'aaaa111122223333';
const G2 = 'bbbb444455556666';
const PART = 'partition-digest';
const body = new TextEncoder().encode('console.log("hello")');
const parts = (generation) => [
	generation,
	'https://example.com/dir/app.js',
	'generic',
	'config',
	'xor',
	PART,
];
const text = async (blob) => (blob === null ? null : await blob.text());

const cache = new RewriteCache();

// the first worker ever: an empty store is not "kept"; the generation is
// recorded for the next worker to compare against
ok(
	'the first activation adopts an empty store (nothing to keep)',
	(await cache.adopt(G1)) === false,
);

const k1 = await cache.key(parts(G1), body);
await cache.put(k1, 'OUTPUT-ONE');
ok(
	'a rewrite kept under the current generation is served warm',
	(await text(await cache.match(k1))) === 'OUTPUT-ONE',
);

// a deploy that did not touch the rewriter: the same generation activates and
// keeps the store, so the revisit is still a warm hit
ok(
	'a worker of the same generation keeps the store on activation',
	(await cache.adopt(G1)) === true,
);
ok(
	'a same-generation revisit IS served warm after the activation',
	(await text(await cache.match(k1))) === 'OUTPUT-ONE',
);

// a deploy that changed the rewriter: a new generation activates and drops the
// whole store, so last build's output is gone
ok(
	'a worker of another generation drops the store on activation',
	(await cache.adopt(G2)) === false,
);
ok(
	'a stale-generation cached rewrite is NOT served after the generation changed',
	(await cache.match(k1)) === null,
);

// the generation is in the key too: the same script under the new generation
// is a different entry, never the old one, and comes back warm on its own
// same-generation revisit
const k2 = await cache.key(parts(G2), body);
ok('the generation is part of the key', k2 !== k1);
await cache.put(k2, 'OUTPUT-TWO');
ok(
	'a worker of the new generation keeps the new store',
	(await cache.adopt(G2)) === true,
);
ok(
	'the new generation serves its own rewrite warm',
	(await text(await cache.match(k2))) === 'OUTPUT-TWO',
);

// the loaded-script path (matchServed: the store's own Response, kept under
// the routed URL) is kept and dropped by generation the same way
const routed = 'https://proxy.example/stomp/js:generic/app.js';
await cache.putServed(routed, k2, PART, 'SERVED-BODY', 'SERVED-BODY'.length, {
	status: 200,
	statusText: 'OK',
	headers: new Headers({ 'content-type': 'text/javascript' }),
});
{
	const served = await cache.matchServed(routed, k2);
	ok(
		'a served entry under the current generation comes back',
		served !== null && (await served.text()) === 'SERVED-BODY',
	);
}
ok(
	'a worker of another generation drops the served entry too',
	(await cache.adopt(G1)) === false,
);
ok(
	'a stale-generation served entry is NOT returned after the generation changed',
	(await cache.matchServed(routed, k2)) === null,
);

await done();
