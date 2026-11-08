// HTML the page loader must preserve: <template> contents (they live in
// .content, not childNodes, and the cloner used to drop them) and the
// document's own character encoding (header charset, <meta charset>, BOM),
// which the service worker has to decode before rewriting.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);

async function load(file, key) {
	await submitLanding(page, `${FIXTURE}pages/${file}`);
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		// every load opens a new tab: the newest proxied frame is the one
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		try {
			const value = await frame.evaluate((k) => window[k], key);
			if (value) return value;
		} catch (error) {
			// navigating
		}
	}
	return null;
}

const tpl = await load('template.html', '__tpl');
ok(
	'template contents survive the page load',
	tpl?.contentChildren === 2,
	JSON.stringify(tpl),
);
ok(
	'template content can be cloned into the page',
	tpl?.cloned === 2,
	JSON.stringify(tpl),
);

async function text(file) {
	await submitLanding(page, `${FIXTURE}pages/${file}`);
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		// every load opens a new tab: the newest proxied frame is the one
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		try {
			const value = await frame.evaluate(
				() => document.getElementById('t')?.textContent,
			);
			if (value) return value;
		} catch (error) {
			// navigating
		}
	}
	return null;
}

for (const [file, expected, why] of [
	[
		'sjis.html.bin',
		'\u65e5\u672c\u8a9e',
		'Shift_JIS from the Content-Type header',
	],
	['cp1252.html.bin', 'caf\u00e9', 'windows-1252 from <meta charset>'],
	[
		'utf16.html.bin',
		'\u00fcn\u00efcode',
		'a UTF-16 BOM over a wrong header charset',
	],
]) {
	const got = await text(file);
	ok(`${why} decodes`, got === expected, JSON.stringify(got));
}

// Raw text (script, style, noscript) and template contents as the page wrote
// them: a no-break space in a JSON script reached React as "&nbsp;" (BBC's
// hydration errors), and a <style> in a declarative shadow root became a
// script that throws there (MDN). Each value is the page's own reading,
// natively and through the proxy.
const native = await browser.newPage();
await native.goto(`${FIXTURE}pages/raw-text.html.bin`);
await native.waitForFunction(() => window.__raw, null, { timeout: 15000 });
const expected = await native.evaluate(() => window.__raw);
await native.close();
const raw = await load('raw-text.html.bin', '__raw');
for (const [key, why] of [
	['json', 'a no-break space in a JSON script'],
	['js', 'a no-break space in an inline script'],
	['css', 'a no-break space in a <style>'],
	['text', 'a no-break space in text'],
	['noscript', 'a <style> in a <noscript>'],
	['shadow', 'a <style> in a declarative shadow root'],
	['shadowColor', 'the declarative shadow root style applies'],
	['template', 'a <style> in a template stays a style'],
	['errors', 'the page throws nothing'],
])
	ok(
		`${why} reads as natively`,
		JSON.stringify(raw?.[key]) === JSON.stringify(expected[key]),
		`proxied ${JSON.stringify(raw?.[key])}, native ${JSON.stringify(expected[key])}`,
	);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
