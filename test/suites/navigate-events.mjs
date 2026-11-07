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
		// the controller dispatches the same reports, with the frame
		window.__controllerNav = [];
		window.__open = [];
		window.controller.addEventListener('navigate', (event) =>
			window.__controllerNav.push(event.detail),
		);
		window.controller.addEventListener('open', (event) =>
			window.__open.push(event.detail.url),
		);
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		frame.addEventListener('navigate', (event) =>
			window.__nav.push(event.detail),
		);
		await frame.go(`${fixture}pages/walk-1.html`);
		// go() resolved: the first report is in
		window.__goReports = window.__nav.length;
	}, FIXTURE);
	await sleep(2000);
	let frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	await frame.evaluate(() => document.getElementById('next').click());
	await sleep(2000);
	const reloaded = await page.evaluate(async () => {
		const frame = window.controller.frames.at(-1);
		const before = window.__nav.length;
		const result = await frame.reload();
		return { result, reported: window.__nav.length > before };
	});
	await sleep(500);
	frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
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
	ok(
		`${mode}: go() resolves after the first report`,
		(await page.evaluate(() => window.__goReports)) >= 1,
		String(await page.evaluate(() => window.__goReports)),
	);
	ok(
		`${mode}: reload() resolves true once the reloaded page reported`,
		reloaded.result === true && reloaded.reported === true,
		JSON.stringify(reloaded),
	);
	const controllerEvents = await page.evaluate(() => ({
		count: window.__controllerNav.length,
		frames: window.__nav.length,
		sameFrame: window.__controllerNav.every(
			(detail) => detail.frame === window.controller.frames.at(-1),
		),
		urls: window.__controllerNav.map((detail) => detail.info.url),
	}));
	ok(
		`${mode}: the controller dispatches every navigate report with its frame`,
		controllerEvents.count === controllerEvents.frames &&
			controllerEvents.count >= 3 &&
			controllerEvents.sameFrame,
		JSON.stringify(controllerEvents),
	);
	// a new tab asked of the host: the controller dispatches `open` too (the
	// demo's onOpen then opens its own tab, so this comes last)
	frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	await frame.evaluate(
		(fixture) => window.open(`${fixture}pages/walk-3.html`),
		FIXTURE,
	);
	await sleep(1000);
	const opened = await page.evaluate(() => window.__open);
	ok(
		`${mode}: the controller dispatches open for a new tab`,
		opened.includes(`${FIXTURE}pages/walk-3.html`),
		JSON.stringify(opened),
	);
	await page.close();
}

await done(browser);
