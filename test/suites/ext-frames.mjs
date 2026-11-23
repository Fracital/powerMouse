// An extension's view of a tab's frames (docs/extensions.md), against
// Chrome's own, with no network: a probe whose content scripts run in every
// frame (all_frames), with match_about_blank, with match_origin_as_fallback,
// with neither, and in the top only, loaded natively (over CDP,
// Extensions.loadUnpacked) and in the demo (isolated and same-origin host).
// The fixture page (test/pages/ext-frames.html) has a frame with a frame
// of its own and an about:blank one, a srcdoc frame, an about:blank frame
// the page writes, a blob: frame, a data: frame, a frame whose host does not
// resolve, and a link that opens a tab:
// - which scripts run in which frame (about:blank and about:srcdoc with
//   match_about_blank, blob: and data: too with match_origin_as_fallback,
//   none of them without, the frames only with all_frames), and the
//   sender.frameId each one's message carries;
// - webNavigation's events of every frame, each with its frameId and its
//   real parentFrameId (-1 for the top), and onErrorOccurred for the frame
//   that fails;
// - getAllFrames' frames and parents;
// - scripting.executeScript({ files }) in every frame: each frame's result
//   is the last file's completion value, in both worlds;
// - the opened tab's openerTabId.
// Frame ids are compared by what they name (a frame's URL, under its
// parent's), never by number. Where this Chrome loads no unpacked
// extension over CDP, the demo's arms are checked against what Chrome is
// documented to do.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
	activeFrame,
	CHROME,
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

const PAGE = `${FIXTURE}pages/ext-frames.html`;
const SITE = 'http://127.0.0.1/*';

const report = (name) =>
	`chrome.runtime.sendMessage({ cs: ${JSON.stringify(name)}, href: location.href }).catch(() => {});`;

const probe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Frames probe',
		version: '1.0',
		permissions: ['tabs', 'webNavigation', 'scripting'],
		host_permissions: ['<all_urls>'],
		background: { service_worker: 'sw.js' },
		content_scripts: [
			{
				matches: [SITE],
				js: ['blank.js'],
				all_frames: true,
				match_about_blank: true,
			},
			{
				matches: [SITE],
				js: ['origin.js'],
				all_frames: true,
				match_origin_as_fallback: true,
			},
			{ matches: [SITE], js: ['plain.js'], all_frames: true },
			{ matches: [SITE], js: ['top.js'], match_about_blank: true },
			{
				matches: [SITE],
				js: ['start.js'],
				all_frames: true,
				match_about_blank: true,
				run_at: 'document_start',
			},
		],
	}),
	'blank.js': report('blank'),
	'origin.js': report('origin'),
	'plain.js': report('plain'),
	'top.js': report('top'),
	'start.js': report('start'),
	// executeScript's files: the result is the last file's completion value
	'exec-a.js': `'first file';`,
	'exec.js': `var execRan = (self.execRan || 0) + 1;
if (self.document) 'r:' + execRan;`,
	'sw.js': `self.log = [];
self.ran = [];
self.created = [];
self.targets = [];
const ours = (url) => typeof url === 'string' && (url.includes('/pages/ext-frames') || /^(about|blob|data):/.test(url) || url.includes('.invalid'));
chrome.runtime.onMessage.addListener((message, sender) => {
	if (message && message.cs) self.ran.push([message.cs, message.href, sender.frameId, sender.tab ? sender.tab.id : -1]);
});
for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred'])
	chrome.webNavigation[name].addListener((details) => {
		if (ours(details.url))
			self.log.push([name, details.tabId, details.frameId, details.parentFrameId, details.url, details.error ?? null]);
	});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) =>
	self.targets.push([details.sourceTabId, details.sourceFrameId, details.tabId, details.url]));
chrome.tabs.onCreated.addListener((tab) => self.created.push([tab.id, tab.openerTabId ?? null, tab.pendingUrl || tab.url || '']));
self.tabOf = async () => {
	const tabs = await chrome.tabs.query({});
	const tab = tabs.find((tab) => (tab.url || '').includes('/pages/ext-frames.html'));
	return tab ? tab.id : null;
};
self.exec = async (tabId) => {
	const out = {};
	const run = async (key, injection) => {
		try {
			const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, ...injection });
			out[key] = results.map((result) => [result.frameId, result.result === undefined ? 'undefined' : result.result]);
		} catch (error) {
			out[key] = String(error.message || error);
		}
	};
	await run('isolated', { files: ['exec-a.js', 'exec.js'] });
	await run('main', { files: ['exec.js'], world: 'MAIN' });
	await run('first', { files: ['exec-a.js'] });
	return out;
};
self.frames = async (tabId) => (await chrome.webNavigation.getAllFrames({ tabId })).map((frame) => [frame.frameId, frame.parentFrameId, frame.url]);`,
};

/** a URL as both arms give it */
const named = (url) => {
	if (typeof url !== 'string') return String(url);
	if (url.startsWith('about:')) return url;
	if (url.startsWith('blob:')) return 'blob:';
	if (url.startsWith('data:')) return 'data:';
	if (url.includes('.invalid')) return 'invalid';
	try {
		const parsed = new URL(url);
		return (parsed.pathname + parsed.search).replace('/pages/', '');
	} catch (error) {
		return url;
	}
};

/**
 * What one arm saw, in words that do not depend on its frame ids: each
 * frame is its URL under its parent's (`top`, `top>ext-frames-child.html`)
 */
function words(got) {
	const tab = got.tab;
	const urls = new Map([[0, 'top']]);
	const parents = new Map();
	for (const [name, tabId, frameId, parentFrameId, url] of got.log) {
		if (tabId !== tab) continue;
		if (name === 'onCommitted' || !urls.has(frameId))
			urls.set(frameId, frameId === 0 ? 'top' : named(url));
		if (!parents.has(frameId) || name === 'onCommitted')
			parents.set(frameId, parentFrameId);
	}
	for (const [frameId, parentFrameId, url] of Array.isArray(got.frames)
		? got.frames
		: []) {
		if (!urls.has(frameId)) urls.set(frameId, named(url));
		if (!parents.has(frameId)) parents.set(frameId, parentFrameId);
	}
	const label = (frameId, depth = 0) => {
		if (frameId === 0) return 'top';
		if (frameId === -1) return '-';
		if (!urls.has(frameId) || depth > 8) return `?${named(urls.get(frameId))}`;
		const parent = parents.get(frameId);
		return `${parent === undefined ? '?' : label(parent, depth + 1)}>${urls.get(frameId)}`;
	};
	const sorted = (list) => [...new Set(list)].sort();
	return {
		// (natively a blob: frame tells its commit and nothing else, and
		// getAllFrames lists none: Chrome 157)
		navigation: sorted(
			got.log
				.filter(
					([, tabId, , , url]) => tabId === tab && !url.startsWith('blob:'),
				)
				.map(
					// (an error is a net:: one: the proxy cannot tell why a
					// host was out of reach, so its name may differ)
					([name, , frameId, parentFrameId, , error]) =>
						`${name} ${label(frameId)} parent=${label(parentFrameId)}${error ? ` ${/^net::ERR_[A-Z_]+$/.test(error) ? 'net::ERR' : error}` : ''}`,
				),
		),
		// (by the frame, not the script's location.href: through the proxy a
		// blob: document's location reads its creator's URL)
		ran: sorted(
			got.ran
				.filter(([, , , tabId]) => tabId === tab)
				.map(([cs, , frameId]) => `${cs} in ${label(frameId)}`),
		),
		frames: sorted(
			(Array.isArray(got.frames) ? got.frames : [])
				.filter(([, , url]) => !url.startsWith('blob:'))
				.map(
					([frameId, parentFrameId]) =>
						`${label(frameId)} parent=${label(parentFrameId)}`,
				),
		),
		exec: Object.fromEntries(
			Object.entries(got.exec ?? {}).map(([key, value]) => [
				key,
				Array.isArray(value)
					? sorted(
							value.map(([frameId, result]) => `${label(frameId)} ${result}`),
						)
					: value,
			]),
		),
		// (the tabs made after the page's)
		opener: got.created
			.slice(got.created.findIndex(([id]) => id === tab) + 1)
			.map(([, opener]) => (opener === tab ? 'the page' : String(opener))),
		targets: got.targets.map(
			([sourceTabId, sourceFrameId, tabId, url]) =>
				`${sourceTabId === tab ? 'the page' : sourceTabId} ${label(sourceFrameId)} ${tabId === tab ? 'itself' : 'a new tab'} ${named(url)}`,
		),
	};
}

/** load the page, open its tab, then take what the probe's background saw */
async function walk({ load, bg, click }) {
	await load();
	let tab = null;
	for (let tries = 0; tries < 100 && tab === null; tries++) {
		tab = await bg(() => self.tabOf()).catch(() => null);
		if (tab === null) await sleep(100);
	}
	// the frames load and the content scripts run
	await sleep(4000);
	await click();
	await sleep(2500);
	return {
		tab,
		log: await bg(() => self.log),
		ran: await bg(() => self.ran),
		created: await bg(() => self.created),
		targets: await bg(() => self.targets),
		frames: await bg((tabId) => self.frames(tabId), tab).catch((error) =>
			String(error),
		),
		exec: await bg((tabId) => self.exec(tabId), tab).catch((error) =>
			String(error),
		),
	};
}

/** the native arm: Chrome with the probe loaded over CDP */
async function nativeArm() {
	const dir = mkdtempSync(join(tmpdir(), 'stomp-ext-frames-'));
	const extension = join(dir, 'probe');
	for (const [path, text] of Object.entries(probe)) {
		mkdirSync(join(extension, path, '..'), { recursive: true });
		writeFileSync(join(extension, path), text);
	}
	const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
		executablePath: CHROME,
		headless: false, // (--headless=new below: the old headless runs no extension)
		args: [
			'--headless=new',
			'--no-sandbox',
			'--no-first-run',
			'--enable-unsafe-extension-debugging',
			'--disable-features=DisableLoadExtensionCommandLineSwitch',
		],
		ignoreDefaultArgs: [
			'--disable-extensions',
			'--enable-automation',
			'--disable-component-extensions-with-background-pages',
			'--headless',
			'--hide-scrollbars',
		],
	});
	try {
		const session = await context.browser().newBrowserCDPSession();
		let id;
		try {
			({ id } = await session.send('Extensions.loadUnpacked', {
				path: extension,
			}));
		} catch (error) {
			return { skipped: String(error.message ?? error) };
		}
		let worker = null;
		for (let tries = 0; tries < 100 && !worker; tries++) {
			worker =
				context
					.serviceWorkers()
					.find((candidate) =>
						candidate.url().startsWith(`chrome-extension://${id}/`),
					) ?? null;
			if (!worker) await sleep(100);
		}
		if (!worker) return { skipped: 'the probe started no service worker' };
		const tab = await context.newPage();
		return await walk({
			load: () => tab.goto(PAGE).catch(() => {}),
			bg: (fn, arg) => worker.evaluate(fn, arg),
			click: () => tab.click('#open').catch(() => {}),
		});
	} finally {
		await Promise.race([context.close().catch(() => {}), sleep(10000)]);
		rmSync(dir, { recursive: true, force: true });
	}
}

/** a probe's files as a stored ZIP (the demo installs it as a file) */
function zip(files) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc32 = (data) => {
		let c = 0xffffffff;
		for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
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
const PROBE_ZIP = [...zip(probe)];

/** the demo's arm, at `base` (its query picks the mode) */
async function demoArm(browser, base) {
	const page = await openDemo(browser, base);
	try {
		const id = await page.evaluate(
			async (bytes) =>
				(
					await window.controller.extensions.install(
						new Uint8Array(bytes).buffer,
						{ filename: 'ext-frames-probe.zip' },
					)
				).id,
			PROBE_ZIP,
		);
		const background = async () => {
			for (let tries = 0; tries < 100; tries++) {
				for (const frame of page.frames()) {
					if (!frame.name().startsWith('ext-context:background')) continue;
					const found = await frame
						.evaluate(() => globalThis.chrome?.runtime?.id ?? null)
						.catch(() => null);
					if (found === id) return frame;
				}
				await sleep(200);
			}
			throw new Error('the probe started no background');
		};
		let frame = await background();
		return await walk({
			load: async () => {
				await submitLanding(page, PAGE);
				for (let tries = 0; tries < 150; tries++) {
					const top = await activeFrame(page);
					const ready = await top
						?.evaluate(() => document.readyState === 'complete')
						.catch(() => false);
					if (ready) return;
					await sleep(200);
				}
			},
			click: async () => {
				const top = await activeFrame(page);
				await top?.click('#open').catch(() => {});
			},
			bg: async (fn, arg) => {
				try {
					return await frame.evaluate(fn, arg);
				} catch (error) {
					frame = await background();
					return frame.evaluate(fn, arg);
				}
			},
		});
	} finally {
		if (page.errors.length)
			console.log(`${base} page errors:`, JSON.stringify(page.errors));
		await page.close();
	}
}

/**
 * What Chrome does, where this Chrome loads no extension over CDP to say
 * so (Chrome 157, measured with this suite's native arm)
 */
const CHROME_WORDS = null;

let native;
try {
	native = await nativeArm();
} catch (error) {
	native = { skipped: String(error.stack ?? error) };
}
let want = CHROME_WORDS;
if (native.skipped)
	console.log(
		`native arm skipped: this Chrome loads no unpacked extension over CDP (${native.skipped.split('\n')[0]})`,
	);
else {
	console.log('native:', JSON.stringify(native));
	want = words(native);
	console.log('native words:', JSON.stringify(want, null, 1));
}

const browser = await launch();
for (const [mode, base] of [
	['isolated host', `${HOST}?nopool`],
	['same-origin host', `${PROXY}?nopool`],
]) {
	let got;
	try {
		got = await demoArm(browser, base);
	} catch (error) {
		got = { error: String(error.stack ?? error) };
	}
	ok(`${mode}: the arm ran`, !got.error, got.error);
	if (got.error) continue;
	console.log(`${mode}:`, JSON.stringify(got));
	const seen = words(got);
	console.log(`${mode} words:`, JSON.stringify(seen, null, 1));
	if (!want) continue;
	const same = (name, a, b) =>
		ok(
			`${mode}: ${name} as Chrome's`,
			JSON.stringify(a) === JSON.stringify(b),
			`${JSON.stringify(a)} natively ${JSON.stringify(b)}`,
		);
	same('the content scripts that run in each frame', seen.ran, want.ran);
	same(
		"webNavigation's events of each frame, with its parent",
		seen.navigation,
		want.navigation,
	);
	same("getAllFrames' frames and their parents", seen.frames, want.frames);
	same(
		"executeScript's files' results, in an isolated world",
		seen.exec.isolated,
		want.exec.isolated,
	);
	same(
		"executeScript's files' results, in the main world",
		seen.exec.main,
		want.exec.main,
	);
	same("executeScript's one file's result", seen.exec.first, want.exec.first);
	same("the opened tab's openerTabId", seen.opener, want.opener);
	same(
		"webNavigation.onCreatedNavigationTarget's source",
		seen.targets,
		want.targets,
	);
}
await done(browser);
