// Two proxied origins share one real origin, so everything keyed by origin
// in the browser must be partitioned by the proxy: BroadcastChannel names,
// the Cache API namespace and the origin private file system. Two tabs on
// different proxied origins and a third on the first origin again.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const other = FIXTURE.replace('127.0.0.1', 'localhost');
const origins = [
	new URL(FIXTURE).origin,
	new URL(other).origin,
	new URL(FIXTURE).origin,
];
for (const base of [FIXTURE, other, FIXTURE]) {
	await page.click('#home');
	await submitLanding(page, `${base}pages/partition.html`);
	await sleep(1500);
}
await sleep(6000);
// received lists are deduplicated by the page only at its own `done`; dedupe here too

const frames = page
	.frames()
	.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
const results = [];
for (const frame of frames) {
	try {
		const part = await frame.evaluate(() => window.__part);
		if (part) part.received = [...new Set(part.received)];
		results.push(part);
	} catch (error) {
		results.push({ error: error.message });
	}
}
ok(
	'three partition pages ran',
	results.length === 3 && results.every((r) => r && r.done),
	JSON.stringify(results.map((r) => r && (r.error || r.done))),
);
const [a, b, a2] = results;
ok(
	'same-origin pages hear each other on the channel',
	a?.received.includes(`from ${origins[2]}`) &&
		a2?.received.includes(`from ${origins[0]}`),
	JSON.stringify([a?.received, a2?.received]),
);
ok(
	'a different proxied origin never hears the channel',
	!a?.received.includes(`from ${origins[1]}`) &&
		!b?.received.includes(`from ${origins[0]}`),
	JSON.stringify([a?.received, b?.received]),
);
ok(
	'BroadcastChannel.name is the page name',
	a?.channelName === 'shared',
	JSON.stringify(a?.channelName),
);
ok(
	'caches.keys() lists only the origin caches, by their page names',
	JSON.stringify(a?.cacheKeys) === '["shared"]' &&
		JSON.stringify(b?.cacheKeys) === '["shared"]',
	JSON.stringify([a?.cacheKeys, b?.cacheKeys]),
);
ok(
	'a cache holds only its own origin entries',
	a?.cacheEntries?.length === 1 &&
		b?.cacheEntries?.length === 1 &&
		a?.cacheEntries[0] !== b?.cacheEntries[0],
	JSON.stringify([a?.cacheEntries, b?.cacheEntries]),
);
ok(
	'the origin private file system is per proxied origin',
	a?.opfsEntries?.length === 1 &&
		b?.opfsEntries?.length === 1 &&
		a?.opfsEntries[0] !== b?.opfsEntries[0],
	JSON.stringify([a?.opfsEntries, b?.opfsEntries]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
