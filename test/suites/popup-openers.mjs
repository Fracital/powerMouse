// Popups and their openers through the proxy, against Chrome
// (docs/same-origin-policy.md, "Cross-origin isolation"; docs/site-pool.md).
// A page and frames of another site open popups every way that keeps a
// window here: window.open() written and navigated, window.open(url) and
// links from a sandboxed frame (the demo takes every other one as a tab of
// its own, onOpen). Each case says whether the opener got a window and is
// the popup's opener, whether the popup's messages and the opener's answers
// came with the right origin and source, closed and close(), and the
// popup's own view of its opener; a page that sends COOP same-origin, and a
// popup whose page does, take the popup out of its opener's group as
// natively. The demo's page is cross-origin isolated here (STOMP_ISOLATION
// on, production's default): with the site pool every proxied page is a
// frame of another origin than it, and under COOP same-origin Chrome gave
// such a frame no window for its popups. The last part runs a second demo
// server without the isolation (STOMP_ISOLATION=off), with the pool as the
// run has it.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
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
	waitForServer,
} from '../lib.mjs';

// Cases known to differ from Chrome, by why. A case on a list that now
// reads as natively fails: take it off.
// With the pool every proxied page is a frame of another origin than the
// demo's page (its slot's), and the isolated host sends COOP same-origin.
const KNOWN_COOP_HOST_POOL_WHY =
	"Chrome opens a frame's popup without an opener when its top sends COOP same-origin: window.open('') and about:blank return null from a proxied page under the pool (docs/site-pool.md, \"Popups under the isolated host\"; a host page isolated by Document-Isolation-Policy is the follow-up)";
const KNOWN_COOP_HOST_POOL = new Set([
	'a frame of another site opens a blank popup and writes it',
	'a frame of another site opens a popup and navigates it to a third origin',
	'a frame of another site opens a popup to a page that sends COOP same-origin',
	'a sandboxed frame of another site: window.open(url)',
	'a sandboxed frame: a target=_blank link with rel=opener',
	'the popup of to-coop',
	'the popup of link-opener',
	'the popup of link-noopener',
	'the popup of link-plain',
	'a COOP same-origin page opens a blank popup',
	'a COOP same-origin page navigates its popup to another origin',
	'a COOP same-origin page navigates its popup to a page of its origin with the same policy',
	'the popup of coop-top-navigated',
]);
// Without the pool the isolated host's documents all send COOP same-origin
// (one cross-origin isolated group, docs/same-origin-policy.md): a popup a
// sandboxed frame opens is sandboxed too, and Chrome keeps no opener for a
// sandboxed popup in a COOP group; natively there is no COOP to apply.
const KNOWN_WITHOUT_POOL_WHY =
	'a popup of a sandboxed frame keeps no opener in the COOP same-origin group of the isolated host without the pool';
const KNOWN_WITHOUT_POOL = new Set([
	'a sandboxed frame of another site: window.open(url)',
	'a sandboxed frame: a target=_blank link with rel=opener',
	'the popup of link-opener',
	'the popup of link-noopener',
	'the popup of link-plain',
]);

const PAGES = {
	'a page without COOP': `${FIXTURE}pages/popup-openers.html`,
	'a page with COOP same-origin': `${FIXTURE}pages/popup-openers-coop.html`,
};

/** the page's cases and every popup's view of its opener, by case */
async function collect(page) {
	let cases = null;
	for (let i = 0; i < 360 && !cases; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const found = await frame
				?.evaluate(() => window.__popups)
				.catch(() => null);
			if (found?.done) cases = found.cases;
		}
	}
	const popups = {};
	for (const other of page.context().pages())
		for (const frame of other.frames()) {
			const info = await frame
				?.evaluate(() => window.__popupInfo)
				.catch(() => null);
			if (info?.case) popups[info.case] = info;
		}
	return { cases, popups };
}

async function native(url) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(url);
	const found = await collect(page);
	await context.close();
	return found;
}

async function proxied(base, url, open = (base) => openDemo(browser, base)) {
	const page = await open(base);
	const isolated = await page.evaluate(() => self.crossOriginIsolated);
	await submitLanding(page, url);
	const found = await collect(page);
	await page.context().close();
	return { isolated, ...found };
}

function compare(label, want, got, known = new Set(), why = '') {
	const check = (name, wanted, had) => {
		const same = JSON.stringify(wanted) === JSON.stringify(had);
		if (known.has(name))
			ok(
				`${label}: ${name} differs as known (${why})`,
				!same,
				same
					? 'now as natively: take it off the list'
					: `native ${JSON.stringify(wanted)} proxied ${JSON.stringify(had)}`,
			);
		else
			ok(
				`${label}: ${name}${name.startsWith('the popup of ') ? ' sees its opener' : ''} as natively`,
				same,
				`\n      native  ${JSON.stringify(wanted)}\n      proxied ${JSON.stringify(had)}`,
			);
	};
	ok(
		`${label}: the page ran every case`,
		!!got.cases &&
			Object.keys(want.cases ?? {}).every((name) => name in got.cases),
		JSON.stringify(got.cases),
	);
	for (const [name, wanted] of Object.entries(want.cases ?? {}))
		check(name, wanted, got.cases?.[name]);
	for (const [name, wanted] of Object.entries(want.popups))
		check(`the popup of ${name}`, wanted, got.popups[name]);
}

const browser = await launch();
const natives = {};
for (const [kind, url] of Object.entries(PAGES)) {
	natives[kind] = await native(url);
	ok(
		`natively, ${kind} ran every case`,
		!!natives[kind].cases &&
			Object.values(natives[kind].cases).every(
				(result) => typeof result === 'object',
			),
		JSON.stringify(natives[kind]),
	);
}
// what the cases rely on, so a change in the browser shows here first
const plain = natives['a page without COOP'].cases ?? {};
const coop = natives['a page with COOP same-origin'].cases ?? {};
ok(
	'natively, a frame of another site keeps its popups, and a COOP same-origin page takes a frame of another origin its popups',
	plain[
		'a frame of another site opens a popup and navigates it to a third origin'
	]?.pong?.source === true &&
		coop[
			'a frame of another origin than a COOP same-origin page opens a blank popup'
		]?.window === false &&
		coop['a COOP same-origin page navigates its popup to another origin']
			?.closed === true,
	JSON.stringify({ plain, coop }),
);

for (const [kind, url] of Object.entries(PAGES)) {
	const got = await proxied(PROXY, url);
	ok(
		'the demo page is cross-origin isolated (STOMP_ISOLATION on)',
		got.isolated === true,
		String(got.isolated),
	);
	compare(
		`isolated host, ${kind}`,
		natives[kind],
		got,
		...(SLOT_PORTS.length
			? [KNOWN_COOP_HOST_POOL, KNOWN_COOP_HOST_POOL_WHY]
			: [KNOWN_WITHOUT_POOL, KNOWN_WITHOUT_POOL_WHY]),
	);
}

// The host that does not send the isolation headers, the pool as this run
// has it: a second demo server
const port = await freePort();
const slots = [];
for (let i = 0; i < SLOT_PORTS.length; i++) slots.push(await freePort());
const env = {
	...process.env,
	PORT: String(port),
	WISP_ALLOW_LOOPBACK: '1',
	STOMP_ISOLATION: 'off',
	STOMP_SITE_POOL: slots.length ? slots.join(',') : '0',
};
delete env.STOMP_PROXY_ORIGIN;
delete env.STOMP_WISP_URL;
const server = spawn(
	process.execPath,
	[fileURLToPath(new URL('../../demo/server.js', import.meta.url))],
	{ env, stdio: ['ignore', 'ignore', 'inherit'] },
);
try {
	await waitForServer(`http://127.0.0.1:${port}/api/status`);
	for (const [kind, url] of Object.entries(PAGES)) {
		const got = await proxied(`http://127.0.0.1:${port}/`, url);
		ok(
			'the second demo page is not isolated (STOMP_ISOLATION off)',
			got.isolated === false,
			String(got.isolated),
		);
		compare(`host not isolated, ${kind}`, natives[kind], got);
	}
} finally {
	server.kill();
}
await done(browser);

/** a port nothing listens on */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}
