// A script the preload scanner fetched while the parser waited on an earlier
// one is asked for again when the parser reaches it: a rewritten body goes
// out no-cache, and Chrome never revalidates for a page a service worker
// controls, it fetches in full. The worker fetched the script from the
// origin again and rewrote it again (YouTube's 20 MB bundle and 3 MB
// stylesheet went through the worker twice per load). Natively the document
// reuses what its scanner fetched. Now the worker answers the document's
// repeat of a request it just answered with the same output: the scripts
// run, in order, and the origin is asked once even for a no-store script.
// Both modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/preload-reuse.html`;
const SCRIPT = `${FIXTURE}pages/preload-reuse.js`;
const upstreamHits = async () =>
	(await (await fetch(`${FIXTURE}requests`)).json()).filter(
		(path) => path === '/pages/preload-reuse.js',
	).length;

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		window.__log = [];
		window.controller.addEventListener('request', (event) =>
			window.__log.push({
				url: event.detail.url,
				status: event.detail.status,
				cached: event.detail.cached,
				rewriteCache: event.detail.rewriteCache ?? null,
			}),
		);
	});
	const hitsBefore = await upstreamHits();
	await submitLanding(page, PAGE);
	let order = null;
	for (let i = 0; i < 120 && !order; i++) {
		await sleep(250);
		order = await page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			?.evaluate(() =>
				window.__order?.length === 2 ? window.__order.join() : null,
			)
			.catch(() => null);
	}
	await sleep(500);
	const log = await page.evaluate(() => window.__log);
	const script = log.filter((entry) => entry.url === SCRIPT);
	const hits = (await upstreamHits()) - hitsBefore;
	const detail = JSON.stringify({ order, hits, script });
	ok(`${mode}: the scripts run, in order`, order === 'slow,fast', detail);
	ok(
		`${mode}: the origin is asked for the no-store script once`,
		hits === 1,
		detail,
	);
	ok(
		`${mode}: the script is rewritten once; a repeat is answered with the output the document was given`,
		script.length >= 1 &&
			script[0].rewriteCache !== null &&
			script.slice(1).every((entry) => entry.cached && !entry.rewriteCache),
		detail,
	);
	await page.close();
}

await done(browser);
