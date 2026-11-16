// A stylesheet and a script the page's markup and its `Link` header both
// name with an integrity (Discord's home page preloads its Webflow
// stylesheet so: `<...css>; rel=preload; as=style; crossorigin;
// integrity="sha384-..."`) apply as natively. The routed copies are
// rewritten, so their bytes are not the ones the hash names: the elements'
// integrity never reaches the browser (DOMAttributes), and the Link header's
// must not either. Kept there, the preload failed its check ("Failed to
// find a valid digest in the 'integrity' attribute"), the page's own
// <link> took the failed preload, and Discord rendered without its
// stylesheet, falling back to a font whose file Discord serves damaged
// (every "OTS parsing error: Size of decompressed WOFF 2.0 is less than
// compressed size" on the page). The same page without the header is the
// control. Compared with the pages loaded natively, in both modes.
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

const PAGES = ['sri-preload', 'sri-plain'];
const browser = await launch();
const integrity = (lines) => lines.filter((line) => /integrity/i.test(line));

const native = {};
for (const name of PAGES) {
	const page = await browser.newPage();
	const lines = [];
	page.on('console', (message) => lines.push(message.text()));
	await page.goto(`${FIXTURE}pages/${name}.html`);
	await page.waitForFunction(() => window.__sri);
	native[name] = await page.evaluate(() => window.__sri);
	await page.close();
	ok(
		`natively, ${name}: the stylesheet applies and the script runs once`,
		native[name].width === '123px' && native[name].script === 1,
		JSON.stringify(native[name]),
	);
	ok(
		`natively, ${name}: no integrity check fails`,
		integrity(lines).length === 0,
		JSON.stringify(integrity(lines)),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const name of PAGES) {
		const page = await openDemo(browser, base);
		const lines = [];
		page.on('console', (message) => lines.push(message.text()));
		await submitLanding(page, `${FIXTURE}pages/${name}.html`);
		let got = null;
		for (let i = 0; i < 80 && !got; i++) {
			await sleep(250);
			for (const frame of page.frames())
				if (/\/stomp\/[\w-]+\/html\//.test(frame.url()))
					got ||= await frame
						.evaluate(() => window.__sri ?? null)
						.catch(() => null);
		}
		ok(`${mode}, ${name}: the page loaded`, !!got);
		ok(
			`${mode}, ${name}: the stylesheet applies and the script runs once, as natively`,
			got?.width === native[name].width && got?.script === native[name].script,
			JSON.stringify({ native: native[name], proxied: got }),
		);
		ok(
			`${mode}, ${name}: no integrity check fails, as natively`,
			integrity(lines).length === 0,
			JSON.stringify(integrity(lines)),
		);
		await page.close();
	}
}
await done(browser);
