// Documents a page builds itself that no service worker controls (Chrome
// hands none of them the page's worker: a new frame's about:blank, one the
// page opened or wrote, a popup) load their images, srcset, image inputs,
// scripts, stylesheets, posters and media through the proxy, not from the
// proxy origin's own server: each load fires as on the real site, reaches
// the worker, and reads back (attribute, property, currentSrc, markup) as
// the page wrote it. Compared with the same page loaded natively; both
// demo modes.
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

const target = `${FIXTURE}pages/blank-loads.html`;
const DOCUMENTS = ['initial', 'opened', 'written', 'popup'];
const KINDS = ['img', 'srcset', 'input', 'script', 'link', 'poster', 'audio'];

async function report(page) {
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__blankLoads)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the documents load and read back',
	DOCUMENTS.every((name) => native?.[name]?.img === 'load'),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.evaluate(() => {
		window.__served = [];
		window.controller.addEventListener('request', (event) =>
			window.__served.push(event.detail.url),
		);
	});
	await submitLanding(page, target);
	const proxied = await report(page);
	await sleep(1500);
	const served = await page.evaluate(() => window.__served);
	for (const name of DOCUMENTS) {
		const events = (value) =>
			Object.fromEntries(
				KINDS.filter((k) => k !== 'poster').map((k) => [k, value?.[k]]),
			);
		ok(
			`${mode}: the ${name} document's loads fire as on the real site`,
			JSON.stringify(events(proxied?.[name])) ===
				JSON.stringify(events(native?.[name])),
			JSON.stringify({
				native: events(native?.[name]),
				proxied: events(proxied?.[name]),
			}),
		);
		const missing = KINDS.filter(
			(kind) => !served.some((url) => url.includes(`blank=${name}-${kind}`)),
		);
		ok(
			`${mode}: the ${name} document's loads go through the worker`,
			missing.length === 0,
			`missing: ${missing.join(', ')}`,
		);
		ok(
			`${mode}: the ${name} document reads back as the page wrote it`,
			JSON.stringify(proxied?.[name]?.readback) ===
				JSON.stringify(native?.[name]?.readback),
			JSON.stringify({
				native: native?.[name]?.readback,
				proxied: proxied?.[name]?.readback,
			}),
		);
	}
	// a copy is let go once the element shows another: an image that swaps
	// its source keeps no old blob alive
	const blank = page.frames().find((frame) => frame.url() === 'about:blank');
	const show = (file) =>
		blank.evaluate(
			(file) =>
				new Promise((resolve) => {
					let image = document.getElementById('swap');
					if (!image) {
						image = document.createElement('img');
						image.id = 'swap';
						document.body.append(image);
					}
					image.onload = () => resolve('load');
					image.onerror = () => resolve('error');
					image.src = new URL(file, document.baseURI).href;
					setTimeout(() => resolve('timeout'), 3000);
				}),
			file,
		);
	const real = () => blank.locator('#swap').getAttribute('src');
	const fetches = (url) =>
		blank.evaluate(
			(url) =>
				fetch(url).then(
					() => true,
					() => false,
				),
			url,
		);
	const first = await show('blank-pixel.svg?blank=swap-a');
	const firstCopy = await real();
	const second = await show('blank-pixel.svg?blank=swap-b');
	const secondCopy = await real();
	await sleep(300);
	ok(
		`${mode}: an image that swaps its source releases the copy it showed`,
		first === 'load' &&
			second === 'load' &&
			firstCopy.startsWith('blob:') &&
			secondCopy.startsWith('blob:') &&
			firstCopy !== secondCopy &&
			!(await fetches(firstCopy)) &&
			(await fetches(secondCopy)),
		JSON.stringify({ first, second, firstCopy, secondCopy }),
	);
	await page.close();
}
await done(browser);
