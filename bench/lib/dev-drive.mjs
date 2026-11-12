// Development driver: load one URL natively or through one contender row and
// print what the harness sees.
//   node bench/lib/dev-drive.mjs <row|native> <url> [--headful] [--shot file]
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { launch } from './browser.mjs';
import { DEFAULTS, loadAdapters, startEnv } from './env.mjs';
import {
	loadURL,
	openNativeTab,
	openProxiedTab,
	screenshot,
	startRow,
} from './session.mjs';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		headful: { type: 'boolean' },
		shot: { type: 'string' },
		chrome: { type: 'string', default: DEFAULTS.chrome },
		holywisp: { type: 'string', default: DEFAULTS.holywisp },
		contenders: { type: 'string', default: DEFAULTS.contenders },
		logs: { type: 'string', default: '/tmp/bench-dev-logs' },
		timeout: { type: 'string', default: '45000' },
	},
});
const [rowId, rawUrl] = positionals;
mkdirSync(values.logs, { recursive: true });
const env = await startEnv({
	holywisp: values.holywisp,
	contenders: values.contenders,
	logDir: values.logs,
});
const url = rawUrl.replace('{fixture}', `a.bench.test:${env.fixture.port}`);
let running = null;
const browser = await launch({
	chrome: values.chrome,
	kind: rowId === 'native' ? 'native' : 'proxy',
	headful: values.headful,
	leakPort: env.leak.port,
	chromeVersion: '156',
});
try {
	let tab;
	if (rowId === 'native') tab = await openNativeTab(browser);
	else {
		const adapters = await loadAdapters();
		const adapter = adapters.find((a) => a.rows.some((r) => r.row === rowId));
		if (!adapter) throw new Error(`no adapter has row ${rowId}`);
		running = await startRow(
			env,
			adapter,
			adapter.rows.find((r) => r.row === rowId),
		);
		tab = await openProxiedTab(browser, running);
		console.log('boot', tab.bootMs, 'ms', tab.bootError || '');
	}
	const t = Date.now();
	const result = await loadURL(tab, url, { timeoutMs: Number(values.timeout) });
	const { snap } = result;
	console.log(
		JSON.stringify(
			{
				ok: result.ok,
				timedOut: result.timedOut,
				navError: result.navError,
				ttl_ms: result.ttl_ms,
				fcp: result.fcp_ms,
				lcp: result.lcp_ms,
				href: snap?.href,
				title: snap?.title,
				elements: snap?.elements,
				textLength: snap?.textLength,
				challenge: snap?.challenge,
				errors: result.errors?.slice(0, 8),
				benchResult: snap?.benchResult?.slice(0, 300),
				requests: result.requests,
				leaks: env.leak.since(t),
			},
			null,
			1,
		),
	);
	if (values.shot) await screenshot(tab, values.shot);
	await tab.context.close();
} finally {
	await browser.close();
	await running?.stop();
	await env.stop();
}
