// A link with a download attribute saves what the real site would serve,
// under the name the browser picks there. Chrome hands no download to a
// service worker, so the proxy fetches it and the browser saves the copy.
// Same-origin links (plain, named, an image map's area, one whose response
// names the file in Content-Disposition) and a blob: link,
// compared with the same page loaded natively; both demo modes.
import { readFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/download.html`;

/** the downloads a page started, by order: suggested name and body */
function collect(page) {
	const saved = [];
	page.on('download', async (download) => {
		const entry = { name: download.suggestedFilename() };
		saved.push(entry);
		const path = await download.path().catch(() => null);
		entry.failure = await download.failure();
		entry.body = path ? readFileSync(path, 'utf8').slice(0, 200) : null;
	});
	return saved;
}

async function finished(page) {
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__download)
				.catch(() => null);
			if (value?.done) return true;
		}
	}
	return false;
}

const browser = await launch();
const nativeContext = await browser.newContext({ acceptDownloads: true });
const nativePage = await nativeContext.newPage();
const native = collect(nativePage);
await nativePage.goto(target);
await finished(nativePage);
await sleep(1000);
await nativeContext.close();
ok(
	'natively, every link downloads',
	native.length === 5 && native.every((entry) => entry.body !== null),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	const proxied = collect(page);
	await submitLanding(page, target);
	await finished(page);
	await sleep(1000);
	const strip = (entries) => entries.map(({ name, body }) => ({ name, body }));
	ok(
		`${mode}: every link downloads what the real site serves, under the same name`,
		JSON.stringify(strip(proxied)) === JSON.stringify(strip(native)),
		JSON.stringify({ native: strip(native), proxied }),
	);
	await context.close();
}
await done(browser);
