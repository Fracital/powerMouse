// An <object> showing an HTML document loads that document's own relative
// resources (an image, a script, a stylesheet) through the proxy, as a frame
// does: each loads as natively, the document's base is its own URL, and the
// bypass recorder sees no request straight to the fixture. Both modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/object-resources.html`;
const fixtureHost = new URL(FIXTURE).host;

async function measure(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames()) {
			const value = await frame
				.evaluate(() => window.__objres)
				.catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	"natively: the object's document loads its image, script and stylesheet",
	native?.image === true &&
		native?.script === true &&
		native?.style === 'rgb(1, 2, 3)',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, PAGE);
	const proxied = await measure(() => page.frames());
	for (const key of ['image', 'script', 'style', 'base'])
		ok(
			`${mode}: the object's document's ${key} as natively`,
			proxied?.[key] === native?.[key],
			`native ${JSON.stringify(native?.[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	const raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === fixtureHost)
		.map((entry) => entry.url);
	ok(
		`${mode}: nothing the object's document loads goes straight to the site`,
		raw.length === 0,
		JSON.stringify(raw),
	);
	await page.close();
}

await done(browser);
