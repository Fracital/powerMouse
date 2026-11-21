// A frame that navigates its top (or its parent) by script navigates it
// through the proxy as it does natively: test/pages/top-nav.js lists the
// cases (a frame of another site, of the top's origin, two levels deep with
// a grandchild of a third origin, of the top's and of its parent's, a
// srcdoc and a written about:blank child, and a frame of another site under
// each set of the sandbox's top navigation flags), each with and without a
// user's click, each form (`top.location = u`, `top.location.href = u`,
// `assign`, `replace`, `parent.location`), and a read of the top's
// location, which must stay refused. Each case is one top page loaded
// natively and then in both demo modes; for each the suite compares what
// the script caught (class, name and message), whether the top navigated,
// whether it made a history entry (history.length as the next document
// reads it at its first script and half a second in: with the site pool the
// other slots' entries are counted from the first), what it saw as
// document.referrer, the Referer, Origin and Sec-Fetch-* headers of its
// request, the console messages Chrome printed about the navigation, and
// the resource timing entries the initiating document has from its call on
// (the proxy's announcement of the navigation to its service worker must not
// be one).
// A frame that lands in a frame (a parent's navigation) has no history entry
// compared: the frame's fresh browsing context makes none through the proxy
// (docs/same-origin-policy.md, "A frame that is to show another origin").
// TOP_NAV_DUMP=<file> writes every case's three answers there, and
// TOP_NAV_ONLY=<text> runs the cases whose name has it. A case that lands
// natively waits for its landing here at most 30 s (8 s once two have not
// landed), so a mode that breaks them all still ends inside the timeout.
import { readFileSync, writeFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	HOST,
	inPool,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const CASES = new Function(
	`${readFileSync(new URL('../pages/top-nav.js', import.meta.url), 'utf8')}; return TOP_NAV_CASES;`,
)();
const NAMES = Object.keys(CASES).filter(
	(name) =>
		!process.env.TOP_NAV_ONLY || name.includes(process.env.TOP_NAV_ONLY),
);
const port = new URL(FIXTURE).port;
const RUN = Date.now().toString(36);
const step = (text) => console.error(`# ${new Date().toISOString()} ${text}`);
// the console messages Chrome prints about a navigation it refuses
const ABOUT_NAVIGATION = /navigat|Unsafe attempt|permission to navigate/i;

const fixtureJSON = async (path) => (await fetch(`${FIXTURE}${path}`)).json();

/** the beacons of a case, decoded */
async function beacons(key) {
	const log = (await fixtureJSON(`echo-post/log?k=${key}`)) ?? {};
	const decoded = {};
	for (const [shape, entry] of Object.entries(log))
		try {
			decoded[shape] = JSON.parse(Buffer.from(entry.bodyHex, 'hex').toString());
		} catch (error) {
			decoded[shape] = { unreadable: entry.bodyHex };
		}
	return decoded;
}

/**
 * One case: `open` loads the top page, `frames` lists the frames to look
 * for the innermost document in, `messages` is the live console log.
 * `settle(result)`: how long to wait for a landing after the script's result.
 */
async function runCase(name, key, { open, frames, messages, settle }) {
	const url = `${FIXTURE}pages/top-nav.html?${new URLSearchParams({ c: name, k: key, d: '0', p: port })}`;
	const mark = messages.length;
	await open(url);
	// (a case that needs no click may have navigated the top already)
	let frame = null;
	let ready = null;
	for (let i = 0; i < 160 && !frame && CASES[name].user; i++) {
		await sleep(250);
		for (const candidate of frames()) {
			const value = await candidate
				.evaluate(() => window.__topNavReady ?? null)
				.catch(() => null);
			if (value?.startsWith?.(`${key}:`)) {
				frame = candidate;
				ready = value.slice(key.length + 1);
				break;
			}
		}
	}
	if (!frame && CASES[name].user)
		return { error: 'the innermost document never ran' };
	if (ready === 'click')
		await frame.click('#go', { timeout: 15000 }).catch(() => {});
	let got = {};
	let resultAt = null;
	const start = Date.now();
	while (Date.now() - start < 60000) {
		await sleep(200);
		got = await beacons(key);
		if (got.result && resultAt === null) resultAt = Date.now();
		if (got.result && got.landed && got.later && got.entries) break;
		// (the entries come as the document goes, or a moment after its call)
		const waited = resultAt === null ? -Infinity : Date.now() - resultAt;
		if (
			resultAt !== null &&
			waited > settle(got.result) &&
			(got.entries || waited > settle(got.result) + 3000)
		)
			break;
	}
	// a late console message of the refusal
	await sleep(300);
	const headers = got.landed
		? await fixtureJSON(`echo-headers/recorded?k=${key}`)
		: null;
	const pick = (header) => headers?.[header] ?? null;
	// (the case's key is in every URL: the same case's runs read alike)
	const result = {
		threw: got.result?.threw ?? (got.result ? null : 'no result'),
		...(got.result?.threw
			? {
					message: got.result.message,
					domException: got.result.domException,
				}
			: {}),
		...(got.result && 'value' in got.result ? { value: got.result.value } : {}),
		landed: !!got.landed,
		...(got.landed
			? {
					landedTop: got.landed.top,
					// (a frame's: see the header) as the document reads it
					// half a second in, and at its first script
					...(got.landed.top
						? {
								entry:
									got.top && typeof got.later?.length === 'number'
										? got.later.length - got.top.length
										: null,
								entryFirst:
									got.top && typeof got.landed.length === 'number'
										? got.landed.length - got.top.length
										: null,
							}
						: {}),
					referrer: got.landed.referrer,
					referer: pick('referer'),
					origin: pick('origin'),
					site: pick('sec-fetch-site'),
					mode: pick('sec-fetch-mode'),
					dest: pick('sec-fetch-dest'),
					user: pick('sec-fetch-user'),
				}
			: {}),
		// the resource timing entries the initiating document saw from its
		// call on (the proxy's announcement to its worker is none of them)
		entries: got.entries ?? null,
		console: messages
			.slice(mark)
			.filter((text) => ABOUT_NAVIGATION.test(text))
			.map((text) => text.trim())
			.sort(),
	};
	return JSON.parse(
		JSON.stringify(result).replaceAll(encodeURIComponent(key), '<k>'),
	);
}

const browser = await launch();
const answers = {};

// natively: each case's top in a tab of its own (a tab's history.length
// stops at 50), in a browser context of its own, four cases at once (each
// waits for its beacons, and a navigation that does not land is waited out)
step('native');
for (const name of NAMES) answers[name] = {};
await inPool(NAMES, 4, async (name) => {
	const messages = [];
	const page = await browser.newPage();
	page.on('console', (message) => messages.push(message.text()));
	answers[name].native = await runCase(
		name,
		`${RUN}-n-${NAMES.indexOf(name)}`,
		{
			open: (url) => page.goto(url).catch(() => {}),
			frames: () => page.frames(),
			messages,
			settle: () => 2500,
		},
	);
	await page.close();
});
ok(
	'natively: every case ran and reported',
	NAMES.every(
		(name) =>
			!answers[name].native.error && answers[name].native.threw !== 'no result',
	),
	JSON.stringify(
		NAMES.filter(
			(name) =>
				answers[name].native.error ||
				answers[name].native.threw === 'no result',
		),
	),
);
if (NAMES.includes('x top.read'))
	ok(
		"natively: a read of another origin's top.location.href throws SecurityError",
		answers['x top.read']?.native.threw === 'SecurityError',
		JSON.stringify(answers['x top.read']?.native),
	);

const proxiedFrames = (page) => () =>
	page
		.frames()
		.filter(
			(frame) =>
				/\/stomp\/[\w-]+\/html[/:]/.test(frame.url()) ||
				frame.url().startsWith('about:'),
		);

// both modes at once, each in demo pages of its own (contexts of their own)
async function runMode([mode, base]) {
	step(mode);
	const messages = [];
	let page = null;
	let first = true;
	// navigations that landed natively and not here: past two, the rest get
	// a shorter wait, so a mode that lands none fails in minutes, not by the
	// suite's timeout
	let misses = 0;
	for (const name of NAMES) {
		// a demo page of its own every few cases: its tabs share one session
		// history, which stops at 50 entries
		if (NAMES.indexOf(name) % 12 === 0) {
			await page?.close();
			page = await openDemo(browser, base);
			page.on('console', (message) => messages.push(message.text()));
			first = true;
		}
		const native = answers[name].native;
		const proxied = await runCase(
			name,
			`${RUN}-${mode[0]}-${NAMES.indexOf(name)}`,
			{
				open: async (url) => {
					if (first) await submitLanding(page, url);
					else await submitOmni(page, url);
					first = false;
				},
				frames: () => proxiedFrames(page)(),
				messages,
				// a navigation that lands natively may take a while here; one that
				// does not is given a few seconds to show it does not
				settle: (result) =>
					native.landed && result.threw === null
						? misses < 2
							? 30000
							: 8000
						: 5000,
			},
		);
		if (native.landed && !proxied.landed) misses++;
		answers[name][mode] = proxied;
		ok(
			`${mode}: ${name}: as natively`,
			JSON.stringify(proxied) === JSON.stringify(native),
			`native ${JSON.stringify(native)} proxied ${JSON.stringify(proxied)}`,
		);
	}
	await page.close();
}
await Promise.all(
	[
		['same-origin', PROXY],
		['isolated', HOST],
	].map(runMode),
);

if (process.env.TOP_NAV_DUMP)
	writeFileSync(process.env.TOP_NAV_DUMP, JSON.stringify(answers, null, '\t'));
await done(browser);
