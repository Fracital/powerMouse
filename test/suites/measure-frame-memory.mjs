// Measurement: what a live frame costs, natively and through the proxy. A
// page appends FRAMES frames of a small page like a cookie-sync or ad frame
// (an inline style, an inline script, a pixel), then the JS heap after GC
// and the renderer's RSS are read before and after; the difference over
// FRAMES is the cost of one frame. Same-origin mode puts every proxied frame
// in the host's renderer, so a page with hundreds of such frames (imgur
// keeps about a thousand) pays this hundreds of times. Also printed: the
// median time from a frame's time origin to its inline script running (a
// proxied frame rewrites the script first), and how long all of them took
// to load. Children of the page's own site and of another site (localhost)
// are measured separately. SKIP_MEASUREMENT=1 leaves the suite out.
//
// Per frame, 60 frames, same-site children, this machine (Chrome 152):
//
//                      heap KB   RSS KB
//   native                 400     1140
//   8efa41b               1834     3629
//   no ast-types          1379     3109
//   crypto-js parts       1276     3023
import { readFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const FRAMES = Number(process.env.FRAMES) || 60;
// a ceiling well above what this build measures, so a slow runner passes:
// it catches a change that puts the whole cost back
const HEAP_LIMIT_KB = Number(process.env.FRAME_HEAP_LIMIT_KB) || 1700;
const ROUTE = /\/stomp\/[\w-]+\/html\//;
const page = 'pages/frame-memory.html';
const fixture = new URL(FIXTURE);
const otherSite = `http://localhost:${fixture.port}/`;

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

/** append FRAMES children of `base` to `frame`, wait until each ran its script */
async function addFrames(tab, frame, base) {
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
		[FRAMES, new URL(page, base).href],
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
		if (times.length >= FRAMES) break;
		await sleep(250);
	}
	times.sort((a, b) => a - b);
	return {
		loaded: times.length,
		loadMs: Date.now() - started,
		scriptAt: times[Math.floor(times.length / 2)] ?? NaN,
	};
}

async function measure(proxied, base) {
	const browser = await launch([
		// natively a frame of another site runs in a process of its own; the
		// proxy's are all same-origin, so compare in one renderer
		'--disable-site-isolation-trials',
		'--disable-features=IsolateOrigins,site-per-process',
	]);
	let tab;
	let frame;
	if (proxied) {
		tab = await openDemo(browser, PROXY);
		const before = new Set(tab.frames());
		await submitLanding(
			tab,
			new URL('pages/frame-memory.html?top', FIXTURE).href,
		);
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
		await tab.goto(new URL('pages/frame-memory.html?top', FIXTURE).href);
		frame = tab.mainFrame();
	}
	await sleep(1000);
	const empty = await sample(browser, tab);
	const load = await addFrames(tab, frame, base);
	await sleep(1000);
	const full = await sample(browser, tab);
	await browser.close();
	return {
		...load,
		heapKB: ((full.heap - empty.heap) * 1024) / FRAMES,
		rssKB:
			full.rss === null || empty.rss === null
				? NaN
				: ((full.rss - empty.rss) * 1024) / FRAMES,
	};
}

const rows = [];
for (const [name, proxied, base] of [
	['native', false, FIXTURE],
	['proxied', true, FIXTURE],
	['proxied, other site', true, otherSite],
]) {
	const result = await measure(proxied, base);
	rows.push([name, result]);
	ok(
		`${name}: all ${FRAMES} frames ran their script`,
		result.loaded === FRAMES,
		`${result.loaded} did`,
	);
}
console.log(
	`\nper frame, ${FRAMES} frames    heap KB   RSS KB   script at ms   all loaded ms`,
);
for (const [name, r] of rows)
	console.log(
		`  ${name.padEnd(22)} ${r.heapKB.toFixed(0).padStart(7)} ${r.rssKB.toFixed(0).padStart(8)} ${r.scriptAt.toFixed(0).padStart(14)} ${String(r.loadMs).padStart(15)}`,
	);
console.log('');
for (const [name, r] of rows.slice(1))
	ok(
		`${name}: a frame costs at most ${HEAP_LIMIT_KB} KB of heap`,
		r.heapKB <= HEAP_LIMIT_KB,
		`${r.heapKB.toFixed(0)} KB`,
	);
await done(null);
