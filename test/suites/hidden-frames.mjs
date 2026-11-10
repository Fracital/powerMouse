// A frame of another origin that is not rendered (display:none, or inside
// such a frame) runs no animation frame callbacks in Chrome until it is
// shown; a same-origin one keeps running them. Through the proxy every frame
// is same-origin, so Google Sign-In's hidden button frame on LinkedIn
// measured its unrendered button (0) after a double requestAnimationFrame and
// threw. hidden-frames.html holds frames of both origins hidden and shown;
// what their animation frames did, before and after the hidden box is shown,
// must match the page loaded natively, in both modes. In isolated mode the
// whole proxied page is cross-origin to the host, so Chrome itself holds a
// hidden frame of the page's own origin as well (a known limitation): there
// only the frames of another origin are compared.
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

const target = `${FIXTURE}pages/hidden-frames.html`;
const FRAMES = [
	'cross-hidden',
	'cross-in-hidden',
	'cross-shown',
	'same-hidden',
	'same-outer',
];
const browser = await launch();

// each frame's report, reduced to what does not depend on timing
const summary = (reports) =>
	Object.fromEntries(
		FRAMES.map((name) => {
			const report = reports?.[name];
			if (!report) return [name, 'no report'];
			return [
				name,
				{
					held: report.ticks < 3,
					measured: report.measured,
					cancelledRan: report.cancelledRan,
				},
			];
		}),
	);

// before and after the hidden box is shown
async function observe(frame) {
	for (let i = 0; i < 120; i++) {
		const names = await frame
			?.evaluate(() => Object.keys(window.reports || {}))
			.catch(() => []);
		if (FRAMES.every((name) => names.includes(name))) break;
		await sleep(250);
	}
	await sleep(1500);
	const before = summary(
		await frame.evaluate(() => window.reports).catch(() => null),
	);
	await frame.evaluate(() => window.reveal()).catch(() => {});
	await sleep(1500);
	const after = summary(
		await frame.evaluate(() => window.reports).catch(() => null),
	);
	return { before, after };
}

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await observe(nativePage.mainFrame());
await nativePage.close();
ok(
	'natively, a hidden frame of another origin holds its callbacks until shown',
	native.before['cross-hidden'].held === true &&
		native.before['cross-hidden'].measured.length === 0 &&
		native.after['cross-hidden'].measured[0] === 400 &&
		native.before['same-hidden'].held === false,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let frame = null;
	for (let i = 0; i < 80 && !frame; i++) {
		await sleep(250);
		for (const f of page.frames())
			if (
				/\/stomp\/[\w-]+\/html\//.test(f.url()) &&
				(await f.evaluate(() => document.title).catch(() => '')) ===
					'HIDDEN FRAMES'
			)
				frame = f;
	}
	const proxied = frame ? await observe(frame) : null;
	const compared = (phase) =>
		Object.fromEntries(
			Object.entries(phase ?? {}).filter(
				([name]) => mode === 'same-origin' || name.startsWith('cross-'),
			),
		);
	for (const phase of ['before', 'after'])
		ok(
			`${mode}: the frames' animation frames ${phase} the box is shown are native`,
			JSON.stringify(compared(proxied?.[phase])) ===
				JSON.stringify(compared(native[phase])),
			JSON.stringify({ native: native[phase], proxied: proxied?.[phase] }),
		);
	ok(
		`${mode}: no page errors`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser);
