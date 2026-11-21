// The address bar's Back, Forward and Reload buttons act on the active tab:
// Back and Forward step its history and grey out with nowhere to go, Back at
// the start of history stays in the tab (the navigation bar's goes home),
// and Reload reloads the page in place.
//
// While the tab loads, Reload is Chrome 157's Stop: Tango's process-stop
// picture, "Stop loading this page" for its tooltip and its name. A press
// ends the load where it got to, in the isolated host and the same-origin
// one: a document still arriving (a fixture that drips its body) keeps
// what it has and the request is given up at the origin, and a navigation
// still waiting for its answer never commits (the frame keeps its page,
// the bar its address). Escape stops a load from the page and from the
// toolbar; in the address bar it reverts an edit first. A load that ends
// while the pointer is pressed on Stop leaves Stop there, disabled: the
// release reloads nothing. A page's own navigation shows Stop from its
// start, before its answer comes, and Stop drops it. A navigation answered
// with a 204 or a download (the page's or the bar's) commits nothing: the
// tab keeps its page and Reload is back as the answer comes, not after a
// give-up time. All of it in the dialing mode too (just call stomp,
// ?mode=just-call-stomp), whose frames are never navigated. A load that
// ends with the keyboard's focus on Stop makes it Reload in that task,
// the focus kept on it.
import {
	activeFrame,
	done,
	FIXTURE,
	launch,
	ok,
	omni,
	onLanding,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const HOST = page.url();
const ONE = `${FIXTURE}pages/hist-1.html`;
const TWO = `${FIXTURE}pages/hist-2.html`;

const omniIs = (value) =>
	page
		.waitForFunction(
			(v) => document.querySelector('#omni input').value === v,
			value,
			{ timeout: 30000 },
		)
		.then(
			() => true,
			() => false,
		);
const disabled = () =>
	page.evaluate(() =>
		['toolBack', 'toolForward', 'toolReload'].map(
			(id) => document.getElementById(id).disabled,
		),
	);
// the buttons follow the frame's history on its load event: give it a moment
const settle = async (want) => {
	for (let i = 0; i < 40; i++) {
		const now = await disabled();
		if (JSON.stringify(now) === JSON.stringify(want)) return now;
		await sleep(250);
	}
	return disabled();
};

await submitLanding(page, ONE);
ok('the first page opens', await omniIs(ONE), await omni(page));
ok(
	'one page in: Back and Forward greyed out, Reload not',
	JSON.stringify(await settle([true, true, false])) === '[true,true,false]',
	JSON.stringify(await disabled()),
);

// the omnibox shows a typed URL at once, before the page is there; a second
// URL typed while the first navigation has not committed yet cancels it and
// leaves no entry for it, natively too (a loaded runner took over a second
// to commit hist-1), so the second page is typed once the first is shown
await waitActive(
	page,
	() => document.title === 'HIST 1' && document.readyState === 'complete',
);
await sleep(500);
await submitOmni(page, TWO);
ok('the second page opens', await omniIs(TWO), await omni(page));
ok(
	'two pages in: Back on, Forward greyed out',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

await page.click('#toolBack');
ok('Back goes to the first page', await omniIs(ONE), await omni(page));
ok(
	'at the first page: Back greyed out, Forward on',
	JSON.stringify(await settle([true, false, false])) === '[true,false,false]',
	JSON.stringify(await disabled()),
);

// a greyed-out Back neither leaves the tab nor walks the host page
await page.click('#toolBack', { force: true }).catch(() => {});
await sleep(800);
ok('Back at the start stays in the tab', !(await onLanding(page)));
ok('the demo page is still the top', page.url().startsWith(HOST), page.url());

await page.click('#toolForward');
ok('Forward goes to the second page', await omniIs(TWO), await omni(page));
ok(
	'Forward greyed out again at the end',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

// Reload: a mark left in the page is gone afterwards, the URL is the same
const frame = await waitActive(page, () => document.title === 'HIST 2');
await frame.evaluate(() => {
	window.__mark = 1;
});
await page.click('#toolReload');
let reloaded = false;
for (let i = 0; i < 80 && !reloaded; i++) {
	await sleep(250);
	const now = await waitActive(page, () => document.readyState === 'complete');
	reloaded = await now
		.evaluate(
			() => window.__mark === undefined && !!document.querySelector('h1'),
		)
		.catch(() => false);
}
ok('Reload reloads the page', reloaded);
ok(
	'the URL is unchanged after Reload',
	(await omni(page)) === TWO,
	await omni(page),
);
ok(
	'Reload adds no history entry',
	JSON.stringify(await settle([false, true, false])) === '[false,true,false]',
	JSON.stringify(await disabled()),
);

// ---- Stop -----------------------------------------------------------------

/** what the bar's Reload shows: its mode, names, picture and state */
const reloadLook = (view) =>
	view.evaluate(() => {
		const button = document.getElementById('toolReload');
		const shown = [...button.querySelectorAll('img')].filter(
			(img) => getComputedStyle(img).display !== 'none',
		);
		return {
			stop: button.classList.contains('stopping'),
			label: button.getAttribute('aria-label'),
			title: button.title,
			pictures: shown.map((img) =>
				new URL(img.currentSrc).pathname.split('/').pop(),
			),
			disabled: button.disabled,
			status: document.getElementById('chromeStatus').textContent,
		};
	});
const isStop = (look) =>
	look.stop &&
	look.label === 'Stop loading this page' &&
	look.title === 'Stop loading this page' &&
	look.pictures.length === 1 &&
	/^process-stop-(24|32)\.png$/.test(look.pictures[0]);
const isReload = (look) =>
	!look.stop &&
	look.label === 'Reload this page' &&
	look.title === 'Reload this page' &&
	look.pictures.length === 1 &&
	/^view-refresh-(24|32)\.png$/.test(look.pictures[0]);
async function lookUntil(view, test, timeout = 20000) {
	const until = Date.now() + timeout;
	let look = await reloadLook(view);
	while (!test(look) && Date.now() < until) {
		await sleep(100);
		look = await reloadLook(view);
	}
	return look;
}
/** the stop fixture's word on its request `key` (test/stream-server.mjs) */
const served = async (key) =>
	(await fetch(`${FIXTURE}stream/stop-log?k=${key}`)).json();
const release = (key) =>
	fetch(`${FIXTURE}stream/stop-release?k=${key}`, { method: 'POST' });
async function servedUntil(key, test, timeout = 20000) {
	const until = Date.now() + timeout;
	let log = await served(key);
	while (!test(log) && Date.now() < until) {
		await sleep(100);
		log = await served(key);
	}
	return log;
}
/**
 * `fn` in the active frame's document (the page's own world), or undefined:
 * a read of a frame that is between documents can wait for the next one
 * to load, so each gives up after a second
 */
async function inFrame(view, fn, arg) {
	const frame = await activeFrame(view);
	if (!frame) return undefined;
	return Promise.race([
		frame.evaluate(fn, arg).catch(() => undefined),
		sleep(1000),
	]);
}
async function frameUntil(view, fn, arg, timeout = 20000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		if (await inFrame(view, fn, arg)) return true;
		await sleep(100);
	}
	return false;
}
/** the stop fixture's document of request `key` shows its early part */
const early = (key) => document.getElementById('early')?.dataset.k === key;
const pageState = async (view) =>
	(await inFrame(view, () => ({
		title: document.title,
		readyState: document.readyState,
		early: !!document.getElementById('early'),
		late: !!document.getElementById('late'),
		mark: window.__stopMark ?? null,
	}))) ?? {};
/**
 * the stop fixture's requests are known by their key in the run's process,
 * whose fixture a second run of the suite meets again: each run's keys are
 * its own, so a request is never read for the last run's
 */
const RUN = Math.random().toString(36).slice(2, 8);
const markPage = (view, mark) =>
	inFrame(
		view,
		(value) => {
			window.__stopMark = value;
		},
		mark,
	);

async function stopChecks(view, mode) {
	const run = `${RUN}-${mode}`;
	const drip = (key, query) => `${FIXTURE}stream/stop?${query}&k=${run}-${key}`;
	// a document that is still arriving: Stop keeps what it has (its end is
	// held at the origin until the suite lets it go, after the Stop)
	const committed = drip('body', 'hold=late');
	await submitOmni(view, committed);
	await frameUntil(view, early, `${run}-body`);
	const loading = await lookUntil(view, isStop);
	ok(
		`${mode}: while the page loads, Reload is Stop (picture, tooltip and name)`,
		isStop(loading) && !loading.disabled,
		JSON.stringify(loading),
	);
	await markPage(view, 'body');
	await view.click('#toolReload');
	const after = await reloadLook(view);
	ok(
		`${mode}: a press on Stop turns it back into Reload at once, under the pointer`,
		isReload(after) && !after.disabled && after.status !== 'Loading…',
		JSON.stringify(after),
	);
	const given = await servedUntil(`${run}-body`, (log) => log?.closed);
	ok(
		`${mode}: Stop gives the document's request up at the origin`,
		given?.closed === true && given.ended === false,
		JSON.stringify(given),
	);
	// the end, if the origin still had the request: it never reaches the page
	await release(`${run}-body`);
	await frameUntil(view, () => !!document.getElementById('late'), null, 3000);
	const partial = await pageState(view);
	ok(
		`${mode}: the stopped page keeps what it had, complete, and nothing more arrives`,
		partial.early &&
			!partial.late &&
			partial.readyState === 'complete' &&
			partial.mark === 'body',
		JSON.stringify(partial),
	);
	const stayed = await reloadLook(view);
	ok(
		`${mode}: Reload stays Reload after the stop`,
		isReload(stayed) && stayed.status !== 'Loading…',
		JSON.stringify(stayed),
	);

	// a navigation still waiting for its answer (held at the origin): Stop
	// drops it
	const pending = drip('head', 'hold&wait=8000');
	await submitOmni(view, pending);
	const waiting = await lookUntil(view, isStop);
	ok(
		`${mode}: Reload is Stop from the start of a navigation`,
		isStop(waiting) && (await omni(view)) === pending,
		JSON.stringify(waiting),
	);
	await servedUntil(`${run}-head`, (log) => log?.asked);
	await sleep(500);
	await view.click('#toolReload');
	const dropped = await reloadLook(view);
	ok(
		`${mode}: Stop before the answer: Reload again, and the bar has the page's address back`,
		isReload(dropped) && (await omni(view)) === committed,
		JSON.stringify([dropped, await omni(view)]),
	);
	// the answer comes after the Stop, its end 8 s after its head
	await release(`${run}-head`);
	const cut = await servedUntil(`${run}-head`, (log) => log?.closed);
	ok(
		// (a request whose answer has not started cannot be taken back over
		// the transport: its answer is cancelled as it comes, as on a page's
		// abort)
		`${mode}: the stopped navigation's request is given up at the origin, its body never read`,
		cut?.closed === true && cut.ended === false,
		JSON.stringify(cut),
	);
	await sleep(2000);
	const kept = await pageState(view);
	ok(
		`${mode}: the stopped navigation never commits: the tab keeps its page`,
		kept.mark === 'body' &&
			kept.title === 'stream stop' &&
			(await omni(view)) === committed,
		JSON.stringify([kept, await omni(view)]),
	);
	const idle = await reloadLook(view);
	ok(`${mode}: and Reload stays Reload`, isReload(idle), JSON.stringify(idle));

	// stopped before the controller sent it, and the moment the frame was
	// sent (its src set), before its request reached the worker
	for (const when of ['unsent', 'sent']) {
		const instant = drip(when, 'head=300&wait=8000');
		await view.evaluate(
			([url, sent, dialing]) => {
				const press = () => document.getElementById('toolReload').click();
				if (sent) {
					const frame = document.querySelector('.frame:not(.hidden)');
					const watch = new MutationObserver(() => {
						watch.disconnect();
						press();
					});
					// (dialing: the frame of the call page goes in beside it)
					if (dialing) watch.observe(frame.parentNode, { childList: true });
					else
						watch.observe(frame, {
							attributes: true,
							attributeFilter: ['src'],
						});
				}
				const form = document.getElementById('omni');
				form.url.value = url;
				form.requestSubmit();
				if (!sent) press();
			},
			[instant, when === 'sent', mode.startsWith('dialing')],
		);
		await sleep(3000);
		// a request that reached the origin: until it is given up there (on
		// its answer's head) or its end is sent
		const instantLog = (await served(`${run}-${when}`))
			? await servedUntil(`${run}-${when}`, (log) => log.closed || log.ended)
			: null;
		const notCommitted = await pageState(view);
		ok(
			`${mode}: a navigation stopped ${when === 'sent' ? 'as the frame is sent' : 'before it is sent'} never commits either`,
			notCommitted.mark === 'body' &&
				(await omni(view)) === committed &&
				isReload(await reloadLook(view)) &&
				instantLog?.ended !== true,
			JSON.stringify([notCommitted, instantLog, await omni(view)]),
		);
	}

	// Escape from the page (the navigation gives it the focus)
	await submitOmni(view, drip('escape', 'hold=late'));
	await frameUntil(view, early, `${run}-escape`);
	await markPage(view, 'escape');
	await lookUntil(view, isStop);
	const focused = await view.evaluate(
		() => document.activeElement?.classList.contains('frame') ?? false,
	);
	await view.keyboard.press('Escape');
	const escaped = await lookUntil(view, isReload);
	const escapedLog = await servedUntil(`${run}-escape`, (log) => log?.closed);
	const escapedPage = await pageState(view);
	await release(`${run}-escape`);
	ok(
		`${mode}: Escape in the page stops its load`,
		focused &&
			isReload(escaped) &&
			escapedLog?.closed === true &&
			escapedPage.early &&
			!escapedPage.late &&
			escapedPage.mark === 'escape',
		JSON.stringify([focused, escaped, escapedLog, escapedPage]),
	);
}

/**
 * a page's own navigation, and navigations answered with a 204 or a
 * download: from the page's link and from the bar
 */
async function answerChecks(view, mode) {
	const run = `${RUN}-${mode}`;
	const linkPage = async (key, to) => {
		const url = `${FIXTURE}stream/link?to=${encodeURIComponent(to)}&k=${run}-${key}`;
		await submitOmni(view, url);
		await frameUntil(
			view,
			(k) => document.getElementById('go')?.dataset.k === k,
			`${run}-${key}`,
		);
		await markPage(view, key);
		await lookUntil(view, isReload);
		return url;
	};
	// (the page's own click: a click of Playwright's waits for the commit)
	const follow = async () =>
		(await activeFrame(view)).evaluate(() =>
			document.getElementById('go').click(),
		);

	// Hold the response until Stop is pressed. A fixed delay can elapse
	// before Playwright samples the button on a busy runner.
	const slow = `/stream/stop?hold&wait=1000&k=${run}-link`;
	const linkUrl = await linkPage('link', slow);
	await follow();
	const leaving = await lookUntil(view, isStop);
	const before = await servedUntil(`${run}-link`, (log) => log?.asked);
	ok(
		`${mode}: a page's own navigation shows Stop from its start, before its answer`,
		isStop(leaving) && before?.headers === false,
		JSON.stringify([leaving, before]),
	);
	if (isStop(leaving)) await view.click('#toolReload');
	const linkStopped = await reloadLook(view);
	await release(`${run}-link`);
	await servedUntil(`${run}-link`, (log) => log?.closed || log?.ended);
	await sleep(500);
	const linkKept = await pageState(view);
	ok(
		`${mode}: Stop drops the page's navigation: Reload again, and the tab keeps its page`,
		isReload(linkStopped) &&
			isReload(await reloadLook(view)) &&
			linkKept.mark === 'link' &&
			linkKept.title === 'stream link' &&
			(await omni(view)) === linkUrl,
		JSON.stringify([linkStopped, linkKept, await omni(view)]),
	);

	// answered with no document: the page's link, then the bar
	for (const answer of ['nothing', 'download']) {
		const what = answer === 'nothing' ? 'a 204' : 'a download';
		const key = `${run}-${answer}`;
		const to = `/stream/stop?hold&answer=${answer}&k=${key}`;
		const pageUrl = await linkPage(answer, to);
		await follow();
		const going = await lookUntil(view, isStop);
		const asked = await servedUntil(key, (log) => log?.asked);
		const saved =
			answer === 'download'
				? view.waitForEvent('download', { timeout: 20000 }).catch(() => null)
				: null;
		await release(key);
		const back = await lookUntil(view, isReload);
		const download = await saved;
		const stayedPage = await pageState(view);
		ok(
			`${mode}: a page's link answered with ${what}: Stop, then Reload as the answer comes, and the tab keeps its page`,
			isStop(going) &&
				asked?.headers === false &&
				isReload(back) &&
				stayedPage.mark === answer &&
				stayedPage.title === 'stream link' &&
				(await omni(view)) === pageUrl &&
				(answer === 'nothing' || download?.suggestedFilename() === 'stop.bin'),
			JSON.stringify([
				going,
				asked,
				back,
				stayedPage,
				await omni(view),
				download?.suggestedFilename() ?? null,
			]),
		);

		const typedKey = `${run}-typed-${answer}`;
		const typed = `${FIXTURE}stream/stop?hold&answer=${answer}&k=${typedKey}`;
		await submitOmni(view, typed);
		const typedGoing = await lookUntil(view, isStop);
		const typedAsked = await servedUntil(typedKey, (log) => log?.asked);
		const typedSaved =
			answer === 'download'
				? view.waitForEvent('download', { timeout: 20000 }).catch(() => null)
				: null;
		await release(typedKey);
		const typedBack = await lookUntil(view, isReload);
		const typedDownload = await typedSaved;
		const typedPage = await pageState(view);
		ok(
			`${mode}: the bar's navigation answered with ${what}: Reload as the answer comes, and the bar has the page's address back`,
			isStop(typedGoing) &&
				typedAsked?.headers === false &&
				isReload(typedBack) &&
				typedPage.mark === answer &&
				(await omni(view)) === pageUrl &&
				(answer === 'nothing' ||
					typedDownload?.suggestedFilename() === 'stop.bin'),
			JSON.stringify([
				typedGoing,
				typedAsked,
				typedBack,
				typedPage,
				await omni(view),
				typedDownload?.suggestedFilename() ?? null,
			]),
		);
	}
}

await stopChecks(page, 'isolated');
await answerChecks(page, 'isolated');

// Escape on the toolbar, and in the address bar after its edit is reverted
// (both held at the origin until they are stopped)
await submitOmni(page, `${FIXTURE}stream/stop?hold&wait=100&k=${RUN}-bar`);
await lookUntil(page, isStop);
await page.focus('#toolSaved');
await page.keyboard.press('Escape');
const fromToolbar = await lookUntil(page, isReload);
ok(
	'Escape with the focus on the toolbar stops the load',
	isReload(fromToolbar),
	JSON.stringify(fromToolbar),
);
const stayedOn = await omni(page);
const typed = `${FIXTURE}stream/stop?hold&wait=100&k=${RUN}-omnibox`;
await submitOmni(page, typed);
await lookUntil(page, isStop);
await page.click('#omni input');
await page.keyboard.press('Control+A');
await page.keyboard.type('an edit');
// (the suggestions' list, if it opened, closes on the first Escape)
for (let i = 0; i < 3 && (await omni(page)) === 'an edit'; i++)
	await page.keyboard.press('Escape');
const reverted = {
	value: await omni(page),
	look: await reloadLook(page),
	focused: await page.evaluate(
		() => document.activeElement === document.querySelector('#omni input'),
	),
};
ok(
	'Escape in the address bar reverts its edit first and stops nothing',
	reverted.value === typed && isStop(reverted.look) && reverted.focused,
	JSON.stringify(reverted),
);
await page.keyboard.press('Escape');
const fromBar = await lookUntil(page, isReload);
ok(
	'then Escape there stops the load, and the bar has the page it stayed on',
	isReload(fromBar) && (await omni(page)) === stayedOn,
	JSON.stringify([fromBar, await omni(page)]),
);
await release(`${RUN}-bar`);
await release(`${RUN}-omnibox`);

// a load that ends while the pointer is pressed on Stop: Stop stays,
// disabled, and the release reloads nothing (the load's end held at the
// origin until the pointer is down)
await submitOmni(page, `${FIXTURE}stream/stop?hold=late&k=${RUN}-held`);
await frameUntil(page, early, `${RUN}-held`);
await markPage(page, 'held');
await lookUntil(page, isStop);
const box = await page.locator('#toolReload').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await release(`${RUN}-held`);
await frameUntil(page, () => !!document.getElementById('late'), null, 20000);
await sleep(300);
const held = await reloadLook(page);
await page.mouse.up();
await sleep(1500);
const heldPage = await pageState(page);
ok(
	'a load that ends with the pointer pressed on Stop leaves Stop there, disabled, and the release reloads nothing',
	isStop(held) && held.disabled && heldPage.mark === 'held',
	JSON.stringify([held, heldPage]),
);
await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
const left = await lookUntil(page, (look) => isReload(look) && !look.disabled);
ok(
	'the pointer leaving it makes it Reload again',
	isReload(left) && !left.disabled,
	JSON.stringify(left),
);

// a load that ends with the keyboard's focus on Stop, the pointer on it
// too: Reload in that same task, never held, and the focus stays on it
// (a disabled button would leave it on the page's body)
await submitOmni(page, `${FIXTURE}stream/stop?hold=late&k=${RUN}-focus`);
await frameUntil(page, early, `${RUN}-focus`);
await lookUntil(page, isStop);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.focus('#toolReload');
await page.evaluate(() => {
	const button = document.getElementById('toolReload');
	window.__reloadFocus = [];
	// (an observer's records are read in the task that made the change)
	new MutationObserver(() =>
		window.__reloadFocus.push({
			stop: button.classList.contains('stopping'),
			disabled: button.disabled,
			focused: document.activeElement === button,
		}),
	).observe(button, { attributes: true });
});
await release(`${RUN}-focus`);
await frameUntil(page, () => !!document.getElementById('late'), null, 20000);
await sleep(300);
const kept = {
	look: await reloadLook(page),
	focused: await page.evaluate(
		() => document.activeElement === document.getElementById('toolReload'),
	),
	seen: await page.evaluate(() => window.__reloadFocus),
};
ok(
	'a load that ends with the focus on Stop makes it Reload in that task, the focus kept on it',
	isReload(kept.look) &&
		!kept.look.disabled &&
		kept.focused &&
		kept.seen.some((seen) => !seen.stop) &&
		kept.seen.every((seen) => !seen.disabled && seen.focused),
	JSON.stringify(kept),
);
await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);

// the same-origin host (Frame, not RemoteFrame), on the origin the isolated
// host's proxy was
const errors = [...page.errors];
await page.close();
const same = await openDemo(browser, PROXY);
await submitLanding(same, ONE);
await waitActive(same, () => document.title === 'HIST 1');
await stopChecks(same, 'same-origin');
await answerChecks(same, 'same-origin');

// dialing (just call stomp): the host writes each document into a frame of
// the call page, and Stop gives up a dial before or while it is answered
const sameErrors = [...same.errors];
await same.close();
const dialing = await openDemo(browser, `${HOST}?nopool&mode=just-call-stomp`);
await submitLanding(dialing, ONE);
await waitActive(dialing, () => document.title === 'HIST 1');
await stopChecks(dialing, 'dialing');
await answerChecks(dialing, 'dialing');
const dialingErrors = [...dialing.errors];
await dialing.close();

// the same on the content slots (test/run.mjs STOMP_SLOT_PORTS): each
// document's call page is its site's slot's, whose worker the host reaches
// through the slot's agent (a call's token, its Stop)
let slotErrors = [];
if (process.env.CONTENT_SLOT_PORTS) {
	const slotted = await openDemo(browser, `${HOST}?mode=just-call-stomp`);
	await submitLanding(slotted, ONE);
	await waitActive(slotted, () => document.title === 'HIST 1');
	ok(
		'dialing on slots: the tab is on a content slot',
		await slotted.evaluate(
			() =>
				window.controller.siteMode &&
				window.controller.siteOrigins.includes(
					new URL(document.querySelector('#browser .frame:not(.hidden)').src)
						.origin,
				),
		),
	);
	await stopChecks(slotted, 'dialing-slots');
	await answerChecks(slotted, 'dialing-slots');
	slotErrors = slotted.errors;
}

await done(browser, [
	...errors,
	...sameErrors,
	...dialingErrors,
	...slotErrors,
]);
