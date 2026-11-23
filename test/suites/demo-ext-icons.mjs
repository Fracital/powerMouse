// The demo's extension icons (docs/extensions.md, "The toolbar's icons"),
// on a probe that sets its icon as Tampermonkey does: at every start
// chrome.action.setIcon({ path: getURL('images/icon_grey.png') }), a file
// its package does not have, and per tab setIcon({ path:
// getURL('images/icon.png'), tabId }), a 32 px picture. As in Chrome 157:
//  - the start's call fails in Chrome's words ("Failed to set icon '...':
//    Failed to fetch") and the button keeps the manifest's 16 px icon, a
//    picture that loads (it used to be the route of the missing file, a
//    broken image the moment the background started);
//  - the tab's call shows icon.png on that tab only: on the bar, in the
//    puzzle piece's list and, at 320 px, in the menu's Extensions submenu,
//    each a picture that loads; another tab shows the manifest's icon, and
//    the first tab its own again;
//  - a file that is no image fails with the decoder's words and changes
//    nothing;
//  - the pictures stay through a stop of every service worker
//    (ServiceWorker.stopAllWorkers) and a reload of the host, whose
//    background sets them again;
//  - no request of the host's fails and no picture is broken on the way.
/* global activateTab, chrome, navigate, tabs -- the demo's, and the background's in the functions evaluated there */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE_A = `${FIXTURE}pages/bookmark-a.html`;
const PAGE_B = `${FIXTURE}pages/bookmark-b.html`;

/** a ZIP of `files`, deflated */
function zip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const body = deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** a `size` px square PNG of one colour */
function png(size, [r, g, b]) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, 'latin1');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const row = Buffer.alloc(1 + size * 4);
	for (let x = 0; x < size; x++) row.set([r, g, b, 255], 1 + x * 4);
	const rows = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const GREY16 = png(16, [128, 128, 128]);
const GREY32 = png(32, [120, 120, 120]);
const COLOUR = png(32, [200, 30, 30]);
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

const PROBE = zip({
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Icon probe',
		version: '1.0',
		permissions: ['tabs'],
		background: { service_worker: 'background.js' },
		action: {
			default_title: 'Icon probe',
			default_popup: 'popup.html',
			default_icon: {
				16: 'images/icon_grey16.png',
				32: 'images/icon_grey32.png',
			},
		},
		icons: { 32: 'images/icon.png' },
	}),
	// Tampermonkey's yh.setIcon at its start
	'background.js': `
chrome.action.setIcon(
	{ path: chrome.runtime.getURL('images/icon_grey.png') },
	() => {
		self.__greyError = chrome.runtime.lastError?.message ?? null;
	},
);`,
	'popup.html': '<!doctype html><title>Icon popup</title>',
	'images/icon_grey16.png': GREY16,
	'images/icon_grey32.png': GREY32,
	'images/icon.png': COLOUR,
	'images/notes.txt': 'not a picture',
});

const browser = await launch();
const page = await openDemo(browser);
const failed = [];
page.on('requestfailed', (request) =>
	failed.push(`${request.url().slice(0, 120)} ${request.failure()?.errorText}`),
);
page.on('response', (response) => {
	if (response.status() >= 400)
		failed.push(`${response.status()} ${response.url().slice(0, 120)}`);
});

/** every extension picture of the host page: where it is, its source, whether it decoded */
const pictures = () =>
	page.evaluate(async () => {
		const shown = [
			...document.querySelectorAll(
				'#extActions img, #extPanel img, .extSubmenu img.pmMenuLead',
			),
		].filter(
			(image) =>
				image.getClientRects().length && !image.src.includes('/pm/icons/'),
		);
		return Promise.all(
			shown.map(async (image) => {
				await image.decode().catch(() => {});
				return {
					in: image.closest('#extActions')
						? 'bar'
						: image.closest('#extPanel')
							? 'list'
							: 'menu',
					src: image.src,
					width: image.naturalWidth,
				};
			}),
		);
	});

/** poll `read` until `want(value)`, else the last value */
async function until(read, want, timeout = 20000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await read().catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

/** the bar's picture for the probe once it is `src` (and has decoded) */
const barShows = (src) =>
	until(pictures, (list) =>
		list?.some((p) => p.in === 'bar' && p.src === src && p.width > 0),
	);

async function inBackground(id, fn, arg) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			if (!frame.name().startsWith('ext-context:background')) continue;
			const found = await frame
				.evaluate(() => globalThis.chrome?.runtime?.id ?? null)
				.catch(() => null);
			if (found === id) return frame.evaluate(fn, arg);
		}
		await sleep(200);
	}
	throw new Error(`no background page for ${id}`);
}

const painted = () =>
	page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	);

await submitLanding(page, PAGE_A);
await page.waitForFunction(
	() => document.querySelector('#omni input')?.value.includes('bookmark-a'),
	null,
	{ timeout: 30000 },
);
const id = await page.evaluate(
	async (bytes) =>
		(
			await window.controller.extensions.install(new Uint8Array(bytes).buffer, {
				filename: 'icon-probe.zip',
			})
		).id,
	[...PROBE],
);
const greyError = await until(
	() => inBackground(id, () => self.__greyError),
	(value) => value !== undefined,
);
ok(
	"the start's setIcon of a file the package lacks fails in Chrome's words",
	greyError ===
		`Failed to set icon 'chrome-extension://${id}/images/icon_grey.png': Failed to fetch`,
	greyError,
);
const started = await barShows(dataUrl(GREY16));
ok(
	"after it the button keeps the manifest's 16 px icon, a picture that loads",
	started?.some(
		(p) => p.in === 'bar' && p.src === dataUrl(GREY16) && p.width === 16,
	) && started.every((p) => p.width > 0),
	JSON.stringify(started?.map((p) => [p.in, p.src.slice(0, 60), p.width])),
);

const tabA = await page.evaluate(() =>
	window.controller.tabIdOf(window.controller.activeTab),
);
const setTab = await inBackground(
	id,
	(tabId) =>
		new Promise((resolve) =>
			chrome.action.setIcon(
				{ path: chrome.runtime.getURL('images/icon.png'), tabId },
				() => resolve(chrome.runtime.lastError?.message ?? 'set'),
			),
		),
	tabA,
);
const tabShown = await barShows(dataUrl(COLOUR));
ok(
	"the tab's setIcon shows its picture on the bar, loaded",
	setTab === 'set' &&
		tabShown?.some(
			(p) => p.in === 'bar' && p.src === dataUrl(COLOUR) && p.width === 32,
		),
	JSON.stringify([
		setTab,
		tabShown?.map((p) => [p.in, p.src.slice(0, 60), p.width]),
	]),
);

const notImage = await inBackground(
	id,
	(tabId) =>
		chrome.action.setIcon({ path: 'images/notes.txt', tabId }).then(
			() => 'set',
			(error) => error.message,
		),
	tabA,
);
await sleep(300);
const afterNotImage = await pictures();
ok(
	"a file that is no image fails with the decoder's words and changes nothing",
	notImage ===
		"Failed to set icon 'images/notes.txt': The source image could not be decoded." &&
		afterNotImage.some(
			(p) => p.in === 'bar' && p.src === dataUrl(COLOUR) && p.width === 32,
		),
	JSON.stringify([notImage, afterNotImage.map((p) => [p.in, p.width])]),
);

await page.click('#toolExtensions');
await painted();
const listed = await until(pictures, (list) =>
	list?.some((p) => p.in === 'list'),
);
const listRow = listed?.find((p) => p.in === 'list');
ok(
	"the puzzle piece's list shows the tab's picture, loaded",
	listRow?.src === dataUrl(COLOUR) && listRow.width === 32,
	JSON.stringify(listed?.map((p) => [p.in, p.src.slice(0, 60), p.width])),
);
await page.keyboard.press('Escape');

// another tab: the extension's icon; then the first one's own again
await page.evaluate((url) => navigate(url, { newTab: true }), PAGE_B);
const otherTab = await barShows(dataUrl(GREY16));
await page.evaluate(() => activateTab(tabs[0]));
const backTab = await barShows(dataUrl(COLOUR));
ok(
	"another tab shows the manifest's icon, the first its own again",
	!!otherTab?.some((p) => p.in === 'bar' && p.src === dataUrl(GREY16)) &&
		!!backTab?.some((p) => p.in === 'bar' && p.src === dataUrl(COLOUR)),
	JSON.stringify([
		otherTab?.map((p) => [p.in, p.src.slice(0, 60), p.width]),
		backTab?.map((p) => [p.in, p.src.slice(0, 60), p.width]),
	]),
);

// a stop of every service worker: the pictures need none
const cdp = await page.context().newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await sleep(1000);
await page.evaluate(() => activateTab(tabs.at(-1)));
const stoppedOther = await barShows(dataUrl(GREY16));
await page.evaluate(() => activateTab(tabs[0]));
const stoppedBack = await barShows(dataUrl(COLOUR));
ok(
	'after a stop of the service workers the pictures still load, tab by tab',
	!!stoppedOther?.some((p) => p.in === 'bar' && p.width === 16) &&
		!!stoppedBack?.some((p) => p.in === 'bar' && p.width === 32),
	JSON.stringify([
		stoppedOther?.map((p) => [p.in, p.width]),
		stoppedBack?.map((p) => [p.in, p.width]),
	]),
);

// the menu's Extensions at 320 px, where the bar has no puzzle piece
await page.setViewportSize({ width: 320, height: 700 });
await painted();
await page.click('#toolMenu');
await painted();
await page.click('#menuExtensions');
const menuShown = await until(pictures, (list) =>
	list?.some((p) => p.in === 'menu'),
);
const menuRow = menuShown?.find((p) => p.in === 'menu');
ok(
	"the menu's Extensions submenu shows the tab's picture, loaded",
	menuRow?.src === dataUrl(COLOUR) && menuRow.width === 32,
	JSON.stringify(menuShown?.map((p) => [p.in, p.src.slice(0, 60), p.width])),
);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 800 });

// a reload of the host: the background starts again and its call fails again
await page.reload();
await page.waitForFunction(
	() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
	null,
	{ timeout: 45000 },
);
const reloadError = await until(
	() => inBackground(id, () => self.__greyError),
	(value) => value !== undefined,
);
const reloaded = await barShows(dataUrl(GREY16));
ok(
	"after a reload of the host the button is the manifest's picture, loaded",
	reloadError?.endsWith('Failed to fetch') &&
		!!reloaded?.some(
			(p) => p.in === 'bar' && p.src === dataUrl(GREY16) && p.width === 16,
		),
	JSON.stringify([reloadError, reloaded?.map((p) => [p.in, p.width])]),
);

// (an extension's file the host asked for: refused by ORB on the isolated
// host, a 404 on the same-origin one)
const broken = failed.filter((line) => /ERR_BLOCKED_BY_ORB|^404 /.test(line));
ok(
	"no request of the host's for an extension's icon failed",
	broken.length === 0,
	JSON.stringify(broken),
);
ok('no page errors', page.errors.length === 0, JSON.stringify(page.errors));
await done(browser);
