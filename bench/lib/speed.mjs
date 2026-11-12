// The speed scenarios. Every one runs its rows interleaved (the order
// rotates every repeat, lib/stats.mjs rotation) and each load gets a fresh
// browser context unless the scenario is about reuse (first visit).
import { launch } from './browser.mjs';
import {
	chromeCPU,
	chromeMemory,
	hostNetworkBytes,
	serverCounters,
} from './metrics.mjs';
import { sleep } from './net.mjs';
import { loadURL, openNativeTab, openProxiedTab } from './session.mjs';
import { median, rotation, stat } from './stats.mjs';

export const FIXTURE_PAGES = [
	{
		id: 'article',
		label: 'Article (text, 11 images, 3 scripts)',
		path: '/speed/article.html',
	},
	{ id: 'many', label: '200 subresources', path: '/speed/many.html' },
	{
		id: 'scripts',
		label: 'Real-world scripts (rewrite corpus)',
		path: '/rewrite/index.html?set=all',
		waitResult: true,
	},
];

function serverPids(env, running) {
	return [
		env.wisp.pid,
		...(running && !running.inProcess ? running.pids || [] : []),
	];
}

async function openTab(ctx, row) {
	return row === 'native'
		? openNativeTab(ctx.browsers.native)
		: openProxiedTab(ctx.browsers.proxy, ctx.running[row]);
}

/** waits for the page's data-bench-result to say done; returns it parsed */
async function benchResult(tab, timeoutMs = 120000, test = (r) => r?.done) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const raw = await tab.probe
			.evalIn(
				tab.frameId,
				"document.documentElement && document.documentElement.getAttribute('data-bench-result')",
			)
			.catch(() => null);
		if (raw) {
			try {
				const parsed = JSON.parse(raw);
				if (test(parsed)) return parsed;
			} catch {
				// partial write
			}
		}
		await sleep(200);
	}
	return null;
}

/**
 * One measured load in a tab: wall time to the load event, paint, browser
 * and server CPU, and bytes, counted the same way for every row: for a
 * fixture page what the fixture server sent (a proxy that caches or blocks
 * asks for less), for a real site the IP bytes the host exchanged with the network
 * in both directions (nothing else uses it during the serial timing runs).
 */
async function measuredLoad(ctx, tab, row, url, { waitResult = false } = {}) {
	const browserSession =
		row === 'native' ? ctx.sessions.native : ctx.sessions.proxy;
	const pids = serverPids(ctx.env, ctx.running[row]);
	const local = url.includes('.bench.test');
	const bytes = () => (local ? ctx.env.fixture.bytesOut() : hostNetworkBytes());
	const bytes0 = await bytes();
	const cpu0 = await chromeCPU(browserSession);
	const server0 = await serverCounters(pids);
	const result = await loadURL(tab, url, { timeoutMs: 60000, settleMs: 1000 });
	let pageResult = null;
	if (waitResult && result.ok) pageResult = await benchResult(tab);
	const cpu1 = await chromeCPU(browserSession);
	const server1 = await serverCounters(pids);
	const bytes1 = await bytes();
	return {
		ok: result.ok && (!waitResult || !!pageResult),
		error: result.error || (result.timedOut ? 'timed out' : null),
		ttl_ms: result.ttl_ms,
		fcp_ms: result.fcp_ms,
		lcp_ms: result.lcp_ms,
		cpu_browser_ms: cpu1 - cpu0,
		cpu_server_ms: server1.cpu - server0.cpu,
		transfer_kb:
			bytes0 !== null && bytes1 !== null ? (bytes1 - bytes0) / 1024 : null,
		bootMs: tab.bootMs,
		pageResult,
		title: result.snap?.title,
	};
}

function collect(store, scenario, row, value) {
	((store[scenario] ||= {})[row] ||= []).push(value);
}

const table = (meta, values, rows) => ({
	...meta,
	rows: Object.fromEntries(rows.map((row) => [row, stat(values?.[row] || [])])),
});

/** fixture page loads, paint, CPU, transfer, in-browser rewrite throughput */
export async function runFixtureLoads(ctx) {
	const { rows, repeats, env, log, record } = ctx;
	const ttl = {};
	const fcp = {};
	const lcp = {};
	const cpuB = {};
	const cpuS = {};
	const bytes = {};
	const mbps = {};
	for (let r = 0; r < repeats; r++)
		for (const page of FIXTURE_PAGES)
			for (const row of rotation(rows, r)) {
				const url = env.fixture.url('a', page.path);
				const tab = await openTab(ctx, row);
				let m;
				try {
					m = tab.bootError
						? { ok: false, error: `boot: ${tab.bootError}` }
						: await measuredLoad(ctx, tab, row, url, page);
				} catch (error) {
					m = { ok: false, error: error.message.split('\n')[0] };
				}
				await tab.context.close().catch(() => {});
				const time = page.waitResult ? m.pageResult?.total_ms : m.ttl_ms;
				collect(ttl, page.id, row, m.ok ? time : null);
				collect(fcp, page.id, row, m.ok ? m.fcp_ms : null);
				collect(lcp, page.id, row, m.ok ? m.lcp_ms : null);
				collect(cpuB, page.id, row, m.ok ? m.cpu_browser_ms : null);
				collect(cpuS, page.id, row, m.ok ? m.cpu_server_ms : null);
				collect(bytes, page.id, row, m.ok ? m.transfer_kb : null);
				if (page.waitResult && m.pageResult?.scripts) {
					const ok = m.pageResult.scripts.filter((s) => s.ok !== false);
					const total = ok.reduce((sum, s) => sum + (s.bytes || 0), 0);
					collect(
						mbps,
						'in_browser',
						row,
						m.pageResult.total_ms
							? total / 1e6 / (m.pageResult.total_ms / 1000)
							: null,
					);
				} else if (page.waitResult) collect(mbps, 'in_browser', row, null);
				record({
					scenario: 'fixture',
					page: page.id,
					row,
					repeat: r,
					...m,
					pageResult: page.waitResult ? m.pageResult : undefined,
				});
				log(
					`fixture ${page.id} ${row} #${r}: ${m.ok ? Math.round(time) + ' ms' : m.error}`,
				);
			}
	const out = { fixtures: {}, paint: {}, cpu: {}, transfer: {}, rewrite: {} };
	for (const page of FIXTURE_PAGES) {
		out.fixtures[page.id] = table(
			{ label: page.label, unit: 'ms', lower_better: true },
			ttl[page.id],
			rows,
		);
		if (page.waitResult) continue;
		out.paint[`${page.id}-fcp`] = table(
			{
				label: `${page.label}: first contentful paint`,
				unit: 'ms',
				lower_better: true,
			},
			fcp[page.id],
			rows,
		);
		out.paint[`${page.id}-lcp`] = table(
			{
				label: `${page.label}: largest contentful paint`,
				unit: 'ms',
				lower_better: true,
			},
			lcp[page.id],
			rows,
		);
	}
	for (const page of FIXTURE_PAGES) {
		out.cpu[`${page.id}-browser`] = table(
			{ label: `${page.label}: Chrome CPU`, unit: 'ms', lower_better: true },
			cpuB[page.id],
			rows,
		);
		out.cpu[`${page.id}-server`] = table(
			{
				label: `${page.label}: server CPU (holyWisp or the proxy's own server)`,
				unit: 'ms',
				lower_better: true,
			},
			cpuS[page.id],
			rows,
		);
		out.transfer[page.id] = table(
			{ label: page.label, unit: 'KB', lower_better: true },
			bytes[page.id],
			rows,
		);
	}
	out.rewrite.in_browser = table(
		{
			label:
				'Rewrite corpus through the proxy, in the browser (download, rewrite, run)',
			unit: 'MB/s',
			lower_better: false,
		},
		mbps.in_browser,
		rows,
	);
	return out;
}

/** first visit (service worker install, bundles) against a warm second load */
export async function runFirstVisit(ctx) {
	const { rows, repeats, env, log, record } = ctx;
	const boot = {};
	const cold = {};
	const warm = {};
	const url = env.fixture.url('a', '/speed/article.html');
	for (let r = 0; r < repeats; r++)
		for (const row of rotation(rows, r)) {
			const tab = await openTab(ctx, row);
			let first = null;
			let second = null;
			if (!tab.bootError) {
				first = await loadURL(tab, url, {
					timeoutMs: 60000,
					settleMs: 500,
				}).catch(() => null);
				second = await loadURL(tab, url, {
					timeoutMs: 60000,
					settleMs: 500,
				}).catch(() => null);
			}
			await tab.context.close().catch(() => {});
			const b = tab.bootError ? null : tab.bootMs;
			collect(boot, 'boot', row, b);
			collect(
				cold,
				'cold',
				row,
				first?.ok && b !== null ? b + first.ttl_ms : null,
			);
			collect(warm, 'warm', row, second?.ok ? second.ttl_ms : null);
			record({
				scenario: 'first-visit',
				row,
				repeat: r,
				boot_ms: b,
				first_ms: first?.ttl_ms,
				second_ms: second?.ttl_ms,
				error: tab.bootError,
			});
			log(
				`first-visit ${row} #${r}: boot ${b} cold ${first?.ttl_ms} warm ${second?.ttl_ms}`,
			);
		}
	return {
		cold: table(
			{
				label:
					'First visit: proxy start (host page to ready) plus the first load',
				unit: 'ms',
				lower_better: true,
			},
			cold.cold,
			rows,
		),
		boot: table(
			{
				label: 'Proxy start alone (host page to ready)',
				unit: 'ms',
				lower_better: true,
			},
			boot.boot,
			rows,
		),
		warm: table(
			{
				label: 'Second load of the same page in the same tab',
				unit: 'ms',
				lower_better: true,
			},
			warm.warm,
			rows,
		),
	};
}

/** time per client-side navigation in the SPA fixture */
export async function runSPA(ctx, navigations = 20) {
	const { rows, repeats, env, log, record } = ctx;
	const per = {};
	const url = env.fixture.url('a', '/speed/spa.html');
	for (let r = 0; r < repeats; r++)
		for (const row of rotation(rows, r)) {
			const tab = await openTab(ctx, row);
			const times = [];
			let error = tab.bootError;
			try {
				if (!error) {
					const loaded = await loadURL(tab, url, {
						timeoutMs: 60000,
						settleMs: 300,
					});
					if (!loaded.ok) error = loaded.error || 'load timed out';
					else if (!(await benchResult(tab, 20000))) error = 'no first render';
				}
				for (let i = 1; !error && i <= navigations; i++) {
					const before = await benchResult(tab, 5000);
					const count = before.renders.length;
					const t = await tab.probe.evalIn(
						tab.frameId,
						`(() => { const t = performance.now(); document.getElementById('route-${i % 20}').click(); return t; })()`,
					);
					const after = await benchResult(
						tab,
						15000,
						(res) => res?.renders?.length > count,
					);
					if (!after) {
						error = `navigation ${i} never rendered`;
						break;
					}
					times.push(after.renders[after.renders.length - 1].t - t);
				}
			} catch (e) {
				error = e.message.split('\n')[0];
			}
			await tab.context.close().catch(() => {});
			collect(per, 'nav', row, error ? null : median(times));
			record({ scenario: 'spa', row, repeat: r, times, error });
			log(
				`spa ${row} #${r}: ${error || Math.round(median(times) * 10) / 10 + ' ms/nav'}`,
			);
		}
	return {
		navigation: table(
			{
				label: `Client-side navigation (pushState, fetch, render), median of ${navigations}`,
				unit: 'ms',
				lower_better: true,
			},
			per.nav,
			rows,
		),
	};
}

/** memory of a tab on a blank page and with 20 ad-like cross-origin frames */
export async function runMemory(ctx) {
	const { rows, repeats, env, log, record } = ctx;
	const m = {};
	for (let r = 0; r < repeats; r++)
		for (const row of rotation(rows, r)) {
			const kind = row === 'native' ? 'native' : 'proxy';
			const browser = await launch({ ...ctx.launchOptions, kind });
			const session = await browser.newBrowserCDPSession();
			const sub = { browsers: { [kind]: browser }, running: ctx.running };
			let entry = { row, repeat: r };
			try {
				const tab = await openTab(sub, row);
				if (tab.bootError) throw new Error(`boot: ${tab.bootError}`);
				const gc = async () => {
					await tab.probe.cdp
						.send('HeapProfiler.collectGarbage')
						.catch(() => {});
					await sleep(500);
				};
				const blank = await loadURL(
					tab,
					env.fixture.url('a', '/speed/blank.html'),
					{ settleMs: 2000 },
				);
				if (!blank.ok) throw new Error('blank page did not load');
				await gc();
				const m0 = await chromeMemory(session);
				const h0 = await tab.probe.cdp.send('Runtime.getHeapUsage');
				const served = () =>
					env.fixture.log.filter((r) =>
						r.url.startsWith('/speed/frame.html?slot='),
					).length;
				const served0 = served();
				const frames = await loadURL(
					tab,
					env.fixture.url('a', '/speed/frames.html?n=20'),
					{ settleMs: 500 },
				);
				// every frame's own script must have run: a blocked or broken
				// frame would make the per-frame figure look cheaper than it is
				const framed = frames.ok ? await benchResult(tab, 60000) : null;
				if (!framed) throw new Error('frames page did not finish');
				if (served() - served0 < 20)
					throw new Error(
						`the fixture served ${served() - served0} of the 20 frames`,
					);
				await sleep(3000);
				await gc();
				const m1 = await chromeMemory(session);
				const h1 = await tab.probe.cdp.send('Runtime.getHeapUsage');
				entry = {
					...entry,
					pss_blank_mb: m0.pss_mb,
					pss_frames_mb: m1.pss_mb,
					per_frame_kb: ((m1.pss_mb - m0.pss_mb) * 1024) / 20,
					heap_blank_mb: h0.usedSize / 1048576,
					heap_frames_mb: h1.usedSize / 1048576,
					processes: m1.processes,
				};
			} catch (error) {
				entry.error = error.message.split('\n')[0];
			}
			await browser.close().catch(() => {});
			for (const key of [
				'pss_blank_mb',
				'pss_frames_mb',
				'per_frame_kb',
				'heap_blank_mb',
				'heap_frames_mb',
			])
				collect(m, key, row, entry[key] ?? null);
			record({ scenario: 'memory', ...entry });
			log(
				`memory ${row} #${r}: ${entry.error || `${Math.round(entry.pss_blank_mb)} MB blank, ${Math.round(entry.per_frame_kb)} KB/frame`}`,
			);
		}
	return {
		pss_blank_mb: table(
			{
				label:
					'Chrome memory (PSS, all processes) with one tab on a blank page',
				unit: 'MB',
				lower_better: true,
			},
			m.pss_blank_mb,
			rows,
		),
		pss_frames_mb: table(
			{
				label: 'Chrome memory (PSS, all processes) with 20 ad-like frames',
				unit: 'MB',
				lower_better: true,
			},
			m.pss_frames_mb,
			rows,
		),
		per_frame_kb: table(
			{
				label: 'Memory per ad-like frame (PSS difference / 20)',
				unit: 'KB',
				lower_better: true,
			},
			m.per_frame_kb,
			rows,
		),
		heap_blank_mb: table(
			{
				label: "JS heap of the tab's process, blank page",
				unit: 'MB',
				lower_better: true,
			},
			m.heap_blank_mb,
			rows,
		),
		heap_frames_mb: table(
			{
				label:
					"JS heap of the tab's process, 20 frames (native keeps cross-site frames in other processes)",
				unit: 'MB',
				lower_better: true,
			},
			m.heap_frames_mb,
			rows,
		),
	};
}

/** a few large real sites, each loaded `repeats` times per row */
export async function runRealTimed(ctx, sites) {
	const { rows, repeats, log, record } = ctx;
	const ttl = {};
	const lcp = {};
	const bytes = {};
	for (let r = 0; r < repeats; r++)
		for (const site of sites)
			for (const row of rotation(rows, r)) {
				const tab = await openTab(ctx, row);
				let m;
				try {
					m = tab.bootError
						? { ok: false, error: `boot: ${tab.bootError}` }
						: await measuredLoad(ctx, tab, row, site.url);
				} catch (error) {
					m = { ok: false, error: error.message.split('\n')[0] };
				}
				await tab.context.close().catch(() => {});
				collect(ttl, site.id, row, m.ok ? m.ttl_ms : null);
				collect(lcp, site.id, row, m.ok ? m.lcp_ms : null);
				collect(bytes, site.id, row, m.ok ? m.transfer_kb : null);
				record({ scenario: 'real', site: site.id, row, repeat: r, ...m });
				log(
					`real ${site.id} ${row} #${r}: ${m.ok ? Math.round(m.ttl_ms) + ' ms' : m.error}`,
				);
				await sleep(500);
			}
	const out = { real: {}, real_lcp: {}, real_transfer: {} };
	for (const site of sites) {
		out.real[site.id] = table(
			{ label: site.url, unit: 'ms', lower_better: true },
			ttl[site.id],
			rows,
		);
		out.real_lcp[site.id] = table(
			{ label: site.url, unit: 'ms', lower_better: true },
			lcp[site.id],
			rows,
		);
		out.real_transfer[site.id] = table(
			{ label: site.url, unit: 'KB', lower_better: true },
			bytes[site.id],
			rows,
		);
	}
	return out;
}
