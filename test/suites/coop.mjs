// Cross-Origin-Opener-Policy, natively and through the proxy
// (test/pages/coop.js on the fixture's /coi/doc). A popup whose policy
// does not match its opener's top-level document's is put in a browsing
// context group of its own: the opener's window of it reads as closed, has
// no frames and takes no message, and the popup has no opener. The browser
// cannot do it for proxied pages (every proxied site is one origin to it,
// and the proxied top is a frame of the host's tab, whose policy is the
// host's), so the inject does it from the policies the worker saw. Every
// row (the opener's policy, the popup's, the popup's site, a popup that
// goes on to a page with a policy, a popup opened by a frame) is compared
// with the same pages loaded natively. Same-origin mode, with a controller
// that has no onOpen (the browser opens the popups).
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const SAME = FIXTURE.replace(/\/$/, '');
const CROSS = SAME.replace('127.0.0.1', 'localhost');
const doc = (origin, policy, query) => {
	const url = new URL(`${origin}/coi/doc`);
	url.searchParams.set('script', '/pages/coop.js');
	if (policy)
		url.searchParams.append('h', `cross-origin-opener-policy:${policy}`);
	for (const [key, value] of Object.entries(query))
		url.searchParams.set(key, value);
	return url.href;
};
// [name, opener's policy, popup's policy, popup's origin, more]
const ROWS = [
	['none opens same-origin', '', 'same-origin', SAME],
	['none opens same-origin of another site', '', 'same-origin', CROSS],
	['none opens same-origin-allow-popups', '', 'same-origin-allow-popups', SAME],
	['none opens noopener-allow-popups', '', 'noopener-allow-popups', SAME],
	['none opens none of another site', '', '', CROSS],
	['same-origin opens none', 'same-origin', '', SAME],
	['same-origin opens same-origin', 'same-origin', 'same-origin', SAME],
	[
		'same-origin opens same-origin of another site',
		'same-origin',
		'same-origin',
		CROSS,
	],
	[
		'same-origin-allow-popups opens none of another site',
		'same-origin-allow-popups',
		'',
		CROSS,
	],
	[
		'same-origin-allow-popups opens same-origin-allow-popups',
		'same-origin-allow-popups',
		'same-origin-allow-popups',
		SAME,
	],
	[
		'same-origin-allow-popups opens it of another site',
		'same-origin-allow-popups',
		'same-origin-allow-popups',
		CROSS,
	],
	['noopener-allow-popups opens none', 'noopener-allow-popups', '', SAME],
	[
		'none opens none that goes on to same-origin',
		'',
		'',
		CROSS,
		{ next: 'same-origin' },
	],
	[
		'a frame with same-origin opens none',
		'',
		'',
		SAME,
		{ frame: 'same-origin' },
	],
	[
		'a frame of a same-origin top opens none of another site',
		'same-origin',
		'',
		CROSS,
		{ frame: '' },
	],
	[
		'a frame of another site in a same-origin top opens none',
		'same-origin',
		'',
		CROSS,
		{ frame: '', childOrigin: CROSS },
	],
	[
		'a frame of another site in a same-origin-allow-popups top opens none',
		'same-origin-allow-popups',
		'',
		CROSS,
		{ frame: '', childOrigin: CROSS },
	],
	[
		'same-origin-allow-popups opens same-origin',
		'same-origin-allow-popups',
		'same-origin',
		SAME,
	],
];
const openers = ROWS.map(([, opener, popup, origin, more = {}], row) => {
	const next =
		more.next !== undefined
			? doc(origin, more.next, {
					role: 'popup',
					row: String(row),
				})
			: null;
	const u = doc(origin, popup, {
		role: 'popup',
		row: String(row),
		...(next ? { next } : {}),
	});
	return doc(SAME, opener, {
		role: 'opener',
		row: String(row),
		u,
		...(more.frame !== undefined ? { frame: '1', child: more.frame } : {}),
		...(more.childOrigin ? { childOrigin: more.childOrigin } : {}),
	});
});

/** every row's opener and popup reports, from every page of `context` */
async function collect(context) {
	const rows = ROWS.map(() => ({}));
	for (let i = 0; i < 100; i++) {
		await sleep(300);
		for (const page of context.pages())
			for (const frame of page.frames()) {
				const found = await frame
					.evaluate(() => ({
						opener: window.__coop,
						popup: window.__coopPopup,
					}))
					.catch(() => null);
				if (found?.opener?.row !== undefined && found.opener.done)
					rows[Number(found.opener.row)].opener = found.opener;
				// the popup's last page
				if (found?.popup?.row !== undefined && found.popup.page === 'last')
					rows[Number(found.popup.row)].popup = found.popup;
			}
		if (rows.every((row) => row.opener && row.popup)) break;
	}
	return rows;
}

const browser = await launch();
const nativeContext = await browser.newContext();
await Promise.all(
	openers.map(async (url) => (await nativeContext.newPage()).goto(url)),
);
const native = await collect(nativeContext);
await nativeContext.close();
ok(
	'natively, every row ran',
	native.every((row) => row.opener && row.popup),
	JSON.stringify(native),
);

const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (urls) => {
	const config = window.STOMP_CONFIG || {};
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: {
			module: config.testTransport
				? '/test/mixed-transport.mjs'
				: '/epoxy/index.mjs',
			options: [
				{
					wisp:
						config.wisp || `${location.origin.replace(/^http/, 'ws')}/wisp/`,
				},
			],
		},
		directory: window.controller.directory.pathname,
		codec: 'xor',
	});
	await controller.wait();
	await Promise.all(
		urls.map((url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 200px; height: 150px';
			document.body.append(element);
			return controller.createFrame(element).go(url);
		}),
	);
}, openers);
const proxied = await collect(context);
for (const [row, [name]] of ROWS.entries()) {
	const shown = (value) =>
		JSON.stringify({
			opener: value?.opener && {
				opened: value.opener.opened,
				first: value.opener.first,
				last: value.opener.last,
			},
			popup: value?.popup && {
				opener: value.popup.opener,
				name: value.popup.name,
				messages: value.popup.messages,
			},
		});
	ok(
		`${name}: what the opener and the popup keep of each other, as natively`,
		shown(proxied[row]) === shown(native[row]),
		`native ${shown(native[row])} proxied ${shown(proxied[row])}`,
	);
}
await done(browser, errors);
