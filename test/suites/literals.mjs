// A rewritten script computes every literal as natively: BigInts above all.
// Escodegen prints a BigInt only from raw text the parse did not keep, so
// 0n came out as 0 (a Number): arithmetic with BigInts threw, and a large
// one lost its value. Each kind of literal the rewriter reprints (BigInt in
// every base, inside a call the rewriter makes of a computed access, regex
// flags v and d, numbers at the edges of precision, strings with lone
// surrogates and line separators) is compared with the page loaded
// natively, in a script the worker rewrites and an inline one the page's
// client rewrites. Both modes.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/literals.html`;

async function measure(frame) {
	for (let i = 0; i < 80; i++) {
		const value = await frame()
			?.evaluate(() =>
				window.__done
					? { external: window.__external, inline: window.__inline }
					: null,
			)
			.catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every literal computed',
	!!native?.external && !!native?.inline && native.external.zero === 'bigint 0',
	JSON.stringify(native),
);

const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	for (const [where, values] of Object.entries(native ?? {}))
		for (const key of Object.keys(values))
			ok(
				`${mode}: ${where} ${key} as natively`,
				proxied?.[where]?.[key] === values[key],
				`native ${JSON.stringify(values[key])} proxied ${JSON.stringify(proxied?.[where]?.[key])}`,
			);
	await page.close();
}

await done(browser);
