// The demo end to end: landing, a proxied page, the address bar, Back, Home,
// and a reload that restores the proxied page from the URL fragment.
import { execFileSync } from 'node:child_process';
import {
	activeFrame,
	done,
	launch,
	ok,
	omni,
	openDemo,
	screenshot,
	sleep,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

ok(
	'landing ready',
	(await page.textContent('#logMsg')) === 'Ready',
	await page.textContent('#logMsg'),
);
ok(
	'uptime shown',
	/\d+ hours, \d+ minutes/.test(await page.textContent('#uptime')),
	await page.textContent('#uptime'),
);
ok('quick links rendered', (await page.$$('.btn-fancy')).length === 4);
// the commits panel
await page
	.waitForFunction(
		() =>
			document.querySelectorAll('#commitList li').length > 0 ||
			document.getElementById('commitsNote').textContent.trim() !==
				'Loading commits from GitHub',
		null,
		{ timeout: 20000 },
	)
	.catch(() => {});
const commits = await page.evaluate(() => ({
	items: document.querySelectorAll('#commitList li').length,
	note: document.getElementById('commitsNote').textContent.trim(),
	shas: [...document.querySelectorAll('.commitSha')].map((c) => c.textContent),
}));
const fit = () =>
	page.evaluate(() => {
		const list = document.getElementById('commitList');
		const shown = [...list.children].filter(
			(li) => !li.classList.contains('hidden'),
		);
		const bottom = list.getBoundingClientRect().bottom;
		return {
			shown: shown.length,
			hidden: list.children.length - shown.length,
			overflow: list.scrollHeight - list.clientHeight,
			cut: shown.filter((li) => li.getBoundingClientRect().bottom > bottom + 1)
				.length,
			lastMarked: shown.length
				? shown[shown.length - 1].classList.contains('last')
				: null,
		};
	});
// the server answers from its own checkout's git log, so GitHub's rate
// limit (60 an hour per address) never empties the list
const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
	encoding: 'utf8',
}).trim();
ok(
	"latest commits shown from the checkout's git log, newest first",
	commits.items > 0 &&
		commits.shas.every((sha) => /^[0-9a-f]{7}$/.test(sha)) &&
		commits.shas[0] === head,
	JSON.stringify({ head, ...commits }),
);
if (commits.items > 0) {
	const fitted = await fit();
	ok(
		'the commit list shows whole rows only, with no scrollbar',
		fitted.shown > 0 &&
			fitted.overflow <= 0 &&
			fitted.cut === 0 &&
			fitted.lastMarked,
		JSON.stringify(fitted),
	);
}
await screenshot(page, 'landing');

await page.fill('#mainForm input[name=url]', 'en.wikipedia.org/wiki/Web_proxy');
await page.click('#mainForm button');
await waitActive(
	page,
	() => document.querySelector('#firstHeading')?.textContent?.length > 0,
);
ok(
	'browser view shown',
	!(await page.$eval('#browser', (e) => e.classList.contains('hidden'))),
);
await sleep(1500);
ok(
	'omnibox shows real url',
	(await omni(page)).startsWith('https://en.wikipedia.org/wiki/'),
	await omni(page),
);
ok(
	'hash tracks url',
	decodeURIComponent(
		await page.evaluate(() => location.hash.slice(1)),
	).startsWith('https://en.wikipedia.org/wiki/'),
);
await screenshot(page, 'browsing');

// click a link inside the frame, then Back
const start = await omni(page);
const frame = await activeFrame(page);
await frame.evaluate((from) => {
	const a = [...document.links].find(
		(x) =>
			/^https:\/\/en\.wikipedia\.org\/wiki\/[^:#?]+$/.test(x.href) &&
			x.href !== from.split('#')[0] &&
			!/Main_Page/.test(x.href),
	);
	a.click();
}, start);
await page.waitForFunction(
	(b) => document.querySelector('#omni input').value !== b,
	start,
	{ timeout: 30000 },
);
const after = await omni(page);
ok(
	'in-frame link updates omnibox',
	after.startsWith('https://en.wikipedia.org/wiki/'),
	after,
);
await page.click('#back');
await page
	.waitForFunction(
		(b) => document.querySelector('#omni input').value === b,
		start,
		{ timeout: 30000 },
	)
	.then(
		() => ok('back button', true),
		(error) => ok('back button', false, error.message),
	);

await submitOmni(page, 'example.com');
await waitActive(page, () => document.title === 'Example Domain').then(
	() => ok('omnibox navigation', true),
	(error) => ok('omnibox navigation', false, error.message),
);
await page.click('#home');
ok(
	'home shows landing',
	!(await page.$eval('#landing', (e) => e.classList.contains('hidden'))),
);

// a reload restores the proxied page from the fragment
await page.fill('#mainForm input[name=url]', 'example.org');
await page.click('#mainForm button');
await page.waitForFunction(() => location.hash.length > 1, null, {
	timeout: 30000,
});
await page.reload();
await waitActive(page, () => document.title === 'Example Domain').then(
	() => ok('reload restores proxied page', true),
	(error) => ok('reload restores proxied page', false, error.message),
);

await page.setViewportSize({ width: 390, height: 800 });
await page.click('#home');
await sleep(300);
if (commits.items > 0) {
	const fitted = await fit();
	ok(
		'on a phone the commit list refits to whole rows, with no scrollbar',
		fitted.shown > 0 &&
			fitted.overflow <= 0 &&
			fitted.cut === 0 &&
			fitted.lastMarked,
		JSON.stringify(fitted),
	);
}
await screenshot(page, 'mobile');

await done(browser, page.errors.filter((e) => !e.includes('404')).slice(0, 5));
