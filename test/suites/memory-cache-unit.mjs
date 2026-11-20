// src/server/cache.ts MemoryCache, checked in node with a clock of its own.
// Chrome's renderer keeps a resource in memory only while something holds
// it: an image taken out of the DOM, or what a document that navigated away
// loaded, is gone at the next collection, and the next document takes it
// from the HTTP cache. The worker's memory cache cannot see what a document
// holds, so an entry no document asked for in MEMORY_IDLE (5 minutes) goes;
// one that was asked for stays, its idle time counted from that use. Kept
// until the budget pushed it out, a live channel left open kept every
// thumbnail and chat emote it ever showed (27 MB after 14 minutes, growing).
// Skips when esbuild is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch {
	console.log('SKIP memory-cache-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}memory-cache-unit-entry.mjs`;
writeFileSync(
	entry,
	`export * from ${JSON.stringify(`${root}src/server/cache.ts`)};\n`,
);
const bundle = `${OUT}memory-cache-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { MemoryCache, MEMORY_IDLE: idle } = await import(
	`${bundle}?${Date.now()}`
);
// (the build before MEMORY_IDLE: the same 5 minutes are expected of it)
const IDLE = idle ?? 5 * 60 * 1000;

let now = 1_800_000_000_000;
Date.now = () => now;
const MIN = 60 * 1000;
const site = 'https://site.test';
const key = (name) =>
	MemoryCache.key(site, false, `https://cdn.test/${name}.png`);
const request = new Headers();
const keep = (cache, name, bytes = 1024) =>
	cache.keep(
		key(name),
		request,
		new Response(null, {
			status: 200,
			headers: {
				'content-type': 'image/png',
				'cache-control': 'max-age=86400',
			},
		}),
		new Blob([new Uint8Array(bytes)]),
	);
const hit = (cache, name) => cache.match(key(name), request) !== null;

{
	const cache = new MemoryCache();
	keep(cache, 'shown-once');
	now += IDLE - MIN;
	ok(
		'an entry is handed out while it has been idle less than MEMORY_IDLE',
		hit(cache, 'shown-once'),
	);
	cache.clear();
}
{
	const cache = new MemoryCache();
	keep(cache, 'thumbnail');
	now += IDLE + 1000;
	ok(
		'an entry no document asked for in MEMORY_IDLE is not handed out (fresh for a day)',
		!hit(cache, 'thumbnail'),
	);
	cache.clear();
}
{
	const cache = new MemoryCache();
	keep(cache, 'emote');
	keep(cache, 'left');
	for (let i = 0; i < 4; i++) {
		now += IDLE - MIN;
		hit(cache, 'emote');
	}
	ok(
		'an entry asked for again stays: its idle time counts from the last use',
		hit(cache, 'emote'),
	);
	ok('another entry kept with it and not asked for went', !hit(cache, 'left'));
	cache.clear();
}
{
	// the budget's accounting follows what the sweep dropped: 64 parts of 96 MB is 1.5 MB
	const cache = new MemoryCache();
	cache.share(64);
	keep(cache, 'old', 1024 * 1024);
	now += IDLE + 1000;
	keep(cache, 'a', 700 * 1024);
	keep(cache, 'b', 700 * 1024);
	ok(
		'what an idle entry held is given back to the budget',
		hit(cache, 'a') && hit(cache, 'b') && !hit(cache, 'old'),
	);
	cache.clear();
}

await done();
