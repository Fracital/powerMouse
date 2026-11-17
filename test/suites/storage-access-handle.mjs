// What a StorageAccessHandle hands out, natively against proxied, both
// modes. A top-level page of a site stores its first-party data
// (localStorage, sessionStorage, IndexedDB, Cache Storage, a file in the
// origin private file system); then a page of another site frames that site,
// and the frame asks requestStorageAccess({ all: true }) and reads every
// member of the handle (test/pages/storage-access-handle.html): natively the
// handle's stores are the site's first-party ones, which the frame's own
// (partitioned) stores are not, and a member of a type not requested throws.
// The browser's handle is of the proxy origin, whose stores are every
// proxied site's and STomp's own at once; through the proxy each member is
// the site's first-party store. The same again with a frame of the top's
// own site, whose handle reads its own stores.
//
// Playwright turns Chrome's storage partitioning off; this suite turns it
// back on (the switch below is Playwright's list without it), as Chrome
// ships, so that natively a frame of another site has partitioned stores.
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
	submitOmni,
} from '../lib.mjs';

const PARTITIONED =
	'--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,AvoidCorsURLLoaderRestartOnRedirect,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch';

const browser = await launch([PARTITIONED]);
const fixture = new URL(FIXTURE);
const PAGE = 'pages/storage-access-handle.html';
const SITES = {
	cross: `http://localhost:${fixture.port}/${PAGE}`,
	same: `${FIXTURE}${PAGE}`,
};
const topURL = (child) =>
	`${FIXTURE}${PAGE}?child=${encodeURIComponent(child)}`;

async function poll(getFrames, read, tries = 160) {
	for (let i = 0; i < tries; i++) {
		for (const frame of getFrames()) {
			const value = await frame?.evaluate(read).catch(() => null);
			if (value) return value;
		}
		await sleep(250);
	}
	return null;
}
const readReport = () =>
	window.__handle && window.__handleTop
		? { frame: window.__handle, top: window.__handleTop }
		: null;

const native = {};
for (const [label, child] of Object.entries(SITES)) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${child}?seed`);
	const seeded = await poll(
		() => [page.mainFrame()],
		() => window.__seeded,
	);
	await page.goto(topURL(child));
	native[label] = await poll(() => [page.mainFrame()], readReport);
	await context.close();
	ok(
		`natively, ${label}: the frame read its handle`,
		seeded === true && !!native[label]?.frame?.worker,
		JSON.stringify({ seeded, ...native[label] }),
	);
}
// what the comparison relies on: natively a frame of another site has
// partitioned stores, and its handle the first-party ones
ok(
	'natively, a frame of another site reads its first-party stores only through the handle',
	native.cross?.frame.local === 'first-party' &&
		native.cross.frame.windowLocal === null,
	JSON.stringify(native.cross?.frame),
);

const proxiedFrames = (page) =>
	page.frames().filter((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const [label, child] of Object.entries(SITES)) {
		const page = await openDemo(browser, base);
		await submitLanding(page, `${child}?seed`);
		const seeded = await poll(
			() => proxiedFrames(page),
			() => window.__seeded,
		);
		await submitOmni(page, topURL(child));
		const proxied = await poll(() => proxiedFrames(page), readReport);
		ok(
			`${mode}, ${label}: the page was seeded and the frame answered`,
			seeded === true && !!proxied,
			JSON.stringify({ seeded, proxied }),
		);
		for (const part of ['top', 'frame'])
			for (const key of Object.keys(native[label]?.[part] ?? {}))
				ok(
					`${mode}, ${label}: ${part} ${key} as natively`,
					JSON.stringify(proxied?.[part]?.[key]) ===
						JSON.stringify(native[label][part][key]),
					`native ${JSON.stringify(native[label][part][key])} proxied ${JSON.stringify(proxied?.[part]?.[key])}`,
				);
		await page.context().close();
	}
}

await done(browser);
