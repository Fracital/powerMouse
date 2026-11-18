// A script written into a new frame's initial about:blank document (which no
// service worker controls) is copied through the synchronous bridge, whose
// answer rides in cookies. One far larger than Chrome keeps cookies for (an
// ad quality script of 735 KB in washingtonpost.com's ad frames) never
// arrived whole: the write held the page's thread for the copy's whole 5 s
// limit, the script never ran, and the cookies set for it pushed the proxy
// origin's own cookies out of the jar; a page's own synchronous request for
// such a body spun to the bridge's 30 s limit and failed. Now the worker
// keeps such a body and the page reads it in parts. Compared with the same
// page loaded natively; both demo modes.
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

const target = (run) => `${FIXTURE}pages/sync-large-answer.html?run=${run}`;

async function report(page) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__large)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target('native'));
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, both scripts of the written frame run, in order',
	JSON.stringify(native?.ran) === JSON.stringify(['big', 'after']),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// a cookie of the proxy origin's own (the host's, in same-origin mode)
	const proxyFrame = () =>
		mode === 'same-origin' ? page.mainFrame() : page.frames().at(-1);
	await page.evaluate(() => {
		document.cookie = 'host-keeps=1; path=/';
	});
	await submitLanding(page, target(`${mode}-${Date.now()}`));
	const proxied = await report(page);
	ok(
		`${mode}: both scripts of the written frame run, in order`,
		JSON.stringify(proxied?.ran) === JSON.stringify(native?.ran),
		JSON.stringify({ native, proxied }),
	);
	for (const [name, what] of [
		['text', 'a text whose characters fall on every part boundary'],
		['image', "an image's bytes"],
	])
		ok(
			`${mode}: a synchronous request reads ${what} in full`,
			proxied?.[name] === native?.[name] && native?.[name]?.startsWith('200 '),
			JSON.stringify({ native: native?.[name], proxied: proxied?.[name] }),
		);
	// natively the write returns at once (the parser waits, not the page);
	// the copy of a script this size takes a fetch and a rewrite, never the
	// bridge's whole limit
	ok(
		`${mode}: the write holds the page's thread well under the copy's 5 s limit`,
		proxied !== null && proxied.writeMs < 3500,
		JSON.stringify({ native: native?.writeMs, proxied: proxied?.writeMs }),
	);
	if (mode === 'same-origin') {
		const cookies = await proxyFrame().evaluate(() => document.cookie);
		ok(
			"same-origin: the host's own cookie is still in the jar",
			cookies.includes('host-keeps=1'),
			`${cookies.split('; ').length} cookies`,
		);
	}
	await page.close();
}

await done(browser);
