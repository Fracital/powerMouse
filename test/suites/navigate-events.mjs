// A frame reports where its page is: a `navigate` event on the Frame (same
// origin) and on the RemoteFrame (isolated), with url, title and whether the
// frame's own history can step, on load, after an in-frame link and after
// a pushState with a title change. No polling involved.
import { done, FIXTURE, HOST, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await browser.newPage();
	await page.goto(base);
	await page.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	await page.evaluate(async (fixture) => {
		window.__nav = [];
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		frame.addEventListener('navigate', (event) =>
			window.__nav.push(event.detail),
		);
		await frame.go(`${fixture}pages/walk-1.html`);
	}, FIXTURE);
	await sleep(2000);
	let frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	await frame.evaluate(() => document.getElementById('next').click());
	await sleep(2000);
	frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	await frame.evaluate(() => {
		history.pushState(null, '', 'walk-9.html');
		document.title = 'PUSHED';
	});
	await sleep(1000);
	const events = await page.evaluate(() => window.__nav);
	const seen = events.map((e) => `${e.url.split('/').pop()} ${e.title}`);
	ok(
		`${mode}: load, link and pushState each report once`,
		JSON.stringify([...new Set(seen)]) ===
			JSON.stringify([
				'walk-1.html WALK 1',
				'walk-2.html WALK 2',
				'walk-9.html PUSHED',
			]),
		JSON.stringify(seen),
	);
	ok(
		`${mode}: the last report knows the frame can go back`,
		events.at(-1)?.canGoBack === true && events.at(-1)?.canGoForward === false,
		JSON.stringify(events.at(-1)),
	);
	ok(
		`${mode}: the frame keeps the last report as its title`,
		(await page.evaluate(() => window.controller.frames.at(-1).title)) ===
			'PUSHED',
		String(await page.evaluate(() => window.controller.frames.at(-1).title)),
	);
	await page.close();
}

await done(browser);
