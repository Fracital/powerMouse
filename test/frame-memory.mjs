// What a live frame costs, natively and through the proxy, for the
// measure-frame-memory and frame-cost suites. A page appends `frames` frames
// of a small page like a cookie-sync or ad frame (an inline style, an inline
// script, a pixel; test/pages/frame-memory.html), then the JS heap after GC
// and the renderers' RSS are read before and after; the difference over
// `frames` is the cost of one frame. Same-origin mode puts every proxied
// frame in the host's renderer, so a page with hundreds of such frames
// (imgur keeps about a thousand) pays this hundreds of times.
//
// Nothing here evaluates with a user gesture: Playwright's evaluate gives
// one (Runtime.callFunctionOn with userGesture), and through the proxy it
// reaches every proxied frame of the page, so the frames the page appended
// started with an activation no page load gives them. The page is driven
// by Runtime.evaluate in each frame's main world without one (pageEval).
// `click` measures frames a real click in the top reached: 'before', frames
// the page appends right after it; 'refresh', frames that load their next
// document right after it (an ad frame's next ad).
import { readFileSync } from 'node:fs';
import {
	FIXTURE,
	launch,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from './lib.mjs';

const ROUTE = /\/stomp\/[\w-]+\/html\//;
const page = 'pages/frame-memory.html';

/** the renderers' resident memory, MB (Linux /proc), or null */
async function rendererRSS(browser) {
	try {
		const session = await browser.newBrowserCDPSession();
		const { processInfo } = await session.send('SystemInfo.getProcessInfo');
		let kb = 0;
		for (const info of processInfo)
			if (info.type === 'renderer')
				kb += Number(
					/VmRSS:\s+(\d+)/.exec(
						readFileSync(`/proc/${info.id}/status`, 'utf8'),
					)[1],
				);
		await session.detach();
		return kb / 1024;
	} catch (error) {
		return null;
	}
}

async function sample(browser, tab) {
	const cdp = await tab.context().newCDPSession(tab);
	await cdp.send('HeapProfiler.enable');
	await cdp.send('Performance.enable');
	for (let i = 0; i < 3; i++) {
		await cdp.send('HeapProfiler.collectGarbage');
		await sleep(300);
	}
	const { metrics } = await cdp.send('Performance.getMetrics');
	await cdp.detach();
	const heap =
		metrics.find((metric) => metric.name === 'JSHeapUsedSize').value / 1048576;
	return { heap, rss: await rendererRSS(browser) };
}

/**
 * The script and task time of the page's main thread, ms, counted from
 * this call on (the browser counts while the domain is enabled): `read()`
 * answers both so far, `stop()` ends it
 */
async function durations(tab) {
	const cdp = await tab.context().newCDPSession(tab);
	await cdp.send('Performance.enable');
	const read = async () => {
		const { metrics } = await cdp.send('Performance.getMetrics');
		const ms = (name) =>
			metrics.find((metric) => metric.name === name).value * 1000;
		return { script: ms('ScriptDuration'), task: ms('TaskDuration') };
	};
	return { read, stop: () => cdp.detach().catch(() => {}) };
}

/**
 * Evaluation in the frames of `tab` without a user gesture: `run(frame, fn,
 * arg)` calls `fn(arg)` in `frame`'s main world and answers its value (by
 * value), `children(frame)` lists its child frames' CDP ids, `runIn(id, fn,
 * arg)` the same by id; `stop()` ends it. Frames are matched to the
 * DevTools protocol's by URL.
 */
async function pageEval(tab) {
	const cdp = await tab.context().newCDPSession(tab);
	const contexts = new Map();
	cdp.on('Runtime.executionContextCreated', ({ context }) => {
		if (context.auxData?.isDefault)
			contexts.set(context.auxData.frameId, context.id);
	});
	cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
		for (const [frameId, id] of contexts)
			if (id === executionContextId) contexts.delete(frameId);
	});
	await cdp.send('Runtime.enable');
	const tree = async () => (await cdp.send('Page.getFrameTree')).frameTree;
	const find = (node, url) => {
		if (node.frame.url === url) return node;
		for (const child of node.childFrames ?? []) {
			const found = find(child, url);
			if (found) return found;
		}
		return null;
	};
	const runIn = async (frameId, fn, arg) => {
		const contextId = contexts.get(frameId);
		if (contextId === undefined) return undefined;
		const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
			expression: `(${fn})(${JSON.stringify(arg)})`,
			contextId,
			returnByValue: true,
			awaitPromise: true,
			userGesture: false,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.text);
		return result.value;
	};
	const idOf = async (frame) => find(await tree(), frame.url())?.frame.id;
	return {
		run: async (frame, fn, arg) => runIn(await idOf(frame), fn, arg),
		runIn,
		children: async (frame) =>
			(find(await tree(), frame.url())?.childFrames ?? []).map(
				(child) => child.frame.id,
			),
		stop: () => cdp.detach().catch(() => {}),
	};
}

/**
 * Wait until every child of `frame` ran its script (`count` of them; with
 * `since`, a document's whose script ran after that time, ms since the
 * epoch): their times
 */
async function waitForChildren(evaluator, frame, count, since = 0) {
	let times = [];
	let ranAt = [];
	for (let i = 0; i < 240; i++) {
		const children = await evaluator.children(frame);
		const ran = (
			await Promise.all(
				children.map((id) =>
					Promise.race([
						evaluator
							.runIn(
								id,
								(since) =>
									typeof window.__ranAt === 'number' &&
									performance.timeOrigin + window.__ranAt > since
										? [window.__ranAt, performance.timeOrigin + window.__ranAt]
										: undefined,
								since,
							)
							.catch(() => undefined),
						sleep(2000),
					]),
				),
			)
		).filter((time) => Array.isArray(time));
		times = ran.map(([time]) => time);
		ranAt = ran.map(([, at]) => at);
		if (times.length >= count) break;
		await sleep(250);
	}
	return { times, ranAt };
}

/** append `count` children of `base` to `frame`, wait until each ran its script */
async function addFrames(tab, frame, base, count, evaluator, act = () => {}) {
	const started = Date.now();
	const spent = await durations(tab);
	const before = await spent.read();
	await act();
	const appended = await evaluator.run(
		frame,
		([count, src]) => {
			const at = performance.timeOrigin + performance.now();
			for (let i = 0; i < count; i++) {
				const child = document.createElement('iframe');
				child.src = `${src}?i=${i}`;
				child.width = 20;
				child.height = 20;
				document.body.append(child);
			}
			return at;
		},
		[count, new URL(page, base).href],
	);
	const { times, ranAt } = await waitForChildren(evaluator, frame, count);
	const after = await spent.read();
	await spent.stop();
	times.sort((a, b) => a - b);
	return {
		loaded: times.length,
		loadMs: Date.now() - started,
		scriptAt: times[Math.floor(times.length / 2)] ?? NaN,
		wallMs: Math.max(...ranAt) - appended,
		scriptMs: after.script - before.script,
		taskMs: after.task - before.task,
	};
}

/**
 * One measurement in a browser of its own: `frames` children of `base` in
 * the fixture's frame-memory page, natively or (`proxied`) through the demo.
 * Per frame: heapKB, rssKB; also how many ran their script (`loaded`), the
 * median time from a frame's time origin to its script (`scriptAt`), how
 * long all of them took (`loadMs`, as this process saw it; `wallMs`, from
 * the page appending them to the last one's script) and the script and
 * task time the page's main thread spent meanwhile (`scriptMs`, `taskMs`).
 * `click` (see the top): 'before', the children appended right after a
 * real click in the top; 'refresh', the children, once loaded, loading
 * their next document right after one (the heap is then the next
 * documents', `loaded` how many loaded theirs).
 */
export async function measureFrames({
	proxied,
	base = FIXTURE,
	frames,
	click = null,
}) {
	const browser = await launch([
		// natively a frame of another site runs in a process of its own; the
		// proxy's are all same-origin, so compare in one renderer
		'--disable-site-isolation-trials',
		'--disable-features=IsolateOrigins,site-per-process',
	]);
	try {
		let tab;
		let frame;
		if (proxied) {
			tab = await openDemo(browser, PROXY);
			const before = new Set(tab.frames());
			await submitLanding(tab, new URL(`${page}?top`, FIXTURE).href);
			for (let i = 0; i < 120 && !frame; i++) {
				await sleep(250);
				frame = tab
					.frames()
					.findLast((f) => !before.has(f) && ROUTE.test(f.url()));
			}
		} else {
			tab = await browser.newPage();
			await tab.goto(new URL(`${page}?top`, FIXTURE).href);
			frame = tab.mainFrame();
		}
		const evaluator = await pageEval(tab);
		for (
			let i = 0;
			i < 120 &&
			frame &&
			!(await evaluator
				.run(frame, () => typeof window.__ranAt === 'number')
				.catch(() => false));
			i++
		)
			await sleep(250);
		// a real click in the top, where no frame is
		const clickTop = async () => {
			const box = proxied
				? await (await frame.frameElement()).boundingBox()
				: { x: 0, y: 0, ...tab.viewportSize() };
			await tab.mouse.click(box.x + box.width - 5, box.y + box.height - 5);
		};
		await sleep(1000);
		const empty = await sample(browser, tab);
		let load = await addFrames(
			tab,
			frame,
			base,
			frames,
			evaluator,
			click === 'before' ? clickTop : undefined,
		);
		if (click === 'refresh') {
			await sleep(1000);
			await clickTop();
			const since = await evaluator.run(
				frame,
				(src) => {
					const at = performance.timeOrigin + performance.now();
					const children = document.querySelectorAll('iframe');
					for (let i = 0; i < children.length; i++)
						children[i].src = `${src}?i=${i}&next`;
					return at;
				},
				new URL(page, base).href,
			);
			const { times } = await waitForChildren(evaluator, frame, frames, since);
			load = { ...load, loaded: times.length };
		}
		await sleep(1000);
		const full = await sample(browser, tab);
		await evaluator.stop();
		return {
			...load,
			heapKB: ((full.heap - empty.heap) * 1024) / frames,
			rssKB:
				full.rss === null || empty.rss === null
					? NaN
					: ((full.rss - empty.rss) * 1024) / frames,
		};
	} finally {
		await browser.close();
	}
}
