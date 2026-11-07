// A page's own history calls stay inside its frame: history.back() at the
// frame's first entry does nothing (as on a top-level page) instead of
// walking the joint session history out to the host, history.length counts
// the frame's entries, and go() past either end is a no-op. A page that
// reopens its document (document.open) keeps the window hooks: the host's
// messages are still filtered (isolated) or unwrapped (same-origin) and its
// title is still reported.
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
		// the host has an entry before the current one, so a traversal that
		// leaves the frame is visible as a change of the host URL
		history.replaceState(null, '', '?before');
		history.pushState(null, '', location.pathname);
		window.__nav = [];
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		frame.addEventListener('navigate', (event) =>
			window.__nav.push(event.detail),
		);
		window.__el = element;
		window.__frame = frame;
		await frame.go(`${fixture}pages/hist-1.html`);
	}, FIXTURE);
	await sleep(2000);
	const newest = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const hostStays = () => page.url().split('#')[0] === base;
	const title = async () => {
		try {
			return await newest().title();
		} catch (error) {
			return `error ${error.message.slice(0, 40)}`;
		}
	};
	const state = async () => `host ${page.url()} frame ${await title()}`;

	await newest().evaluate(() => history.back());
	await sleep(1500);
	ok(
		`${mode}: history.back() at the frame's first entry stays put`,
		hostStays() && (await title()) === 'HIST 1',
		await state(),
	);
	const length1 = await newest().evaluate(() => history.length);
	ok(
		`${mode}: history.length counts the frame's own entries (1)`,
		length1 === 1,
		`length ${length1}`,
	);

	await newest().evaluate(() => document.getElementById('next').click());
	await sleep(1500);
	ok(`${mode}: the link navigates the frame`, (await title()) === 'HIST 2');
	const length2 = await newest().evaluate(() => history.length);
	ok(
		`${mode}: history.length counts the frame's own entries (2)`,
		length2 === 2,
		`length ${length2}`,
	);

	await newest().evaluate(() => history.back());
	await sleep(1500);
	ok(
		`${mode}: history.back() returns to the frame's previous page`,
		hostStays() && (await title()) === 'HIST 1',
		await state(),
	);

	await newest().evaluate(() => history.go(-5));
	await sleep(1500);
	ok(
		`${mode}: history.go() past the first entry stays put`,
		hostStays() && (await title()) === 'HIST 1',
		await state(),
	);

	await newest().evaluate(() => history.forward());
	await sleep(1500);
	ok(
		`${mode}: history.forward() steps the frame's own entry`,
		hostStays() && (await title()) === 'HIST 2',
		await state(),
	);

	await page.evaluate(
		(fixture) => window.__frame.go(`${fixture}pages/reopen.html`),
		FIXTURE,
	);
	await sleep(2500);
	await page.evaluate(() =>
		window.__el.contentWindow.postMessage('from-host', '*'),
	);
	await sleep(500);
	const messages = await newest().evaluate(() => window.__msgs || null);
	// isolated: the host is a foreign window, the filter drops its message.
	// same-origin: the host shares the origin and its call runs the frame's
	// own postMessage, so the message looks like the page's and arrives; the
	// tagger (also a window listener) must still unwrap the envelope
	if (mode === 'isolated')
		ok(
			`${mode}: a host message never reaches a page that reopened its document`,
			Array.isArray(messages) && messages.length === 0,
			JSON.stringify(messages),
		);
	else
		ok(
			`${mode}: a message to a page that reopened its document is still unwrapped`,
			JSON.stringify(messages) === '["from-host"]',
			JSON.stringify(messages),
		);
	const titles = await page.evaluate(() => window.__nav.map((e) => e.title));
	ok(
		`${mode}: the reopened document's title is still reported`,
		titles.includes('REOPENED'),
		JSON.stringify(titles),
	);
	await page.close();
}
await done(browser);
