// A URL property set before the attribute that makes it a load
// (property-order.html): `link.href` and then `link.rel = 'stylesheet'`, as
// YouTube's player loads www-player.css. What each element holds and whether
// the sheet applies are compared with the page loaded natively, in both demo
// modes. Before, the href setter wrote the native getter's reading back into
// the attribute when no hook had taken the value yet: the page's relative URL
// resolved against the document's real URL, the proxy's, so the rel that
// came next loaded the sheet from the proxy origin (refused, 403) and the
// player never built.
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

const target = `${FIXTURE}pages/property-order.html`;
const read = () => (window.__po?.done ? window.__po.cases : null);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 40 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read);
}
await nativePage.close();
ok(
	'natively, the late rel loads the sheet',
	native?.['href before rel']?.event === 'load' &&
		native['href before rel'].color === 'rgb(4, 5, 6)',
	JSON.stringify(native?.['href before rel']),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// a slow runner can take more than ten seconds to show the frame
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		proxied = await frame?.evaluate(read).catch(() => null);
	}
	ok(`${mode}: the page finishes through the proxy`, !!proxied);
	for (const name of Object.keys(native ?? {})) {
		const a = JSON.stringify(native[name]);
		const b = JSON.stringify(proxied?.[name]);
		ok(
			`${mode}: ${name} holds and loads as natively`,
			a === b,
			a === b ? a.slice(0, 160) : `native ${a} proxied ${b}`,
		);
	}
	await page.close();
}
await done(browser);
