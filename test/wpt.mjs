// Shared runner for the wpt-<area> suites: the web-platform-tests vendored
// under test/wpt/ (see its README) run twice, straight from the fixture
// ("native") and inside a proxied frame of the same-origin controller
// ("proxied"), and the two testharness verdicts are compared per subtest.
//
// The suite's assertion is the expected-failure list in
// test/wpt/expected/<suite>.json: for every subtest that passes natively, the
// proxied verdict must be PASS unless the list names it, and every name on
// the list must still fail, so the list stays honest in both directions.
// Subtests that fail natively (a wptserve feature the fixture lacks, user
// activation, a browser quirk) are left out of the comparison and listed.
// Every page starts with an empty cookie jar in both modes.
// UPDATE_EXPECTED=1 rewrites the list from the measured run; WPT_ONLY=<regex>
// runs only the matching pages (for a quick look, not for updating the list),
// WPT_NATIVE=<file> keeps the native verdicts in a file and takes them from
// it on the next run.
//
// Output: one PASS/FAIL line per test page, `native-fail` and `proxied-fail`
// lines for the excluded and the expected failures, `stalled` lines for a
// page that timed out through the proxy only and is not expected to (what
// each of its frames was doing), and a `summary` line with the counts. This file is a library;
// run by test/run.mjs it prints nothing and exits 0.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, PROXY, sleep } from './lib.mjs';
import { metaOf, SAME_ORIGIN_HOST } from './wpt-server.mjs';

const root = fileURLToPath(new URL('./wpt/', import.meta.url));
const expectedDir = `${root}expected/`;
// every page gets this long to report; past it the page counts as failed
// with the cause "timeout" (its harness status), whether the harness is
// still waiting on a subresource (a `timeout=long` page allows 120 s) or
// never loaded. The pages that take longer than this through the proxy are a
// finding in themselves, and a run of hundreds of pages has to end.
// (a suite's `budget` option changes it for its pages)
let PAGE_BUDGET_MS = 30000;
const POLL_MS = 250;

/** the test's origin on the fixture: {{host}} in the substitutions */
const origin = (() => {
	const url = new URL(FIXTURE);
	url.hostname = SAME_ORIGIN_HOST;
	return url.origin;
})();

/** the globals a `// META: global=` value names (wptserve's sets) */
function globalsOf(value) {
	const sets = {
		default: ['window', 'dedicatedworker'],
		worker: ['dedicatedworker', 'sharedworker', 'serviceworker'],
	};
	const globals = new Set(value === null ? sets.default : []);
	for (const item of (value ?? '').split(',').map((part) => part.trim())) {
		if (!item) continue;
		const names = sets[item.replace(/^!/, '')] ?? [item.replace(/^!/, '')];
		for (const name of names)
			if (item.startsWith('!')) globals.delete(name);
			else globals.add(name);
	}
	return globals;
}

// the wrapper page of an .any.js test, by the global it runs in
const ANY_PAGES = {
	window: '.any.html',
	dedicatedworker: '.any.worker.html',
	sharedworker: '.any.sharedworker.html',
};

/** the tests whose report is taken by path and query (they declare variants) */
const exactQuery = new Set();

/**
 * Every test page under `roots` (paths relative to test/wpt/): an .html file
 * that loads testharness.js, or an .any.js / .window.js / .worker.js test
 * (served wrapped, an .any.js once per global of `globals` it is exposed
 * in). A test that declares variants (`// META: variant=?x`, or the meta
 * element of that name) is one page per variant. Helper pages under
 * resources/ and support/ are not tests, nor are manual tests and crash
 * tests.
 */
export function discover(roots, globals = ['window']) {
	const tests = [];
	const add = (path, variants) => {
		if (!variants.length) return tests.push(path);
		for (const variant of variants) {
			tests.push(path + variant);
			exactQuery.add(path + variant);
		}
	};
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = `${dir}${name}`;
			if (statSync(full).isDirectory()) {
				if (!['resources', 'support', 'crashtests'].includes(name))
					walk(`${full}/`);
				continue;
			}
			if (/-manual\./.test(name)) continue;
			const path = `/${full.slice(root.length)}`;
			if (/\.(any|window|worker)\.js$/.test(name)) {
				const meta = metaOf(readFileSync(full, 'utf8'));
				const variants = meta
					.filter(([key]) => key === 'variant')
					.map(([, value]) => value);
				if (name.endsWith('.window.js'))
					add(path.replace(/\.js$/, '.html'), variants);
				else if (name.endsWith('.worker.js')) {
					if (globals.includes('dedicatedworker'))
						add(path.replace(/\.js$/, '.html'), variants);
				} else {
					const exposed = globalsOf(
						meta.find(([key]) => key === 'global')?.[1] ?? null,
					);
					for (const global of globals)
						if (exposed.has(global) && ANY_PAGES[global])
							add(path.replace(/\.any\.js$/, ANY_PAGES[global]), variants);
				}
			} else if (/\.(html|htm|xhtml)$/.test(name)) {
				const source = readFileSync(full, 'utf8');
				if (!source.includes('/resources/testharness.js')) continue;
				add(
					path,
					[
						...source.matchAll(
							/<meta\s+name=["']?variant["']?\s+content=["']([^"']*)["']/g,
						),
					].map(([, value]) => value),
				);
			}
		}
	};
	for (const dir of roots) walk(`${root}${dir}/`);
	return tests;
}

async function takeReport(path) {
	const response = await fetch(
		`${FIXTURE}_wpt/results?take&path=${encodeURIComponent(path)}${
			exactQuery.has(path) ? '' : '&anyquery'
		}`,
	);
	return response.status === 200 ? response.json() : null;
}

/** how long a page's posted report is waited for before its window is read instead */
const FALLBACK_AFTER_MS = 10000;

/**
 * A frame's window.__wptResults, read with no user gesture. Playwright
 * evaluates with one (a string as well as a function), and a gesture gives
 * the page transient activation, in Chrome as through the proxy: a
 * navigation the page starts within five seconds sends Sec-Fetch-User, and
 * a page that is still running when its window is read is measured with
 * activations the other run never had. A proxied page that runs past
 * FALLBACK_AFTER_MS and not natively, wpt-fetch-metadata's
 * window-location page (17 s against 7 to 10 s), was read every POLL_MS
 * while it ran, and one of its four navigations that expect none sent
 * Sec-Fetch-User now and then. CDP's Runtime.evaluate without
 * `userGesture` gives none (measured in Chrome 157: `hasBeenActive` stays
 * false). Null when the frame is gone or has no copy.
 */
async function readResults(frame) {
	let session;
	try {
		const page = frame.page();
		session = await page.context().newCDPSession(page);
		const { frameTree } = await session.send('Page.getFrameTree');
		const unfragmented = frame.url().replace(/#.*$/s, '');
		const find = (node) =>
			node.frame.url === unfragmented &&
			(frame.parentFrame() === null) === !node.frame.parentId
				? node.frame.id
				: (node.childFrames ?? []).map(find).find(Boolean);
		const frameId = find(frameTree);
		if (!frameId) return null;
		const contexts = new Map();
		session.on('Runtime.executionContextCreated', ({ context }) => {
			if (context.auxData?.isDefault)
				contexts.set(context.auxData.frameId, context.id);
		});
		// (reports the contexts there are now, before it answers)
		await session.send('Runtime.enable');
		const contextId = contexts.get(frameId);
		if (contextId === undefined) return null;
		const { result } = await session.send('Runtime.evaluate', {
			expression: 'window.__wptResults',
			contextId,
			returnByValue: true,
		});
		return result.value ?? null;
	} catch (error) {
		return null;
	} finally {
		await session?.detach().catch(() => {});
	}
}

/** wait for the page at `path` to report, or give up with a TIMEOUT */

async function awaitReport(path, fallback) {
	const started = Date.now();
	while (Date.now() - started < PAGE_BUDGET_MS) {
		await sleep(POLL_MS);
		const report = await takeReport(path);
		if (report) return report;
		// the page's own report (posted to the fixture) is what counts; reading
		// the window (readResults, with no user gesture) is the fallback for
		// a page that cannot post, and only late
		if (Date.now() - started < FALLBACK_AFTER_MS) continue;
		const direct = await fallback?.();
		if (direct) return direct;
	}
	return {
		path,
		status: {
			status: 'TIMEOUT',
			message: `timeout: no report within ${PAGE_BUDGET_MS / 1000} s`,
		},
		tests: [],
	};
}

/**
 * Run every test natively: `concurrency` tabs of one browser context, each
 * loading its share of the pages straight from the fixture.
 */
async function runNative(browser, tests, concurrency) {
	const context = await browser.newContext();
	const results = new Map();
	const queue = [...tests];
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			// a page that crashed its tab is that page's failure: the next page
			// gets a tab of its own
			const open = async () => {
				const page = await context.newPage();
				page.once('crash', () => (page.crashed = true));
				return page;
			};
			let page = await open();
			while (queue.length) {
				const path = queue.shift();
				await takeReport(path);
				if (page.crashed || page.isClosed()) {
					await page.close().catch(() => {});
					page = await open();
				}
				// each page starts with an empty jar, so a cookie one page could not
				// delete is that page's failure and not the next page's
				await context.clearCookies();
				try {
					await page.goto(`${origin}${path}`, { waitUntil: 'commit' });
				} catch (error) {
					results.set(path, {
						status: { status: 'ERROR', message: error.message },
						tests: [],
					});
					continue;
				}
				const started = Date.now();
				const report = await awaitReport(path, () =>
					readResults(page.mainFrame()),
				);
				results.set(path, report);
				progress('native', path, report, started);
				await page.goto('about:blank').catch(() => {});
			}
			await page.close().catch(() => {});
		}),
	);
	await context.close();
	return results;
}

/**
 * Run every test through the proxy: `concurrency` same-origin controller
 * pages, each with one frame navigated through `frame.go()`. One host page
 * per worker, not one page with several frames: two frames loading at once
 * in one controller page stall each other (measured, not fixed here).
 */
async function runProxied(
	browser,
	tests,
	concurrency,
	native,
	expected,
	called,
) {
	const errors = [];
	const results = new Map();
	const queue = [...tests];
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			let page;
			// a page that crashed its tab is that page's failure: the next page
			// gets a host page of its own
			const open = async () => {
				page = await browser.newPage();
				page.once('crash', () => (page.crashed = true));
				page.on('pageerror', (error) => errors.push(error.message));
				await page.goto(PROXY);
				await page.waitForFunction(
					() => window.controller && window.controller.isReady,
					null,
					{ timeout: 45000 },
				);
				// a controller of the suite's own, on the demo page's worker and
				// a transport described as the demo describes its own: the demo's
				// controller takes a page's window.open as a tab of the demo and
				// the page gets null, which is the demo's choice (`onOpen`) and
				// not the proxy's behaviour. A host that takes no tabs leaves the
				// popup to the browser, and that is what the tests that open one
				// measure. The transport is a descriptor, hosted in the transport
				// worker as the demo's is: a transport instance runs on the page,
				// which cannot answer a proxied page's synchronous XHR while that
				// page spins (every sync XHR then waited out its 30 s).
				await page.evaluate(async (called) => {
					const element = document.createElement('iframe');
					element.style.cssText = 'width: 800px; height: 600px';
					document.body.append(element);
					const config = window.STOMP_CONFIG || {};
					const controller = new window.StompController({
						serviceworker: window.controller.serviceworker,
						transport: {
							module: config.testTransport
								? '/test/mixed-transport.mjs'
								: '/epoxy/index.mjs',
							options: [
								{
									wisp:
										config.wisp ||
										`${location.origin.replace(/^http/, 'ws')}/wisp/`,
								},
							],
						},
						directory: window.controller.directory.pathname,
						codec: 'xor',
						// (just call stomp is the controller's to opt in to)
						...(called && { dialing: true }),
					});
					await controller.wait();
					window.__wptController = controller;
					window.__wptFrame = controller.createFrame(element);
				}, called);
			};
			await open();
			// just call stomp (`called`): each page is a tab of its own, a
			// fresh frame called with it, whose history starts at the page
			let tabs = 0;
			const go = (url) =>
				called
					? page.evaluate(
							async ({ url, key }) => {
								const old = window.__wptFrame;
								const element = document.createElement('iframe');
								element.style.cssText = 'width: 800px; height: 600px';
								old.element.replaceWith(element);
								window.__wptFrame = window.__wptController.createFrame(element);
								await window.StompController.justCallStomp(
									window.__wptFrame,
									url,
									{ key },
								);
							},
							{ url, key: `wpt-${++tabs}-${Math.random()}` },
						)
					: page.evaluate((url) => window.__wptFrame.go(url), url);
			// the fallback reads the frame's own copy: the proxied frame is a
			// direct child of the host page on a routed URL
			// (a called one is the frame's element now: its URL is the call
			// page's, whose name is the config's)
			const fallback = (path) => async () => {
				const frame = called
					? await page
							.evaluateHandle(() => window.__wptFrame.element)
							.then((handle) => handle.contentFrame())
							.catch(() => null)
					: page
							.frames()
							.find(
								(f) =>
									f.parentFrame() === page.mainFrame() &&
									/\/stomp\/[\w-]+\/html\//.test(f.url()),
							);
				const direct = frame ? await readResults(frame) : null;
				return direct?.path === path.split('?')[0] ? direct : null;
			};
			while (queue.length) {
				const path = queue.shift();
				await takeReport(path);
				if (page.crashed || page.isClosed()) {
					await page.close().catch(() => {});
					await open();
				}
				// the proxy's jar is shared by every controller of the scope; empty
				// it for the page the way the native run empties the browser's
				await page
					.evaluate(() => window.__wptController.cookies.clear())
					.catch(() => {});
				try {
					await go(`${origin}${path}`);
				} catch (error) {
					results.set(path, {
						status: { status: 'ERROR', message: error.message },
						tests: [],
					});
					continue;
				}
				const started = Date.now();
				const report = await awaitReport(path, fallback(path));
				results.set(path, report);
				progress('proxied', path, report, started);
				if (
					report.status.status === 'TIMEOUT' &&
					native.get(path)?.status.status !== 'TIMEOUT' &&
					!('(harness)' in (expected[path] || {}))
				)
					await stalled(page, path, native.get(path));
				if (!called) await leave(page);
			}
			await page.close().catch(() => {});
		}),
	);
	return { results, errors };
}

/**
 * Send the default mode's frame to about:blank after a page. A page can keep
 * its frame: the frame's navigation is the parent's script's, so a page
 * whose navigate handler cancels every navigation, or that is still in one
 * of its own, keeps the next page from ever loading there (each page after
 * it timed out). When the frame still shows a routed document after a few
 * seconds, it is replaced with a fresh one, as a new tab would be.
 */
async function leave(page) {
	const left = await page
		.evaluate(async () => {
			const frame = window.__wptFrame;
			const gone = () => {
				try {
					return !/\/stomp\/[\w-]+\/html\//.test(
						frame.element.contentWindow.location.href,
					);
				} catch (error) {
					return false;
				}
			};
			frame.go('about:blank').catch(() => {});
			for (let waited = 0; waited < 5000; waited += 100) {
				if (gone()) return true;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return gone();
		})
		.catch(() => false);
	if (left) return;
	await page
		.evaluate(() => {
			const old = window.__wptFrame;
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 800px; height: 600px';
			old.element.replaceWith(element);
			window.__wptFrame = window.__wptController.createFrame(element);
		})
		.catch(() => {});
}

/**
 * What each frame of a proxied page that timed out (and did not natively,
 * and whose expected list does not name the harness) was doing: its URL, its readyState and, in the test's own frame, the
 * subtests the native run had that never finished, one line a frame. A page
 * that stalls only on a loaded runner says so in the log of the run it
 * stalled in. Read after the verdict is taken, since an evaluation is a
 * user gesture.
 */
async function stalled(page, path, native) {
	for (const frame of page.frames()) {
		const state = await frame
			.evaluate(() => ({
				url: location.href,
				readyState: document.readyState,
				finished: Array.isArray(window.__wptFinished)
					? [...window.__wptFinished]
					: null,
			}))
			.catch((error) => ({ error: String(error).slice(0, 120) }));
		if (state.finished) {
			const finished = new Set(state.finished.map(stable));
			state.unfinished = (native?.tests ?? [])
				.map((test) => stable(test.name))
				.filter((name) => !finished.has(name));
		}
		delete state.finished;
		console.log(
			`  stalled ${path}: ${frame.url().slice(0, 120)}: ${JSON.stringify(state).slice(0, 2000)}`,
		);
	}
}

/** one line per page and mode as it finishes, so a long run shows progress */
const progress = (mode, path, report, started) =>
	console.log(
		`  ${mode} ${path}: ${report.status.status}, ${report.tests.length} subtests, ${Math.round((Date.now() - started) / 1000)}s`,
	);

// ports and uuids differ between runs; the expected list stores a name and
// a message that stay the same (a test may name a subtest after a URL)
const stable = (text) =>
	String(text ?? '')
		.replace(/:\d{4,5}\b/g, ':PORT')
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			'UUID',
		);
const normalise = (message) =>
	stable(message).replace(/\s+/g, ' ').slice(0, 200);

/** a report as a map: subtest name -> { status, message }, plus (harness) */
function verdicts(report) {
	const map = new Map();
	map.set('(harness)', report.status);
	for (const test of report.tests) map.set(stable(test.name), test);
	return map;
}

/**
 * Run the suite: `roots` are directories under test/wpt/, `concurrency` the
 * number of pages loading at once in each mode (1 where the tests share
 * the cookie jar or other state of the origin), `globals` the globals an
 * .any.js test runs in (of `window`, `dedicatedworker`, `sharedworker`),
 * `skip` the pages left out (RegExps over the path and query; the README
 * says why for each), `budget` the milliseconds a page has to report,
 * `called` runs the proxied pages in just call stomp
 * (src/controller/justCallStomp.ts), each a tab of its own.
 */
export async function runWpt(
	suite,
	{
		roots,
		concurrency = 1,
		globals = ['window'],
		skip = [],
		budget,
		called = false,
	},
) {
	const only = process.env.WPT_ONLY && new RegExp(process.env.WPT_ONLY);
	if (process.env.WPT_CONCURRENCY)
		concurrency = Number(process.env.WPT_CONCURRENCY) || 1;
	if (budget) PAGE_BUDGET_MS = budget;
	const tests = discover(roots, globals)
		.filter((path) => !skip.some((rule) => rule.test(path)))
		.filter((path) => !only || only.test(path));
	const expectedFile = `${expectedDir}${suite}.json`;
	const expected = existsSync(expectedFile)
		? JSON.parse(readFileSync(expectedFile, 'utf8'))
		: {};
	const update = process.env.UPDATE_EXPECTED === '1';

	const browser = await launch();
	let native;
	let proxied;
	let errors;
	try {
		await fetch(`${FIXTURE}_wpt/reset`);
		// WPT_NATIVE=<file>: the native verdicts of an earlier run, kept there
		// by the first run that names it (for a quick look at the proxied
		// side, never for updating the list)
		const kept = process.env.WPT_NATIVE;
		if (kept && existsSync(kept)) {
			native = new Map(JSON.parse(readFileSync(kept, 'utf8')));
			for (const path of tests)
				if (!native.has(path))
					native.set(path, {
						status: { status: 'ERROR', message: 'not in WPT_NATIVE' },
						tests: [],
					});
		} else {
			native = await runNative(browser, tests, concurrency);
			if (kept) writeFileSync(kept, JSON.stringify([...native]));
		}
		await fetch(`${FIXTURE}_wpt/reset`);
		({ results: proxied, errors } = await runProxied(
			browser,
			tests,
			concurrency,
			native,
			expected,
			called,
		));
	} catch (error) {
		// the browser is the only thing a suite spawns; never leave it behind
		await browser.close().catch(() => {});
		throw error;
	}

	const measured = {};
	const totals = {
		pages: tests.length,
		subtests: 0,
		nativePass: 0,
		proxiedPass: 0,
		excluded: 0,
		expectedFailures: 0,
		newFailures: 0,
		newPasses: 0,
	};
	for (const path of tests) {
		const nativeVerdicts = verdicts(native.get(path));
		const proxiedVerdicts = verdicts(proxied.get(path));
		const failures = {};
		const newFailures = [];
		const newPasses = [];
		const wanted = expected[path] || {};
		for (const [name, verdict] of nativeVerdicts) {
			const passedNatively =
				verdict.status === 'PASS' || verdict.status === 'OK';
			totals.subtests++;
			if (!passedNatively) {
				totals.excluded++;
				console.log(
					`  native-fail ${path} :: ${name} - ${verdict.status}: ${normalise(verdict.message)}`,
				);
				continue;
			}
			totals.nativePass++;
			const after = proxiedVerdicts.get(name);
			const passedProxied =
				after && (after.status === 'PASS' || after.status === 'OK');
			if (passedProxied) {
				totals.proxiedPass++;
				if (name in wanted) newPasses.push(name);
				continue;
			}
			const detail = after
				? `${after.status}: ${normalise(after.message)}`
				: `MISSING: the harness ended ${proxiedVerdicts.get('(harness)').status} before this subtest`;
			failures[name] = detail;
			if (name in wanted) {
				totals.expectedFailures++;
				console.log(`  proxied-fail ${path} :: ${name} - ${detail}`);
			} else newFailures.push(`${name} (${detail})`);
		}
		// a subtest the proxied run reports that the native run never reached
		// is not compared: there is no native verdict to hold it to
		if (Object.keys(failures).length) measured[path] = failures;
		totals.newFailures += newFailures.length;
		totals.newPasses += newPasses.length;
		const detail = [
			newFailures.length ? `new failures: ${newFailures.join('; ')}` : '',
			newPasses.length
				? `new passes (drop them from the expected list): ${newPasses.join('; ')}`
				: '',
		]
			.filter(Boolean)
			.join(' | ');
		ok(
			`${suite}: ${path}`,
			update || (!newFailures.length && !newPasses.length),
			detail ||
				`${nativeVerdicts.size - 1} subtests, ${Object.keys(failures).length} expected proxied failures`,
		);
	}
	if (update && !only) {
		mkdirSync(expectedDir, { recursive: true });
		writeFileSync(expectedFile, `${JSON.stringify(measured, null, '\t')}\n`);
		console.log(`wrote ${expectedFile}`);
	}
	console.log(
		`summary: ${totals.pages} pages, ${totals.subtests} subtests (harness status counted once per page), native pass ${totals.nativePass}, excluded (fail natively) ${totals.excluded}, proxied pass ${totals.proxiedPass}, expected proxied failures ${totals.expectedFailures}, new failures ${totals.newFailures}, new passes ${totals.newPasses}`,
	);
	await done(browser, errors);
}
