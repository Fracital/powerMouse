// A quoted url() in a custom property, in a style's text written by script
// (cssText, `el.style = text`, the attribute), reads back as natively and
// the declaration after it is kept. The kept token of a routed custom
// property is a JSON string (`#url(\"/a.svg\")`), and the raw url() scan
// (rust/rwcss url_at, src/cssURLs.ts RAW_URL) ended a quoted target at its
// first `")`: a text routed again had its routed URL routed as the target,
// which leaked into the page's readback and swallowed what came after it.
// Every cssText write was routed twice (the declaration's Proxy, then the
// hooked prototype setter), so every such write broke. The page
// (test/pages/custom-property-csstext.html) writes each way in itself and in
// an about:blank frame; compared with native in both demo modes, and in
// same-origin mode the raw attributes are checked for a route inside a kept
// token.
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

const target = `${FIXTURE}pages/custom-property-csstext.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';
// Known and left: after `el.style = text` the style attribute is taken back
// from the browser's serialisation (the attribute hook, for an element
// copied with a CSSOM-written style), which quotes every url() as a
// property's value: a custom property's single-quoted or bare url() reads
// back double-quoted. Nothing loads otherwise or is lost.
const KNOWN = /^(page|blank) (single|bare) assign --a$/;

async function collect(find) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__record && window.__record.done
					? JSON.stringify(window.__record)
					: null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const browser = await launch();
const errors = [];

const nativePage = await browser.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(target);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();

const image = `${FIXTURE}pages/blank-cors-image.svg`;
ok(
	'native: a custom property reads as written and loads by var()',
	native['page double cssText --a'] === 'url("/pages/blank-cors-image.svg")' &&
		native['page used cssText background'] === `url("${image}")` &&
		native['blank used assign background'] === `url("${image}")`,
	show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const find = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const proxied = await collect(async () => find());
	const wrong = Object.keys(native)
		.filter(
			(key) =>
				key !== 'done' && !KNOWN.test(key) && proxied[key] !== native[key],
		)
		.map(
			(key) =>
				`${key}: native ${show(native[key])} -> proxied ${show(proxied[key])}`,
		);
	ok(`${mode}: every value as native`, wrong.length === 0, wrong.join('\n'));
	if (mode === 'same-origin') {
		// the attributes as they are, through the host's own getAttribute
		const raw = await page.evaluate(() => {
			const get = Element.prototype.getAttribute;
			const all = [];
			const walk = (w) => {
				all.push(w);
				for (let i = 0; i < w.frames.length; i++) walk(w.frames[i]);
			};
			walk(window);
			const styles = [];
			for (const w of all)
				try {
					for (const element of w.document.querySelectorAll('body > div'))
						styles.push(get.call(element, 'style') ?? '');
				} catch (error) {
					// another origin
				}
			return styles;
		});
		const nested = raw.filter((style) =>
			/#url\(\\*["']?(?:https?:\/\/[^/"\\]*)?\/stomp\//.test(style),
		);
		ok(
			`${mode}: no route is kept as the page's token`,
			raw.length >= 30 && nested.length === 0,
			`${raw.length} styles; ${nested.slice(0, 2).join('\n')}`,
		);
	}
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
