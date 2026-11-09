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
// runs only the matching pages (for a quick look, not for updating the list).
//
// Output: one PASS/FAIL line per test page, `native-fail` and `proxied-fail`
// lines for the excluded and the expected failures, and a `summary` line
// with the counts. This file is a library; run by test/run.mjs it prints
// nothing and exits 0.
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
import { SAME_ORIGIN_HOST } from './wpt-server.mjs';

const root = fileURLToPath(new URL('./wpt/', import.meta.url));
const expectedDir = `${root}expected/`;
// every page gets this long to report; past it the page counts as failed
// with the cause "timeout" (its harness status), whether the harness is
// still waiting on a subresource (a `timeout=long` page allows 120 s) or
// never loaded. The pages that take longer than this through the proxy are a
// finding in themselves, and a run of hundreds of pages has to end.
const PAGE_BUDGET_MS = 30000;
const POLL_MS = 250;

/** the test's origin on the fixture: {{host}} in the substitutions */
const origin = (() => {
	const url = new URL(FIXTURE);
	url.hostname = SAME_ORIGIN_HOST;
	return url.origin;
})();

/**
 * Every test page under `roots` (paths relative to test/wpt/): an .html file
 * that loads testharness.js, or an .any.js / .window.js test (served
 * wrapped as .any.html / .window.html). Helper pages under resources/ and
 * support/ are not tests.
 */
export function discover(roots) {
	const tests = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = `${dir}${name}`;
			if (statSync(full).isDirectory()) {
				if (name !== 'resources' && name !== 'support') walk(`${full}/`);
				continue;
			}
			const path = `/${full.slice(root.length)}`;
			if (/\.(any|window)\.js$/.test(name))
				tests.push(path.replace(/\.js$/, '.html'));
			else if (
				name.endsWith('.html') &&
				readFileSync(full, 'utf8').includes('/resources/testharness.js')
			)
				tests.push(path);
		}
	};
	for (const dir of roots) walk(`${root}${dir}/`);
	return tests;
}

async function takeReport(path) {
	const response = await fetch(
		`${FIXTURE}_wpt/results?take&path=${encodeURIComponent(path)}`,
	);
	return response.status === 200 ? response.json() : null;
}

/** wait for the page at `path` to report, or give up with a TIMEOUT */
/** how long a page's posted report is waited for before its window is read instead */
const FALLBACK_AFTER_MS = 10000;

async function awaitReport(path, fallback) {
	const started = Date.now();
	while (Date.now() - started < PAGE_BUDGET_MS) {
		await sleep(POLL_MS);
		const report = await takeReport(path);
		if (report) return report;
		// the page's own report (posted to the fixture) is what counts; reading
		// the window is the fallback for a page that cannot post, and only
		// late: Playwright evaluates with a user gesture, which gives the page
		// transient activation and so Sec-Fetch-User on its next navigation
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
			const page = await context.newPage();
			while (queue.length) {
				const path = queue.shift();
				await takeReport(path);
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
					page.evaluate(() => window.__wptResults).catch(() => null),
				);
				results.set(path, report);
				progress('native', path, report, started);
				await page.goto('about:blank').catch(() => {});
			}
			await page.close();
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
async function runProxied(browser, tests, concurrency) {
	const errors = [];
	const results = new Map();
	const queue = [...tests];
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			const page = await browser.newPage();
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(PROXY);
			await page.waitForFunction(
				() => window.controller && window.controller.isReady,
				null,
				{ timeout: 45000 },
			);
			await page.evaluate(() => {
				const element = document.createElement('iframe');
				element.style.cssText = 'width: 800px; height: 600px';
				document.body.append(element);
				window.__wptFrame = window.controller.createFrame(element);
			});
			// the fallback reads the frame's own copy: the proxied frame is a
			// direct child of the host page on a routed URL
			const fallback = (path) => async () => {
				const frame = page
					.frames()
					.find(
						(f) =>
							f.parentFrame() === page.mainFrame() &&
							/\/stomp\/[\w-]+\/html\//.test(f.url()),
					);
				const direct = await frame
					?.evaluate(() => window.__wptResults)
					.catch(() => null);
				return direct?.path === path ? direct : null;
			};
			while (queue.length) {
				const path = queue.shift();
				await takeReport(path);
				// the proxy's jar is shared by every controller of the scope; empty
				// it for the page the way the native run empties the browser's
				await page
					.evaluate(() => window.controller.cookies.clear())
					.catch(() => {});
				try {
					await page.evaluate(
						(url) => window.__wptFrame.go(url),
						`${origin}${path}`,
					);
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
				await page
					.evaluate(() => window.__wptFrame.go('about:blank'))
					.catch(() => {});
			}
			await page.close();
		}),
	);
	return { results, errors };
}

/** one line per page and mode as it finishes, so a long run shows progress */
const progress = (mode, path, report, started) =>
	console.log(
		`  ${mode} ${path}: ${report.status.status}, ${report.tests.length} subtests, ${Math.round((Date.now() - started) / 1000)}s`,
	);

/** a report as a map: subtest name -> { status, message }, plus (harness) */
function verdicts(report) {
	const map = new Map();
	map.set('(harness)', report.status);
	for (const test of report.tests) map.set(test.name, test);
	return map;
}

// ports and uuids differ between runs; the expected list stores a message
// that stays the same
const normalise = (message) =>
	String(message ?? '')
		.replace(/:\d{4,5}\b/g, ':PORT')
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			'UUID',
		)
		.replace(/\s+/g, ' ')
		.slice(0, 200);

/**
 * Run the suite: `roots` are directories under test/wpt/, `concurrency` the
 * number of pages loading at once in each mode (1 where the tests share
 * the cookie jar).
 */
export async function runWpt(suite, { roots, concurrency = 1 }) {
	const only = process.env.WPT_ONLY && new RegExp(process.env.WPT_ONLY);
	if (process.env.WPT_CONCURRENCY)
		concurrency = Number(process.env.WPT_CONCURRENCY) || 1;
	const tests = discover(roots).filter((path) => !only || only.test(path));
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
		native = await runNative(browser, tests, concurrency);
		await fetch(`${FIXTURE}_wpt/reset`);
		({ results: proxied, errors } = await runProxied(
			browser,
			tests,
			concurrency,
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
