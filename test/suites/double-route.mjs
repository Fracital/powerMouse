// A route of a route is the route. A page that gets hold of its own raw
// proxy URL (a read the rewriter missed) and hands it to a link, a form
// action or location.href ends on the real URL, not on the proxy refusing
// its own origin: every routing hook unwraps a URL that is already a route
// of the scope. The page reads such a link back as it wrote it, as with any
// other URL it writes. A navigation straight to a double-routed URL is redirected
// by the worker to the single route. Both demo modes.
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

const target = `${FIXTURE}pages/double-route.html`;

/** the frame showing the test page at load `loads` or later, with its state */
async function landed(page, loads, timeout = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		for (const frame of page.frames()) {
			const state = await frame
				.evaluate(() => ({
					...window.__double,
					title: document.title,
					raw: location.href,
					// a hook that unwrapped sends no redirect for the worker to answer
					redirects:
						performance.getEntriesByType('navigation')[0]?.redirectCount ??
						null,
				}))
				.catch(() => null);
			if (state?.loads >= loads) return { frame, state };
		}
		await sleep(200);
	}
	const titles = await Promise.all(
		page.frames().map((f) => f.title().catch(() => '?')),
	);
	return { frame: null, state: { titles } };
}

/**
 * The XOR codec of the controller, derived from the route of a known URL
 * (the key is not exposed): encode a string as the controller would. The
 * route is the URL's bytes XORed with the key's stream in URL-safe base64
 * (docs/codec.md), so the route of a long enough known URL gives the stream
 * for any shorter ASCII text.
 */
async function codecOf(page) {
	const known = `https://x.invalid/${'a'.repeat(2000)}`;
	const routed = await page.evaluate(
		(url) => window.controller.route(url),
		known,
	);
	const encoded = routed.slice(routed.lastIndexOf('/html/') + 6);
	const sealed = Buffer.from(encoded, 'base64url');
	if (sealed.length !== known.length) throw new Error('codec not derived');
	const stream = sealed.map((byte, at) => byte ^ known.charCodeAt(at));
	const encode = (input) => {
		if (
			input.length > stream.length ||
			[...input].some((c) => c.charCodeAt(0) > 0x7f)
		)
			throw new Error('not derived for this text');
		return Buffer.from(
			[...input].map((c, at) => c.charCodeAt(0) ^ stream[at]),
		).toString('base64url');
	};
	return { encode, prefix: routed.slice(0, routed.lastIndexOf('/html/') + 6) };
}

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let { frame, state } = await landed(page, 1);
	if (!frame) {
		ok(`${mode}: the test page loads`, false, JSON.stringify(state));
		continue;
	}
	// the page's own raw proxy URL, read where no rewriting reaches
	const raw = state.raw;
	let loads = state.loads;

	const link = await frame.evaluate((url) => window.__double.setLink(url), raw);
	// the real attribute, read in Playwright's utility world where no hook runs
	const unroute = (url) =>
		page.evaluate((routed) => window.controller.unroute(routed), url);
	const realLink = await unroute(
		new URL(await frame.locator('#a').getAttribute('href'), raw).href,
	);
	await frame.evaluate(() => window.__double.click());
	({ frame, state } = await landed(page, loads + 1));
	ok(
		`${mode}: a link set to the raw proxy URL navigates to the real URL (it reads back as written)`,
		link === raw &&
			realLink === target &&
			state.redirects === 0 &&
			state.title === 'DOUBLE' &&
			state.href === target,
		JSON.stringify({ link, realLink, state }),
	);
	loads = state.loads ?? loads + 1;

	if (frame) {
		const action = await frame.evaluate(
			(url) => window.__double.setAction(url),
			raw,
		);
		const realAction = await unroute(
			new URL(await frame.locator('#form').getAttribute('action'), raw).href,
		);
		await frame.evaluate(() => window.__double.submit());
		({ frame, state } = await landed(page, loads + 1));
		ok(
			`${mode}: a form action set to the raw proxy URL submits to the real URL (it reads back as written)`,
			action === raw &&
				realAction === target &&
				// the form route's own redirect, which puts the query in the
				// route, is the worker's: the page counts none, as natively
				state.redirects === 0 &&
				state.title === 'DOUBLE' &&
				state.href === `${target}?via=form`,
			JSON.stringify({ action, realAction, state }),
		);
		loads = state.loads ?? loads + 1;
	}

	if (frame) {
		await frame.evaluate((url) => window.__double.go(url), raw);
		({ frame, state } = await landed(page, loads + 1));
		ok(
			`${mode}: location.href set to the raw proxy URL lands on the real URL`,
			state.redirects === 0 &&
				state.title === 'DOUBLE' &&
				state.href === target,
			JSON.stringify(state),
		);
		loads = state.loads ?? loads + 1;
	}

	if (frame) {
		const { encode, prefix } = await codecOf(page);
		const double = `${prefix}${encode(raw)}`;
		// a native navigation, past every hook: only the worker sees it
		await frame.evaluate((url) => location.replace(url), double);
		({ state } = await landed(page, loads + 1));
		ok(
			`${mode}: a navigation to a double-routed URL lands on the single route`,
			state.redirects === 1 &&
				state.title === 'DOUBLE' &&
				state.href === target &&
				state.raw === raw,
			JSON.stringify({ state, raw, double: double.slice(0, 80) }),
		);
	}
	await page.close();
}
await done(browser);
