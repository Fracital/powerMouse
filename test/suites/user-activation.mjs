// A proxied document has a user activation only where it would natively
// (src/inject/dom/activation.ts). Every proxied document is of one real
// origin, so the browser's activation from an input event reached every
// frame of the page, and the host's own input reached the page in
// same-origin mode: a frame of another site, or an opaque one, could then
// open a popup, enter fullscreen, play sound or navigate the top on a click
// it never had. test/pages/user-activation.html frames another site's page
// (with a frame of the top's origin and one of its own), one of the top's
// origin and an opaque one, each saying on the console when its activation
// changes. The suite moves and clicks the mouse and types real keys; it
// never evaluates in a page (an evaluation is an activation of its own).
// Compared with the same pages loaded natively, in both demo modes:
//
// - which frames a click in each frame activates (natively the frame, its
//   ancestors and the frames of its origin);
// - that a click in the host's own page activates none;
// - what each gesture-gated call answers in a frame of another site (or the
//   opaque one) after a click in the top: navigator.userActivation, vibrate,
//   copy, showPicker, EyeDropper, autoplay with sound, pointer lock,
//   presentation, fullscreen, the file picker, a sandboxed popup and the top
//   navigation of a frame sandboxed with
//   allow-top-navigation-by-user-activation; and, after a click in the frame
//   itself, that the call has its activation;
// - the activation a document starts with after a link of its origin, of
//   another site, and a URL typed into the host's address bar.
//
// The popup blocker is on (Playwright turns it off by default), so a popup
// with no activation is refused as for a user.
import { chromium } from 'playwright-core';
import {
	CHROME,
	done,
	FIXTURE,
	HOST,
	NO_AUDIO,
	ok,
	openDemo,
	PROXY,
	sleep,
	SLOT_PORTS,
	submitLanding,
} from '../lib.mjs';

const OTHER = FIXTURE.replace('127.0.0.1', 'localhost');
const FRAMES = ['P', 'same', 'opaque', 'cross', 'cross-x', 'cross-y'];
// where each frame is clicked, in the top's coordinates
const AT = {
	P: [100, 300],
	same: [100, 70],
	opaque: [280, 70],
	cross: [530, 200],
	'cross-x': [450, 70],
	'cross-y': [590, 70],
	'same-next': [100, 315],
	'cross-next': [100, 355],
};
// each call, made in the frame named after it with a click in the top first
const CALLS = {
	userActivation: 'cross',
	vibrate: 'cross',
	execCopy: 'cross',
	showPicker: 'cross',
	eyeDropper: 'cross',
	media: 'cross',
	pointerLock: 'cross',
	presentation: 'cross',
	fullscreen: 'cross',
	filePicker: 'cross',
	open: 'opaque',
	topNavigation: 'opaque',
};
// the calls whose answer with an activation of the frame's own is compared:
// the file picker and (isolation mode) fullscreen answer a frame of another
// site otherwise than natively whatever the activation (the browser's
// checks of a cross-origin frame see one origin), and a popup or a top
// navigation that goes through leaves the page
const OWN = [
	'userActivation',
	'vibrate',
	'execCopy',
	'showPicker',
	'media',
	'presentation',
	'pointerLock',
];

const pageURL = (query) =>
	`${FIXTURE}pages/user-activation.html?other=${encodeURIComponent(OTHER)}&self=${encodeURIComponent(FIXTURE)}&${query}`;

const browser = await chromium.launch({
	executablePath: CHROME,
	headless: true,
	env: { ...process.env, ...NO_AUDIO },
	args: [
		'--no-sandbox',
		'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
	],
	ignoreDefaultArgs: ['--disable-popup-blocking'],
});

/**
 * One load of `query` in `context` (by `load`), with what its frames said:
 * `act(page, offset)` acts once every frame (`frames` of them) is ready and
 * a mouse move told where the top is; `until(lines)` ends the wait
 */
async function run(context, load, query, frames, act, until, ms = 1500) {
	const lines = [];
	const listen = (message) => {
		const text = message.text();
		if (text.startsWith('ua ')) lines.push(text.slice(3));
	};
	context.on('console', listen);
	let result;
	let page;
	try {
		page = await load(pageURL(query));
		page.on('popup', (popup) => popup.close().catch(() => {}));
		for (
			let i = 0;
			i < 150 &&
			lines.filter((line) => line.startsWith('ready ')).length < frames;
			i++
		)
			await sleep(100);
		// where the top sits in the host page: a mouse move (no activation)
		const guess = load.native ? [100, 300] : [640, 500];
		await page.mouse.move(guess[0], guess[1]);
		let offset = null;
		for (let i = 0; i < 60 && !offset; i++) {
			const move = lines.find((line) => line.startsWith('move P '));
			if (move) {
				const [, , x, y] = move.split(' ');
				offset = [guess[0] - Number(x), guess[1] - Number(y)];
			} else await sleep(50);
		}
		await sleep(300);
		const before = lines.length;
		if (offset) await act(page, offset);
		for (
			let waited = 0;
			waited < ms && !until(lines.slice(before));
			waited += 100
		)
			await sleep(100);
		result = { offset, after: lines.slice(before), all: lines };
	} catch (error) {
		result = { error: String(error), after: [], all: lines };
	}
	context.off('console', listen);
	await page?.close().catch(() => {});
	return result;
}

const click = (target) => (page, offset) =>
	page.mouse.click(offset[0] + AT[target][0], offset[1] + AT[target][1]);
const activated = (lines) =>
	FRAMES.filter((name) =>
		lines.some((line) => line.startsWith(`state ${name} true/`)),
	);
const answerOf = (lines, api) => {
	const line = lines.find(
		(line) => line.startsWith('answer ') && line.includes(` ${api} `),
	);
	return line
		? JSON.parse(line.slice(line.indexOf(` ${api} `) + api.length + 2))
		: null;
};

async function measure(mode, base) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	if (base) await openDemo(context, base);
	const load = base
		? async (url) => {
				const page = await openDemo(context, base);
				await submitLanding(page, url);
				return page;
			}
		: async (url) => {
				const page = await context.newPage();
				await page.goto(url);
				return page;
			};
	load.native = !base;
	const result = { clicks: {}, calls: {}, own: {}, starts: {} };

	for (const target of FRAMES) {
		const seen = await run(
			context,
			load,
			'battery=',
			6,
			click(target),
			() => false,
		);
		result.clicks[target] = seen.offset
			? activated(seen.after)
			: `no top (${seen.error ?? ''})`;
	}
	if (base) {
		// the host's own page, above the proxied top
		const seen = await run(
			context,
			load,
			'battery=',
			6,
			(page, offset) =>
				page.mouse.click(
					Math.max(5, offset[0] / 2),
					Math.max(5, offset[1] / 2),
				),
			() => false,
		);
		result.host = seen.offset
			? activated(seen.after)
			: `no top (${seen.error ?? ''})`;
	}
	for (const [api, frame] of Object.entries(CALLS)) {
		const seen = await run(
			context,
			load,
			`battery=${frame}&api=${api}`,
			6,
			click('P'),
			(lines) =>
				!!answerOf(lines, api) ||
				lines.some((l) => l.startsWith('start landed')),
			8000,
		);
		result.calls[api] = seen.after.some((line) =>
			line.startsWith('start landed'),
		)
			? 'the top navigated'
			: (answerOf(seen.after, api) ?? `no answer (${seen.error ?? 'none'})`);
	}
	for (const api of OWN) {
		const seen = await run(
			context,
			load,
			`battery=cross&api=${api}`,
			6,
			click('cross'),
			(lines) => !!answerOf(lines, api),
			8000,
		);
		result.own[api] =
			answerOf(seen.after, api) ?? `no answer (${seen.error ?? 'none'})`;
	}
	for (const link of ['same-next', 'cross-next']) {
		const seen = await run(
			context,
			load,
			'links',
			1,
			click(link),
			(lines) => lines.some((line) => line.startsWith(`start ${link} `)),
			8000,
		);
		const start = seen.after.find((line) => line.startsWith(`start ${link} `));
		result.starts[link] = start ? start.split(' ')[2] : 'never loaded';
	}
	if (base) {
		// a URL typed into the host's address bar, with real keys
		const seen = await run(
			context,
			load,
			'links',
			1,
			async (page) => {
				const box = await page.locator('#omni input').boundingBox();
				await page.mouse.click(box.x + 20, box.y + box.height / 2);
				await page.keyboard.press('Control+a');
				await page.keyboard.type(pageURL('name=typed&links'));
				await page.keyboard.press('Enter');
			},
			(lines) => lines.some((line) => line.startsWith('start typed ')),
			8000,
		);
		const start = seen.after.find((line) => line.startsWith('start typed '));
		result.starts.typed = start ? start.split(' ')[2] : 'never loaded';
	}
	await context.close();
	return result;
}

const native = await measure('native', null);
console.log(`# native ${JSON.stringify(native)}`);
ok(
	'natively a click in a frame activates it, its ancestors and the frames of its origin',
	JSON.stringify(native.clicks.cross) === '["P","cross","cross-y"]' &&
		JSON.stringify(native.clicks['cross-x']) ===
			'["P","same","cross","cross-x"]',
	JSON.stringify(native.clicks),
);
ok(
	'natively a frame of another site has no activation after a click in the top',
	native.calls.userActivation === 'false/false',
	native.calls.userActivation,
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const proxied = await measure(mode, base);
	console.log(`# ${mode} ${JSON.stringify(proxied)}`);
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(`${mode}: ${name} as natively`, x === y, `native ${x} proxied ${y}`);
	};
	for (const target of FRAMES)
		same(
			`the frames a click in ${target} activates are`,
			native.clicks[target],
			proxied.clicks[target],
		);
	same('the frames a click in the host page activates are', [], proxied.host);
	for (const api of Object.keys(CALLS))
		if (api === 'fullscreen' && mode === 'isolated' && SLOT_PORTS.length)
			// the site pool in isolation mode: the frame of another site is a
			// slot's, which the click in the top gives no activation, as
			// natively, so the browser answers its request, and refuses it for
			// the permissions policy of the host's frame, which does not allow
			// fullscreen (the demo's FRAME_ALLOW): refused either way
			ok(
				`${mode}: ${api} in ${CALLS[api]}, after a click in the top, is refused as natively`,
				/^rejected TypeError: /.test(native.calls[api]) &&
					/^rejected TypeError: /.test(proxied.calls[api]),
				`native ${JSON.stringify(native.calls[api])} proxied ${JSON.stringify(proxied.calls[api])}`,
			);
		else
			same(
				`${api} in ${CALLS[api]}, after a click in the top, answers`,
				native.calls[api],
				proxied.calls[api],
			);
	for (const api of OWN)
		same(
			`${api} in cross, after a click in it, answers`,
			native.own[api],
			proxied.own[api],
		);
	for (const link of ['same-next', 'cross-next'])
		same(
			`the activation a document starts with after a link (${link}) is`,
			native.starts[link],
			proxied.starts[link],
		);
	// natively a typed URL's document starts with none (page.goto's)
	same(
		'the activation a document starts with after a URL typed into the address bar is',
		'false/false',
		proxied.starts.typed,
	);
}
await done(browser);
