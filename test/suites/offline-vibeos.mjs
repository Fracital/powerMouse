// vibeOS in offline.html (scripts/offline-vibeos.mjs, demo/offline/vibeos.mjs):
// the build's file opened from file: with this run's demo server as its wisp
// server, nothing else, which this suite skips when the file carries no
// vibeOS (a build without vendor/vibeOS):
//  - the file keeps vibeOS as an archive no script reads until the first
//    switch, and it carries no emulator;
//  - the menu's vibeOS item switches: the tab becomes a window of vibeOS's
//    browser holding its own frame (moveBefore), its document as it was (its
//    script's state, a typed input, its scroll, its timer and its nested
//    frame's realm), and the fixture sees no second request for it;
//  - the desktop's module, stylesheet, font, wallpaper and icons are the
//    file's own blob: URLs, and every image on it loads;
//  - each game opens from a blob: URL with what its page names: Tetris's
//    canvas, 2048's stylesheet and font, Breakout's images;
//  - the emulator boots from Cache Storage with nothing fetched (its first
//    launch's fetch through the proxy is demo-vibeos's);
//  - back in powerMouse's view the tab is as it was;
//  - from the switch on, no request leaves the file: none to the network
//    (the wisp server's socket aside), none to file:.
/* global vibeHost -- pm/main.js's, read in the file's page */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
	done,
	FIXTURE,
	launch,
	ok,
	PORT,
	sleep,
	submitLanding,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const file = `${root}build/offline.html`;
if (!existsSync(file))
	throw new Error('build/offline.html is not there: `npm run build` writes it');
const text = readFileSync(file, 'utf8');
if (!text.includes('id="pm-vibeos"')) {
	console.log(
		'SKIP offline-vibeos (build/offline.html carries no vibeOS: dist/vibeos/ was not built)',
	);
	process.exit(0);
}
const WISP = `ws://127.0.0.1:${PORT}/wisp/`;
const opened = `${pathToFileURL(file).href}?wisp=${encodeURIComponent(WISP)}`;
const STATE = `${FIXTURE}pages/vibeos-state.html`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
// every request the page and its frames make: to the network, and to file:
const network = [];
const files = [];
page.on('request', (request) => {
	const url = request.url();
	if (url.startsWith('file:')) {
		if (url.split(/[?#]/)[0] !== pathToFileURL(file).href) files.push(url);
	} else if (!/^(blob|data):/.test(url)) network.push(url);
});
const sockets = [];
page.on('websocket', (socket) => sockets.push(socket.url()));

async function until(read, want, timeout = 30000, arg = undefined, on = page) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await on.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}
const hits = async () => {
	const all = await (await fetch(`${FIXTURE}hits`)).json();
	return [
		all['vibeos-state.html']?.requests ?? 0,
		all['vibeos-state-inner.html']?.requests ?? 0,
	];
};
/** the tab's document (titled 'vibeOS state'), wherever its frame is */
async function stateFrame(timeout = 30000) {
	for (const end = Date.now() + timeout; Date.now() < end;) {
		for (const frame of page.frames().reverse()) {
			const title = await frame.evaluate(() => document.title).catch(() => '');
			if (title === 'vibeOS state') return frame;
		}
		await sleep(100);
	}
	return null;
}
async function stateOf() {
	const frame = await stateFrame(5000);
	if (!frame) return null;
	const top = await frame.evaluate(() => ({
		loads: window.loads,
		mark: window.__mark ?? null,
		count: window.count,
		typed: document.getElementById('typed').value,
		y: Math.round(scrollY),
	}));
	const nested = frame.childFrames()[0];
	const inner = nested
		? await nested.evaluate(() => ({
				ticks: window.ticks,
				mark: window.__mark ?? null,
			}))
		: null;
	return { ...top, inner };
}
async function checkState(label, before, hitsBefore) {
	const first = await stateOf().catch((error) => ({ error: error.message }));
	await sleep(300);
	const second = await stateOf().catch((error) => ({ error: error.message }));
	ok(
		`${label}: the page's script state, typed input and scroll are kept, its timer runs`,
		first?.mark === 'alive' &&
			first.loads === 1 &&
			first.typed === 'typed before' &&
			first.y === 1234 &&
			first.inner?.mark === 'nested alive' &&
			second?.count > first.count &&
			first.count >= before.count,
		`${JSON.stringify(first)} -> ${JSON.stringify(second)}`,
	);
	const now = await hits();
	ok(
		`${label}: neither document was requested again`,
		now.join() === hitsBefore.join(),
		`${hitsBefore} -> ${now}`,
	);
}

await page.goto(opened);
await page.waitForFunction(
	() => /^(Ready|Error)/.test(document.getElementById('logMsg')?.textContent),
	null,
	{ timeout: 60000 },
);
const kept = await page.evaluate(() => {
	const archive = document.getElementById('pm-vibeos');
	return {
		type: archive?.type,
		offered: typeof globalThis.STOMP_OFFLINE?.vibeos === 'function',
		item: !!document.getElementById('menuVibe'),
		root: !!document.getElementById('vibeos-root'),
	};
});
ok(
	'the file keeps vibeOS as an archive no script reads, and offers the switch',
	kept.type === 'application/octet-stream' &&
		kept.offered &&
		kept.item &&
		!kept.root,
	JSON.stringify(kept),
);
const carried = (() => {
	const plain = gunzipSync(
		Buffer.from(/id="pm-vibeos">([^<]*)</.exec(text)[1], 'base64'),
	);
	const length = plain.readUInt32BE(0);
	return JSON.parse(plain.subarray(4, 4 + length)).map(([path]) => path);
})();
ok(
	'the file carries no emulator (no v86 core, BIOS, disk or libcurl relay)',
	carried.includes('embed.js') &&
		!carried.some((path) =>
			/^scripts\/|\.(wasm|img|iso|bin)$|libv86|libcurl/.test(path),
		),
	carried.filter((path) => !/^(tango|appfiles)\//.test(path)).join(' '),
);

// a tab with state, then the switch from the menu
await submitLanding(page, STATE);
const frame = await stateFrame(40000);
ok('the tab loads', !!frame);
const settled = await until(
	() => ({ count: window.count, frames: frames.length }),
	(v) => v?.count > 3 && v.frames === 1,
	20000,
	undefined,
	frame,
);
const nestedFrame = frame.childFrames()[0];
// (the nested frame's own document does not load in the file yet: its
// frame stays an empty call page, so only that frame's realm is checked)
ok(
	'its timer runs, its nested frame is there',
	settled?.count > 3 && !!nestedFrame,
	JSON.stringify({
		settled,
		urls: frame.childFrames().map((f) => f.url()),
	}),
);
await frame.fill('#typed', 'typed before');
await frame.evaluate(() => {
	window.__mark = 'alive';
	scrollTo(0, 1234);
});
await frame.childFrames()[0].evaluate(() => {
	window.__mark = 'nested alive';
});
const hitsBefore = await hits();
const before = await stateOf();

// the emulator's pinned files in Cache Storage (as a first launch through
// the proxy leaves them), and vibeOS's network recorded and refused: the
// emulator boots in the file with nothing fetched
const vibe = `${root}vendor/vibeOS/`;
const v86 = `${vibe}scripts/v86/`;
const pins = readFileSync(`${vibe}src/dom/v86files.ts`, 'utf8');
const pinned = (name) =>
	new RegExp(`const ${name} =\\s*'([^']+)'`).exec(pins)[1];
await page.evaluate(
	async ({ name, entries }) => {
		const cache = await caches.open(name);
		for (const [url, data] of entries)
			await cache.put(url, new Response(Uint8Array.fromBase64(data)));
		window.__v86Asked = [];
		vibeHost.fetch = async (url) => {
			window.__v86Asked.push(url);
			return new Response(null, { status: 503 });
		};
	},
	{
		name: /const cacheName = '([^']+)'/.exec(pins)[1],
		entries: [
			[`${pinned('release')}libv86.js`, `${v86}libv86.js`],
			[`${pinned('release')}v86.wasm`, `${v86}v86.wasm`],
			[`${pinned('bios')}seabios.bin`, `${v86}bios/seabios.bin`],
			[`${pinned('bios')}vgabios.bin`, `${v86}bios/vgabios.bin`],
			[`${pinned('images')}freedos722.img`, `${v86}images/freedos722.img`],
		].map(([url, path]) => [url, readFileSync(path).toString('base64')]),
	},
);

// what the page asks for from here on is vibeOS's
network.length = 0;
files.length = 0;
sockets.length = 0;
await page.click('#toolMenu');
await page.click('#menuVibe');
const shown = await until(
	() => {
		const windows = [...document.querySelectorAll('#vibeos-root .vo-window')];
		const panel = document.querySelector(
			'#vibeos-root .vo-window.vo-active .vibe-browser-panel:not([hidden])',
		);
		return {
			vibeos: document.body.classList.contains('vibeos'),
			windows: windows.length,
			inWindow: !!panel?.querySelector('iframe.frame'),
			archive: !!document.getElementById('pm-vibeos'),
		};
	},
	(v) => v?.vibeos && v.inWindow,
	60000,
);
ok(
	'the switch makes the tab a window of vibeOS holding its frame',
	shown?.vibeos && shown.windows === 1 && shown.inWindow,
	JSON.stringify(shown),
);
ok("the archive's text is dropped once unpacked", shown && !shown.archive);
await checkState('into vibeOS', before, hitsBefore);

const desktop = await until(
	() => {
		const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')]
			.map((link) => link.href)
			.filter((href) => href.startsWith('blob:'));
		const wallpaper = getComputedStyle(
			document.getElementById('vo-wallpaper'),
		).backgroundImage;
		const images = [...document.querySelectorAll('#vibeos-root img')].filter(
			(image) => image.src && !image.closest('[hidden]'),
		);
		return {
			sheets: sheets.length,
			wallpaper,
			font: document.fonts.check('16px "Open Sans"', 'vibeOS'),
			images: images.length,
			own: images.every((image) => /^(blob|data):/.test(image.src)),
			broken: images
				.filter((image) => image.complete && image.naturalWidth === 0)
				.map((image) => image.src.slice(0, 60)),
			pending: images.filter((image) => !image.complete).length,
		};
	},
	(v) => v && v.pending === 0 && v.font,
	10000,
);
ok(
	"the desktop's stylesheet, font, wallpaper and icons are the file's own, and every image loads",
	desktop?.sheets >= 1 &&
		desktop.font &&
		/^url\("blob:/.test(desktop.wallpaper) &&
		desktop.images > 3 &&
		desktop.own &&
		desktop.broken.length === 0,
	JSON.stringify(desktop),
);

/** a game from the applications menu: what its frame shows, read by `read` */
async function openGame(name, read, want) {
	await page.click('#vibeos-root .vo-applications:not(.vo-leave)');
	await page.evaluate(
		(label) =>
			[...document.querySelectorAll('#vibeos-root .vo-menu-item')]
				.find((item) => item.textContent.trim() === label)
				.click(),
		name,
	);
	const handle = await until(
		() => !!document.querySelector('#vibeos-root .vo-web-app-frame'),
		Boolean,
	);
	const element = handle
		? await page.$('#vibeos-root .vo-web-app-frame')
		: null;
	const game = await element?.contentFrame();
	const seen = game
		? await until(read, (v) => want(v), 15000, undefined, game)
		: null;
	const src = await element?.evaluate((frame) => frame.src);
	await page.evaluate(() =>
		document
			.querySelector('#vibeos-root .vo-web-app-frame')
			.closest('.vo-window')
			.querySelector('.vo-window-close')
			.click(),
	);
	return { src, seen };
}
const tetris = await openGame(
	'Tetris',
	() => !!document.getElementById('canvas'),
	Boolean,
);
ok(
	'Tetris opens from a blob: URL',
	/^blob:/.test(tetris.src) && tetris.seen === true,
	JSON.stringify(tetris),
);
const game2048 = await openGame(
	'2048',
	async () => {
		await document.fonts.ready;
		return {
			styled:
				getComputedStyle(document.querySelector('.game-container')).position ===
				'relative',
			font: document.fonts.check('16px "Clear Sans"'),
		};
	},
	(v) => v?.styled && v.font,
);
ok(
	'2048 opens from a blob: URL with its stylesheet and font',
	/^blob:/.test(game2048.src) && game2048.seen?.styled && game2048.seen.font,
	JSON.stringify(game2048),
);
const breakout = await openGame(
	'Breakout',
	() =>
		[...document.querySelectorAll('#levels img')].map(
			(image) => image.naturalWidth,
		),
	(v) => v?.length === 2 && v.every((width) => width > 0),
);
ok(
	'Breakout opens from a blob: URL with its images',
	/^blob:/.test(breakout.src) &&
		breakout.seen?.length === 2 &&
		breakout.seen.every((width) => width > 0),
	JSON.stringify(breakout),
);
await page.click('#vibeos-root .vo-applications:not(.vo-leave)');
await page.evaluate(() =>
	[...document.querySelectorAll('#vibeos-root .vo-menu-item')]
		.find((item) => item.textContent.trim() === 'Emulator')
		.click(),
);
const emulator = await until(
	() => ({
		status:
			document.querySelector('#vibeos-root .vibe-emulator-status')
				?.textContent ?? '',
		asked: window.__v86Asked,
	}),
	(v) => v?.status === 'Running FreeDOS' || /^Cannot/.test(v?.status),
	60000,
);
ok(
	'the emulator boots in the file from Cache Storage, fetching nothing',
	emulator?.status === 'Running FreeDOS' && emulator.asked.length === 0,
	JSON.stringify(emulator),
);
await page.evaluate(() =>
	document
		.querySelector('#vibeos-root .vibe-emulator')
		.closest('.vo-window')
		.querySelector('.vo-window-close')
		.click(),
);
await checkState('with the games opened and closed', before, hitsBefore);

await page.click('#vibeos-root .vo-leave');
const back = await page.evaluate(() => ({
	vibeos: document.body.classList.contains('vibeos'),
	inFrames: [...document.querySelectorAll('iframe.frame')].every(
		(frame) => frame.parentNode === document.getElementById('frames'),
	),
}));
ok(
	"back in powerMouse's view the frame is its tab again",
	!back.vibeos && back.inFrames,
	JSON.stringify(back),
);
await checkState('back from vibeOS', before, hitsBefore);

ok(
	'from the switch on no request left the file: none to the network or to file:',
	network.length === 0 &&
		files.length === 0 &&
		sockets.every((url) => url.startsWith(WISP)),
	JSON.stringify({
		network: network.slice(0, 5),
		files: files.slice(0, 5),
		sockets: [...new Set(sockets)],
	}),
);

await done(browser, errors);
