// Loads named outside an element's src or href in documents a page builds
// itself, which no service worker controls (a new frame's about:blank, one
// the page opened, a popup): SVG references (blank-svg.html), FontFace
// sources (blank-fonts.html) and constructed, adopted stylesheets
// (blank-sheets.html). Each goes
// through the proxy, not to the proxy origin's own server: it fires and
// reads back as on the real site and reaches the worker, and nothing the
// page names loads past the proxy. Compared with the same page loaded
// natively; both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const host = new URL(FIXTURE).host;

/** the report `key` holds once it is done, from whichever frame has it */
async function reportOf(page, key) {
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate((key) => window[key], key)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

/** the keys whose values differ, native then proxied */
const differences = (native, proxied) =>
	Object.fromEntries(
		[...new Set([...Object.keys(native ?? {}), ...Object.keys(proxied ?? {})])]
			.filter(
				(key) =>
					JSON.stringify(native?.[key]) !== JSON.stringify(proxied?.[key]),
			)
			.map((key) => [key, { native: native?.[key], proxied: proxied?.[key] }]),
	);

const CASES = [
	{
		name: 'SVG references',
		page: 'blank-svg.html',
		key: '__blankSvg',
		marker: 'svg',
		documents: ['initial', 'opened', 'written', 'popup'],
		// what fires, and what reaches the worker
		events: ['image', 'xlink', 'use', 'script'],
		loads: ['image', 'xlink', 'use', 'feimage', 'script'],
		// an SVG image that changes its href releases the copy it showed
		async afterwards(page, mode) {
			const blank = page
				.frames()
				.find((frame) => frame.url() === 'about:blank');
			const show = (file) =>
				blank.evaluate(
					(file) =>
						new Promise((resolve) => {
							let image = document.getElementById('swap');
							if (!image) {
								const svg = document.createElementNS(
									'http://www.w3.org/2000/svg',
									'svg',
								);
								image = document.createElementNS(
									'http://www.w3.org/2000/svg',
									'image',
								);
								image.id = 'swap';
								svg.append(image);
								document.body.append(svg);
							}
							image.onload = () => resolve('load');
							image.onerror = () => resolve('error');
							image.setAttribute('href', new URL(file, document.baseURI).href);
							setTimeout(() => resolve('timeout'), 3000);
						}),
					file,
				);
			const real = () => blank.locator('#swap').getAttribute('href');
			const fetches = (url) =>
				blank.evaluate(
					(url) =>
						fetch(url).then(
							() => true,
							() => false,
						),
					url,
				);
			const first = await show('blank-pixel.svg?svg=swap-a');
			const firstCopy = await real();
			const second = await show('blank-pixel.svg?svg=swap-b');
			const secondCopy = await real();
			await sleep(300);
			ok(
				`${mode}: an SVG image that changes its href releases the copy it showed`,
				first === 'load' &&
					second === 'load' &&
					firstCopy?.startsWith('blob:') &&
					secondCopy?.startsWith('blob:') &&
					firstCopy !== secondCopy &&
					!(await fetches(firstCopy)) &&
					(await fetches(secondCopy)),
				JSON.stringify({ first, second, firstCopy, secondCopy }),
			);
		},
	},
	{
		name: 'FontFace sources',
		page: 'blank-fonts.html',
		key: '__blankFonts',
		marker: 'font',
		documents: ['initial', 'opened', 'popup'],
		// FontFace.load and document.fonts.load
		events: ['face', 'set'],
		loads: ['face', 'set'],
	},
	{
		name: 'constructed sheets',
		page: 'blank-sheets.html',
		key: '__blankSheets',
		marker: 'sheet',
		documents: ['initial', 'opened', 'popup'],
		events: [],
		// replaceSync, replace and its font, insertRule (in a shadow root)
		loads: ['sync', 'replace', 'font', 'insert'],
		// an @import, which a constructed sheet drops
		never: ['import'],
		// a sheet whose rules change releases the copy it no longer shows
		async afterwards(page, mode) {
			const blank = page
				.frames()
				.find((frame) => frame.url() === 'about:blank');
			await blank.evaluate(() => {
				document.documentElement.dataset.swap = '';
				window.__swap = new CSSStyleSheet();
				document.adoptedStyleSheets = [
					...document.adoptedStyleSheets,
					window.__swap,
				];
			});
			const show = (kind) =>
				blank.evaluate((kind) => {
					const url = new URL(
						`blank-pixel.svg?sheet=swap-${kind}`,
						document.baseURI,
					).href;
					window.__swap.replaceSync(
						`.swap { background-image: url("${url}"); }`,
					);
				}, kind);
			const copy = async (other) => {
				for (let i = 0; i < 30; i++) {
					const text = await realSheet(page, blank, '[data-swap]');
					const url = /blob:[^"')#\\]+/.exec(text ?? '')?.[0];
					if (url && url !== other) return url;
					await sleep(100);
				}
				return null;
			};
			const fetches = (url) =>
				blank.evaluate(
					(url) =>
						fetch(url).then(
							() => true,
							() => false,
						),
					url,
				);
			await show('a');
			const firstCopy = await copy(null);
			await show('b');
			const secondCopy = await copy(firstCopy);
			await sleep(300);
			ok(
				`${mode}: a constructed sheet whose rules change releases the copy it showed`,
				firstCopy !== null &&
					secondCopy !== null &&
					!(await fetches(firstCopy)) &&
					(await fetches(secondCopy)),
				JSON.stringify({ firstCopy, secondCopy }),
			);
		},
	},
];

/**
 * The text the browser holds for the last sheet adopted by the about:blank
 * frame whose document matches `selector`, read in an isolated world: the
 * page's own cssText reads back the page's URLs, not the copies. The
 * session is the frame's process's (its parent's, an out-of-process frame
 * in isolated mode, else the page's).
 */
async function realSheet(page, frame, selector) {
	const cdp = await page
		.context()
		.newCDPSession(frame.parentFrame())
		.catch(() => page.context().newCDPSession(page));
	try {
		const { frameTree } = await cdp.send('Page.getFrameTree');
		const frames = [];
		const walk = (node) => {
			frames.push(node.frame);
			for (const child of node.childFrames ?? []) walk(child);
		};
		walk(frameTree);
		for (const frame of frames) {
			if (frame.url !== 'about:blank') continue;
			const { executionContextId } = await cdp.send(
				'Page.createIsolatedWorld',
				{ frameId: frame.id, worldName: 'blank-sources' },
			);
			// the sheet is the page's object: found through the document,
			// which both worlds share
			const { result } = await cdp.send('Runtime.evaluate', {
				contextId: executionContextId,
				returnByValue: true,
				expression: `document.querySelector(${JSON.stringify(selector)}) && [...document.adoptedStyleSheets.at(-1).cssRules].map((rule) => rule.cssText).join(' ')`,
			});
			if (result.value) return result.value;
		}
		return null;
	} finally {
		await cdp.detach().catch(() => {});
	}
}

const browser = await launch();
const natives = {};
for (const test of CASES) {
	const page = await browser.newPage();
	const requested = [];
	page.context().on('request', (request) => requested.push(request.url()));
	await page.goto(`${FIXTURE}pages/${test.page}`);
	natives[test.page] = await reportOf(page, test.key);
	await page.close();
	const never = (test.never ?? []).filter((kind) =>
		requested.some(
			(url) => url.includes(`${test.marker}=`) && url.includes(`-${kind}`),
		),
	);
	if (test.never)
		ok(
			`natively, the ${test.name} never load ${test.never.join(', ')}`,
			never.length === 0,
			JSON.stringify(never),
		);
	ok(
		`natively, the ${test.name} load in every document`,
		test.documents.every((name) =>
			test.events.every(
				// a written script runs while the page writes: no event to see
				(kind) =>
					[undefined, 'load'].includes(natives[test.page]?.[name]?.[kind]),
			),
		),
		JSON.stringify(natives[test.page]),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const test of CASES) {
		const native = natives[test.page];
		const page = await openDemo(browser, base);
		const recorder = await recordRequests(page.context());
		await page.evaluate(() => {
			window.__served = [];
			window.controller.addEventListener('request', (event) =>
				window.__served.push(event.detail.url),
			);
		});
		await submitLanding(page, `${FIXTURE}pages/${test.page}`);
		const proxied = await reportOf(page, test.key);
		await sleep(1000);
		const served = await page.evaluate(() => window.__served);
		const raw = recorder
			.raw()
			.filter((entry) => new URL(entry.url).host === host)
			.map((entry) => entry.url);
		ok(
			`${mode}: no ${test.name} load reaches the site past the proxy`,
			raw.length === 0,
			JSON.stringify([...new Set(raw)]),
		);
		for (const name of test.documents) {
			const events = (value) =>
				Object.fromEntries(test.events.map((kind) => [kind, value?.[kind]]));
			ok(
				`${mode}: the ${name} document's ${test.name} fire as on the real site`,
				JSON.stringify(events(proxied?.[name])) ===
					JSON.stringify(events(native?.[name])),
				JSON.stringify({
					native: events(native?.[name]),
					proxied: events(proxied?.[name]),
				}),
			);
			const missing = test.loads.filter(
				(kind) =>
					!served.some((url) => url.includes(`${test.marker}=${name}-${kind}`)),
			);
			const loaded = (test.never ?? []).filter((kind) =>
				served.some((url) => url.includes(`${test.marker}=${name}-${kind}`)),
			);
			ok(
				`${mode}: the ${name} document's ${test.name} go through the worker`,
				missing.length === 0 && loaded.length === 0,
				`missing: ${missing.join(', ')}; loaded: ${loaded.join(', ')}`,
			);
			ok(
				`${mode}: the ${name} document's ${test.name} read back as the page wrote them`,
				JSON.stringify(proxied?.[name]?.readback) ===
					JSON.stringify(native?.[name]?.readback),
				JSON.stringify(
					differences(native?.[name]?.readback, proxied?.[name]?.readback),
				),
			);
		}
		ok(
			`${mode}: the ${test.name} throw nothing in the page`,
			page.errors.length === 0,
			JSON.stringify(page.errors),
		);
		await test.afterwards?.(page, mode);
		await page.close();
	}
}
await done(browser);
