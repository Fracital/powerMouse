// The benchmark driver behind bench/run.py (which sets up the contenders
// first and passes its arguments through). Starts holyWisp (the one wisp
// server every wisp contender uses), the harness DNS, the fixture server and
// the leak catcher, every contender row's host server, and Chrome, then runs
// the scenarios and writes results.json, runs.jsonl, results.csv and
// results.md to --out. bench/README.md has the method.
//
//   node bench/lib/driver.mjs --out bench/results/full [--headful] [--repeats 5]
//        [--only stomp-js,scramjet] [--scenarios size,fixtures,...]
//        [--sites wikipedia,mdn] [--parallel 8] [--spacing 15000] [--merge]
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from './browser.mjs';
import { DEFAULTS, loadAdapters, REPO, startEnv } from './env.mjs';
import { HOLYWISP_SETTINGS, holyWispVersion } from './holywisp.mjs';
import { freePort, sleep, startProcess } from './net.mjs';
import { resultsCSV, resultsMarkdown } from './report.mjs';
import { startRow } from './session.mjs';
import { runSiteSupport } from './site-support.mjs';
import { SITES, TIMED_SITES } from './sites.mjs';
import { measureSize } from './size.mjs';
import {
	runFirstVisit,
	runFixtureLoads,
	runMemory,
	runRealTimed,
	runSPA,
} from './speed.mjs';

const ALL_SCENARIOS = [
	'size',
	'fidelity',
	'fixtures',
	'first-visit',
	'spa',
	'memory',
	'real',
	'rewrite-offline',
	'sites',
];

const { values: opts } = parseArgs({
	options: {
		out: { type: 'string' },
		only: { type: 'string' },
		scenarios: { type: 'string', default: ALL_SCENARIOS.join(',') },
		repeats: { type: 'string', default: '5' },
		sites: { type: 'string' },
		parallel: { type: 'string', default: '8' },
		spacing: { type: 'string', default: '15000' },
		headful: { type: 'boolean', default: false },
		merge: { type: 'boolean', default: false },
		chrome: { type: 'string', default: DEFAULTS.chrome },
		holywisp: { type: 'string', default: DEFAULTS.holywisp },
		contenders: { type: 'string', default: DEFAULTS.contenders },
		node: { type: 'string', default: DEFAULTS.node },
	},
});

const out = resolve(
	opts.out ||
		join(REPO, 'bench/results', new Date().toISOString().slice(0, 10)),
);
mkdirSync(join(out, 'logs'), { recursive: true });
const scenarios = opts.scenarios.split(',').filter(Boolean);
const repeats = Number(opts.repeats);
const started = Date.now();

const log = (line) => {
	const text = `[${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s] ${line}`;
	console.log(text);
	appendFileSync(join(out, 'logs', 'run.log'), text + '\n');
};
const record = (entry) =>
	appendFileSync(
		join(out, 'runs.jsonl'),
		JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
	);

const sh = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
};

function hostInfo() {
	let osName = os.type();
	try {
		osName =
			readFileSync('/etc/os-release', 'utf8').match(
				/^PRETTY_NAME="?([^"\n]+)/m,
			)?.[1] || osName;
	} catch {
		// keep the kernel type
	}
	return {
		hostname: os.hostname(),
		cpu: os.cpus()[0]?.model,
		cores: os.cpus().length,
		mem_gb: Math.round(os.totalmem() / 1073741824),
		kernel: os.release(),
		os: osName,
	};
}

// ---------------------------------------------------------------- setup
const results =
	opts.merge && existsSync(join(out, 'results.json'))
		? JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
		: {};
const save = () => {
	writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
	writeFileSync(join(out, 'results.md'), resultsMarkdown(results));
	writeFileSync(join(out, 'results.csv'), resultsCSV(results));
};

const loadSamples = [];
const sampler = setInterval(
	() => loadSamples.push({ t: Date.now(), load: os.loadavg() }),
	30000,
);
sampler.unref();

const adapters = await loadAdapters();
const only = opts.only ? new Set(opts.only.split(',')) : null;
const rowDefs = [
	{ row: 'native', label: 'native Chrome', contender: 'native' },
];
for (const adapter of adapters)
	for (const row of adapter.rows)
		if (!only || only.has(row.row) || only.has(adapter.id))
			rowDefs.push({ ...row, contender: adapter.id, adapter });
const rows = rowDefs.map((r) => r.row);

let xvfb = null;
if (opts.headful && !process.env.DISPLAY) {
	const display = `:${90 + Math.floor(Math.random() * 400)}`;
	xvfb = startProcess(
		'Xvfb',
		[display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
		{ logFile: join(out, 'logs', 'xvfb.log') },
	);
	process.env.DISPLAY = display;
	await sleep(1500);
}

const fixtureCtx = {};
if (scenarios.includes('fixtures') || scenarios.includes('rewrite-offline')) {
	try {
		const { ensureScripts } = await import('./scripts.mjs');
		fixtureCtx.scripts = await ensureScripts(
			join(dirname(out), '.cache', 'scripts'),
		);
	} catch (error) {
		log(`rewrite corpus unavailable: ${error.message}`);
	}
}
const env = await startEnv({
	holywisp: opts.holywisp,
	contenders: opts.contenders,
	node: opts.node,
	logDir: join(out, 'logs'),
	fixtureCtx,
});
log(
	`holyWisp ${env.wisp.url} (pid ${env.wisp.pid}), fixture :${env.fixture.port}, leak catcher :${env.leak.port}`,
);

const chromeVersion =
	sh(opts.chrome, ['--version'])?.match(/[\d.]+/)?.[0] || 'unknown';
const holywispDir = resolve(dirname(opts.holywisp), '../..');
results.meta = {
	...(results.meta || {}),
	date: new Date().toISOString(),
	host: hostInfo(),
	chrome: chromeVersion,
	chrome_path: opts.chrome,
	node: sh(opts.node, ['--version']),
	harness_node: process.version,
	holywisp: {
		version: holyWispVersion(opts.holywisp),
		sha: sh('git', ['-C', holywispDir, 'rev-parse', 'HEAD']),
		settings: HOLYWISP_SETTINGS.map(([k, v]) => `${k}=${v}`),
		args: env.wisp.args,
	},
	harness: {
		sha: sh('git', ['-C', REPO, 'rev-parse', 'HEAD']),
		dirty: !!sh('git', ['-C', REPO, 'status', '--porcelain', '--', 'bench']),
	},
	command: process.argv.slice(1).join(' '),
	repeats,
	headful_sites: opts.headful,
	load: { before: os.loadavg(), samples: loadSamples },
	rows: [],
};
results.rows = rows;
results.labels = Object.fromEntries(rowDefs.map((r) => [r.row, r.label]));

const running = { native: null };
for (const def of rowDefs) {
	if (def.row === 'native') {
		results.meta.rows.push({
			row: 'native',
			label: def.label,
			contender: 'native',
		});
		continue;
	}
	const ctx = {
		repoRoot: REPO,
		contendersDir: env.contenders,
		dir: join(env.contenders, def.adapter.id),
		wispUrl: env.wisp.url,
		port: 0,
		freePort,
		logDir: env.logDir,
		node: env.node,
	};
	let describe;
	try {
		describe = await def.adapter.describe(ctx);
	} catch (error) {
		describe = { error: error.message };
	}
	results.meta.rows.push({
		row: def.row,
		label: def.label,
		contender: def.contender,
		options: def.options,
		describe,
	});
	try {
		running[def.row] = await startRow(env, def.adapter, def);
		log(`started ${def.row} at ${running[def.row].hostUrl}`);
	} catch (error) {
		log(`could not start ${def.row}: ${error.message}`);
		running[def.row] = {
			hostUrl: 'about:blank#start-failed',
			pids: [],
			startError: error.message,
			stop: async () => {},
		};
	}
}
save();

const launchOptions = {
	chrome: opts.chrome,
	leakPort: env.leak.port,
	chromeVersion,
};
const browsers = {
	native: await launch({ ...launchOptions, kind: 'native' }),
	proxy: await launch({ ...launchOptions, kind: 'proxy' }),
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
	process.on(signal, () => cleanup(signal).finally(() => process.exit(130)));
const sessions = {
	native: await browsers.native.newBrowserCDPSession(),
	proxy: await browsers.proxy.newBrowserCDPSession(),
};
const ctx = {
	env,
	rows,
	running,
	browsers,
	sessions,
	repeats,
	log,
	record,
	launchOptions,
};

async function scenario(name, fn) {
	if (!scenarios.includes(name)) return;
	const t = Date.now();
	const before = os.loadavg();
	log(`=== ${name} (load ${before.map((l) => l.toFixed(2)).join(' ')})`);
	try {
		await fn();
	} catch (error) {
		log(`scenario ${name} failed: ${error.stack}`);
		(results.errors ||= {})[name] = error.message;
	}
	(results.meta.scenarios ||= {})[name] = {
		seconds: Math.round((Date.now() - t) / 1000),
		load_before: before,
		load_after: os.loadavg(),
	};
	save();
}

results.speed ||= {};
try {
	await scenario('size', async () => {
		results.size = {};
		for (const def of rowDefs) {
			if (def.row === 'native') continue;
			const ctxRow = running[def.row]?.ctx;
			if (!ctxRow) continue;
			results.size[def.row] = measureSize(
				await def.adapter.assets(ctxRow, def.options || {}),
			);
		}
	});
	await scenario('fidelity', async () => {
		const { runFidelity } = await import('./fidelity.mjs');
		const { loadURL, openNativeTab, openProxiedTab } =
			await import('./session.mjs');
		results.fidelity = await runFidelity({
			env,
			rows,
			open: (row) =>
				row === 'native'
					? openNativeTab(browsers.native)
					: openProxiedTab(browsers.proxy, running[row]),
			load: loadURL,
			log,
			record,
		});
	});
	await scenario('fixtures', async () => {
		const res = await runFixtureLoads(ctx);
		Object.assign(results.speed, {
			fixtures: res.fixtures,
			paint: res.paint,
			cpu: res.cpu,
			transfer: res.transfer,
		});
		results.speed.rewrite = {
			...(results.speed.rewrite || {}),
			...res.rewrite,
		};
	});
	await scenario('first-visit', async () => {
		results.speed.first_visit = await runFirstVisit(ctx);
	});
	await scenario('spa', async () => {
		results.speed.spa = await runSPA(ctx);
	});
	await scenario('memory', async () => {
		results.speed.memory = await runMemory(ctx);
	});
	await scenario('real', async () => {
		const sites = SITES.filter((s) => TIMED_SITES.includes(s.id));
		Object.assign(results.speed, await runRealTimed(ctx, sites));
	});
	await scenario('rewrite-offline', async () => {
		const { measureOffline } = await import('./rewrite-offline.mjs');
		const res = await measureOffline({
			repoRoot: REPO,
			contendersDir: env.contenders,
			scripts: fixtureCtx.scripts,
			repeats,
			chrome: opts.chrome,
		});
		const { notes, perScript, failures, common, meta, ...all } = res;
		const {
			scripts: commonScripts,
			bytes: commonBytes,
			...commonRows
		} = common || {};
		results.speed.rewrite = {
			...(results.speed.rewrite || {}),
			offline: {
				label: `Rewriter alone, the ${commonScripts?.length ?? 0} corpus scripts every rewriter handled (no network, no proxy)`,
				unit: 'MB/s',
				lower_better: false,
				rows: commonRows,
				scripts: commonScripts,
				bytes: commonBytes,
			},
			offline_all: {
				label: 'Rewriter alone, every corpus script it handled',
				unit: 'MB/s',
				lower_better: false,
				rows: all,
			},
		};
		results.rewrite_offline = { notes, per_script: perScript, failures, meta };
	});
	await scenario('sites', async () => {
		const pick = opts.sites ? new Set(opts.sites.split(',')) : null;
		const sites = SITES.filter((s) => !pick || pick.has(s.id));
		let siteBrowsers = browsers;
		if (opts.headful)
			siteBrowsers = {
				native: await launch({
					...launchOptions,
					kind: 'native',
					headful: true,
				}),
				proxy: await launch({ ...launchOptions, kind: 'proxy', headful: true }),
			};
		const cmpContext = await browsers.native.newContext();
		const cmpPage = await cmpContext.newPage();
		const res = await runSiteSupport({
			sites,
			rows,
			running,
			browsers: siteBrowsers,
			cmpPage,
			outDir: out,
			parallel: Number(opts.parallel),
			spacingMs: Number(opts.spacing),
			log,
			record,
		});
		results.site_support = {
			headful: opts.headful,
			sites: sites.map(({ id, url, category, features }) => ({
				id,
				url,
				category,
				features: features || [],
			})),
			...res,
		};
		await cmpContext.close();
		if (siteBrowsers !== browsers) {
			await siteBrowsers.native.close();
			await siteBrowsers.proxy.close();
		}
	});
} finally {
	await cleanup('done');
}

/** stops everything this run started; also on SIGTERM / SIGINT */
async function cleanup(why) {
	if (cleanup.ran) return;
	cleanup.ran = true;
	results.meta.load.after = os.loadavg();
	results.meta.seconds = Math.round((Date.now() - started) / 1000);
	results.meta.leak_catcher_hits = env.leak.hits.length;
	if (why !== 'done') results.meta.stopped = why;
	save();
	await browsers.native.close().catch(() => {});
	await browsers.proxy.close().catch(() => {});
	for (const r of Object.values(running)) await r?.stop?.().catch(() => {});
	await env.stop();
	await xvfb?.stop();
	clearInterval(sampler);
	log(
		`${why === 'done' ? 'done' : `stopped (${why})`} in ${results.meta.seconds}s: ${out}`,
	);
}
