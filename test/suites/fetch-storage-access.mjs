// Sec-Fetch-Storage-Access (Chrome 133+): a request that may carry
// credentials and whose site for cookies is another site than its top's
// (a cross-site image, fetch with credentials, frame navigation, and a
// cross-site frame's requests to its own origin) says whether it has
// unpartitioned cookie access, and with Chrome's default cookie settings
// it has: `active`. A first-party request and one without credentials get
// none. Proxied, the header was missing on every request: Google's sign-in
// page loads its gstatic resources and its CheckConnection frame that way.
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

const KINDS = [
	'image',
	'fetch-include',
	'fetch-omit',
	'fetch-no-cors',
	'own',
	'frame',
	'nested-own',
];
const PAGE = `${FIXTURE}pages/fetch-storage-access.html`;
const stamp = Date.now().toString(36);

/** what each kind's request carried, once every one has arrived */
async function measure(run) {
	let seen = {};
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		seen = {};
		for (const kind of KINDS)
			seen[kind] = await fetch(
				`${FIXTURE}echo-headers/recorded?k=fsa${run}-${kind}`,
			).then((response) => response.json());
		if (KINDS.every((kind) => seen[kind])) break;
	}
	return Object.fromEntries(
		KINDS.map((kind) => [
			kind,
			seen[kind]
				? (seen[kind]['sec-fetch-storage-access'] ?? 'absent')
				: 'not requested',
		]),
	);
}

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${PAGE}?run=${stamp}n`);
const native = await measure(`${stamp}n`);
ok(
	'natively the cross-site requests with credentials have storage access',
	native.image === 'active' &&
		native['fetch-include'] === 'active' &&
		native.frame === 'active' &&
		native.own === 'absent' &&
		native['fetch-omit'] === 'absent',
	JSON.stringify(native),
);

const page = await openDemo(browser, PROXY);
await submitLanding(page, `${PAGE}?run=${stamp}p`);
const proxied = await measure(`${stamp}p`);
for (const kind of KINDS)
	ok(
		`${kind}: Sec-Fetch-Storage-Access is the native one`,
		proxied[kind] === native[kind],
		`${proxied[kind]} vs ${native[kind]}`,
	);
await done(browser, page.errors);
