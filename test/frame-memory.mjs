// What a live frame costs, natively and through the proxy, for the
// measure-frame-memory and frame-cost suites. A page appends `frames` frames
// of a small page like a cookie-sync or ad frame (an inline style, an inline
// script, a pixel; test/pages/frame-memory.html), then the JS heap after GC
// and the renderers' RSS are read before and after; the difference over
// `frames` is the cost of one frame. Same-origin mode puts every proxied
// frame in the host's renderer, so a page with hundreds of such frames
// (imgur keeps about a thousand) pays this hundreds of times.
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

/** append `count` children of `base` to `frame`, wait until each ran its script */
async function addFrames(tab, frame, base, count) {
	const started = Date.now();
	await frame.evaluate(
		([count, src]) => {
			for (let i = 0; i < count; i++) {
				const child = document.createElement('iframe');
				child.src = `${src}?i=${i}`;
				child.width = 20;
				child.height = 20;
				document.body.append(child);
			}
		},
		[count, new URL(page, base).href],
	);
	let times = [];
	for (let i = 0; i < 240; i++) {
		const children = tab.frames().filter((f) => f.parentFrame() === frame);
		times = (
			await Promise.all(
				children.map((child) =>
					Promise.race([
						child.evaluate(() => window.__ranAt).catch(() => undefined),
						sleep(2000),
					]),
				),
			)
		).filter((time) => typeof time === 'number');
		if (times.length >= count) break;
		await sleep(250);
	}
	times.sort((a, b) => a - b);
	return {
		loaded: times.length,
		loadMs: Date.now() - started,
		scriptAt: times[Math.floor(times.length / 2)] ?? NaN,
	};
}

/**
 * One measurement in a browser of its own: `frames` children of `base` in
 * the fixture's frame-memory page, natively or (`proxied`) through the demo.
 * Per frame: heapKB, rssKB; also how many ran their script (`loaded`), the
 * median time from a frame's time origin to its script (`scriptAt`) and how
 * long all of them took (`loadMs`).
 */
export async function measureFrames({ proxied, base = FIXTURE, frames }) {
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
			await frame?.waitForFunction(() => typeof window.__ranAt === 'number', {
				timeout: 30000,
			});
		} else {
			tab = await browser.newPage();
			await tab.goto(new URL(`${page}?top`, FIXTURE).href);
			frame = tab.mainFrame();
		}
		await sleep(1000);
		const empty = await sample(browser, tab);
		const load = await addFrames(tab, frame, base, frames);
		await sleep(1000);
		const full = await sample(browser, tab);
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
