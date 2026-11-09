// Rewriting a stylesheet takes time in proportion to its length. Each url()
// the rewriter routed was spliced into the whole text, which was quadratic:
// CNN's 3 MB of inline CSS with 600 url()s took about 5 s of its load. A
// stylesheet four times as long (four times the url()s) must take about four
// times as long to write into a <style>, not sixteen, and the page reads back
// what it wrote. A ratio, not a time, so a slow runner does not change the
// verdict. Both modes.
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
const PAGE = `${FIXTURE}pages/css-scale.html`;
// linear is about 4; the splicing it replaces measured 10 and more
const LIMIT = 8;

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
	let result = null;
	for (let i = 0; i < 240 && !result; i++) {
		await sleep(250);
		result = await frameOf(page)
			?.evaluate(() => window.__cssScale ?? null)
			.catch(() => null);
	}
	const ratio = (pair) => pair && pair[1] / Math.max(pair[0], 0.1);
	const detail = JSON.stringify({
		write: result?.write.map(Math.round),
		ratio: ratio(result?.write)?.toFixed(1),
	});
	ok(
		`${mode}: a stylesheet four times as long takes about four times as long to write into a <style>`,
		!!result && ratio(result.write) < LIMIT,
		detail,
	);
	ok(
		`${mode}: the page reads back what it wrote`,
		result?.same === true,
		detail,
	);
	await page.close();
}

await done(browser);
