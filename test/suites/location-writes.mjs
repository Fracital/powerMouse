// Every way a script can write the window's location, or another window's,
// navigates through the proxy: test/pages/location-writes.js lists them (var
// bindings at the top level, loop heads, assignment patterns, compound and
// logical assignment, `with`, eval and the other string carriers, inline
// handlers and javascript: URLs, modules, members of self, document, parent,
// frames, opener and top, the reflective setters) and a few controls that
// bind a location of their own. Each case runs in a frame of its own and
// navigates to the same page marked landed. Natively that tells which cases
// navigate and how often each frame loads; through the proxy the same cases
// must land, each on its routed URL, a frame whose case navigates nothing
// must load as often (a write that assigns nothing must not reload; whether
// a navigating case's first document finishes loading is a race), and the
// bypass recorder must see no request straight to the fixture. A write the
// rewriter does not route navigates the frame to the site itself, past the
// proxy. Both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const harness = `${FIXTURE}pages/location-writes.html`;
// a frame's routed URL; a nested frame's names its parent's origin
const ROUTED = /\/stomp\/[\w-]+\/html[/:]/;
const host = new URL(FIXTURE).host;

/** every landed frame of the context: [name, url] */
async function landings(context) {
	const found = [];
	for (const page of context.pages())
		for (const frame of page.frames()) {
			const name = await frame
				.evaluate(() => window.__landed ?? null)
				.catch(() => null);
			if (name !== null) found.push([name, frame.url()]);
		}
	return found;
}

/** the harness frame's state: case names and load counts */
async function harnessState(context) {
	for (const page of context.pages())
		for (const frame of page.frames()) {
			const state = await frame
				.evaluate(() =>
					window.__names
						? { names: window.__names, loads: window.__loads }
						: null,
				)
				.catch(() => null);
			if (state) return state;
		}
	return null;
}

/**
 * Wait until every case frame loaded and every name in `expected` landed
 * (a native run, which does not know them yet, passes none), then until
 * nothing changes for a while: a reload loop or a late write shows in what
 * is returned.
 */
async function settle(context, expected, timeout = 120000) {
	const start = Date.now();
	let last = '';
	let stableSince = Date.now();
	while (Date.now() - start < timeout) {
		await sleep(500);
		const found = await landings(context);
		const state = await harnessState(context);
		const snapshot = JSON.stringify([found.map(([n]) => n).sort(), state]);
		if (snapshot !== last) {
			last = snapshot;
			stableSince = Date.now();
		}
		// every frame loaded once (the harness starts a few at a time)
		const loaded =
			state !== null &&
			state.names.every((name) => (state.loads[name] ?? 0) > 0);
		const all =
			!expected || expected.every((name) => found.some(([n]) => n === name));
		if (loaded && all && Date.now() - stableSince > 3000)
			return { found, state };
	}
	return { found: await landings(context), state: await harnessState(context) };
}

const browser = await launch();

// natively: which cases navigate, and how often each frame loads
const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
await nativePage.goto(harness);
const native = await settle(nativeContext, null, 30000);
const names = native.state?.names ?? [];
const alone = ['top', 'top-pattern', 'top-for-of', 'top-reflect'];
const nativeLanded = new Set(native.found.map(([n]) => n));
for (const name of alone) {
	const page = await nativeContext.newPage();
	await page.goto(`${harness}?only=${name}`);
	for (let i = 0; i < 40 && !nativeLanded.has(name); i++) {
		await sleep(250);
		for (const [n] of await landings(nativeContext)) nativeLanded.add(n);
	}
	await page.close();
}
await nativeContext.close();
ok(
	'natively, every case but the controls navigates',
	names.length > 60 &&
		[...names, ...alone].every(
			(name) =>
				nativeLanded.has(name) ===
				![
					'or-assign',
					'nullish-assign',
					'module-var',
					'function-var',
					'param-pattern',
					'catch',
					'block-let',
					'local-pattern',
				].includes(name),
		),
	JSON.stringify({ names, landed: [...nativeLanded] }),
);

/**
 * The harness (`query` picks cases) in a demo page of its own: what landed,
 * the load counts, the requests that went straight to the fixture, and the
 * URL of each case's frame (a frame keeps its name over navigations)
 */
async function proxiedRun(base, query, expected, timeout) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, `${harness}${query}`);
	const result = await settle(page.context(), expected, timeout);
	result.raw = recorder
		.raw()
		.filter((entry) => new URL(entry.url).host === host)
		.map((entry) => entry.url);
	result.frames = {};
	for (const frame of page.frames())
		if (frame.name().startsWith('case-'))
			(result.frames[frame.name().slice(5)] ??= []).push(
				frame.url().slice(0, 100),
			);
	await page.close();
	return result;
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const expected = names.filter((name) => nativeLanded.has(name));
	const proxied = await proxiedRun(base, '', expected, 60000);
	// A frame load through the proxy now and then never completes while
	// eighty frames load through one controller (seen for a frame of any
	// case, a nested one most often): a case whose frame never loaded runs
	// again alone, and the report says so
	const retried = (proxied.state?.names ?? names).filter(
		(name) => !proxied.state?.loads?.[name],
	);
	for (const name of retried) {
		const again = await proxiedRun(
			base,
			`?only=${name}`,
			nativeLanded.has(name) ? [name] : [],
			30000,
		);
		proxied.found = [
			...proxied.found.filter(([n]) => n !== name),
			...again.found.filter(([n]) => n === name),
		];
		if (proxied.state) proxied.state.loads[name] = again.state?.loads?.[name];
		proxied.raw.push(...again.raw);
		proxied.frames[name] = again.frames[name];
	}
	for (const name of names) {
		const landed = proxied.found.filter(([n]) => n === name);
		const nativeLoads = native.state?.loads?.[name];
		const loads = proxied.state?.loads?.[name];
		const leaked = proxied.raw.filter((url) => url.includes(`c=${name}&`));
		ok(
			`${mode}: ${name} ${nativeLanded.has(name) ? 'lands on its routed URL' : 'navigates nothing'}, as natively`,
			(nativeLanded.has(name)
				? landed.length > 0 && landed.every(([, url]) => ROUTED.test(url))
				: landed.length === 0 && loads === nativeLoads) && leaked.length === 0,
			JSON.stringify({
				landed: landed.map(([, url]) => url.slice(0, 100)),
				frame: proxied.frames[name],
				loads,
				nativeLoads,
				leaked,
				...(retried.includes(name) ? { retried: true } : {}),
			}),
		);
	}

	// the cases that navigate the top page: one page each; the host page
	// itself (the real top) stays where it is
	for (const name of alone) {
		const page = await openDemo(browser, base);
		const context = page.context();
		const recorder = await recordRequests(context);
		const hostURL = page.url();
		await submitLanding(page, `${harness}?only=${name}`);
		let landed = [];
		for (let i = 0; i < 80 && !landed.length; i++) {
			await sleep(250);
			landed = (await landings(context)).filter(([n]) => n === name);
		}
		await sleep(1000);
		const leaked = recorder
			.raw()
			.filter((entry) => new URL(entry.url).host === host)
			.map((entry) => entry.url);
		ok(
			`${mode}: ${name} navigates the top proxied page on its routed URL, not the host`,
			landed.length > 0 &&
				landed.every(([, url]) => ROUTED.test(url)) &&
				// the host keeps its page (its hash follows the frame)
				page.url().split('#')[0] === hostURL.split('#')[0] &&
				leaked.length === 0,
			JSON.stringify({ landed, host: page.url(), leaked }),
		);
		await page.close();
	}
}
await done(browser);
