// Own methods and accessors on an element (instance-overrides.html): OneTrust's
// OtAutoBlock, which discord.com runs, gives the scripts it creates an own
// setAttribute and own src and type accessors that write through the hooked
// setAttribute. The hooks swap an element's prototype while they work, but an
// own property shadows any prototype, so the setAttribute hook called the
// page's own setAttribute, which called the hook again until the stack
// overflowed ("Maximum call stack size exceeded" on every script OneTrust
// made). Each case's result is compared with the page loaded natively, in
// both demo modes.
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

const target = `${FIXTURE}pages/instance-overrides.html`;
const read = () => (window.__io?.done ? window.__io.cases : null);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await nativePage.evaluate(read);
await nativePage.close();
ok(
	'natively, every case runs without throwing',
	native !== null &&
		Object.values(native).every((value) => !String(value).startsWith('threw')),
	JSON.stringify(native),
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
			`${mode}: ${name} reads as natively`,
			a === b,
			a === b ? a.slice(0, 160) : `native ${a} proxied ${b}`,
		);
	}
	ok(
		`${mode}: no page error`,
		page.errors.length === 0,
		page.errors.join(' | ').slice(0, 300),
	);
	await page.close();
}
await done(browser);
