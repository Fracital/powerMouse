// Clones, downloads, installs and builds every contender at its pinned
// version (each adapter's setup(); see its header for what it pins), into
// --contenders (default bench/.contenders, gitignored). Idempotent: a
// contender that is already set up is checked and skipped.
//
//   node bench/lib/setup.mjs [--contenders <dir>] [--only scramjet,ultraviolet]
// bench/run.py runs it before every run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, loadAdapters, NODE_DNS_SHIM, REPO } from './env.mjs';
import { freePort } from './net.mjs';

const { values } = parseArgs({
	options: {
		contenders: { type: 'string', default: DEFAULTS.contenders },
		only: { type: 'string' },
		node: { type: 'string', default: DEFAULTS.node },
	},
});
const only = values.only ? new Set(values.only.split(',')) : null;
mkdirSync(values.contenders, { recursive: true });
const logDir = join(values.contenders, '.logs');
mkdirSync(logDir, { recursive: true });
let failed = 0;
for (const adapter of await loadAdapters()) {
	if (only && !only.has(adapter.id)) continue;
	const ctx = {
		repoRoot: REPO,
		contendersDir: values.contenders,
		dir: join(values.contenders, adapter.id),
		wispUrl: 'ws://127.0.0.1:1/',
		port: 0,
		freePort,
		logDir,
		node: values.node,
		nodeDnsShim: NODE_DNS_SHIM,
	};
	const t = Date.now();
	try {
		await adapter.setup(ctx);
		const info = await adapter.describe(ctx);
		console.log(
			`${adapter.id}: ready in ${((Date.now() - t) / 1000).toFixed(1)} s (${info.sha || info.ref || ''})`,
		);
	} catch (error) {
		failed++;
		console.error(`${adapter.id}: setup failed: ${error.stack}`);
	}
}
process.exit(failed ? 1 : 0);
