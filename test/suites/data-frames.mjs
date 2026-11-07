// A data: frame is its own opaque origin "null", as the browser makes it,
// while it runs proxied: its fetch goes through the proxy, its messages reach
// the page with origin "null", and neither side reaches the other's
// document. A message the page aims at its own origin does not reach it; one
// for "*" does. Both demo modes.
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
const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/data-frame.html`);
	let data = null;
	for (let i = 0; i < 40 && !data?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__data).catch(() => null);
			if (value) data = value;
		}
	}
	data ||= {};
	const ready = data.fromChild?.find((m) => m.kind === 'ready');
	const echoes = (data.fromChild ?? []).filter((m) => m.kind === 'echo');
	ok(
		`${mode}: the data: frame fetches through the proxy and its message arrives with origin "null"`,
		ready?.fetched === true && ready?.origin === 'null',
		JSON.stringify(ready),
	);
	ok(
		`${mode}: inside, the frame is the opaque origin it is`,
		ready?.origin === 'null' &&
			ready?.locationOrigin === 'null' &&
			ready?.href === 'data:text/html,' &&
			ready?.domain === '',
		JSON.stringify(ready),
	);
	ok(
		`${mode}: neither side reaches the other's document`,
		data.contentDocument === 'null' &&
			data.childDocument === 'SecurityError' &&
			ready?.parentDocument === 'SecurityError' &&
			ready?.topDocument === 'SecurityError' &&
			data.src === 'data:text/html,',
		JSON.stringify([data.contentDocument, data.childDocument, ready, data.src]),
	);
	ok(
		`${mode}: a message for "*" reaches the frame, one aimed at the page's origin does not`,
		echoes.length === 1 && echoes[0].got === 'star',
		JSON.stringify(echoes),
	);
	errors.push(...page.errors.map((e) => `${mode}: ${e}`));
	await page.close();
}
await done(browser, errors);
