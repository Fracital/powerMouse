// A view transition in a frame whose viewport forces a scrollbar it has
// nothing to scroll for kills Chrome's renderer ("Aw, Snap!", error code 4,
// a CHECK in cc::draw_property_utils::CalculateDrawProperties; 152 to at
// least 159). Natively such a page is a top-level document and animates; the
// proxy frames every page, and YouTube's watch page starts one on every load
// with its body `overflow-y: scroll`, so proxying it took the tab down. Through
// the proxy each shape must load, run its update callback and leave the tab
// alive, skipping the transition only when it could crash; one without a
// forced scrollbar still animates. Each case gets its own tab: a crash in
// same-origin mode takes the whole host page.
//
// Natively framed (no proxy) the root, body and grow shapes crash the same
// way: it is Chrome's bug, which the proxy has to keep its pages away from.
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

const page = (kind) => `${FIXTURE}pages/view-transition.html?case=${kind}`;
// scrollbars drawn: without them (Playwright's headless default) nothing crashes
const browser = await launch([], { scrollbars: true });

// natively, at the top, every same-document case animates
for (const kind of ['root', 'body', 'grow', 'plain']) {
	const native = await browser.newPage();
	await native.goto(page(kind));
	let vt = null;
	for (let i = 0; i < 40 && !vt?.done; i++) {
		await sleep(250);
		vt = await native.evaluate(() => window.__vt).catch(() => null);
	}
	ok(
		`natively, ${kind}: the transition runs`,
		vt?.done && vt.updated && vt.ready === 'resolved',
		JSON.stringify(vt),
	);
	await native.close();
}

// what the proxied frame recorded, or why it has nothing to say
async function proxied(base, kind, want) {
	const demo = await openDemo(browser, base);
	let crashed = false;
	demo.on('crash', () => (crashed = true));
	await submitLanding(demo, page(kind));
	let vt = null;
	for (let i = 0; i < 80 && !crashed && !want(vt); i++) {
		await sleep(250);
		for (const frame of demo.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url())) {
				const value = await frame.evaluate(() => window.__vt).catch(() => null);
				if (value) vt = value;
			}
	}
	// the renderer of a crashed frame can take a moment to be reported
	await sleep(500);
	const alive =
		!crashed && (await demo.evaluate(() => true).catch(() => false));
	await demo.close().catch(() => {});
	return { alive, vt };
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const kind of ['root', 'body', 'grow']) {
		const { alive, vt } = await proxied(base, kind, (vt) => vt?.done);
		ok(
			`${mode}, ${kind}: the tab survives and the update runs, the transition skipped`,
			alive && vt?.done && vt.updated && vt.ready === 'AbortError',
			JSON.stringify({ alive, vt }),
		);
	}
	{
		const { alive, vt } = await proxied(base, 'plain', (vt) => vt?.done);
		ok(
			`${mode}, plain: without a forced scrollbar the transition still runs`,
			alive && vt?.done && vt.updated && vt.ready === 'resolved',
			JSON.stringify({ alive, vt }),
		);
	}
	{
		const { alive, vt } = await proxied(
			base,
			'xdoc',
			(vt) => vt?.n === 1 && vt.done,
		);
		ok(
			`${mode}, cross-document: the tab survives and the next page loads`,
			alive && vt?.n === 1 && vt.done,
			JSON.stringify({ alive, vt }),
		);
	}
}
await done(browser);
