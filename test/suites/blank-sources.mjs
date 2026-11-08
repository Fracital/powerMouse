// Loads named outside an element's src or href in documents a page builds
// itself, which no service worker controls (a new frame's about:blank, one
// the page opened, a popup): SVG references (blank-svg.html) and FontFace
// sources (blank-fonts.html). Each goes
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
];

const browser = await launch();
const natives = {};
for (const test of CASES) {
	const page = await browser.newPage();
	await page.goto(`${FIXTURE}pages/${test.page}`);
	natives[test.page] = await reportOf(page, test.key);
	await page.close();
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
			ok(
				`${mode}: the ${name} document's ${test.name} go through the worker`,
				missing.length === 0,
				`missing: ${missing.join(', ')}`,
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
		await test.afterwards?.(page, mode);
		await page.close();
	}
}
await done(browser);
