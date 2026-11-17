// A cookie may be named as any of Object.prototype's members (constructor,
// toString, __proto__, valueOf, ...): Chrome keeps it, from a Set-Cookie
// header and from document.cookie, and sends it back. The jar dropped them
// until the parser it used (set-cookie-parser, which refused every name
// `in {}`) was replaced. Compared with the page loaded natively, in both
// modes: document.cookie and the Cookie header the site receives.
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

const target = `${FIXTURE}pages/cookie-names.html`;
const browser = await launch();

const answer = (frame) =>
	frame.evaluate(() => (window.__names?.done ? window.__names : null));

const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native; i++) {
	await sleep(100);
	native = await answer(nativePage.mainFrame()).catch(() => null);
}
await nativeContext.close();
ok(
	'natively, the page reports its cookies',
	native !== null && native.document.includes('constructor=js'),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext();
	const page = await openDemo(context, base);
	await submitLanding(page, target);
	let proxied = null;
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url()))
				proxied ??= await answer(frame).catch(() => null);
	}
	ok(
		`${mode}: document.cookie holds the cookies it holds natively`,
		proxied?.document === native?.document,
		JSON.stringify({ native: native?.document, proxied: proxied?.document }),
	);
	ok(
		`${mode}: the site receives the cookies it receives natively`,
		proxied?.sent === native?.sent,
		JSON.stringify({ native: native?.sent, proxied: proxied?.sent }),
	);
	await context.close();
}
await done(browser);
