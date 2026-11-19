// The worker's HTTP cache against Chrome's, shape by shape
// (docs/http-cache.md): a page fetches a URL three times under each
// Cache-Control shape (test/pages/http-cache.html) and the fixture says what
// each fetch asked of it: nothing (the cache answered), a conditional
// request (the cache had the origin confirm its entry), or a plain one.
// The same page runs natively and through the proxy in both modes, and
// each shape's report (what the origin was asked, what the page got) is
// compared. HC_ONLY=<text> runs the shapes whose name has it.
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
	submitOmni,
} from '../lib.mjs';

// Shapes known to differ from Chrome, by why, with what the proxy does
// (docs/http-cache.md). A shape on the list that now reads as natively
// fails: take it off.
const KNOWN_BY_REASON = {
	'an entry made for a request with credentials is confirmed with the origin before a request with other credentials is given it (fetched again when it has no validator), where Chrome hands it over':
		{
			'max-age=3600, another cookie each time': {
				asked: ['200', '200', '200'],
				got: ['200 #1', '200 #2', '200 #3'],
			},
			'max-age=3600 with an ETag, another cookie each time': {
				asked: ['200', '304 if-none-match', '304 if-none-match'],
				got: ['200 #1', '200 #1', '200 #1'],
			},
			'private, max-age=3600, another cookie each time': {
				asked: ['200', '200', '200'],
				got: ['200 #1', '200 #2', '200 #3'],
			},
		},
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, shapes]) =>
		Object.entries(shapes).map(([name, does]) => [name, { why, does }]),
	),
);

const only = process.env.HC_ONLY ?? '';
// (a run of its own in the fixture's log, whatever ran against it before)
const run = Date.now().toString(36);
const pageURL = (k) =>
	`${FIXTURE}pages/http-cache.html?k=${k}-${run}${
		only ? `&only=${encodeURIComponent(only)}` : ''
	}`;

/** the page's report, from whichever frame holds it */
async function report(page) {
	for (let i = 0; i < 480; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame?.evaluate(() => window.__hc).catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const browser = await launch();

if (!['reloads', 'credentials', 'history'].includes(only)) {
	const nativePage = await browser.newPage();
	await nativePage.goto(pageURL('native'));
	const native = await report(nativePage);
	await nativePage.context().close();
	ok(
		'natively, the page fetched every shape',
		native !== null &&
			native.error === undefined &&
			Object.keys(native.cases).length > 0,
		JSON.stringify(native?.error),
	);
	// what the comparison rests on, so a change in the browser shows here first
	if (!only)
		ok(
			'natively, a fresh entry is not asked for, no-cache with a validator gets a 304 each time and no-store a body',
			JSON.stringify(native?.cases['max-age=3600']) ===
				'{"asked":["200","not asked","not asked"],"got":["200 #1","200 #1","200 #1"]}' &&
				JSON.stringify(native?.cases['no-cache with an ETag']) ===
					'{"asked":["200","304 if-none-match","304 if-none-match"],"got":["200 #1","200 #1","200 #1"]}' &&
				JSON.stringify(native?.cases['no-store with an ETag']) ===
					'{"asked":["200","200","200"],"got":["200 #1","200 #2","200 #3"]}',
			JSON.stringify([
				native?.cases['max-age=3600'],
				native?.cases['no-cache with an ETag'],
				native?.cases['no-store with an ETag'],
			]),
		);
	if (process.env.HC_PRINT)
		for (const [name, value] of Object.entries(native?.cases ?? {}))
			console.log(
				`  native | ${name} | ${value.asked.join(' ; ')} | ${value.got.join(' ; ')}`,
			);

	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await submitLanding(page, pageURL(mode));
		const proxied = await report(page);
		ok(
			`${mode}: the page fetched every shape`,
			proxied !== null &&
				proxied.error === undefined &&
				Object.keys(proxied.cases).length ===
					Object.keys(native?.cases ?? {}).length,
			JSON.stringify(proxied?.error),
		);
		for (const name of Object.keys(native?.cases ?? {})) {
			const want = JSON.stringify(native.cases[name]);
			const got = JSON.stringify(proxied?.cases[name] ?? null);
			const detail = `\n      native  ${want}\n      proxied ${got}`;
			const known = KNOWN.get(name);
			if (!known) ok(`${mode}: ${name}, as natively`, want === got, detail);
			else if (want === got)
				ok(
					`${mode}: ${name} (known: ${known.why})`,
					false,
					`now as natively: take it off the list${detail}`,
				);
			else
				ok(
					`${mode}: ${name} differs as known (${known.why})`,
					got === JSON.stringify(known.does),
					detail,
				);
		}
		await page.context().close();
	}
}

// A top-level document that is fresh by its Last-Modified alone, shown,
// shown again, reloaded, reloaded with the tab, and hard-reloaded with the
// tab (Ctrl+Shift+R): natively the cache answers the second showing, a
// reload has the origin confirm the document and a hard reload fetches it
// and the image in it past the caches. Through the proxy a reload of the tab reloads the host
// page, which shows its page again with a new navigation: the controller
// tells the worker how the host was loaded (src/controller/hostReload.ts).
if (!only || only === 'reloads') {
	const doc = (name) =>
		`${FIXTURE}http-cache/doc?k=reloads-${run}&n=${name}&lm=864000&html=1&img=1`;
	/** what the origin was asked by each step, once the step's document shows */
	const walk = async (name, page, shows, steps) => {
		const each = [];
		const seen = [0, 0];
		for (const step of steps) {
			await step();
			for (let i = 0; i < 80 && !(await shows()); i++) await sleep(250);
			await sleep(1000);
			const log = await (
				await fetch(`${FIXTURE}http-cache/log?k=reloads-${run}`)
			).json();
			// the document, then the image in it
			each.push(
				[name, `${name}-img`].map((resource, index) => {
					const all = log[resource]?.asked ?? [];
					const mine = all.slice(seen[index]).join(' / ') || 'not asked';
					seen[index] = all.length;
					return mine;
				}),
			);
		}
		return JSON.stringify(each);
	};
	const hard = async (page) => {
		const session = await page.context().newCDPSession(page);
		await session.send('Page.reload', { ignoreCache: true });
		await session.detach();
	};
	// (a step's document is a new one: the last one's mark is gone)
	const fresh = (frame) =>
		frame
			.evaluate(() => {
				if (!/^#\d+$/.test(document.body?.textContent ?? '')) return false;
				if (window.__seen) return false;
				return (window.__seen = true);
			})
			.catch(() => false);

	const nativeTab = await browser.newPage();
	const native = await walk(
		'native',
		nativeTab,
		() => fresh(nativeTab.mainFrame()),
		[
			() => nativeTab.goto(doc('native')),
			() => nativeTab.goto(doc('native')),
			() => nativeTab.reload(),
			() => nativeTab.reload(),
			() => hard(nativeTab),
		],
	);
	await nativeTab.context().close();
	ok(
		'natively, a heuristically fresh document is not asked for when shown again, confirmed on a reload, and fetched with its image on a hard reload',
		native ===
			JSON.stringify([
				['200', '200'],
				['not asked', 'not asked'],
				['304 if-modified-since cache-control: max-age=0', 'not asked'],
				['304 if-modified-since cache-control: max-age=0', 'not asked'],
				[
					'200 cache-control: no-cache pragma: no-cache',
					'200 cache-control: no-cache pragma: no-cache',
				],
			]),
		native,
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		const proxied = await walk(
			mode,
			page,
			async () => {
				for (const frame of page.frames())
					if (
						/\/stomp\/[\w-]+\/html\//.test(frame.url()) &&
						(await fresh(frame))
					)
						return true;
				return false;
			},
			[
				() => submitLanding(page, doc(mode)),
				() => submitOmni(page, doc(mode)),
				() => page.click('#toolReload'),
				() => page.reload(),
				() => hard(page),
			],
		);
		ok(
			`${mode}: a heuristically fresh document shown again, reloaded, reloaded with the tab and hard-reloaded with the tab asks the origin as natively`,
			proxied === native,
			`\n      native  ${native}\n      proxied ${proxied}`,
		);
		await page.context().close();
	}
}

// Back to a document made for a request with a cookie, after the page
// set another: Chrome's Back asks its HTTP cache to take whatever entry it
// has, however stale and whatever cookies the request carries now, so the
// origin is not asked (the suite's browser has no back/forward cache, as
// for a frame, whose history steps never use it). The proxy's rule for
// other credentials (above, and the credentials rows below) is for every
// other request: the step shows again the page its history entry showed.
// Again after another tab added entries: the demo's Back then takes the
// step with location.replace (src/controller/history.ts), and the
// controller tells the worker it is a history step all the same.
if (!only || only === 'history') {
	const idle = (n) =>
		`${FIXTURE}pages/http-cache.html?k=idle-${run}&only=none&n=${n}`;
	const path = '/http-cache/history';
	const doc = (mode) =>
		`${FIXTURE}${path.slice(1)}?k=history-${run}&n=${mode}&cc=${encodeURIComponent('max-age=3600')}&html=1`;
	const link = (url) => {
		const a = document.createElement('a');
		a.href = url;
		document.body.append(a);
		a.click();
	};
	// (each showing of a page is a new document: the last one's mark is gone)
	const isIdle = () => {
		if (!window.__hc?.done || window.__seen) return false;
		return (window.__seen = true);
	};
	const isDoc = () => {
		if (!/^#\d+$/.test(document.body?.textContent ?? '')) return false;
		if (window.__seen) return false;
		return (window.__seen = true);
	};
	/** the frame (of `frames()`) where `pred` holds */
	const showing = async (frames, pred, arg) => {
		for (let i = 0; i < 160; i++) {
			for (const frame of frames())
				if (await frame.evaluate(pred, arg).catch(() => false)) return frame;
			await sleep(250);
		}
		throw new Error('not shown');
	};
	const walk = async (mode, frames, back, between) => {
		let frame = await showing(frames, isIdle);
		await frame.evaluate((line) => {
			document.cookie = line;
		}, `hch=1; path=${path}`);
		frame.evaluate(link, doc(mode)).catch(() => {});
		frame = await showing(frames, isDoc);
		await frame.evaluate((line) => {
			document.cookie = line;
		}, `hch=2; path=${path}`);
		frame.evaluate(link, idle('2')).catch(() => {});
		await showing(frames, isIdle);
		if (between) await between(link);
		await back();
		await showing(frames, isDoc);
		await sleep(500);
		const log = await (
			await fetch(`${FIXTURE}http-cache/log?k=history-${run}`)
		).json();
		const asked = log[mode]?.asked ?? [];
		return JSON.stringify([
			asked[0] ?? 'not asked',
			asked.slice(1).join(' / ') || 'not asked',
		]);
	};
	// (the other tab: a page, then a link from it)
	const otherTab = async (frames, open, link) => {
		await open();
		const frame = await showing(frames, isIdle);
		frame.evaluate(link, idle('4')).catch(() => {});
		await showing(frames, isIdle);
	};
	const variants = [
		['', false],
		[', after another tab added entries', true],
	];
	for (const [said, tabs] of variants) {
		const name = (mode) => (tabs ? `${mode}-tabs` : mode);
		const context = await browser.newContext();
		const nativeTab = await context.newPage();
		await nativeTab.goto(idle('1'));
		let other = null;
		const native = await walk(
			name('native'),
			() => [nativeTab.mainFrame(), ...(other ? [other.mainFrame()] : [])],
			async () => {
				await nativeTab.bringToFront();
				await nativeTab.goBack();
			},
			tabs
				? (link) =>
						otherTab(
							() => [other.mainFrame()],
							async () => {
								other = await context.newPage();
								await other.goto(idle('3'));
							},
							link,
						)
				: null,
		);
		await context.close();
		ok(
			`natively, Back to a document made with another cookie is not asked for${said}`,
			native === JSON.stringify(['200', 'not asked']),
			native,
		);
		for (const [mode, base] of [
			['same-origin', PROXY],
			['isolated', HOST],
		]) {
			const page = await openDemo(browser, base);
			await submitLanding(page, idle('1'));
			const frames = () =>
				page
					.frames()
					.filter((frame) => /\/stomp\/[\w-]+\/html\//.test(frame.url()));
			const proxied = await walk(
				name(mode),
				frames,
				() => page.click('#toolBack'),
				tabs
					? async (link) => {
							await otherTab(
								frames,
								async () => {
									await page.click('#home');
									await sleep(500);
									await submitLanding(page, idle('3'));
								},
								link,
							);
							// the first tab again: the tab manager, then the tab with the keyboard
							await page.click('#recents');
							await sleep(900);
							for (let i = 0; i < 6; i++)
								await page.keyboard.press('ArrowLeft');
							await sleep(300);
							await page.keyboard.press('Enter');
							await sleep(900);
						}
					: null,
			);
			ok(
				`${mode}: Back to a document made with another cookie asks the origin as natively${said}`,
				proxied === native,
				`\n      native  ${native}\n      proxied ${proxied}`,
			);
			await page.context().close();
		}
	}
}

// The credentials an entry was made with are the proxy's cookie jar's at
// the time, whoever changed it: an entry made for a request with a cookie
// is confirmed with the origin once the jar holds another one for that
// request, set by the page's script (the shapes above), by the host
// (`cookies.set`, `cookies.clear`) or by a page in another tab (another
// controller of the scope: one jar, one cache), and is given unasked while
// the jar stays as it is.
if (!only || only === 'credentials') {
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		// (two tabs of one browser: a context of the suite's own)
		const context = await browser.newContext();
		const demo = async () => {
			const tab = await context.newPage();
			await tab.goto(base);
			await tab.waitForFunction(
				() =>
					/^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
				null,
				{ timeout: 45000 },
			);
			return tab;
		};
		const page = await demo();
		const idle = `${FIXTURE}pages/http-cache.html?k=idle-${run}&only=none`;
		const proxiedFrame = async (tab) => {
			for (let i = 0; i < 120; i++) {
				for (const frame of tab.frames())
					if (
						/\/stomp\/[\w-]+\/html\//.test(frame.url()) &&
						(await frame.evaluate(() => window.__hc?.done).catch(() => false))
					)
						return frame;
				await sleep(250);
			}
			throw new Error('no proxied page');
		};
		await submitLanding(page, idle);
		const frame = await proxiedFrame(page);
		const path = '/http-cache/credentials';
		const resource = `${path}?k=credentials-${run}&n=${mode}&cc=${encodeURIComponent('max-age=3600')}&etag=1`;
		let seen = 0;
		const each = [];
		const fetched = async () => {
			await frame.evaluate(async (url) => (await fetch(url)).text(), resource);
			const all =
				(
					await (
						await fetch(`${FIXTURE}http-cache/log?k=credentials-${run}`)
					).json()
				)[mode]?.asked ?? [];
			each.push(all.slice(seen).join(' / ') || 'not asked');
			seen = all.length;
		};
		const cookie = (tab, value) =>
			tab.evaluate((line) => {
				document.cookie = line;
			}, `hcc=${value}; path=${path}`);
		await cookie(frame, 1);
		await fetched();
		await fetched();
		// the host writes the jar
		await page.evaluate(
			([url, line]) => window.controller.cookies.set(url, line),
			[`${FIXTURE}${path.slice(1)}`, `hcc=2; path=${path}`],
		);
		await fetched();
		await fetched();
		// a page in another tab writes it
		const other = await demo();
		await submitLanding(other, idle);
		await cookie(await proxiedFrame(other), 3);
		await fetched();
		await fetched();
		// the host empties it
		await page.evaluate(
			(origin) => window.controller.cookies.clear(origin),
			new URL(FIXTURE).origin,
		);
		await fetched();
		await fetched();
		ok(
			`${mode}: an entry made with a cookie is confirmed once the jar holds another, whoever wrote it (the host, a page in another tab, the host clearing it), and given unasked while it holds the same`,
			JSON.stringify(each) ===
				JSON.stringify([
					'200',
					'not asked',
					'304 if-none-match',
					'not asked',
					'304 if-none-match',
					'not asked',
					'304 if-none-match',
					'not asked',
				]),
			JSON.stringify(each),
		);
		await context.close();
	}
}

await done(browser);
