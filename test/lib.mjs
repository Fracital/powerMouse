// Shared helpers for the browser suites in test/suites/. A suite is a plain
// script: it prints one `PASS name` / `FAIL name - detail` line per check and
// exits non-zero when anything failed, so it can be run on its own against a
// running demo server (`PORT=8080 node test/suites/back.mjs`) or by
// test/run.mjs, which starts the servers and runs every suite one at a time.
//
// Environment:
//   PORT     demo server port (default 8090). http://localhost:PORT/ is the
//            host page in origin-isolation mode (proxy on 127.0.0.1);
//            http://127.0.0.1:PORT/ opens the same-origin controller.
//   FIXTURE  base URL of test/fixture.mjs (default http://127.0.0.1:8084/)
//   CHROME   Chrome binary (default /usr/bin/google-chrome)
//   SHOTS    when set, suites write screenshots to test/out/
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const PORT = process.env.PORT || '8090';
export const HOST = `http://localhost:${PORT}/`;
export const PROXY = `http://127.0.0.1:${PORT}/`;
export const FIXTURE = process.env.FIXTURE || 'http://127.0.0.1:8084/';
export const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

/** one check; `detail` is printed after the name so a failure explains itself */
export function ok(name, condition, detail = '') {
	if (!condition) failures++;
	console.log(
		(condition ? 'PASS ' : 'FAIL ') + name + (detail ? ` - ${detail}` : ''),
	);
	return !!condition;
}

/** close the browser, print the verdict, exit with the failure count */
export async function done(browser, extra = []) {
	if (extra.length) console.log('page errors:', extra);
	await browser?.close();
	console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
	process.exit(failures ? 1 : 0);
}

export async function waitForServer(url, tries = 60) {
	for (let i = 0; ; i++) {
		try {
			await fetch(url);
			return;
		} catch (error) {
			if (i >= tries) throw new Error(`no server at ${url}`, { cause: error });
			await sleep(500);
		}
	}
}

/**
 * Headless Chrome. Every hostname except the loopback ones fails to resolve,
 * so a request that bypasses the proxy fails loudly instead of silently
 * reaching the real site. `*.localhost` stays resolvable too: the WPT suites
 * use www.localhost as a same-site, cross-origin host for the fixture.
 */
/**
 * `args`: more Chrome flags (e.g. an autoplay policy for media suites).
 * `scrollbars`: draw scrollbars as a user's Chrome does; Playwright hides them
 * in headless mode (`--hide-scrollbars`), and a bug that needs one never shows.
 */
export async function launch(args = [], { scrollbars = false } = {}) {
	return chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: [
			'--no-sandbox',
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
			...args,
		],
		...(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
	});
}

/**
 * Every request the browser makes in `context`, from any page, frame, worker
 * or service worker, WebSocket handshakes included, each classified: `worker`
 * (the proxy origin under the scope, served by the service worker), `proxy`
 * (the proxy origin outside it: the demo's own files, its wisp socket),
 * `host` (the isolated host page's origin), `raw` (any other origin: it
 * reached the network without the proxy) or `local` (data:, blob:, about:).
 * A raw request to a target a proxied page named is a bypass. Requests are
 * recorded from the call on; `raw()` lists the raw ones.
 */
export async function recordRequests(context, { scope = '/stomp/' } = {}) {
	const proxy = new URL(PROXY);
	const host = new URL(HOST);
	const log = [];
	const classify = (url) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			return 'local';
		}
		if (!/^(https?|wss?):$/.test(parsed.protocol)) return 'local';
		if (parsed.host === proxy.host)
			return parsed.pathname.startsWith(scope) ? 'worker' : 'proxy';
		if (parsed.host === host.host) return 'host';
		return 'raw';
	};
	const add = (url, type, source) =>
		log.push({ url, type, source, kind: classify(url) });
	context.on('request', (request) => {
		let source;
		if (request.serviceWorker()) source = 'service-worker';
		else
			try {
				source = request.frame().parentFrame() ? 'frame' : 'page';
			} catch (error) {
				source = 'worker';
			}
		add(request.url(), request.resourceType(), source);
	});
	// Playwright reports no worklet module request (measured): every page,
	// and every frame in a process of its own, is watched over CDP too. An
	// audio worklet's module request shows in neither (measured): not
	// recorded
	const watched = new WeakSet();
	const watchTarget = async (target, source) => {
		if (watched.has(target)) return;
		watched.add(target);
		try {
			const session = await context.newCDPSession(target);
			session.on('Network.requestWillBeSent', ({ request, type }) =>
				add(request.url, type ?? 'other', `${source}-cdp`),
			);
			await session.send('Network.enable');
		} catch (error) {
			// a frame in its parent's process has no session of its own
		}
	};
	const watch = (page) => {
		page.on('websocket', (socket) => add(socket.url(), 'websocket', 'page'));
		watchTarget(page, 'page');
		page.on('framenavigated', (frame) => {
			if (frame.parentFrame()) watchTarget(frame, 'frame');
		});
	};
	for (const page of context.pages()) watch(page);
	context.on('page', watch);
	// Playwright reports no request of a shared worker (measured): those
	// targets are watched over CDP, each through its own session
	const browser = context.browser();
	if (browser) {
		const cdp = await browser.newBrowserCDPSession();
		let id = 0;
		cdp.on('Target.targetCreated', async ({ targetInfo }) => {
			if (targetInfo.type !== 'shared_worker') return;
			try {
				const { sessionId } = await cdp.send('Target.attachToTarget', {
					targetId: targetInfo.targetId,
					flatten: false,
				});
				await cdp.send('Target.sendMessageToTarget', {
					sessionId,
					message: JSON.stringify({ id: ++id, method: 'Network.enable' }),
				});
			} catch (error) {
				// the worker went before it could be watched
			}
		});
		cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
			const { method, params } = JSON.parse(message);
			if (method === 'Network.requestWillBeSent')
				add(params.request.url, params.type ?? 'other', 'shared-worker');
		});
		await cdp.send('Target.setDiscoverTargets', { discover: true });
		context.on('close', () => cdp.detach().catch(() => {}));
	}
	return {
		log,
		raw: () => log.filter((entry) => entry.kind === 'raw'),
	};
}

/** a page on the demo's landing screen with the controller ready */
export async function openDemo(browser, base = HOST, viewport = {}) {
	await waitForServer(base);
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800, ...viewport },
	});
	const errors = [];
	const stacks = [];
	page.on('pageerror', (error) => {
		errors.push(error.message);
		stacks.push(error.stack || error.message);
	});
	page.errors = errors;
	// the same errors with their stacks, in the same order
	page.errorStacks = stacks;
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	return page;
}

/**
 * The uncaught errors of a page loaded natively (pages, frames and dedicated
 * workers report through `pageerror`), as a live list of messages
 */
export function trackErrors(page) {
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	return errors;
}

/**
 * The errors a proxied load raised that the native load of the same page did
 * not: `proxied` minus `native`, message by message, so an error the page
 * throws natively too (a probe's own TypeError) is not the proxy's. With
 * `stacks` (the proxied errors' stacks, in order) each comes with its stack.
 */
export function proxiedOnlyErrors(native, proxied, stacks = []) {
	const left = new Map();
	for (const message of native) left.set(message, (left.get(message) ?? 0) + 1);
	const extra = [];
	proxied.forEach((message, i) => {
		const count = left.get(message) ?? 0;
		if (count) left.set(message, count - 1);
		else extra.push(stacks[i] ?? message);
	});
	return extra;
}

export function screenshot(page, name) {
	if (!process.env.SHOTS) return Promise.resolve();
	mkdirSync(OUT, { recursive: true });
	return page.screenshot({
		path: `${OUT}${name}.png`,
		animations: 'disabled',
		timeout: 60000,
	});
}

/** the visible tab's frame (hidden tabs keep display, so look at the class) */
export async function activeFrame(page) {
	const handle = await page.$('.frame:not(.hidden)');
	return handle ? handle.contentFrame() : null;
}

/** poll the active proxied frame until `pred` (evaluated inside it) holds */
export async function waitActive(page, pred, timeout = 40000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const frame = await activeFrame(page);
		if (frame) {
			try {
				if (await frame.evaluate(pred)) return frame;
			} catch (error) {
				// the frame is navigating; try again
			}
		}
		await sleep(250);
	}
	throw new Error('frame condition timeout');
}

export const omni = (page) =>
	page.evaluate(() => document.querySelector('#omni input').value);

export const onLanding = (page) =>
	page.evaluate(
		() =>
			!document.getElementById('landing').classList.contains('hidden') &&
			!document.body.classList.contains('recents'),
	);

/** type a URL into the landing form (opens a new tab) */
export const submitLanding = (page, url) =>
	page.evaluate((u) => {
		const form = document.getElementById('mainForm');
		form.url.value = u;
		form.requestSubmit();
	}, url);

/** type a URL into the omnibox (navigates the active tab) */
export const submitOmni = (page, url) =>
	page.evaluate((u) => {
		const form = document.getElementById('omni');
		form.url.value = u;
		form.requestSubmit();
	}, url);

/** bounding boxes of every element matching `selector`, rounded */
export const rects = (page, selector) =>
	page.evaluate(
		(sel) =>
			[...document.querySelectorAll(sel)].map((element) => {
				const r = element.getBoundingClientRect();
				return [
					Math.round(r.left),
					Math.round(r.top),
					Math.round(r.width),
					Math.round(r.height),
				];
			}),
		selector,
	);

export const near = (a, b, tolerance) =>
	a.length === b.length &&
	a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= tolerance));

/** click a Wikipedia article link inside the active frame that is not in `visited` */
export async function clickWikipediaLink(page, visited) {
	const frame = await waitActive(
		page,
		`[...document.links].some((x) => /^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/[^:#?]+$/.test(x.href) && !${JSON.stringify(visited)}.includes(x.href) && !/Main_Page|Wikipedia$/.test(x.href))`,
	);
	await frame.evaluate((v) => {
		const a = [...document.links].find(
			(x) =>
				/^https:\/\/en\.wikipedia\.org\/wiki\/[^:#?]+$/.test(x.href) &&
				!v.includes(x.href) &&
				!/Main_Page|Wikipedia$/.test(x.href),
		);
		a.click();
	}, visited);
}
