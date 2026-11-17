// Document-Isolation-Policy and reach, natively and through the proxy
// (test/pages/dip-reach.js on the fixture's /coi/doc). A document whose own
// policy isolates it is in an agent cluster apart from the documents of its
// origin that are not isolated by one (a cross-origin isolated page
// included): neither reaches the other's document, as across origins; two
// isolated by one (either value) reach each other. A report-only policy, a
// value Chrome does not know, and the policy on an origin that is not
// potentially trustworthy change nothing. Each row is compared with the
// same pages loaded natively, in same-origin mode.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const SAME = FIXTURE.replace(/\/$/, '');
const DIP = 'document-isolation-policy:isolate-and-require-corp';
const CREDENTIALLESS = 'document-isolation-policy:isolate-and-credentialless';
const CORP = 'cross-origin-resource-policy:same-origin';
// [name, the parent's headers, the frame's]
const ROWS = [
	['neither isolated', [], []],
	['a frame isolated by its policy', [], [DIP]],
	['a parent isolated by its policy', [DIP], [CORP]],
	['both isolated by the policy', [DIP], [DIP]],
	['both isolated, by either value', [CREDENTIALLESS], [DIP]],
	[
		'a frame with a report-only policy',
		[],
		['document-isolation-policy-report-only:isolate-and-require-corp'],
	],
	[
		'a frame with a value Chrome does not know',
		[],
		['document-isolation-policy:isolate'],
	],
];
const doc = (row, parent, frame) => {
	const url = new URL(`${SAME}/coi/doc`);
	url.searchParams.set('script', '/pages/dip-reach.js');
	url.searchParams.set('role', 'parent');
	url.searchParams.set('row', String(row));
	for (const header of parent) url.searchParams.append('h', header);
	for (const header of frame) url.searchParams.append('fh', header);
	return url.href;
};
const urls = ROWS.map(([, parent, frame], row) => doc(row, parent, frame));

/** every row's report, from every frame of `pages` */
async function collect(pages) {
	const rows = ROWS.map(() => null);
	for (let i = 0; i < 100 && rows.includes(null); i++) {
		await sleep(200);
		for (const page of pages)
			for (const frame of page.frames()) {
				const found = await frame
					.evaluate(() => window.__dip)
					.catch(() => null);
				if (found?.row !== undefined) rows[Number(found.row)] = found;
			}
	}
	return rows;
}

const browser = await launch();
const nativeContext = await browser.newContext();
const nativePages = await Promise.all(
	urls.map(async (url) => {
		const page = await nativeContext.newPage();
		await page.goto(url);
		return page;
	}),
);
const native = await collect(nativePages);
await nativeContext.close();
ok('natively, every row ran', !native.includes(null), JSON.stringify(native));

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(
	(urls) =>
		Promise.all(
			urls.map((url) => {
				const element = document.createElement('iframe');
				document.body.append(element);
				return window.controller.createFrame(element).go(url);
			}),
		),
	urls,
);
const proxied = await collect([page]);
for (const [row, [name]] of ROWS.entries()) {
	const shown = (value) =>
		JSON.stringify(value && { ...value, row: undefined });
	ok(
		`${name}: what the parent and its frame of one origin reach of each other, as natively`,
		shown(proxied[row]) === shown(native[row]),
		`native ${shown(native[row])} proxied ${shown(proxied[row])}`,
	);
}
await done(browser, errors);
