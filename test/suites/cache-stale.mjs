// The HTTP cache honours what the origin asked for and nothing more: a stale
// entry is served within its stale-while-revalidate window and revalidated
// behind the page, answers for a 5xx within its stale-if-error window, and is
// not used past either window. No heuristic freshness.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
await submitLanding(page, `${FIXTURE}pages/cache-stale.html`);
let result = {};
for (let i = 0; i < 60 && !result.done; i++) {
	await sleep(500);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		result = (await frame?.evaluate(() => window.__stale)) || {};
	} catch (error) {
		result = {};
	}
}
const hits = result.hits || {};
ok(
	'the page ran to the end',
	result.done === true && !result.error,
	JSON.stringify(result.error),
);
ok(
	'a stale entry within stale-while-revalidate is served at once',
	result.swr2?.status === 200 && result.swr2?.body?.n === 1,
	JSON.stringify(result.swr2),
);
ok(
	'the background revalidation refreshed the entry once',
	result.swr3?.body?.n === 2 && hits['stale/swr']?.requests === 2,
	JSON.stringify([result.swr3, hits['stale/swr']]),
);
ok(
	'past the stale-while-revalidate window the entry is not used',
	result.short2?.body?.n === 2 && hits['stale/swr-short']?.requests === 2,
	JSON.stringify([result.short2, hits['stale/swr-short']]),
);
ok(
	'a stale entry within stale-if-error answers for a 5xx',
	result.sie2?.status === 200 &&
		result.sie2?.body?.n === 1 &&
		hits['stale/sie']?.requests === 2,
	JSON.stringify([result.sie2, hits['stale/sie']]),
);
await done(browser);
