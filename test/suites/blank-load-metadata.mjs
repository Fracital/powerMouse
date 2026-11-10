// A load the proxy copies for a document no service worker controls (an
// about:blank frame the page builds) goes out with the Sec-Fetch-Dest and
// Sec-Fetch-Mode of the load it stands for, not those of the fetch that
// copies it (`empty`, `cors`): an image, a script, a stylesheet's @import,
// background and font; and an <embed>'s and an <object>'s resource, which
// the proxy copies in every document. Both modes, each request compared with the page
// loaded natively (Sec-Fetch-Site too). The header that says so is the
// proxy's: a page's fetch that sends it with a navigation's values goes out
// as the fetch it is, without it, and the host's request rules match it as
// that fetch: a rule that edits headers sees the real destination only, a
// rule that blocks sees the load named too.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/blank-load-metadata.html`;
const KINDS = [
	'img',
	'script',
	'import',
	'bg',
	'font',
	'embed',
	'object',
	'spoof',
];

/** each load's metadata as the fixture saw it, once the page is done */
async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		if (
			await getFrame()
				?.evaluate(() => window.__blankMeta)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	const seen = {};
	for (const kind of KINDS) {
		const headers = await (
			await fetch(`${FIXTURE}echo-headers/recorded?k=blm-${kind}`)
		).json();
		seen[kind] = headers && {
			dest: headers['sec-fetch-dest'] ?? null,
			mode: headers['sec-fetch-mode'] ?? null,
			site: headers['sec-fetch-site'] ?? null,
		};
		if (seen[kind]) seen[kind].tag = headers['x-stomp-load'] ?? null;
	}
	return seen;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every load arrived',
	KINDS.every((kind) => native[kind]),
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// a rule that adds a header to images, and one that blocks one image
	const run = `-${mode}-${Date.now()}`;
	await page.evaluate(
		(rules) => window.controller.setRules(rules),
		[
			{
				match: {
					url: `*://*:*/echo-headers?k=blm-blocked${run}`,
					destination: ['image'],
				},
				action: 'block',
			},
			{
				match: { destination: ['image'] },
				action: { requestHeaders: { 'x-image-rule': '1' } },
			},
		],
	);
	await submitLanding(page, `${PAGE}?run=${encodeURIComponent(run)}`);
	const proxied = await measure(() => frameOf(page));
	const keyed = async (key) =>
		(await fetch(`${FIXTURE}echo-headers/recorded?k=${key}${run}`)).json();
	const realImage = await keyed('blm-realimg');
	const claimed = await keyed('blm-claim');
	const blocked = await keyed('blm-blocked');
	ok(
		`${mode}: a header rule for images applies to the page's own image`,
		realImage?.['x-image-rule'] === '1',
		JSON.stringify(realImage?.['x-image-rule'] ?? null),
	);
	ok(
		`${mode}: a page's fetch claiming to be an image does not get the image rule's header`,
		!!claimed && claimed['x-image-rule'] === undefined,
		JSON.stringify(claimed && { rule: claimed['x-image-rule'] ?? null }),
	);
	ok(
		`${mode}: a block rule for images blocks an image copied for the uncontrolled frame`,
		blocked === null,
		JSON.stringify(blocked && 'arrived'),
	);
	// a page's fetch claiming an embed's navigation is the fetch it is: the
	// page's own requests never carry the proxy's load header (the inject
	// drops it, so a page cannot pass for one of the proxy's copies), and
	// the worker answers it as a fetch (the site's body as it came, no
	// Sec-Fetch-User, no wait for a navigation's hint)
	const embedClaim = await keyed('blm-embedclaim');
	const claimSeen = await frameOf(page)
		?.evaluate(() => window.__embedClaim ?? null)
		.catch(() => null);
	ok(
		`${mode}: a page's fetch claiming an embed's navigation goes out as the fetch it is, and is answered as one`,
		embedClaim?.['sec-fetch-dest'] === 'empty' &&
			embedClaim?.['sec-fetch-mode'] === 'cors' &&
			embedClaim?.['sec-fetch-user'] === undefined &&
			embedClaim?.['x-stomp-load'] === undefined &&
			claimSeen?.json === true &&
			/json/.test(claimSeen?.type ?? '') &&
			claimSeen?.ms < 2000,
		JSON.stringify({
			dest: embedClaim?.['sec-fetch-dest'],
			mode: embedClaim?.['sec-fetch-mode'],
			user: embedClaim?.['sec-fetch-user'] ?? null,
			page: claimSeen,
		}),
	);
	await page.evaluate(() => window.controller.setRules([]));
	const metadata = ({ dest, mode, site } = {}) => ({ dest, mode, site });
	for (const kind of KINDS.filter((kind) => kind !== 'spoof'))
		ok(
			`${mode}: a copied ${kind} load: Sec-Fetch-Dest, -Mode and -Site as natively`,
			JSON.stringify(metadata(proxied[kind])) ===
				JSON.stringify(metadata(native[kind])),
			`native ${JSON.stringify(native[kind])} proxied ${JSON.stringify(proxied[kind])}`,
		);
	// the proxy owns the header: it is never forwarded, and a navigation's
	// values in it are not taken
	ok(
		`${mode}: a page's fetch naming a navigation in the load header goes out as its own fetch, the header dropped`,
		JSON.stringify(metadata(proxied.spoof)) ===
			JSON.stringify(metadata(native.spoof)) && proxied.spoof?.tag === null,
		`native ${JSON.stringify(native.spoof)} proxied ${JSON.stringify(proxied.spoof)}`,
	);
	await page.close();
}

await done(browser);
