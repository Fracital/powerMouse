// One load of one URL, natively or through a contender, measured the same
// way: the probe's snapshot from an isolated world, wall time from the
// harness's go() to the document's load event, screenshot, requests that
// failed, and (proxied) requests that reached the leak catcher.
import { probedPage, VIEWPORT, waitForLoad } from './browser.mjs';
import { adapterContext } from './env.mjs';
import { freePort, sleep } from './net.mjs';

/** starts a contender row's host server; returns the adapter's handle plus row info */
export async function startRow(env, adapter, row) {
	const ctx = adapterContext(env, adapter, await freePort());
	const handle = await adapter.start(ctx, row.options || {});
	return { ...handle, ctx, adapter, row };
}

/**
 * Evaluates in the host page's own world through CDP, without the user
 * gesture Playwright's page.evaluate carries: a gesture there would count as
 * user activation for the proxied frame (same origin as its host), which a
 * native load never gets.
 */
async function hostEval(probe, expression) {
	const { exceptionDetails } = await probe.cdp.send('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		userGesture: false,
		returnByValue: true,
	});
	if (exceptionDetails)
		throw new Error(
			exceptionDetails.exception?.description?.split('\n')[0] ||
				exceptionDetails.text,
		);
}

function watchRequests(page) {
	const stats = { requests: 0, failed: 0, failedUrls: [], errors4xx: 0 };
	page.on('request', () => stats.requests++);
	page.on('requestfailed', (request) => {
		const failure = request.failure()?.errorText || '';
		if (/ERR_ABORTED/.test(failure)) return;
		stats.failed++;
		if (stats.failedUrls.length < 30)
			stats.failedUrls.push(`${failure} ${request.url().slice(0, 160)}`);
	});
	page.on('response', (response) => {
		if (response.status() >= 400) stats.errors4xx++;
	});
	return stats;
}

/**
 * Opens a fresh context and page for a proxied row, loads its host page and
 * waits for `__bench.ready`. Returns a tab with `go(url)` / `snapshot()`.
 */
export async function openProxiedTab(
	browser,
	running,
	{ bootTimeoutMs = 60000 } = {},
) {
	const context = await browser.newContext({ viewport: VIEWPORT });
	const probe = await probedPage(context);
	const { page } = probe;
	const t0 = Date.now();
	let bootError = null;
	try {
		await page.goto(running.hostUrl, { timeout: bootTimeoutMs });
		await hostEval(
			probe,
			`new Promise((resolve, reject) => {
				const end = Date.now() + ${bootTimeoutMs};
				const wait = () =>
					window.__bench
						? window.__bench.ready.then(resolve, reject)
						: Date.now() > end
							? reject(new Error('no __bench on the host page'))
							: setTimeout(wait, 50);
				wait();
				setTimeout(() => reject(new Error('ready timed out')), ${bootTimeoutMs});
			})`,
		);
	} catch (error) {
		bootError = error.message.split('\n')[0];
	}
	const bootMs = Date.now() - t0;
	const frameId = bootError ? null : await probe.frameIdOf('#bench-frame');
	return { context, probe, page, frameId, bootMs, bootError, native: false };
}

export async function openNativeTab(browser) {
	const context = await browser.newContext({ viewport: VIEWPORT });
	const probe = await probedPage(context);
	return {
		context,
		probe,
		page: probe.page,
		frameId: await probe.mainFrameId(),
		bootMs: 0,
		bootError: null,
		native: true,
	};
}

/**
 * Navigates the tab to `url` and waits for its load. Returns the
 * measurement; `leakHits` is filled by the caller (the leak catcher is
 * shared).
 */
export async function loadURL(
	tab,
	url,
	{ timeoutMs = 45000, settleMs = 2500 } = {},
) {
	if (tab.bootError)
		return { ok: false, error: `boot: ${tab.bootError}`, bootMs: tab.bootMs };
	const requests = watchRequests(tab.page);
	const oldContext = tab.probe.contextOf(tab.frameId);
	const goAt = Date.now();
	let navError = null;
	try {
		if (tab.native)
			await tab.page
				.goto(url, { timeout: timeoutMs, waitUntil: 'commit' })
				.catch((error) => {
					navError = error.message.split('\n')[0];
				});
		else await hostEval(tab.probe, `window.__bench.go(${JSON.stringify(url)})`);
	} catch (error) {
		navError = error.message.split('\n')[0];
	}
	const deadline = goAt + timeoutMs;
	let { snap, timedOut, context, seenComplete } = await waitForLoad(
		tab.probe,
		tab.frameId,
		{
			timeoutMs,
			oldContext,
		},
	);
	// a page that moves on to another document after its first one loaded
	// (a client-side redirect, a proxy's own extra hop) has loaded when that
	// document has: wait for it the same way, within the same time budget
	for (;;) {
		if (settleMs) await sleep(settleMs);
		const newest = tab.probe.contextOf(tab.frameId);
		if (timedOut || newest === null || newest === context) break;
		const next = await waitForLoad(tab.probe, tab.frameId, {
			timeoutMs: Math.max(1000, deadline - Date.now()),
			oldContext: context,
		});
		if (next.snap) snap = next.snap;
		timedOut = next.timedOut;
		context = next.context;
		seenComplete = next.seenComplete;
	}
	const full =
		(await tab.probe.snapshot(tab.frameId).catch(() => null)) || snap;
	// the end of the load: the final document's load event on the wall
	// clock (Chrome and this process share it), else the moment its
	// readyState became complete, else when the harness saw it complete
	const loadAt = !full
		? null
		: (full.loadWall ??
			full.completeWall ??
			(full.load !== null ? full.timeOrigin + full.load : seenComplete));
	const exceptions = tab.probe.exceptionsOf(tab.frameId, goAt);
	return {
		ok: !!full && !timedOut,
		errors: exceptions.map((e) => e.text),
		timedOut,
		navError,
		goAt,
		ttl_ms: loadAt !== null && !timedOut ? Math.max(0, loadAt - goAt) : null,
		fcp_ms: full?.fcp ?? null,
		lcp_ms: full?.lcp ?? null,
		dcl_ms: full?.dcl ?? null,
		load_ms: full?.load ?? null,
		bootMs: tab.bootMs,
		snap: full,
		requests,
	};
}

export async function screenshot(tab, file) {
	await tab.page.screenshot({ path: file, type: 'jpeg', quality: 70 });
}
