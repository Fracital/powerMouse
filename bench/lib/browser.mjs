// Launching Chrome for the benchmark and reading proxied documents from an
// isolated world (probe.js), the same way for the native row and for every
// proxy.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { sleep } from './net.mjs';

const PROBE = readFileSync(new URL('./probe.js', import.meta.url), 'utf8');

export const VIEWPORT = { width: 1280, height: 800 };

/** the user agent of a regular (headful) Chrome of the given version */
export function regularUserAgent(version) {
	const major = String(version).split('.')[0];
	return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * kind 'proxy': every name but localhost/127.0.0.1 fails to resolve, and
 * *.bench.test goes to the leak catcher, so anything that bypasses the proxy
 * fails or is counted. kind 'native': only *.bench.test is mapped (to the
 * fixtures), the rest is the real network.
 */
export async function launch({
	chrome,
	kind,
	headful = false,
	leakPort,
	chromeVersion,
	extraArgs = [],
}) {
	const rules =
		kind === 'native'
			? 'MAP *.bench.test 127.0.0.1'
			: `MAP *.bench.test 127.0.0.1:${leakPort}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`;
	const args = [
		`--host-resolver-rules=${rules}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
		'--disable-background-networking',
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
		'--autoplay-policy=no-user-gesture-required',
		...extraArgs,
	];
	// headless Chrome says HeadlessChrome in its user agent, which bot walls
	// answer differently; give it the regular one (headful keeps its own)
	if (!headful && chromeVersion)
		args.push(`--user-agent=${regularUserAgent(chromeVersion)}`);
	const browser = await chromium.launch({
		executablePath: chrome,
		headless: !headful,
		args,
		env: {
			...process.env,
			PULSE_SERVER: 'unix:/nonexistent/pulse',
			ALSA_CONFIG_PATH: '/dev/null',
		},
	});
	return browser;
}

/**
 * A page with the probe in every document it loads. Returns
 * { page, cdp, frameIdOf(elementHandle), mainFrameId(), evalProbe(frameId, expr) }.
 */
export async function probedPage(context) {
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	const contexts = new Map(); // frameId -> [executionContextId], newest last
	// uncaught exceptions and unhandled rejections of every document, by
	// frame, as Chrome reports them: unlike a page listener this survives a
	// document.open() (which drops every listener on the window) and sees
	// the page's own world
	const frameOfContext = new Map();
	const exceptions = [];
	cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
		const frameId = frameOfContext.get(d.executionContextId) ?? null;
		exceptions.push({
			t: Date.now(),
			frameId,
			text: String(
				d.exception?.description?.split('\n')[0] || d.text || 'exception',
			).slice(0, 300),
		});
	});
	cdp.on('Runtime.executionContextCreated', ({ context: ctx }) => {
		if (ctx.auxData?.frameId) frameOfContext.set(ctx.id, ctx.auxData.frameId);
		if (ctx.name !== 'bench' || !ctx.auxData) return;
		const list = contexts.get(ctx.auxData.frameId) || [];
		list.push(ctx.id);
		contexts.set(ctx.auxData.frameId, list);
	});
	cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
		for (const [frameId, list] of contexts) {
			const at = list.indexOf(executionContextId);
			if (at >= 0) {
				list.splice(at, 1);
				if (!list.length) contexts.delete(frameId);
			}
		}
	});
	cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');
	await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
		source: PROBE,
		worldName: 'bench',
		runImmediately: true,
	});
	const contextGeneration = (frameId) => {
		const list = contexts.get(frameId);
		return list ? list[list.length - 1] : null;
	};
	async function evalIn(frameId, expression) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const id = contextGeneration(frameId);
			if (id === null) {
				await sleep(100);
				continue;
			}
			try {
				const { result, exceptionDetails } = await cdp.send(
					'Runtime.evaluate',
					{
						expression,
						contextId: id,
						returnByValue: true,
						awaitPromise: true,
						timeout: 15000,
					},
				);
				if (exceptionDetails)
					throw new Error(
						exceptionDetails.exception?.description || exceptionDetails.text,
					);
				return result.value;
			} catch (error) {
				if (!/context|Cannot find|destroyed/i.test(error.message)) throw error;
				await sleep(150);
			}
		}
		return null;
	}
	return {
		page,
		cdp,
		contextOf: contextGeneration,
		/** exceptions thrown in `frameId`'s documents since `since` (ms) */
		exceptionsOf: (frameId, since = 0) =>
			exceptions.filter((e) => e.frameId === frameId && e.t >= since),
		async mainFrameId() {
			const { frameTree } = await cdp.send('Page.getFrameTree');
			return frameTree.frame.id;
		},
		async frameIdOf(selector) {
			const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
			const { nodeId } = await cdp.send('DOM.querySelector', {
				nodeId: root.nodeId,
				selector,
			});
			if (!nodeId) return null;
			const { node } = await cdp.send('DOM.describeNode', { nodeId });
			return node.frameId || null;
		},
		snapshot: (frameId, options = {}) =>
			evalIn(frameId, `__benchProbe.snapshot(${JSON.stringify(options)})`),
		evalIn,
	};
}

/**
 * Waits for the document in `frameId` to finish loading: a document other
 * than `oldContext`'s (the one shown before the navigation) whose URL is not
 * about:blank reached readyState complete, and no newer document replaced it
 * for `quietMs`. Returns the last snapshot (or null).
 */
export async function waitForLoad(
	probe,
	frameId,
	{ timeoutMs = 45000, quietMs = 1500, oldContext = null } = {},
) {
	const end = Date.now() + timeoutMs;
	let last = null;
	let stableSince = 0;
	let lastContext = null;
	let seenComplete = null;
	while (Date.now() < end) {
		const ctx = probe.contextOf(frameId);
		let snap = null;
		if (ctx !== null)
			snap = await probe.snapshot(frameId, { text: false }).catch(() => null);
		if (snap) last = snap;
		const ready =
			snap &&
			snap.readyState === 'complete' &&
			!/^about:/.test(snap.href) &&
			ctx !== oldContext;
		if (ready) {
			if (ctx !== lastContext) {
				lastContext = ctx;
				stableSince = Date.now();
				seenComplete = stableSince;
			} else if (Date.now() - stableSince >= quietMs) {
				return { snap, timedOut: false, context: ctx, seenComplete };
			}
		} else {
			lastContext = null;
		}
		await sleep(100);
	}
	return { snap: last, timedOut: true, context: lastContext, seenComplete };
}
