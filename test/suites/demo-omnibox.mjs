// The demo's address bars (src/omnibox/ through demo/public/pm/main.js) and
// window.controller.suggest(), in both controller modes:
//  - the box is a combobox naming its listbox; typing shows the default row
//    and the matching bookmark at once, and the engine's completions come
//    250 ms after the last keystroke, only for two characters or more, for
//    the engine the demo searches with;
//  - the keys: the arrows move the highlight (aria-activedescendant,
//    aria-selected) and go round the ends through "nothing", Tab fills the
//    box, Escape closes, Enter with nothing highlighted submits as before;
//  - an answer for older text is dropped: new text aborts the request in
//    flight before the next one starts;
//  - the open tabs: "Switch to tab" rows in the top box (not the tab on
//    show) and on the landing (every tab), picked with Enter and a click,
//    and no new tab;
//  - the empty box's picks open on a click, not when the page focuses it;
//  - while the list is open the top box's bottom corners are square and the
//    list hangs flush from it, at 1280, 390 and 320 px;
//  - window.controller.suggest() asks the endpoint through the transport with
//    Chrome's fields and no cookie of a proxied page, parses an OpenSearch
//    answer, and rejects when its signal aborts.
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

const A = `${FIXTURE}pages/bookmark-a.html`;
const B = `${FIXTURE}pages/bookmark-b.html`;
const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, arg, timeout = 30000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(100);
	}
	return value;
}

/**
 * The engine's completions, played by the page: each call is recorded with
 * when it came and whether its signal aborted; `plan[text]` says how long
 * the answer takes and what it is (by default `<text> one`, `<text> two`)
 */
const stubSuggest = (page) =>
	page.evaluate(() => {
		window.__asked = [];
		window.__plan = {};
		window.__typedAt = 0;
		for (const input of document.querySelectorAll('input[name=url]'))
			input.addEventListener('input', () => {
				window.__typedAt = performance.now();
			});
		window.controller.suggest = (text, options = {}) => {
			const call = {
				text,
				engine: options.engine,
				at: performance.now(),
				typedAt: window.__typedAt,
				abortedAt: null,
			};
			window.__asked.push(call);
			options.signal?.addEventListener('abort', () => {
				call.abortedAt = performance.now();
			});
			const plan = window.__plan[text] ?? {
				ms: 0,
				list: [`${text} one`, `${text} two`],
			};
			return new Promise((resolve) =>
				setTimeout(() => resolve(plan.list), plan.ms),
			);
		};
	});

/** the box of `form` and its list as the page has them */
const boxState = (page, form) =>
	page.evaluate((form) => {
		const input = document.querySelector(`#${form} input[name=url]`);
		const list = document.getElementById(input.getAttribute('aria-controls'));
		const options = [...(list?.querySelectorAll('[role=option]') ?? [])];
		return {
			role: input.getAttribute('role'),
			autocomplete: input.getAttribute('aria-autocomplete'),
			expanded: input.getAttribute('aria-expanded'),
			active: input.getAttribute('aria-activedescendant'),
			listRole: list?.getAttribute('role'),
			value: input.value,
			focused: document.activeElement === input,
			// each row as "<title> :: <hint>"
			rows: options.map(
				(o) =>
					`${o.querySelector('.omnibox-text').firstChild.textContent} :: ${o.querySelector('.omnibox-hint')?.textContent ?? ''}`,
			),
			ids: options.map((o) => o.id),
			selected: options.findIndex(
				(o) => o.getAttribute('aria-selected') === 'true',
			),
			heads: [...(list?.querySelectorAll('.omnibox-head') ?? [])].map(
				(h) => h.textContent,
			),
		};
	}, form);

const press = async (page, key) => {
	await page.keyboard.press(key);
	await sleep(30);
};

/** the browser view on the newest tab, its page loaded */
async function opened(page, url) {
	await submitLanding(page, url);
	await until(
		page,
		(url) =>
			!document.getElementById('browser').classList.contains('hidden') &&
			document.querySelector('#omni input').value === url,
		Boolean,
		url,
	);
}

/** back to the landing (the home button), its box focused by the page */
async function home(page) {
	await page.click('#home');
	await until(
		page,
		() => !document.getElementById('landing').classList.contains('hidden'),
		Boolean,
	);
	await sleep(300);
}

const tabCount = (page) =>
	page.evaluate(() => document.querySelectorAll('#frames iframe').length);

for (const [mode, base] of [
	['isolated', HOST],
	['same-origin', PROXY],
]) {
	const page = await openDemo(browser, base);
	await until(
		page,
		() =>
			!!document.querySelector('#mainForm .suggestions') &&
			!!document.querySelector('#omni .suggestions'),
		Boolean,
	);
	await stubSuggest(page);

	// ---- ARIA, local rows at once, completions after the pause ------------------
	let state = await boxState(page, 'mainForm');
	ok(
		`${mode}: the landing box is a combobox naming its listbox, closed`,
		state.role === 'combobox' &&
			state.autocomplete === 'list' &&
			state.listRole === 'listbox' &&
			state.expanded === 'false' &&
			state.rows.length === 0,
		JSON.stringify(state),
	);
	await page.focus('#mainForm input[name=url]');
	await page.keyboard.type('r');
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: one character shows the default row and the bookmark at once`,
		state.expanded === 'true' &&
			state.rows[0] === 'Search Brave for "r" :: Search' &&
			state.rows.some((row) => row.startsWith('Reddit')),
		JSON.stringify(state.rows),
	);
	await page.keyboard.type('ed', { delay: 30 });
	await until(
		page,
		() => document.querySelector('#mainForm .suggestions').textContent,
		(text) => text?.includes('red one'),
	);
	const asked = await page.evaluate(() => window.__asked);
	const last = asked.at(-1);
	ok(
		`${mode}: the completions are asked 250 ms after the last keystroke, for two characters or more, of the demo's engine`,
		last?.text === 'red' &&
			last.engine === 'https://search.brave.com/search?q=%s' &&
			last.at - last.typedAt >= 245 &&
			asked.every((call) => call.text.length >= 2),
		JSON.stringify(asked),
	);
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: the completions are rows under their header, after the bookmark`,
		state.heads.includes('Search suggestions') &&
			state.heads.includes('Sites') &&
			state.rows.includes('red one :: Search') &&
			state.rows.includes('red two :: Search'),
		JSON.stringify(state),
	);

	// ---- keys -------------------------------------------------------------------
	const n = state.rows.length;
	await press(page, 'ArrowDown');
	const first = await boxState(page, 'mainForm');
	await press(page, 'ArrowUp');
	const none = await boxState(page, 'mainForm');
	await press(page, 'ArrowUp');
	const lastRow = await boxState(page, 'mainForm');
	await press(page, 'ArrowDown');
	const wrapped = await boxState(page, 'mainForm');
	ok(
		`${mode}: the arrows move the highlight and go round the ends through nothing`,
		first.selected === 0 &&
			first.active === first.ids[0] &&
			none.selected === -1 &&
			none.active === null &&
			lastRow.selected === n - 1 &&
			lastRow.active === lastRow.ids[n - 1] &&
			wrapped.selected === -1 &&
			wrapped.focused,
		JSON.stringify(
			[first, none, lastRow, wrapped].map((s) => [s.selected, s.active]),
		),
	);
	await press(page, 'ArrowUp');
	await press(page, 'Tab');
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: Tab fills the box with the highlighted row's text and keeps the focus`,
		state.value === 'red two' && state.focused && state.selected === -1,
		JSON.stringify(state),
	);
	await press(page, 'Escape');
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: Escape closes the list and keeps the text and the focus`,
		state.expanded === 'false' &&
			state.rows.length === 0 &&
			state.value === 'red two' &&
			state.focused,
		JSON.stringify(state),
	);

	// ---- a late answer is dropped -------------------------------------------------
	await page.evaluate(() => {
		window.__plan.late = { ms: 1500, list: ['late answer'] };
		window.__plan.later = { ms: 0, list: ['later answer'] };
	});
	await page.fill('#mainForm input[name=url]', '');
	await page.keyboard.type('late');
	// its request in flight
	await until(
		page,
		() => window.__asked.some((call) => call.text === 'late'),
		Boolean,
	);
	await page.keyboard.type('r');
	await until(
		page,
		() => document.querySelector('#mainForm .suggestions').textContent,
		(text) => text?.includes('later answer'),
	);
	await sleep(1800);
	state = await boxState(page, 'mainForm');
	const calls = await page.evaluate(() => window.__asked);
	const lateCall = calls.find((call) => call.text === 'late');
	const laterCall = calls.find((call) => call.text === 'later');
	ok(
		`${mode}: new text aborts the request in flight, and its late answer is dropped`,
		state.rows.includes('later answer :: Search') &&
			!state.rows.some((row) => row.includes('late answer')) &&
			lateCall?.abortedAt !== null &&
			laterCall &&
			lateCall.abortedAt <= laterCall.at,
		JSON.stringify({ rows: state.rows, calls }),
	);

	// ---- Enter with nothing highlighted submits, as before ---------------------------
	await page.fill('#mainForm input[name=url]', A);
	await press(page, 'Enter');
	await until(
		page,
		(url) => document.querySelector('#omni input').value === url,
		Boolean,
		A,
	);
	ok(
		`${mode}: Enter with nothing highlighted opens what was typed`,
		(await tabCount(page)) === 1,
		String(await tabCount(page)),
	);
	await home(page);
	await opened(page, B);
	ok(`${mode}: two tabs`, (await tabCount(page)) === 2);
	// (recorded once the tab's page reports, after the address bar shows it)
	const kept = await until(
		page,
		() =>
			JSON.parse(localStorage.getItem('omnibox:visits') ?? '[]').map(
				(visit) => visit.url,
			),
		(urls) => urls?.includes(B),
	);
	ok(
		`${mode}: the pages the tabs reached are in the history`,
		kept.includes(A) && kept.includes(B),
		JSON.stringify(kept),
	);

	// ---- switch to tab: the top box -------------------------------------------------
	await page.click('#omni input[name=url]', { position: { x: 30, y: 10 } });
	await until(
		page,
		() => document.querySelector('#omni input').getAttribute('aria-expanded'),
		(expanded) => expanded === 'true',
	);
	state = await boxState(page, 'omni');
	ok(
		`${mode}: a click in the empty top box opens the picks, the other tab among them`,
		state.expanded === 'true' &&
			state.rows.some((row) => row.startsWith('Bookmark A')) &&
			!state.rows.some((row) => row.startsWith('Bookmark B')),
		JSON.stringify(state),
	);
	await page.keyboard.press('Control+A');
	await page.keyboard.type('bookmark');
	// (the completions too: they come last, and the indexes stay)
	await until(
		page,
		() => document.querySelector('#omni .suggestions').textContent,
		(text) => text?.includes('bookmark one'),
	);
	state = await boxState(page, 'omni');
	const switchRow = state.rows.findIndex(
		(row) => row.startsWith('Bookmark A') && row.endsWith('Switch to tab'),
	);
	ok(
		`${mode}: the top box shows the other tab to switch to, not the one on show`,
		switchRow > 0 &&
			state.heads.includes('Open tabs') &&
			!state.rows.some(
				(row) => row.startsWith('Bookmark B') && row.endsWith('Switch to tab'),
			),
		JSON.stringify(state),
	);
	for (let i = 0; i <= switchRow; i++) await press(page, 'ArrowDown');
	await press(page, 'Enter');
	await until(
		page,
		(url) => document.querySelector('#omni input').value === url,
		Boolean,
		A,
	);
	ok(
		`${mode}: Enter on Switch to tab shows that tab, and opens none`,
		(await page.evaluate(() => document.querySelector('#omni input').value)) ===
			A && (await tabCount(page)) === 2,
		String(await tabCount(page)),
	);

	// ---- switch to tab: the landing ---------------------------------------------------
	await home(page);
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: the landing focused by the page opens no list`,
		state.focused && state.expanded === 'false',
		JSON.stringify(state),
	);
	await page.keyboard.type('bookmark b');
	state = await boxState(page, 'mainForm');
	ok(
		`${mode}: the landing shows every open tab to switch to`,
		state.rows.some(
			(row) => row.startsWith('Bookmark B') && row.endsWith('Switch to tab'),
		),
		JSON.stringify(state.rows),
	);
	await page
		.locator('#mainForm .suggestions [role=option]')
		.filter({ hasText: 'Bookmark B' })
		.filter({ hasText: 'Switch to tab' })
		.click();
	await until(
		page,
		(url) =>
			!document.getElementById('browser').classList.contains('hidden') &&
			document.querySelector('#omni input').value === url,
		Boolean,
		B,
	);
	ok(
		`${mode}: clicking Switch to tab on the landing shows that tab, and opens none`,
		(await page.evaluate(() => document.querySelector('#omni input').value)) ===
			B && (await tabCount(page)) === 2,
	);

	// ---- the open list's look: square bottom corners, flush ------------------------------
	for (const width of [1280, 390, 320]) {
		await page.setViewportSize({ width, height: 760 });
		await sleep(200);
		await page.focus('#omni input[name=url]');
		await page.keyboard.press('Control+A');
		await page.keyboard.type('book');
		await until(
			page,
			() => document.querySelector('#omni input').getAttribute('aria-expanded'),
			(expanded) => expanded === 'true',
		);
		const look = await page.evaluate(() => {
			const input = document.querySelector('#omni input');
			const list = document.querySelector('#omni .suggestions');
			const a = input.getBoundingClientRect();
			const b = list.getBoundingClientRect();
			const style = getComputedStyle(input);
			return {
				radii: [style.borderBottomLeftRadius, style.borderBottomRightRadius],
				top: [style.borderTopLeftRadius, style.borderTopRightRadius],
				gap: Math.abs(b.top - a.bottom),
				left: Math.abs(b.left - a.left),
				right: Math.abs(b.right - a.right),
				scroll: document.documentElement.scrollWidth - innerWidth,
			};
		});
		await press(page, 'Escape');
		const closed = await page.evaluate(() => {
			const style = getComputedStyle(document.querySelector('#omni input'));
			return style.borderBottomLeftRadius;
		});
		ok(
			`${mode} at ${width}px: the open list squares the top box's bottom corners and hangs flush from it`,
			look.radii.every((r) => r === '0px') &&
				look.top.every((r) => r !== '0px') &&
				look.gap <= 1 &&
				look.left <= 1 &&
				look.right <= 1 &&
				look.scroll <= 0 &&
				closed !== '0px',
			JSON.stringify({ look, closed }),
		);
	}
	await page.setViewportSize({ width: 1280, height: 800 });

	// ---- window.controller.suggest() itself ---------------------------------------------------
	await page.evaluate(() => delete window.controller.suggest);
	// a cookie of the fixture's origin in the proxied page's jar, seen by the
	// page's own request and not by suggest()'s
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const key = `omni-${mode}-${Date.now()}`;
	const pageSaw = await frame
		?.evaluate(async (key) => {
			document.cookie = 'omnibox=1; path=/';
			const response = await fetch(`/echo-headers?k=${key}-page`);
			return (await response.json()).cookie ?? null;
		}, key)
		.catch((error) => String(error));
	const listed = await page.evaluate(
		([endpoint, echo]) =>
			Promise.all([
				window.controller.suggest('abc', { endpoint }),
				window.controller.suggest('abc', { endpoint: echo }),
			]),
		[
			`${FIXTURE}pages/omnibox-suggest.json?q=%s`,
			`${FIXTURE}echo-headers?k=${key}&q=%s`,
		],
	);
	const fields = await (
		await fetch(`${FIXTURE}echo-headers/recorded?k=${key}`)
	).json();
	ok(
		`${mode}: suggest() parses the endpoint's OpenSearch answer`,
		JSON.stringify(listed[0]) === JSON.stringify(['abc def', 'abc ghi']) &&
			JSON.stringify(listed[1]) === '[]',
		JSON.stringify(listed),
	);
	ok(
		`${mode}: suggest() asks as the browser does, with no page's cookie, origin or referrer`,
		String(pageSaw).includes('omnibox=1') &&
			fields &&
			!('cookie' in fields) &&
			!('origin' in fields) &&
			!('referer' in fields) &&
			fields['sec-fetch-site'] === 'none' &&
			fields['sec-fetch-mode'] === 'no-cors' &&
			fields['sec-fetch-dest'] === 'empty' &&
			typeof fields['user-agent'] === 'string' &&
			/^en/.test(fields['accept-language'] ?? ''),
		JSON.stringify({ pageSaw, fields }),
	);
	const aborted = await page.evaluate(async (slow) => {
		const abort = new AbortController();
		const asked = window.controller.suggest('abc', {
			endpoint: slow,
			signal: abort.signal,
		});
		setTimeout(() => abort.abort(), 100);
		const start = performance.now();
		try {
			await asked;
			return 'resolved';
		} catch (error) {
			return { name: error.name, ms: performance.now() - start };
		}
	}, `${FIXTURE}slow?q=%s`);
	ok(
		`${mode}: suggest() rejects when its signal aborts, without waiting for the answer`,
		aborted?.name === 'AbortError' && aborted.ms < 3000,
		JSON.stringify(aborted),
	);

	errors.push(...page.errors);
	await page.close();
}

ok('no page errors', errors.length === 0, JSON.stringify(errors));
await done(browser);
