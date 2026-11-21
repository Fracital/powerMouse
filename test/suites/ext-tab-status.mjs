// A tab's status as the extensions see it (docs/extensions.md, "Tabs"),
// against Chrome's own, with no network: a probe that records
// tabs.onUpdated, webNavigation's events of the tab's top and what
// tabs.query says of the tab, installed once the tab's page has loaded (as
// a user installs Tampermonkey, whose per-tab icon waits for 'complete'),
// then the same steps natively (the probe loaded over CDP,
// Extensions.loadUnpacked) and in the demo (isolated host, same-origin
// host, the site pool, and dialing):
// - after the install, tabs.query says the loaded tab is 'complete';
// - a link to another page, pushState, a fragment, the page's Back and
//   Forward within the document and across documents, its reload, and the
//   browser's own Back and reload: tabs.onUpdated's changes (status, url,
//   title, favIconUrl) and the top's onBeforeNavigate, onCommitted (its
//   transition and qualifiers), onDOMContentLoaded, onCompleted,
//   onHistoryStateUpdated and onReferenceFragmentUpdated in Chrome's
//   order, and the tab 'complete' at the end of each;
// - under the pool, the tab's documents are on its slots (the probe's
//   background stays on the hub's origin).
// Where this Chrome loads no unpacked extension over CDP, only the tab's
// status is checked.
/* global step -- the fixture page's (test/pages/tab-status.js) */
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
	SLOTS,
	submitLanding,
} from '../lib.mjs';

const PAGE_A = `${FIXTURE}pages/tab-status-a.html`;

const probe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Tab status probe',
		version: '1.0',
		permissions: ['tabs', 'webNavigation'],
		host_permissions: ['<all_urls>'],
		background: { service_worker: 'sw.js' },
		// (as Tampermonkey's: in every frame from its start, both worlds)
		content_scripts: [
			{
				matches: ['<all_urls>'],
				js: ['cs.js'],
				run_at: 'document_start',
				all_frames: true,
			},
			{
				matches: ['<all_urls>'],
				js: ['cs.js'],
				run_at: 'document_start',
				all_frames: true,
				world: 'MAIN',
			},
		],
	}),
	'cs.js': 'document.documentElement.dataset.probe = "ran";',
	'sw.js': `self.log = [];
const ours = (url) => typeof url === 'string' && url.includes('/pages/tab-status');
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (ours(tab.url) || ours(change.url)) self.log.push(['onUpdated', change, tab.status]);
});
for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated'])
	chrome.webNavigation[name].addListener((details) => {
		if (details.frameId === 0 && ours(details.url))
			self.log.push([name, details.url, details.transitionType ? [details.transitionType, ...details.transitionQualifiers].join('+') : null]);
	});
self.tabNow = async () => {
	const tabs = await chrome.tabs.query({});
	const tab = tabs.find((tab) => ours(tab.url));
	return tab ? { status: tab.status, url: tab.url, title: tab.title } : null;
};
self.take = () => self.log.splice(0);`,
};

/** a URL as both arms give it: its path, query and fragment */
const local = (url) => {
	try {
		const parsed = new URL(url);
		return parsed.pathname + parsed.search + parsed.hash;
	} catch (error) {
		return String(url);
	}
};

/** the log of one step, as words both arms can compare */
const words = (log) =>
	log.map(([name, a, b]) =>
		name === 'onUpdated'
			? `onUpdated ${Object.keys(a)
					.sort()
					.map((key) => `${key}=${/url/i.test(key) ? local(a[key]) : a[key]}`)
					.join(' ')} (${b})`
			: `${name} ${local(a)}${b ? ` ${b}` : ''}`,
	);

const STEPS = [
	['link', true],
	['push', false],
	['fragment', false],
	['back', false],
	['back', false],
	['back', true],
	['forward', true],
	['reload', true],
	// the browser's own Back and reload (the demo's buttons)
	['host-back', true],
	['host-reload', true],
];

/**
 * Run the steps in one arm: `doc()` is the tab's top document (a playwright
 * Frame), `bg(fn)` evaluates in the probe's background, `host(what)` is the
 * browser's own Back or reload, `place()` the origin the tab's document is
 * on (the demo's)
 */
async function walk({ doc, bg, host, place }) {
	const out = { initial: null, steps: [] };
	out.initial = await bg(() => self.tabNow());
	await bg(() => self.take());
	for (const [what, crosses] of STEPS) {
		const start = Date.now();
		if (what.startsWith('host-')) await host(what);
		else
			await (await doc()).evaluate((what) => step(what), what).catch(() => {});
		// until the step's onUpdated says complete (every step's ends so,
		// natively), then a while for what Chrome tells after it (the icon)
		while (Date.now() - start < 15000) {
			const told = await bg(() =>
				self.log.some(
					([name, change]) =>
						name === 'onUpdated' && change.status === 'complete',
				),
			).catch(() => false);
			if (told) break;
			await sleep(100);
		}
		await sleep(crosses ? 1500 : 900);
		const where = (await place?.()) ?? null;
		const log = await bg(() => self.take());
		const now = await bg(() => self.tabNow());
		out.steps.push({ what, log: words(log), now, where });
	}
	return out;
}

/** the native arm: Chrome with the probe loaded over CDP */
async function nativeArm() {
	const dir = mkdtempSync(join(tmpdir(), 'stomp-tab-status-'));
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
		const tab = await context.newPage();
		await tab.goto(PAGE_A);
		await sleep(500);
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
		return await walk({
			doc: async () => tab.mainFrame(),
			bg: (fn) => worker.evaluate(fn),
			host: (what) =>
				(what === 'host-back'
					? tab.goBack({ waitUntil: 'commit' })
					: tab.reload({ waitUntil: 'commit' })
				).catch(() => {}),
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
		await submitLanding(page, PAGE_A);
		let top = null;
		for (let tries = 0; tries < 150; tries++) {
			top = await activeFrame(page);
			const ready = await top
				?.evaluate(() => document.readyState === 'complete' && !!window.step)
				.catch(() => false);
			if (ready) break;
			top = null;
			await sleep(200);
		}
		if (!top) return { error: 'the tab never loaded page A' };
		await sleep(500);
		const id = await page.evaluate(
			async (bytes) =>
				(
					await window.controller.extensions.install(
						new Uint8Array(bytes).buffer,
						{ filename: 'tab-status-probe.zip' },
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
			throw new Error(
				`no background for ${id} among ${JSON.stringify(page.frames().map((frame) => frame.name()))}`,
			);
		};
		let frame = await background();
		await sleep(300);
		return await walk({
			host: (what) =>
				page.click(what === 'host-back' ? '#toolBack' : '#toolReload'),
			doc: async () => (await activeFrame(page)) ?? top,
			place: async () => {
				const url = (await activeFrame(page))?.url();
				return url ? new URL(url).origin : null;
			},
			bg: async (fn) => {
				try {
					return await frame.evaluate(fn);
				} catch (error) {
					frame = await background();
					return frame.evaluate(fn);
				}
			},
		});
	} finally {
		if (page.errors.length)
			console.log(`${base} page errors:`, JSON.stringify(page.errors));
		await page.close();
	}
}

let native;
try {
	native = await nativeArm();
} catch (error) {
	native = { skipped: String(error.stack ?? error) };
}
if (native.skipped)
	console.log(
		`native arm skipped: this Chrome loads no unpacked extension over CDP (${native.skipped.split('\n')[0]})`,
	);
else console.log('native:', JSON.stringify(native, null, 1));

const browser = await launch();
const arms = [
	['isolated host', `${HOST}?nopool`, false],
	['same-origin host', `${PROXY}?nopool`, false],
	['isolated host, site pool', HOST, true],
	['same-origin host, site pool', PROXY, true],
	['dialing', `${HOST}?mode=just-call-stomp`, false],
];
const slotOrigins = SLOTS.map((slot) => new URL(slot).origin);
for (const [mode, base, pooled] of arms) {
	let got;
	try {
		got = await demoArm(browser, base);
	} catch (error) {
		got = { error: String(error.stack ?? error) };
	}
	console.log(`${mode}:`, JSON.stringify(got, null, 1));
	ok(`${mode}: the arm ran`, !got.error, got.error);
	if (got.error) continue;
	ok(
		`${mode}: after the install tabs.query says the loaded tab is complete`,
		got.initial?.status === 'complete',
		JSON.stringify(got.initial),
	);
	if (pooled)
		ok(
			`${mode}: the tab's documents are on the pool's slots`,
			slotOrigins.length > 0 &&
				got.steps.every((step) => slotOrigins.includes(step.where)),
			JSON.stringify([slotOrigins, got.steps.map((step) => step.where)]),
		);
	for (const [index, step] of got.steps.entries()) {
		ok(
			`${mode}: step ${index + 1} (${step.what}) ends with the tab complete`,
			step.now?.status === 'complete',
			JSON.stringify(step.now),
		);
		if (native.skipped) continue;
		const want = native.steps[index];
		// (the icon of an entry Chrome's favicons have is told while the
		// document loads, before or after its DOMContentLoaded as their
		// lookup comes back: its place among the loading's events is no
		// order of Chrome's, whether it is told while loading or after is)
		const icon = (word) => word.startsWith('onUpdated favIconUrl=');
		const order = (log) => [
			...log.filter((word) => !icon(word)),
			...log.filter(icon),
		];
		ok(
			`${mode}: step ${index + 1} (${step.what}) tells what Chrome tells, in its order`,
			JSON.stringify(order(step.log)) === JSON.stringify(order(want.log)),
			`${JSON.stringify(step.log)} natively ${JSON.stringify(want.log)}`,
		);
	}
}
await done(browser);
