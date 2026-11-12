// navigator.keyboard.getLayoutMap() resolves in a proxied document, as it
// does for a top-level page natively (twitch and its ad frames read the
// keyboard layout at load). Chrome rejects it with a SecurityError outside
// the outermost main frame unless the keyboard-map permission policy is
// delegated, and every proxied document is a frame: an isolated deployment's
// is cross-origin, where the browser denies keyboard-map, so without the
// inject's shim the call throws the SecurityError a top-level page never
// sees. The shim resolves instead (the real layout where the browser still
// gives it, an empty map where it refuses), so the page never sees the
// throw. Compared with the page loaded natively, in both demo modes.
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
const PAGE = `${FIXTURE}pages/keyboard-layout.html`;

async function read(frame) {
	for (let i = 0; i < 80; i++) {
		const value = await frame()
			?.evaluate(() => window.__keyboard)
			.catch(() => null);
		if (value?.done) return value;
		await sleep(250);
	}
	return null;
}

// natively, a top-level page reads the keyboard layout
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await read(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively, getLayoutMap resolves at the top level',
	native?.resolved === true && typeof native.size === 'number',
	JSON.stringify(native),
);

// the proxied page: the routed frame the host itself holds
const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await read(() => frameOf(page));
	ok(
		`${mode}: the proxied page's getLayoutMap resolves, never the SecurityError`,
		proxied?.resolved === true && typeof proxied.size === 'number',
		JSON.stringify(proxied),
	);
	await page.close();
}

await done(browser);
