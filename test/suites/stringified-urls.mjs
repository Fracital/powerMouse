// A URL attribute set to an object takes the string the object reads as.
// The setAttribute hook kept the object and compared it with '': an object
// whose string is '' passed for a URL and was resolved to the document's
// own, so an <img> fetched the page again, as an image. On YouTube that was
// the logo (Polymer hands setAttribute such a value): every watch page was
// requested twice, the second time with an image's headers. Natively, and
// through the proxy in both modes, the page must be requested once, the
// empty values must stay empty, and an object that reads as a path must
// still load that path.
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

const PAGE = `${FIXTURE}pages/stringified-urls.html`;
const browser = await launch();

/** how often the fixture served each of these paths so far */
async function served(paths) {
	const all = await (await fetch(`${FIXTURE}requests`)).json();
	return paths.map((path) => all.filter((p) => p === path).length);
}
const PATHS = ['/pages/stringified-urls.html', '/pages/su-marker.png'];

/** the page's report from whichever frame has it */
async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__su).catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const EXPECTED = {
	attr: '',
	prop: '',
	input: '',
	poster: '',
	routed: 'su-marker.png',
};
const readsAsWritten = (su) =>
	!!su && Object.entries(EXPECTED).every(([key, value]) => su[key] === value);

{
	const before = await served(PATHS);
	const page = await browser.newPage();
	await page.goto(PAGE);
	const su = await report(page);
	// the marker image's request may land after the report
	await sleep(1000);
	const after = await served(PATHS);
	ok(
		'natively: the page is requested once and the marker image loads',
		after[0] - before[0] === 1 && after[1] - before[1] === 1,
		JSON.stringify({ before, after }),
	);
	ok(
		'natively: the attributes read as written',
		readsAsWritten(su),
		JSON.stringify(su),
	);
	await page.close();
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const demo = await openDemo(browser, base);
	const before = await served(PATHS);
	await submitLanding(demo, PAGE);
	const su = await report(demo);
	await sleep(1000);
	const after = await served(PATHS);
	ok(
		`${mode}: the page is requested once, never again as an image`,
		after[0] - before[0] === 1,
		JSON.stringify({ before, after }),
	);
	ok(
		`${mode}: an object that reads as a path loads that path`,
		after[1] - before[1] === 1,
		JSON.stringify({ before, after }),
	);
	ok(
		`${mode}: the attributes read as written`,
		readsAsWritten(su),
		JSON.stringify(su),
	);
	await demo.close();
}

await done(browser);
