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
	PORT,
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
// async=false scripts the page adds to a document it built run in the order
// it added them, a slow one before a fast one, as natively
// (blank-order.html). Scripts the page writes run in place, in the native
// order, a script that writes the next one included (an ad chain), and read
// back as written: their copy is made at once through the synchronous
// bridge, which completes with the transport in the transport worker. With
// the transport in the page the bridge would spin to its limit, so a written
// script does not run there (the known limit). Measured with the demo (its
// transport in the worker) and with a host page per transport host.
// The image events fall where the network puts them: only the scripts' order
// is compared.
const scripts = (order) =>
	order?.written
		?.split(' ')
		.filter((mark) => !mark.startsWith('img'))
		.join(' ');
const orderOf = async (page) => {
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__blankOrder)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
};
const orderPage = await browser.newPage();
await orderPage.goto(`${FIXTURE}pages/blank-order.html`);
const nativeOrder = await orderOf(orderPage);
await orderPage.close();
ok(
	'natively, async=false and written scripts run in order',
	nativeOrder?.dynamic === 'slow fast' &&
		scripts(nativeOrder) === 'a chain b inline',
	JSON.stringify(nativeOrder),
);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/blank-order.html`);
	const order = await orderOf(page);
	ok(
		`${mode}: async=false scripts run in the order they were added`,
		order?.dynamic === nativeOrder?.dynamic,
		JSON.stringify(order),
	);
	ok(
		`${mode}: written scripts run in place, in the native order, and read back as written`,
		scripts(order) === scripts(nativeOrder) &&
			JSON.stringify(order?.writtenSrc) ===
				JSON.stringify(nativeOrder?.writtenSrc),
		JSON.stringify({ native: nativeOrder, proxied: order }),
	);
	await page.close();
}
const WISP = `ws://127.0.0.1:${PORT}/wisp/`;
for (const [host, transport] of [
	['worker', 'descriptor'],
	['page', 'page'],
]) {
	const page = await browser.newPage();
	const query = new URLSearchParams({ wisp: WISP, transport });
	await page.goto(`${FIXTURE}pages/transport-host.html?${query}`);
	await page
		.waitForFunction(() => window.__th?.ready, null, { timeout: 60000 })
		.catch(() => {});
	const booted = await page.evaluate(() => window.__th);
	await page.evaluate(async (fixture) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		// the proxy refuses its own origin, the host page's
		const origin = new URL(fixture).origin.replace('127.0.0.1', 'localhost');
		await window.controller
			.createFrame(element)
			.go(`${origin}/pages/blank-order.html`);
	}, FIXTURE);
	const order = await orderOf(page);
	ok(
		`a ${host}-hosted transport: async=false scripts run in the order they were added`,
		booted?.host === host && order?.dynamic === nativeOrder?.dynamic,
		JSON.stringify({ host: booted?.host, order }),
	);
	ok(
		host === 'worker'
			? 'a worker-hosted transport: written scripts run in place, in the native order'
			: 'a page-hosted transport: a written script does not run (the known limit)',
		booted?.host === host &&
			scripts(order) === (host === 'worker' ? scripts(nativeOrder) : 'inline'),
		JSON.stringify({ host: booted?.host, order, native: scripts(nativeOrder) }),
	);
	await page.close();
}
// CSS in a document no worker controls (blank-css.html): a stylesheet's
// own loads are copied (its url()s, its @import and the import's url()s, its
// font) and it reads back as the page's controlled document reads the same
// stylesheet; a <style>'s rules, a style attribute and a CSSOM write have
// their url()s copied underneath the hooks, so they read back, and the
// page's observer sees them, as on the real site; an inline style that
// changes its image releases the copy it showed.
const CSS_KINDS = [
	...['link-bg', 'import', 'import-bg', 'link-font'],
	...['style-bg', 'attr-bg', 'cssom-bg'],
];
/** the report holding `key` (the ?top run's, or the frame run's) */
const cssOf = async (page, key) => {
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__blankCss)
				.catch(() => null);
			if (value?.done && value[key]) return value;
		}
	}
	return null;
};
const nativeCssPage = await browser.newPage();
await nativeCssPage.goto(`${FIXTURE}pages/blank-css.html`);
const nativeCss = await cssOf(nativeCssPage, 'computed');
await nativeCssPage.close();
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
	await submitLanding(page, `${FIXTURE}pages/blank-css.html?top`);
	const top = (await cssOf(page, 'top'))?.top;
	await page.evaluate(() => (window.__served = []));
	await submitLanding(page, `${FIXTURE}pages/blank-css.html`);
	const css = await cssOf(page, 'computed');
	await sleep(1000);
	const served = await page.evaluate(() => window.__served);
	const missing = CSS_KINDS.filter(
		(kind) => !served.some((url) => url.includes(`css=${kind}`)),
	);
	ok(
		`${mode}: CSS loads go through the worker (a stylesheet's url()s, @import and font, a <style>, a style attribute, a CSSOM write)`,
		missing.length === 0,
		`missing: ${missing.join(', ')}`,
	);
	// a <style>'s rules, a style attribute and a CSSOM write: their copies are
	// set underneath the hooks, so the page reads and observes what it wrote
	const declared = (value) => ({
		sameRule: value?.sameRule,
		style: value?.computed?.style,
		attr: value?.computed?.attr,
		cssom: value?.computed?.cssom,
		attribute: value?.attribute,
		records: value?.records,
	});
	ok(
		`${mode}: a <style>, a style attribute and a CSSOM write read back and are observed as on the real site`,
		JSON.stringify(declared(css)) === JSON.stringify(declared(nativeCss)),
		JSON.stringify({ native: declared(nativeCss), proxied: declared(css) }),
	);
	// an inline style that changes its image releases the copy it showed
	const frame = page.frames().find((f) => f.url() === 'about:blank');
	const restyle = (kind) =>
		frame.evaluate((kind) => {
			const element =
				document.getElementById('restyle') ?? document.createElement('div');
			element.id = 'restyle';
			document.body.append(element);
			element.style.backgroundImage = `url("${new URL(`blank-pixel.svg?css=${kind}`, document.baseURI).href}")`;
		}, kind);
	const inlineCopy = async () => {
		for (let i = 0; i < 20; i++) {
			const style = await frame.locator('#restyle').getAttribute('style');
			const copy = /blob:[^"')#]+/.exec(style ?? '')?.[0];
			if (copy) return copy;
			await sleep(100);
		}
		return null;
	};
	const fetches = (url) =>
		frame.evaluate(
			(url) =>
				fetch(url).then(
					() => true,
					() => false,
				),
			url,
		);
	await restyle('restyle-a');
	const firstCopy = await inlineCopy();
	await restyle('restyle-b');
	await sleep(300);
	const secondCopy = await inlineCopy();
	ok(
		`${mode}: an inline style that changes its image releases the copy it showed`,
		firstCopy !== null &&
			secondCopy !== null &&
			firstCopy !== secondCopy &&
			!(await fetches(firstCopy)) &&
			(await fetches(secondCopy)),
		JSON.stringify({ firstCopy, secondCopy }),
	);
	ok(
		`${mode}: a copied stylesheet reads back as in a controlled document`,
		css?.computed?.link === top?.link &&
			css?.computed?.import === top?.import &&
			top?.link !== 'none',
		JSON.stringify({ frame: css?.computed, top }),
	);
	await page.close();
}
await done(browser);
