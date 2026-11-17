// Shared runner for the parser differential fuzz (adversarial-parse-<kind>
// suites): places where STomp's rewriting reads markup, a stylesheet or a
// URL one way and Chrome reads it another. A suite generates cases (seeded:
// the same cases every run), each a piece of a page that names URLs on a
// logging server of the suite's own, and this runner loads every batch of
// them natively and through the proxy (the same-origin demo) in one Chrome.
// The oracle is what Chrome did natively:
//
// - every request the logging server got for a case (`/fz/<case>/...`),
//   with the host it was asked for. Natively it is what Chrome fetched;
//   proxied it is what the proxy fetched for the page. A target the page
//   reached natively and not proxied, or reached differently, is
//   breakage; one proxied and not natively is a leak of the rewrite (the
//   proxy fetched what the page never named).
// - every request the proxied page made past the proxy (recordRequests'
//   `raw`): an escape, whatever it is.
// - a logged request whose URL or headers show the proxy (its port, a
//   /stomp/ path): the page's code ran unrewritten and saw the real
//   location (an escape), or a proxied request told the target where it
//   came from (a leak).
// - what the page itself reports per case (`window.__fz.obs[case]`, read
//   back values, computed styles, a document's shape): a value proxied that
//   is not the native one is breakage.
//
// Each suite lists its open findings (`knownOpen`: a key, the reason, and
// `match(case, finding)`); a finding that matches one passes as known open,
// one that matches none fails the suite, and an entry no finding matched in
// a run where some of its cases ran is stale and fails too, so the entry goes
// when a fix lands. The budget bounds the run: batches are run in order
// until it is spent, and the rest are skipped with a note (never a failure).
//
// This file is a library. Run by test/run.mjs it prints nothing and exits 0.
import { createServer } from 'node:http';
import {
	done,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
	submitOmni,
} from './lib.mjs';

/** a seeded PRNG (mulberry32): the same cases every run */
export function prng(seed) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n) => Math.floor(next() * n);
	const pick = (list) => list[int(list.length)];
	return { next, int, pick };
}

// a 1x1 PNG: every image a case names is one
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);
// an SVG document with the fragments a filter, a clip-path, a mask and a
// marker name
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><filter id="f"><feOffset/></filter><clipPath id="c"><rect width="1" height="1"/></clipPath><mask id="m"><rect width="1" height="1" fill="white"/></mask><marker id="k"/><rect id="r" width="1" height="1"/></svg>`;

const TYPES = {
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript',
	html: 'text/html; charset=utf-8',
	svg: 'image/svg+xml',
	json: 'application/json',
	txt: 'text/plain',
	vtt: 'text/vtt',
};

/**
 * The logging server: serves what a batch registered (`files`, by path) and
 * answers anything else under /fz/ by its extension, and logs every request
 * with the host it was asked for.
 */
export async function startLogServer() {
	const files = new Map();
	let log = [];
	let reports = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		const entry = {
			method: req.method,
			host: req.headers.host,
			path: url.pathname,
			search: url.search,
			headers: req.headers,
			at: Date.now(),
		};
		if (url.pathname === '/fz-done') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				try {
					reports.push(JSON.parse(body));
				} catch (error) {
					reports.push({ unparsed: body.slice(0, 200) });
				}
				res.writeHead(204, {
					'access-control-allow-origin': '*',
					'cache-control': 'no-store',
				});
				res.end();
			});
			return;
		}
		log.push(entry);
		const file = files.get(url.pathname);
		const ext = /\.(\w+)$/.exec(url.pathname)?.[1] ?? '';
		const headers = {
			'cache-control': 'no-store',
			'access-control-allow-origin': '*',
			'timing-allow-origin': '*',
		};
		if (file) {
			res.writeHead(file.status ?? 200, {
				...headers,
				// a type of null sends none (the browser sniffs what it got)
				...(file.type === null
					? {}
					: { 'content-type': file.type ?? TYPES[ext] ?? 'text/plain' }),
				...file.headers,
			});
			res.end(file.body);
			return;
		}
		if (/^(woff2?|ttf|otf)$/.test(ext)) {
			res.writeHead(404, headers);
			res.end();
			return;
		}
		if (TYPES[ext]) {
			res.writeHead(200, { ...headers, 'content-type': TYPES[ext] });
			res.end(
				ext === 'svg'
					? SVG
					: ext === 'html'
						? '<!doctype html><title>fz</title>'
						: ext === 'json'
							? '{}'
							: ext === 'vtt'
								? 'WEBVTT\n'
								: '',
			);
			return;
		}
		res.writeHead(200, { ...headers, 'content-type': 'image/png' });
		res.end(PNG);
	});
	server.keepAliveTimeout = 60000;
	await new Promise((resolve) => server.listen(0, resolve));
	const port = server.address().port;
	return {
		port,
		origin: `http://127.0.0.1:${port}`,
		// a second origin of the same server (cross-origin targets)
		other: `http://localhost:${port}`,
		files,
		take() {
			const taken = { log, reports };
			log = [];
			reports = [];
			return taken;
		},
		peek: () => ({ log, reports }),
		close: () => server.close(),
	};
}

/**
 * The script every batch page ends with: once the page loaded and settled,
 * it posts what the cases observed (`window.__fz.obs`) to /fz-done. `settle`
 * gives late loads (an @import's own url()s, a font) time to start.
 */
export const doneScript = (origin, settle = 600) =>
	`<script>
(() => {
	const report = () => {
		let obs = {};
		try { obs = (window.__fzCollect ? window.__fzCollect() : null) || window.__fz.obs; } catch (e) { obs = { collectError: String(e) }; }
		fetch(${JSON.stringify(origin)} + '/fz-done', { method: 'POST', body: JSON.stringify({ obs }), mode: 'no-cors', keepalive: true });
	};
	const later = () => setTimeout(() => Promise.resolve(window.__fzReady).then(report, report), ${settle});
	if (document.readyState === 'complete') later(); else addEventListener('load', later);
})();
</script>`;

/** the start of every batch page: where cases put what they observe */
export const headScript = `<script>window.__fz = { obs: {} };</script>`;

const caseOf = (path) => /^\/fz\/([^/]+)\//.exec(path)?.[1] ?? null;

/** what a logged request stands for: the host it was asked for and its path */
const keyOf = (entry) => `${entry.host}${entry.path}${entry.search}`;

/** the proxy's tells in a request: a code that ran unrewritten, or a header the proxy let through */
const proxyTell = (text) =>
	new RegExp(`/stomp/|(127\\.0\\.0\\.1|localhost):${PORT}(?!\\d)`).test(text);

/** wait until the batch reported and the log stayed quiet for `quiet` ms */
async function settle(server, { timeout = 25000, quiet = 700 } = {}) {
	const started = Date.now();
	let reported = false;
	let last = -1;
	let quietSince = Date.now();
	while (Date.now() - started < timeout) {
		const { log, reports } = server.peek();
		if (reports.length) reported = true;
		if (log.length !== last) {
			last = log.length;
			quietSince = Date.now();
		}
		if (reported && Date.now() - quietSince >= quiet) break;
		await sleep(100);
	}
	return reported;
}

function summarise(log, cases) {
	const byCase = new Map(cases.map((c) => [c.id, new Map()]));
	const strays = [];
	for (const entry of log) {
		const id = caseOf(entry.path);
		const into = id && byCase.get(id);
		if (into) {
			const key = keyOf(entry);
			if (!into.has(key)) into.set(key, entry);
		} else strays.push(entry);
	}
	return { byCase, strays };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (value, n = 300) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text && text.length > n ? `${text.slice(0, n)}...` : text;
};

/**
 * The findings of one case: native against proxied. Each is
 * `{ kind: 'escape' | 'leak' | 'breakage', what, detail }`.
 */
function compareCase(c, native, proxied, rawList, nativeObs, proxiedObs) {
	const findings = [];
	// Playwright and CDP both report most requests: one finding per URL
	const raws = [...new Map(rawList.map((raw) => [raw.url, raw])).values()];
	const rawKeys = new Set(
		raws.map((raw) => {
			try {
				const u = new URL(raw.url);
				return `${u.host}${u.pathname}${u.search}`;
			} catch (error) {
				return raw.url;
			}
		}),
	);
	for (const raw of raws)
		findings.push({
			kind: 'escape',
			what: 'request past the proxy',
			detail: `${raw.url.slice(0, 200)} (${raw.type})`,
		});
	for (const [key, entry] of proxied) {
		// a request past the proxy carries the proxy's referrer: the escape
		// above says it
		if (rawKeys.has(key)) continue;
		const tell = [
			entry.path + entry.search,
			...Object.entries(entry.headers)
				.filter(([name]) => !/^(host|origin)$/.test(name))
				.map(([, value]) => String(value)),
		].find(proxyTell);
		if (tell)
			findings.push(
				/\/ran/.test(entry.path) && proxyTell(entry.path + entry.search)
					? {
							kind: 'escape',
							what: 'code ran unrewritten (saw the proxy URL)',
							detail: short(key, 240),
						}
					: {
							kind: 'leak',
							what: 'request shows the proxy',
							detail: `${short(key, 160)}: ${short(tell, 200)}`,
						},
			);
	}
	const nativeKeys = [...native.keys()].filter((k) => !c.ignore?.(k));
	const proxiedKeys = [...proxied.keys()].filter((k) => !c.ignore?.(k));
	const missing = nativeKeys.filter((k) => !proxied.has(k) && !rawKeys.has(k));
	// a request that reached the logging server past the proxy is the escape
	// above, not one the proxy made
	const extra = proxiedKeys.filter((k) => !native.has(k) && !rawKeys.has(k));
	if (missing.length)
		findings.push({
			kind: 'breakage',
			what: 'native request not made proxied',
			detail: `${short(missing)}${extra.length ? `; proxied asked ${short(extra)}` : ''}`,
		});
	else if (extra.length)
		findings.push({
			kind: extra.some(proxyTell) ? 'leak' : 'breakage',
			what: 'proxied request not made natively',
			detail: short(extra),
		});
	if (c.observe !== false) {
		const a = nativeObs?.[c.id];
		const b = proxiedObs?.[c.id];
		if (!same(a, b)) {
			const keys = [
				...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]),
			];
			const differing = keys.filter((k) => !same(a?.[k], b?.[k]));
			for (const k of differing.length ? differing : ['(all)']) {
				const nv = a?.[k];
				const pv = b?.[k];
				const tell = proxyTell(JSON.stringify(pv ?? null));
				findings.push({
					kind: tell ? (/^ran|^exec/.test(k) ? 'escape' : 'leak') : 'breakage',
					what: `observed ${k}`,
					detail: `native ${short(nv, 200)} proxied ${short(pv, 200)}`,
				});
			}
		}
	}
	return findings;
}

/**
 * Run the batches natively and proxied, compare, report. A batch is
 * `{ id, page, files, cases }`: `page` the batch page's markup (served at
 * /fz-batch/<id>.html), `files` more bodies by path, `cases` the cases it
 * holds (`{ id, tags, repro, ignore?, observe? }`; a case's requests are
 * the ones whose path starts /fz/<id>/).
 */
export async function runDifferential({
	name,
	build,
	knownOpen = {},
	budget = 240000,
	native: nativeOnly = false,
}) {
	const server = await startLogServer();
	const batches = build(server);
	if (process.env.FZ_LIST === '1') {
		// list what each batch holds and stop: to find a batch's cases
		for (const batch of batches)
			for (const c of batch.cases)
				console.log(`LIST ${batch.id} ${c.id} ${JSON.stringify(c.tags)}`);
		server.close();
		return;
	}
	const browser = await launch();
	const major = Number(browser.version().split('.')[0]);
	console.log(`Chrome ${browser.version()}`);
	const entries = Object.entries(knownOpen).map(([key, entry]) => ({
		key,
		...entry,
		hits: 0,
		ran: 0,
	}));
	const started = Date.now();
	const nativeContext = await browser.newContext();
	let demo = null;
	let recorder = null;
	let first = true;
	const counts = { cases: 0, agree: 0, open: 0, failed: 0 };
	const skipped = [];
	for (const batch of batches) {
		if (Date.now() - started > budget) {
			skipped.push(batch);
			continue;
		}
		const path = `/fz-batch/${batch.id}.html`;
		server.files.set(path, { type: TYPES.html, body: batch.page });
		for (const [file, body] of Object.entries(batch.files ?? {}))
			server.files.set(file, body);
		const url = `${server.origin}${path}`;
		// native
		server.take();
		const page = await nativeContext.newPage();
		await page.goto(url, { waitUntil: 'commit' }).catch(() => {});
		const nativeReported = await settle(server);
		await page.close();
		const nativeRun = server.take();
		if (nativeOnly) {
			const { byCase } = summarise(nativeRun.log, batch.cases);
			for (const c of batch.cases)
				console.log(
					`NATIVE ${c.id} ${short([...byCase.get(c.id).keys()])} ${short(nativeRun.reports[0]?.obs?.[c.id])}`,
				);
			continue;
		}
		// proxied
		if (!demo) {
			demo = await openDemo(browser, PROXY);
			recorder = await recordRequests(demo.context());
		}
		const mark = recorder.log.length;
		if (first) await submitLanding(demo, url);
		else await submitOmni(demo, url);
		first = false;
		const proxiedReported = await settle(server, { timeout: 40000 });
		await sleep(200);
		const proxiedRun = server.take();
		// a ws: or wss: URL anywhere but a WebSocket is no request the
		// network sees: Chrome fails it as an unknown scheme, natively too
		const raw = recorder.log
			.slice(mark)
			.filter(
				(e) =>
					e.kind === 'raw' &&
					(/^https?:/i.test(e.url) || e.type === 'websocket'),
			);
		const nativeSum = summarise(nativeRun.log, batch.cases);
		const proxiedSum = summarise(proxiedRun.log, batch.cases);
		const nativeObs = nativeRun.reports[0]?.obs ?? null;
		const proxiedObs = proxiedRun.reports[0]?.obs ?? null;
		ok(
			`${name}: batch ${batch.id} reported natively and proxied`,
			nativeReported && proxiedReported,
			`native ${nativeReported} proxied ${proxiedReported}`,
		);
		const rawOf = (id) =>
			raw.filter((e) => {
				try {
					return caseOf(new URL(e.url).pathname) === id;
				} catch (error) {
					return false;
				}
			});
		for (const c of batch.cases) {
			counts.cases++;
			const findings = proxiedReported
				? compareCase(
						c,
						nativeSum.byCase.get(c.id),
						proxiedSum.byCase.get(c.id),
						rawOf(c.id),
						nativeObs,
						proxiedObs,
					)
				: [];
			const matching = entries.filter(
				(e) =>
					(!e.chrome || e.chrome.includes(major)) && e.applies?.(c) !== false,
			);
			for (const entry of matching) entry.ran++;
			if (!findings.length) {
				counts.agree++;
				continue;
			}
			for (const finding of findings) {
				const entry = matching.find((e) => e.match(c, finding));
				const label = `${name}: ${c.id} ${finding.kind}: ${finding.what}`;
				const detail = `${finding.detail} | repro ${short(c.repro, 400)}`;
				if (entry) {
					entry.hits++;
					counts.open++;
					ok(`${label} (known open ${entry.key}: ${entry.why})`, true, detail);
				} else {
					counts.failed++;
					ok(label, false, detail);
				}
			}
		}
		// a request past the proxy that names no case is the batch's own
		const strayRaw = raw.filter((e) => {
			try {
				return !caseOf(new URL(e.url).pathname);
			} catch (error) {
				return true;
			}
		});
		ok(
			`${name}: batch ${batch.id} makes no other request past the proxy`,
			strayRaw.length === 0,
			short(strayRaw.map((e) => `${e.url} (${e.type})`)),
		);
	}
	if (skipped.length)
		console.log(
			`NOTE ${name}: budget spent, ${skipped.length} of ${batches.length} batches not run (${skipped.map((b) => b.id).join(', ')})`,
		);
	console.log(
		`NOTE ${name}: ${counts.cases} cases, ${counts.agree} agree, ${counts.open} known-open findings, ${counts.failed} new findings, ${Math.round((Date.now() - started) / 1000)} s`,
	);
	if (!nativeOnly)
		for (const entry of entries) {
			if (entry.chrome && !entry.chrome.includes(major)) continue;
			if (!entry.ran) {
				console.log(`NOTE ${name}: known-open ${entry.key} met no case`);
				continue;
			}
			ok(
				`${name}: known-open ${entry.key} still holds`,
				entry.hits > 0,
				entry.hits
					? `${entry.hits} findings`
					: `no finding matched it in ${entry.ran} cases: the entry is stale and goes`,
			);
		}
	server.close();
	await demo?.close();
	await done(browser);
}

/** HTML-escape text for an attribute value written with double quotes */
export const attr = (text) =>
	String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** a string as a JS literal that is safe inside <script> */
export const js = (value) =>
	JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\u2028')
		.replace(/\u2029/g, '\\u2029');
