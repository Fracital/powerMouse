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
//
// Nothing here waits by the clock. Which frames run is read off the animation
// frames each counts from its start, over a stretch of the shown frame's own;
// the probes are done when a frame that runs has finished them; a callback is
// cancelled once the shown frame ran thirty. And Chrome's own hold is waited
// for: it reaches a frame of another origin inside a hidden frame of the
// page's origin only with the top document's next layout, so on a page that
// stays as it is that frame ran or not from load to load (the suite then
// compared the proxy with whichever it got), until settle() lays the top out
// again.
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
					order: report.order,
					oneFrame: new Set(report.times).size <= 1,
				},
			];
		}),
	);

// the frame that is shown from the start: the animation frames it counts are
// the clock every wait below is measured on
const SHOWN = 'cross-shown';
const STRETCH = 30;
const read = (frame) => frame.evaluate(() => window.reports).catch(() => null);
const all = (reports, test) =>
	FRAMES.every((name) => reports[name] && test(reports[name]));
// the reports once `settled` holds of them; as they are after `bound` when it
// never does, and the comparison then says what was missing
async function until(frame, settled, bound = 30000) {
	const end = Date.now() + bound;
	for (;;) {
		const reports = await read(frame);
		if ((reports && settled(reports)) || Date.now() > end) return reports;
		await sleep(100);
	}
}
// every frame either runs or is held: over a stretch of the shown frame's
// animation frames, each ran about as many or next to none. One in between
// was stopping (a hold reached it within the stretch): the next stretch
async function steady(frame) {
	for (let attempt = 0; attempt < 20; attempt++) {
		const from = await until(frame, (reports) => all(reports, () => true));
		const to = await until(
			frame,
			(reports) => reports[SHOWN].alive - from?.[SHOWN]?.alive >= STRETCH,
		);
		if (!from || !to) return;
		const ran = FRAMES.map((name) => to[name].alive - from[name].alive);
		if (ran.every((count) => count < 3 || count >= STRETCH / 3)) return;
	}
}
// a frame that runs has finished the probe
const probed = (report) =>
	report.measured.length > 0 && report.order.length === 3;

// before and after the hidden box is shown
async function observe(frame) {
	await until(frame, (reports) => all(reports, () => true));
	await frame.evaluate(() => window.settle()).catch(() => {});
	await steady(frame);
	await frame.evaluate(() => window.go()).catch(() => {});
	await until(
		frame,
		(reports) =>
			reports[SHOWN]?.ticks >= STRETCH &&
			all(reports, (report) => report.ticks < 3 || probed(report)),
	);
	await frame.evaluate(() => window.cancel()).catch(() => {});
	const before = summary(
		await until(frame, (reports) => all(reports, (report) => report.cancelled)),
	);
	await frame.evaluate(() => window.reveal()).catch(() => {});
	const after = summary(
		await until(frame, (reports) =>
			all(reports, (report) => report.ticks >= 3 && probed(report)),
		),
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
