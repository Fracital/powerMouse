// The demo dials by default (docs/dialing.md): with no address of its own
// asking, on the host's origin and on localhost (whose classic tabs were
// the isolated mode), the page's controller dials on the server's neutral
// scope, and after a typed address and a link every frame of the page is
// the call page to the browser: each iframe's src (the host realm's
// getAttribute, AGENTS.md Verification 4) and each frame's real location
// (Playwright's frame.url()), the top's address a token (`?N`).
//
// Where the browser lacks the Navigation API (removed here before the
// page's first script), justCallStomp() would throw NotSupportedError: the
// page shows its tabs the classic way instead and says so (the status
// line, About's Dialing row), and a typed address loads, never a blank tab.
/* global JUST_CALL, DIRECTORY, badgeFacts */
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
	waitActive,
} from '../lib.mjs';

const config = await (await fetch(`${PROXY}config.js`)).text();
const DIAL = JSON.parse(
	/window\.STOMP_CONFIG = (.*);\s*$/s.exec(config)[1],
).dial;
const CALL_PATH = `${DIAL.directory}${DIAL.page}`;
const PAGE = `${FIXTURE}pages/walk-1.html`;

/** the host realm's view of every iframe's src, and the browser's of every frame below the top */
const urls = async (page) => ({
	srcs: await page.evaluate(() =>
		[...document.querySelectorAll('iframe')]
			.map((element) => Element.prototype.getAttribute.call(element, 'src'))
			.filter((src) => src !== null),
	),
	frames: page
		.frames()
		.slice(1)
		.map((frame) => frame.url()),
	top: page.url(),
});

const browser = await launch();
const errors = [];

for (const [mode, base] of [
	['same-origin', PROXY],
	['localhost', HOST],
]) {
	const page = await openDemo(browser, base);
	const origin = new URL(base).origin;
	const call = `${origin}${CALL_PATH}`;
	const facts = await page.evaluate(() => ({
		dialing: JUST_CALL,
		directory: DIRECTORY,
		status: document.getElementById('logMsg').textContent,
		about: badgeFacts.get('Dialing') ?? null,
	}));
	ok(
		`${mode}: the page dials by default, on the server's neutral scope`,
		facts.dialing === true &&
			facts.directory === DIAL.directory &&
			!/stomp/i.test(facts.directory) &&
			facts.status === 'Ready' &&
			/^on\b/.test(facts.about ?? ''),
		JSON.stringify(facts),
	);
	await submitLanding(page, PAGE);
	const first = await waitActive(page, () => document.title === 'WALK 1').catch(
		() => null,
	);
	ok(`${mode}: a typed address loads`, !!first);
	const typed = await urls(page);
	ok(
		`${mode}: every frame is the call page and the top a token`,
		typed.srcs.length > 0 &&
			typed.srcs.every((src) => src === call) &&
			typed.frames.length > 0 &&
			typed.frames.every((url) => url === call) &&
			/^\?\d+$/.test(new URL(typed.top).search),
		JSON.stringify(typed),
	);
	await first?.evaluate(() => document.getElementById('next').click());
	const second = await waitActive(
		page,
		() => document.title === 'WALK 2',
	).catch(() => null);
	// (the frame the link left goes once the next one shows)
	await sleep(500);
	const linked = await urls(page);
	ok(
		`${mode}: after a link the frames are still the call page alone`,
		!!second &&
			linked.srcs.every((src) => src === call) &&
			linked.frames.every((url) => url === call) &&
			new URL(linked.top).search !== new URL(typed.top).search,
		JSON.stringify(linked),
	);
	errors.push(...page.errors);
	await page.close();
}

// no Navigation API: the classic tabs, said so
{
	const page = await openDemo(browser, PROXY, {}, (page) =>
		page.addInitScript(() => {
			delete window.navigation;
			delete Window.prototype.navigation;
			delete window.NavigateEvent;
		}),
	);
	const facts = await page.evaluate(() => ({
		navigation: 'navigation' in window,
		dialing: JUST_CALL,
		directory: DIRECTORY,
		status: document.getElementById('logMsg').textContent,
		about: badgeFacts.get('Dialing') ?? null,
	}));
	ok(
		'without the Navigation API the page shows classic tabs and says why',
		facts.navigation === false &&
			facts.dialing === false &&
			facts.directory === '/stomp/' &&
			/^Ready \(classic tabs: .*Navigation API/.test(facts.status) &&
			/^off \(.*Navigation API/.test(facts.about ?? ''),
		JSON.stringify(facts),
	);
	await submitLanding(page, PAGE);
	const frame = await waitActive(page, () => document.title === 'WALK 1').catch(
		() => null,
	);
	const shown = await urls(page);
	ok(
		'without the Navigation API a typed address loads in its classic frame',
		!!frame &&
			shown.frames.some((url) =>
				url.startsWith(`${new URL(PROXY).origin}/stomp/`),
			),
		JSON.stringify(shown),
	);
	errors.push(...page.errors);
	await page.close();
}

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
