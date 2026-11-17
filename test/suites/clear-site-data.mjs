// Clear-Site-Data, as Chrome acts on it: an answer of a secure origin (here
// 127.0.0.1, potentially trustworthy) naming "cookies" drops the cookies of
// its site, "storage" its origin's localStorage, IndexedDB, Cache API and
// file system, "cache" its cached responses, "*" all of them; a value that
// is not a quoted type does nothing. The worker drops the header (the
// browser would wipe every proxied site's state at once, and STomp's own)
// and clears the site's own jar and partitions instead. Another site's
// state is untouched. Every case is compared with the same page loaded
// natively. Same-origin mode.
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

const OTHER = FIXTURE.replace('127.0.0.1', 'localhost');
const page = (origin) => `${origin}pages/hdr-csd.html`;
const CASES = [
	'"cookies"',
	'"storage"',
	'"cache"',
	'"*"',
	'"cookies", "storage"',
	'cookies',
	'"executionContexts"',
];

/** each case's state of the page that got the answer and of another site's */
async function measure(first, other) {
	const results = {};
	for (const types of CASES) {
		await other.evaluate(() => window.csd.setup());
		await first.evaluate(() => window.csd.setup());
		const cleared = await first
			.evaluate((value) => window.csd.clear(value), types)
			.catch((error) => `threw ${error.message.split('\n')[0]}`);
		await sleep(300);
		results[types] = {
			cleared,
			other: await other.evaluate(() => window.csd.state()),
		};
	}
	return results;
}

const browser = await launch();
const context = await browser.newContext();
const nativeFirst = await context.newPage();
const nativeOther = await context.newPage();
await nativeFirst.goto(page(FIXTURE));
await nativeOther.goto(page(OTHER));
const native = await measure(nativeFirst, nativeOther);
await context.close();
console.log('native', JSON.stringify(native));
ok(
	'natively, "cookies" drops the cookies and "storage" the stores of the site that answered, and nothing of another site',
	native['"cookies"']?.cleared?.sent === '' &&
		native['"storage"']?.cleared?.local === null &&
		native['"*"']?.other?.local === '1',
	JSON.stringify(native),
);

const host = await openDemo(browser, PROXY);
const errors = [];
host.on('pageerror', (error) => errors.push(error.message));
/** the proxied frame of a site the landing opened (the newest that runs the page) */
const opened = async (origin) => {
	await submitLanding(host, page(origin));
	for (let i = 0; i < 120; i++) {
		for (const frame of [...host.frames()].reverse()) {
			const found = await frame
				.evaluate(() => window.csd?.origin)
				.catch(() => null);
			if (found && `${found}/` === origin) return frame;
		}
		await sleep(250);
	}
	return null;
};
const first = await opened(FIXTURE);
const other = await opened(OTHER);
const proxied = await measure(first, other);
console.log('proxied', JSON.stringify(proxied));
for (const types of CASES)
	for (const who of ['cleared', 'other'])
		ok(
			`Clear-Site-Data: ${types}: what ${who === 'cleared' ? 'the site that answered' : 'another site'} keeps, as natively`,
			JSON.stringify(proxied[types]?.[who]) ===
				JSON.stringify(native[types]?.[who]),
			JSON.stringify({
				native: native[types]?.[who],
				proxied: proxied[types]?.[who],
			}),
		);
await done(browser, errors);
