// Walking the frame tree from a frame of another site: up through `parent`
// to `top`, over every frame from `top`, and `parent.top === top` many
// times, as ad scripts do. Every read of another window goes through the
// Context module's stand-ins, which must be the same object on every read
// (or `w = w.parent` never reaches `top`) and cheap: it decoded both
// documents' routed URLs on every read (about 25 us each), and the ad frames
// of a crazygames game page, about 200 of them walking the tree, kept the
// renderer's main thread busy for good. A chain of six frames alternating
// two sites, natively and through the proxy in same-origin mode; the cost
// check is a timing and reads SKIP_TIMING.
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

const DEPTH = 6;
const target = `${FIXTURE}pages/frame-walk.html?d=${DEPTH}`;
const SKIP_TIMING = process.env.SKIP_TIMING === '1';

async function result(page, timeout = 40000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__walk).catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await result(nativePage);
await nativePage.close();
ok(
	'natively, the deepest frame walks the tree',
	!!native,
	JSON.stringify(native),
);

const page = await openDemo(browser, PROXY);
await submitLanding(page, target);
const proxied = await result(page);
ok(
	'proxied, the deepest frame walks the tree',
	!!proxied,
	JSON.stringify(proxied),
);

ok(
	'parent reaches top in as many steps as natively',
	proxied?.up === DEPTH && native?.up === DEPTH,
	`proxied ${proxied?.up} native ${native?.up}`,
);
ok(
	'a walk from top sees every frame, as natively',
	proxied?.frames === native?.frames && native?.frames === DEPTH + 1,
	`proxied ${proxied?.frames} native ${native?.frames}`,
);
ok(
	'parent.top is top on every read',
	proxied?.same === proxied?.reads && native?.same === native?.reads,
	`proxied ${proxied?.same}/${proxied?.reads} native ${native?.same}/${native?.reads}`,
);
// 5,000 reads took about 100 ms through the proxy when each decoded both
// URLs (natively about 3 ms); about 20 ms with the documents' site keys.
// A loaded machine slows both, so the bound grows with the native time
if (!SKIP_TIMING)
	ok(
		'a read of another window costs a few microseconds',
		proxied && native && proxied.readsMs < Math.max(60, 15 * native.readsMs),
		`proxied ${Math.round(proxied?.readsMs)} ms native ${Math.round(native?.readsMs)} ms for ${proxied?.reads} reads`,
	);

await done(browser);
