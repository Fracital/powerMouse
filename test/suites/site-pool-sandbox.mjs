// A frame's sandbox through the proxy when the frame is of another site
// than its parent (docs/site-pool.md): with the site pool that is another
// slot, whose document cannot read its frame element, so the frame's route
// carries the sandbox (src/partition.ts nestedMark). Against Chrome, frames
// of another site (test/pages/pool-sandbox.html): one without allow-scripts
// runs no script, one with allow-scripts alone is of an opaque origin (and
// so is a frame of the other site in it), and window.open(url) and links
// obey allow-popups, and a link's rel, as natively. Runs with the pool as
// the run has it.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	SLOT_PORTS,
	submitLanding,
} from '../lib.mjs';

const URL_ = `${FIXTURE}pages/pool-sandbox.html`;
// Chrome opens a frame's popup without an opener when its top sends COOP
// same-origin (the isolated host) and the frame is of another origin than
// the top: with the pool every proxied page is, and without it a sandboxed
// frame is (opaque), so these popups keep no window there (a host page
// isolated by Document-Isolation-Policy is the follow-up for the pool)
const KNOWN_COOP_HOST = new Set([
	'window.open(url) with allow-popups opens a popup with its opener',
	'a target=_blank link with rel=opener opens a popup with its opener',
]);

async function collect(page) {
	for (let i = 0; i < 480; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(() => window.__poolSandbox)
				.catch(() => null);
			if (found?.done) return found.results;
		}
	}
	return null;
}

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(URL_);
const native = await collect(page);
await context.close();
ok(
	'natively, every case ran, and the sandbox holds',
	native?.['a frame without allow-scripts runs no script']?.ran === false &&
		native['a frame with allow-scripts alone is of an opaque origin']
			?.origin === 'null' &&
		native['a frame in a frame with allow-scripts alone inherits its sandbox']
			?.origin === 'null' &&
		native['window.open(url) with allow-popups opens a popup with its opener']
			?.hello === true,
	JSON.stringify(native),
);

const demo = await openDemo(browser, PROXY);
const isolated = await demo.evaluate(() => self.crossOriginIsolated);
await submitLanding(demo, URL_);
const proxied = await collect(demo);
ok('proxied, every case ran', proxied !== null, JSON.stringify(proxied));
for (const [name, wanted] of Object.entries(native ?? {})) {
	const want = JSON.stringify(wanted);
	const got = JSON.stringify(proxied?.[name]);
	if (isolated && KNOWN_COOP_HOST.has(name))
		ok(
			`${name}, differs as known (the isolated host's COOP${SLOT_PORTS.length ? ' with the pool' : ''})`,
			want !== got,
			`now as natively: take it off the list (${got})`,
		);
	else
		ok(
			`${name}, as natively`,
			want === got,
			`\n      native  ${want}\n      proxied ${got}`,
		);
}
await done(browser);
