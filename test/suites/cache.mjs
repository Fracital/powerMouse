// The service worker's HTTP cache, on by default and off with `?nocache` in
// the demo: a fresh entry (max-age) serves the second fetch without an
// upstream request, no-store never caches, a stale entry with an ETag
// revalidates and a 304 refreshes it, a request with Authorization is given
// what the same Authorization got, clearCache() forces a refetch, and with
// the opt-out nothing is cached. What is kept and what is asked, shape by
// shape against Chrome, is the http-cache suite's.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();

async function run(base) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/cache.html`);
	let result = {};
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		try {
			result = (await frame.evaluate(() => window.__cache)) || {};
		} catch (error) {
			result = {};
		}
		if (result.done) break;
	}
	return { page, result };
}

// cache on by default
{
	const { page, result } = await run(HOST);
	const hits = result.hits || {};
	ok(
		'page fetched everything',
		result.error === undefined,
		JSON.stringify(result.error),
	);
	ok(
		'a fresh entry serves the second fetch from the cache',
		hits['fresh.json']?.requests === 1,
		JSON.stringify(hits['fresh.json']),
	);
	ok(
		'a request that arrives while the entry is still being stored is served from it',
		hits['burst.json']?.requests === 1,
		JSON.stringify(hits['burst.json']),
	);
	ok(
		'no-store is fetched every time',
		hits['nostore.json']?.requests === 2,
		JSON.stringify(hits['nostore.json']),
	);
	ok(
		'a stale entry with an ETag revalidates and gets a 304',
		hits['revalidate.json']?.requests === 2 &&
			hits['revalidate.json']?.notModified === 1,
		JSON.stringify(hits['revalidate.json']),
	);
	ok(
		'a request with Authorization is given what the same Authorization got',
		hits['auth.json']?.requests === 1,
		JSON.stringify(hits['auth.json']),
	);
	ok(
		'and another Authorization is not: the origin is asked',
		hits['auth-other.json']?.requests === 2,
		JSON.stringify(hits['auth-other.json']),
	);
	await page.evaluate(() => window.controller.clearCache());
	// after clearCache the fresh file must be fetched again
	await submitLanding(page, `${FIXTURE}pages/cache.html`);
	await sleep(4000);
	const hits2 = await (await fetch(`${FIXTURE}hits`)).json();
	ok(
		'clearCache() makes the fresh entry fetch again',
		hits2['fresh.json']?.requests === 2,
		JSON.stringify(hits2['fresh.json']),
	);
	await page.close();
}

// cache: false refetches
{
	const before = await (await fetch(`${FIXTURE}hits`)).json();
	const { page, result } = await run(`${HOST}?nocache`);
	const hits = result.hits || {};
	ok(
		'with cache: false a fresh entry is fetched every time',
		(hits['fresh.json']?.requests || 0) -
			(before['fresh.json']?.requests || 0) ===
			2,
		JSON.stringify([before['fresh.json'], hits['fresh.json']]),
	);
	await page.close();
}

await done(browser);
