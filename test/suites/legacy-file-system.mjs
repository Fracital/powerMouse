// The legacy sandboxed file system (webkitRequestFileSystem, its entries,
// the Sync forms in a dedicated worker) is the browser's per real origin,
// which every proxied site shares: STomp gives each site one of its own.
// test/pages/legacy-fs.html runs natively and through the proxy on two
// sites (127.0.0.1 and localhost on the fixture's port), A, B, then A
// again, and each run's view (names, URLs, paths, `..` at the root, the
// errors, a sandboxed frame's refusal, the worker's view, the other site's
// file) must be what native Chrome shows.
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
const other = FIXTURE.replace('127.0.0.1', 'localhost');
const RUNS = [
	['a', `${FIXTURE}pages/legacy-fs.html?write`],
	['b', `${other}pages/legacy-fs.html?write`],
	['a again', `${FIXTURE}pages/legacy-fs.html`],
];

const result = async (frame) => {
	for (let i = 0; i < 100; i++) {
		const value = await frame
			?.evaluate(() => (window.__fs ? window.__fs.then((r) => r) : undefined))
			.catch(() => undefined);
		if (value) return value;
		await sleep(300);
	}
	return { failed: 'no result' };
};

const native = [];
{
	const context = await browser.newContext();
	const page = await context.newPage();
	for (const [, url] of RUNS) {
		await page.goto(url);
		native.push(await result(page.mainFrame()));
	}
	await context.close();
}

const proxied = [];
const page = await openDemo(browser);
for (const [, url] of RUNS) {
	await page.click('#home');
	await submitLanding(page, url);
	await sleep(1000);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	proxied.push(await result(frame));
}

RUNS.forEach(([name], i) => {
	const n = native[i];
	const p = proxied[i];
	ok(
		`${name}: the page ran natively and proxied`,
		n?.done === true && p?.done === true,
		JSON.stringify([n, p]).slice(0, 600),
	);
	for (const key of Object.keys(n ?? {}))
		ok(
			`${name}: ${key} as native`,
			JSON.stringify(p?.[key]) === JSON.stringify(n[key]),
			`native ${JSON.stringify(n[key])} proxied ${JSON.stringify(p?.[key])}`,
		);
});
ok(
	'site b does not see the file site a wrote',
	!proxied[1]?.list?.includes('/a.txt') &&
		/^NotFoundError/.test(proxied[1]?.other ?? ''),
	JSON.stringify([proxied[1]?.list, proxied[1]?.other]),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
