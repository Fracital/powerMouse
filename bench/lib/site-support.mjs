// Site support: every corpus site loaded natively (twice, first and last)
// and once through every proxied row in a rotated order, each in a fresh
// browser context. A load is scored against the native ones (see score()).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interact } from './interact.mjs';
import { sleep, withTimeout } from './net.mjs';
import {
	loadURL,
	openNativeTab,
	openProxiedTab,
	screenshot,
} from './session.mjs';
import { compareImages, textOverlap, tokens } from './similarity.mjs';
import { median, rotation } from './stats.mjs';

const LOCAL = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

async function measure(args) {
	// an overall cap so no single row can stall the scenario, whatever wedges
	// (a renderer that never answers a CDP call, a page that reloads forever):
	// the tab is closed afterwards even when the work is abandoned
	let tab = null;
	const work = (async () => {
		tab = await measureInner(args, (created) => (tab = created));
		return tab.result;
	})();
	const result = await withTimeout(work, 200000, {
		ok: false,
		error: 'row timed out (200s cap)',
		leaks: [],
	});
	if (tab && tab.context)
		withTimeout(
			tab.context.close().catch(() => {}),
			15000,
			undefined,
		);
	return result;
}

async function measureInner(
	{ browsers, row, running, site, shotFile, leakWatch },
	onTab,
) {
	const tab =
		row === 'native'
			? await openNativeTab(browsers.native)
			: await openProxiedTab(browsers.proxy, running);
	onTab(tab);
	const leaks = [];
	if (row !== 'native')
		tab.page.on('request', (request) => {
			const url = request.url();
			if (/^(https?|wss?):/.test(url) && !LOCAL.test(url))
				leaks.push(url.slice(0, 200));
		});
	let result;
	try {
		result = await loadURL(tab, site.url, { timeoutMs: 45000, settleMs: 3000 });
		if (!tab.bootError) {
			// a wedged renderer can hang a screenshot or an interaction with no
			// timeout of its own, so each is bounded; the whole scenario must
			// never wait on one site
			await withTimeout(screenshot(tab, shotFile), 25000, undefined).catch(
				() => {},
			);
			result.interaction = await withTimeout(interact(tab, site), 45000, {
				error: 'interaction timed out',
			});
		}
	} catch (error) {
		result = { ok: false, error: error.message.split('\n')[0] };
	}
	result.leaks = leaks;
	leakWatch?.(leaks);
	tab.result = result;
	return tab;
}

const loaded = (r) =>
	!!r &&
	!r.error &&
	!!r.snap &&
	!/^about:/.test(r.snap.href || 'about:') &&
	(r.snap.textLength > 0 || r.snap.elements > 40);

/**
 * Per-row verdict and score (0..1) against the two native loads:
 *   content = mean of SSIM and text overlap, each relative to how similar the
 *             two native loads were to each other (capped at 1);
 *   interaction = share of the interactions that worked natively and also
 *             worked here;
 *   score = 0.75 content + 0.25 interaction for a loaded page, else 0.
 * pass >= 0.85, partial >= 0.5, fail below; challenge when the row was
 * shown a challenge the native load was not; boot-fail when the proxy never
 * became ready; native-fail when the site did not load natively at all.
 */
function score(row, r, native, cmp) {
	const out = {
		loaded: loaded(r),
		challenge: !!r?.snap?.challenge,
		ttl_ms: r?.ttl_ms ?? null,
		fcp_ms: r?.fcp_ms ?? null,
		lcp_ms: r?.lcp_ms ?? null,
		js_errors: r?.errors ? r.errors.length : null,
		js_errors_native: native.errors,
		failed_requests: r?.requests?.failed ?? null,
		failed_requests_native: native.failed,
		requests: r?.requests?.requests ?? null,
		leaks: r?.leaks?.length ?? 0,
		interaction: r?.interaction || {},
		ssim: cmp?.ssim ?? null,
		phash_dist: cmp?.phash_dist ?? null,
		text_overlap: cmp?.text ?? null,
		error: r?.error || (r?.timedOut ? 'load timed out' : null),
	};
	if (r?.error?.startsWith('boot')) {
		out.verdict = 'boot-fail';
		out.score = 0;
		return out;
	}
	out.ssim_rel =
		cmp?.ssim !== null && cmp?.ssim !== undefined
			? Math.min(1, cmp.ssim / native.ssim)
			: null;
	out.text_rel =
		cmp?.text !== null && cmp?.text !== undefined
			? Math.min(1, cmp.text / native.text)
			: null;
	if (!out.loaded) {
		out.score = 0;
		out.verdict = out.challenge && !native.challenge ? 'challenge' : 'fail';
		return out;
	}
	if (out.challenge && !native.challenge) {
		out.score = 0;
		out.verdict = 'challenge';
		return out;
	}
	const content = ((out.ssim_rel ?? 0) + (out.text_rel ?? 0)) / 2;
	const tried = ['scroll', 'search', 'link'].filter(
		(k) => native.interaction[k] === true,
	);
	const interaction = tried.length
		? tried.filter((k) => out.interaction[k] === true).length / tried.length
		: content;
	out.content = content;
	out.interaction_score = interaction;
	out.score = row === 'native' ? 1 : 0.75 * content + 0.25 * interaction;
	out.verdict =
		out.score >= 0.85 ? 'pass' : out.score >= 0.5 ? 'partial' : 'fail';
	return out;
}

export async function runSiteSupport({
	sites,
	rows,
	running,
	browsers,
	cmpPage,
	outDir,
	parallel = 3,
	spacingMs = 15000,
	log = () => {},
	record = () => {},
}) {
	const proxied = rows.filter((row) => row !== 'native');
	const results = {};
	let next = 0;
	async function worker() {
		while (next < sites.length) {
			const index = next++;
			const site = sites[index];
			const dir = join(outDir, 'shots', site.id);
			mkdirSync(dir, { recursive: true });
			const raw = {};
			const order = ['native', ...rotation(proxied, index), 'native-2'];
			for (const row of order) {
				const t = Date.now();
				const base = row === 'native-2' ? 'native' : row;
				raw[row] = await measure({
					browsers,
					row: base,
					running: running[base],
					site,
					shotFile: join(dir, `${row}.jpg`),
				});
				record({
					scenario: 'site',
					site: site.id,
					row,
					t,
					ok: raw[row].ok,
					ttl_ms: raw[row].ttl_ms,
					title: raw[row].snap?.title?.slice(0, 120),
					href: raw[row].snap?.href?.slice(0, 200),
					textLength: raw[row].snap?.textLength,
					elements: raw[row].snap?.elements,
					challenge: raw[row].snap?.challenge,
					errors: raw[row].errors?.slice(0, 10),
					failed: raw[row].requests?.failedUrls,
					leaks: raw[row].leaks?.slice(0, 10),
					interaction: raw[row].interaction,
					error: raw[row].error,
				});
				if (spacingMs) await sleep(spacingMs);
				log(
					`site ${site.id} ${row}: ${raw[row].error || (raw[row].ok ? 'ok' : 'timeout')} ${raw[row].ttl_ms ? Math.round(raw[row].ttl_ms) + ' ms' : ''} "${(raw[row].snap?.title || '').slice(0, 40)}"`,
				);
			}
			results[site.id] = await scoreSite(site, raw, dir, cmpPage, rows);
		}
	}
	await Promise.all(Array.from({ length: parallel }, worker));
	return { results, summary: summarize(sites, results, rows) };
}

async function scoreSite(site, raw, dir, cmpPage, rows) {
	const shot = (row) => {
		try {
			return readFileSync(join(dir, `${row}.jpg`));
		} catch {
			return null;
		}
	};
	const n1 = raw.native;
	const n2 = raw['native-2'];
	const nativeShots = [shot('native'), shot('native-2')];
	const nativeTokens = [tokens(n1?.snap?.text), tokens(n2?.snap?.text)];
	// against each native load, keeping the better match: pages that differ
	// from load to load (a banner shown one time in three) are then judged
	// against the native load they resemble
	const compare = async (row, against = [0, 1]) => {
		const img = shot(row);
		const r = raw[row];
		if (!img || !r?.snap) return null;
		let best = null;
		for (const i of against) {
			if (!nativeShots[i]) continue;
			const image = await compareImages(cmpPage, nativeShots[i], img).catch(
				() => null,
			);
			const text = textOverlap(nativeTokens[i], tokens(r.snap.text));
			best = {
				ssim: Math.max(best?.ssim ?? 0, image?.ssim ?? 0),
				phash_dist: Math.min(best?.phash_dist ?? 64, image?.phash_dist ?? 64),
				text: Math.max(best?.text ?? 0, text),
			};
		}
		return best;
	};
	const self = await compare('native-2', [0]);
	const nativeOk = loaded(n1) && !n1.snap.challenge;
	const native = {
		ssim: Math.max(0.05, self?.ssim ?? 1),
		text: Math.max(0.05, self?.text ?? 1),
		errors: Math.max(n1?.errors?.length ?? 0, n2?.errors?.length ?? 0),
		failed: Math.max(n1?.requests?.failed ?? 0, n2?.requests?.failed ?? 0),
		challenge: !!n1?.snap?.challenge,
		interaction: {
			scroll: n1?.interaction?.scroll && n2?.interaction?.scroll !== false,
			search: n1?.interaction?.search,
			link: n1?.interaction?.link,
		},
	};
	const out = {};
	for (const row of rows) {
		const cmp = row === 'native' ? self : await compare(row);
		const scored = score(row, raw[row], native, cmp);
		scored.shot = `shots/${site.id}/${row}.jpg`;
		if (!nativeOk && row !== 'native') {
			scored.verdict = 'native-fail';
			scored.native_challenge = native.challenge;
		}
		if (row === 'native' && !nativeOk)
			scored.verdict = native.challenge ? 'challenge' : 'fail';
		out[row] = scored;
	}
	return out;
}

function summarize(sites, results, rows) {
	const summary = {};
	for (const row of rows) {
		const s = {
			score: 0,
			pass: 0,
			partial: 0,
			fail: 0,
			challenge: 0,
			boot_fail: 0,
			native_fail: 0,
			sites: 0,
			by_category: {},
			by_feature: {},
		};
		const scores = [];
		const extraErrors = [];
		const ratios = [];
		const cats = {};
		const feats = {};
		for (const site of sites) {
			const r = results[site.id]?.[row];
			if (!r) continue;
			if (r.verdict === 'native-fail') {
				s.native_fail++;
				continue;
			}
			const native = results[site.id].native;
			if (row !== 'native' && native?.verdict !== 'pass') continue;
			s.sites++;
			s[r.verdict === 'boot-fail' ? 'boot_fail' : r.verdict]++;
			scores.push(r.score);
			(cats[site.category] ||= []).push(r.score);
			for (const f of site.features || []) (feats[f] ||= []).push(r.score);
			if (r.js_errors !== null && r.loaded)
				extraErrors.push(Math.max(0, r.js_errors - r.js_errors_native));
			if (r.ttl_ms && native?.ttl_ms) ratios.push(r.ttl_ms / native.ttl_ms);
		}
		s.score = scores.length
			? scores.reduce((a, b) => a + b, 0) / scores.length
			: null;
		for (const [k, v] of Object.entries(cats))
			s.by_category[k] = v.reduce((a, b) => a + b, 0) / v.length;
		for (const [k, v] of Object.entries(feats))
			s.by_feature[k] = v.reduce((a, b) => a + b, 0) / v.length;
		s.extra_js_errors_median = median(extraErrors);
		s.ttl_ratio_median = median(ratios);
		summary[row] = s;
	}
	return summary;
}
