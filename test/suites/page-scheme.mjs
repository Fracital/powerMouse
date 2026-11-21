// The pages' light or dark mode (Settings, Page appearance; pm/theme.js,
// docs/themes.md), compared with Chrome light and dark: natively in a
// Chrome of its own with --force-dark-mode, and in the suite's Chrome. No
// context emulates the preference (Playwright's colorScheme): emulation
// outranks a frame's own preference in the renderer, and the browser's
// navigation hint ignores it (measured: a navigation says light, its
// images dark). A proxied frame's document takes its preference from its
// element's color-scheme, which the demo sets on every frame. Per mode, in
// both controller modes:
//  - what a page reads: matchMedia, a @media rule inline and in a linked
//    stylesheet, a <picture>'s chosen source, a form control and the canvas
//    (screen pixels, a page of color-scheme normal and one of light dark),
//    a nested frame of another site;
//  - the Sec-CH-Prefers-Color-Scheme of its navigation (Critical-CH) and of
//    its subresources;
//  - Match theme: Default is dark, the Light and Dark themes their own;
//  - a switch in Settings while the page is open changes it at once, with
//    one change event, and the requests after it carry the new value, the
//    next navigation's too.
/* global PMTheme -- the demo page's, in the functions evaluated there */
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';

const HINT = 'sec-ch-prefers-color-scheme';
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/** what a page (and its frame) reads; `window.__read()` in it */
const READER = `<script>
const q = matchMedia('(prefers-color-scheme: dark)');
window.__log = [];
q.addEventListener('change', (event) => __log.push(event.matches));
window.__read = () => {
	const style = (id) => getComputedStyle(document.getElementById(id));
	const picture = document.getElementById('pic');
	return {
		dark: q.matches,
		light: matchMedia('(prefers-color-scheme: light)').matches,
		media: style('m').color,
		linked: style('l').color,
		picture: picture ? (/-pd$/.test(picture.currentSrc) ? 'dark' : 'light') : null,
		input: [style('in').backgroundColor, style('in').color],
		root: [getComputedStyle(document.documentElement).colorScheme, style('m').backgroundColor],
		log: [...__log],
	};
};
</script>`;
const BODY = (key) =>
	`<title>${key}</title><style>#m { color: rgb(9, 9, 9) } @media (prefers-color-scheme: dark) { #m { color: rgb(1, 2, 3) } }</style>` +
	`<link rel="stylesheet" href="/s.css">` +
	`<picture><source media="(prefers-color-scheme: dark)" srcset="/i.gif?k=${key}-pd"><img id="pic" src="/i.gif?k=${key}-pl"></picture>` +
	`<div id="m">m</div><div id="l">l</div><input id="in">`;
const CSS =
	'#l { color: rgb(7, 7, 7) } @media (prefers-color-scheme: dark) { #l { color: rgb(4, 5, 6) } }';

/** two recorders: the page on 127.0.0.1, its frame on localhost */
async function sites() {
	const log = new Map();
	const origins = {};
	const handler = (req, res) => {
		const url = new URL(req.url, 'http://x/');
		const key = url.searchParams.get('k');
		if (key) log.set(key, req.headers[HINT] ?? '(none)');
		if (url.pathname === '/i.gif') {
			res.setHeader('content-type', 'image/gif');
			return res.end(GIF);
		}
		if (url.pathname === '/s.css') {
			res.setHeader('content-type', 'text/css');
			return res.end(CSS);
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('accept-ch', HINT);
		res.setHeader('critical-ch', HINT);
		if (url.pathname === '/frame')
			return res.end(`<!doctype html>${READER}${BODY(key)}`);
		if (url.pathname === '/canvas')
			// a page that takes the preference for its own scheme
			return res.end(
				`<!doctype html><meta name="color-scheme" content="${url.searchParams.get('s')}"><title>${key}</title><body style="margin:0">`,
			);
		res.end(
			`<!doctype html><body style="margin:0">${READER}${BODY(key)}` +
				`<iframe id="x" style="position:absolute;right:0;bottom:0" src="${origins.b}/frame?k=${key}-f"></iframe>`,
		);
	};
	const a = createServer(handler);
	const b = createServer(handler);
	await new Promise((resolve) => a.listen(0, resolve));
	await new Promise((resolve) => b.listen(0, resolve));
	origins.a = `http://127.0.0.1:${a.address().port}`;
	origins.b = `http://localhost:${b.address().port}`;
	return {
		...origins,
		log,
		close: () => {
			a.close();
			b.close();
		},
	};
}

async function until(read, want, timeout = 30000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await read().catch(() => undefined);
		if (want(value)) return value;
		await sleep(200);
	}
	return value;
}

/** a frame's reading, its nested frame's with it */
async function readFrame(frame) {
	const top = await until(
		() => frame.evaluate(() => window.__read?.() ?? null),
		(value) => value && value.picture !== null,
	);
	const child = frame.childFrames()[0];
	const nested = child
		? await until(
				() => child.evaluate(() => window.__read?.() ?? null),
				Boolean,
			)
		: null;
	return { top, nested };
}

/** the colour of one screen pixel of `page` at x, y */
async function pixel(page, x, y) {
	const png = await page.screenshot({
		clip: { x, y, width: 1, height: 1 },
		animations: 'disabled',
	});
	return page.evaluate(async (base64) => {
		const image = new Image();
		image.src = `data:image/png;base64,${base64}`;
		await image.decode();
		const canvas = new OffscreenCanvas(1, 1);
		const context = canvas.getContext('2d');
		context.drawImage(image, 0, 0);
		return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(',');
	}, png.toString('base64'));
}

// the order the log is compared in: what the page reads, then the hints
const hints = (log, key) => ({
	nav: log.get(key),
	image: log.get(`${key}-p${log.has(`${key}-pd`) ? 'd' : 'l'}`),
	frame: log.get(`${key}-f`),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** a reading without its change events, which the live checks look at */
const still = ({ top, nested }) => ({
	top: { ...top, log: [] },
	nested: nested && { ...nested, log: [] },
});

await waitForServer(HOST);
const browser = await launch();
const site = await sites();

// ---- natively, forced light and dark --------------------------------------

let visits = 0;
const native = {};
const forcedDark = await launch(['--force-dark-mode']);
for (const scheme of ['light', 'dark']) {
	const context = await (scheme === 'dark' ? forcedDark : browser).newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme: null,
	});
	const page = await context.newPage();
	const key = `n-${scheme}`;
	await page.goto(`${site.a}/p?k=${key}`);
	const read = await readFrame(page.mainFrame());
	await sleep(300);
	native[scheme] = { read, hints: hints(site.log, key) };
	native[scheme].canvas = {};
	for (const own of ['normal', 'light dark']) {
		await page.goto(
			`${site.a}/canvas?k=c${++visits}&s=${encodeURIComponent(own)}`,
		);
		native[scheme].canvas[own] = await pixel(page, 600, 400);
	}
	await context.close();
}
await forcedDark.close();
ok(
	'natively, the two modes read apart',
	native.light.read.top.dark === false &&
		native.dark.read.top.dark === true &&
		native.dark.hints.nav === 'dark' &&
		native.light.hints.nav === 'light',
	JSON.stringify({ light: native.light, dark: native.dark }),
);

// ---- through the proxy ------------------------------------------------------

async function demo(base) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		// no emulation: the frame elements' color-scheme decides
		colorScheme: null,
	});
	const page = await context.newPage();
	page.errors = [];
	page.on('pageerror', (error) => page.errors.push(error.message));
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	return page;
}

const frameOf = async (page) =>
	(await page.$('.frame:not(.hidden)'))?.contentFrame();

/** open `path` of site A in the demo's active tab (a new one from the landing) */
async function visit(page, path, first = false) {
	const url = `${site.a}${path}`;
	if (first) await submitLanding(page, url);
	else await submitOmni(page, url);
	const key = new URL(url).searchParams.get('k');
	return until(
		async () => {
			const frame = await frameOf(page);
			if (!frame) return null;
			const ready = await frame.evaluate(
				(want) => document.title === want && document.readyState === 'complete',
				key,
			);
			return ready ? frame : null;
		},
		Boolean,
		45000,
	);
}

/** the pixel in the middle of the active tab's frame */
async function framePixel(page) {
	const box = await (await page.$('.frame:not(.hidden)')).boundingBox();
	return pixel(
		page,
		Math.round(box.x + box.width / 2),
		Math.round(box.y + box.height / 2),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await demo(base);
	const state = await page.evaluate(() => ({
		mode: PMTheme.pageMode(),
		scheme: PMTheme.pageScheme(),
		attribute: document.documentElement.dataset.pmPageScheme,
	}));
	ok(
		`${mode}: Match theme is the default, and Default is dark`,
		same(state, { mode: 'theme', scheme: 'dark', attribute: 'dark' }),
		JSON.stringify(state),
	);

	// Light and Dark, each against Chrome's own
	let first = true;
	for (const scheme of ['light', 'dark']) {
		await page.evaluate((next) => PMTheme.setPageMode(next), scheme);
		const key = `p${++visits}`;
		const frame = await visit(page, `/p?k=${key}`, first);
		first = false;
		const read = frame && (await readFrame(frame));
		await sleep(300);
		const got = { read, hints: hints(site.log, key) };
		ok(
			`${mode}: Page appearance ${scheme} reads as Chrome ${scheme}: matchMedia, @media inline and linked, <picture>, the form control, the nested frame of another site`,
			read && same(still(read), still(native[scheme].read)),
			JSON.stringify({ got: read, native: native[scheme].read }),
		);
		ok(
			`${mode}: Page appearance ${scheme}: the navigation's, an image's and the nested frame's ${HINT} are Chrome's`,
			same(got.hints, native[scheme].hints),
			JSON.stringify({ got: got.hints, native: native[scheme].hints }),
		);
		const canvas = {};
		for (const own of ['normal', 'light dark']) {
			await visit(page, `/canvas?k=c${++visits}&s=${encodeURIComponent(own)}`);
			await sleep(300);
			canvas[own] = await framePixel(page);
		}
		ok(
			`${mode}: Page appearance ${scheme}: the canvas of a page of color-scheme normal and of light dark is Chrome's`,
			same(canvas, native[scheme].canvas),
			JSON.stringify({ got: canvas, native: native[scheme].canvas }),
		);
	}

	// Match theme: Default dark, then the Light and Dark themes, live
	await page.evaluate(() => PMTheme.setPageMode('light'));
	let key = `p${++visits}`;
	let frame = await visit(page, `/p?k=${key}`);
	await readFrame(frame);
	await page.evaluate(() => PMTheme.setPageMode('theme'));
	// the page's change events, then what it reads: reads of the list's
	// matches right after the switch can take the change in before the
	// event does, which then never fires (natively too, in a frame of
	// another site)
	const live = async (events) => {
		await until(
			() => frame.evaluate(() => window.__log.length),
			(length) => length >= events,
			5000,
		);
		await sleep(150);
		return frame.evaluate(() => window.__read());
	};
	let now = await live(1);
	ok(
		`${mode}: Match theme with Default turns the open page dark at once, with one change event`,
		now?.dark === true &&
			same(now.log, [true]) &&
			now.media === native.dark.read.top.media &&
			now.linked === native.dark.read.top.linked &&
			now.picture === 'dark',
		JSON.stringify(now),
	);
	await page.evaluate(() => PMTheme.apply('light'));
	now = await live(2);
	ok(
		`${mode}: Match theme follows the Light theme`,
		now?.dark === false && same(now.log, [true, false]),
		JSON.stringify(now),
	);
	await page.evaluate(() => PMTheme.apply('dark'));
	now = await live(3);
	ok(
		`${mode}: Match theme follows the Dark theme`,
		now?.dark === true && same(now.log, [true, false, true]),
		JSON.stringify(now),
	);

	// Settings' radio group, with the page open; then what it requests and
	// the next navigation
	await page.evaluate(() => PMTheme.apply('default'));
	await page.evaluate(() => PMTheme.setPageMode('light'));
	key = `p${++visits}`;
	frame = await visit(page, `/p?k=${key}`);
	await readFrame(frame);
	await page.click('#toolMenu');
	await sleep(150);
	await page.click('#menuSettings');
	await page.waitForSelector('#spPageModes .spModePick');
	const picks = await page.$$eval('#spPageModes .spModePick', (els) =>
		els.map((el) => [el.dataset.pageMode, el.getAttribute('aria-checked')]),
	);
	ok(
		`${mode}: Settings has Page appearance: Match theme, Light and Dark, Light checked`,
		same(picks, [
			['theme', 'false'],
			['light', 'true'],
			['dark', 'false'],
		]),
		JSON.stringify(picks),
	);
	await page.click('.spModePick[data-page-mode="dark"]');
	now = await live(1);
	const stored = await page.evaluate(() =>
		localStorage.getItem('stomp-demo:page-scheme'),
	);
	ok(
		`${mode}: choosing Dark in Settings turns the open page dark, with one change event, and keeps the choice`,
		now?.dark === true &&
			same(now.log, [true]) &&
			now.picture === 'dark' &&
			stored === 'dark',
		JSON.stringify({ now, stored }),
	);
	await frame.evaluate((k) => {
		new Image().src = `/i.gif?k=${k}`;
	}, `${key}-after`);
	await until(async () => site.log.get(`${key}-after`), Boolean, 10000);
	const after = `p${++visits}`;
	await visit(page, `/p?k=${after}`);
	await until(async () => site.log.get(after), Boolean, 10000);
	await sleep(300);
	ok(
		`${mode}: after the switch, an image the page asks for and the next navigation send ${HINT}: dark`,
		site.log.get(`${key}-after`) === 'dark' && site.log.get(after) === 'dark',
		JSON.stringify({
			image: site.log.get(`${key}-after`),
			navigation: site.log.get(after),
		}),
	);
	ok(`${mode}: no page errors`, !page.errors.length, page.errors.join('; '));
	await page.context().close();
}

site.close();
await done(browser);
