// A Request object the page hands to fetch is sent as natively, whatever
// its mode: the fetch hook passed the page's Request on as the init of the
// routed fetch, which gives the browser its body as a stream, and a no-cors
// or keepalive request may not have one, so fetch threw "If request is
// made from ReadableStream, mode should be same-origin or cors" (npr.org:
// GeoEdge's no-cors POST reports) where natively the bytes go. The page
// (test/pages/request-bodies.html) on 127.0.0.1 posts Request objects to
// localhost (another origin, the same fixture); what each fetch answered
// and what reached /echo-post are compared with the page loaded natively,
// in both modes.
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
const A = new URL(FIXTURE).origin + '/';
const B = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin + '/';
const FIELDS = ['method', 'contentType', 'bodyHex', 'origin'];

const log = (k) => fetch(`${A}echo-post/log?k=${k}`).then((r) => r.json());

async function measure(getFrame, k) {
	let answered = null;
	for (let i = 0; i < 80; i++) {
		answered = await getFrame()
			?.evaluate(() => window.__done ?? null)
			.catch(() => null);
		if (answered) break;
		await sleep(250);
	}
	// (a keepalive or no-cors POST may land after the page heard of it)
	await sleep(500);
	return { answered, recorded: (await log(k)) ?? {} };
}

const pageURL = (k) =>
	`${A}pages/request-bodies.html?to=${encodeURIComponent(B)}&k=${k}`;

const nativePage = await browser.newPage();
await nativePage.goto(pageURL('native'));
const native = await measure(() => nativePage.mainFrame(), 'native');
await nativePage.close();
const shapes = Object.keys(native.answered ?? {});
ok(
	'natively: every Request is sent, and reaches the origin',
	shapes.length === 6 &&
		shapes.every(
			(shape) =>
				!/^threw/.test(native.answered[shape]) && native.recorded[shape],
		),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const k = `prox-${mode}`;
	const page = await openDemo(browser, base);
	await submitLanding(page, pageURL(k));
	const proxied = await measure(
		() =>
			page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
		k,
	);
	for (const shape of shapes) {
		ok(
			`${mode}: fetch of a ${shape} Request answers as natively`,
			proxied.answered?.[shape] === native.answered[shape],
			`native ${native.answered[shape]} -> proxied ${proxied.answered?.[shape]}`,
		);
		const n = native.recorded[shape];
		const p = proxied.recorded[shape];
		const diffs = p
			? FIELDS.filter((f) => (n?.[f] ?? null) !== (p[f] ?? null)).map(
					(f) =>
						`${f}: native ${JSON.stringify(n?.[f] ?? null)} proxied ${JSON.stringify(p[f] ?? null)}`,
				)
			: ['did not arrive'];
		ok(
			`${mode}: a ${shape} Request reaches the origin as natively`,
			diffs.length === 0,
			diffs.join('; '),
		);
	}
	await page.close();
}

await done(browser);
