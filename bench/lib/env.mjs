// The shared environment of a run: holyWisp (with the harness DNS), the leak
// catcher, the fixture server and the adapters, plus where things live.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { startHolyWisp } from './holywisp.mjs';
import { startLeakCatcher } from './leak.mjs';
import { freePort } from './net.mjs';

export const BENCH = fileURLToPath(new URL('../', import.meta.url));
export const REPO = resolve(BENCH, '..');
export const NODE_DNS_SHIM = fileURLToPath(
	new URL('./node-dns-shim.cjs', import.meta.url),
);

export const DEFAULTS = {
	chrome:
		process.env.CHROME ||
		'/home/user/.cache/stomp-chrome/156/x/root/opt/google/chrome/chrome',
	holywisp:
		process.env.HOLYWISP ||
		join(process.env.HOME, 'src/holyWisp/build/release/holywisp'),
	// setup.mjs clones and builds the other contenders here (gitignored)
	contenders:
		process.env.BENCH_CONTENDERS || join(REPO, 'bench', '.contenders'),
	node: process.env.BENCH_NODE || process.execPath,
};

/** every adapter under bench/contenders, in a fixed order */
export async function loadAdapters() {
	const order = [
		'stomp',
		'scramjet',
		'ultraviolet',
		'stompv1',
		'powermouse-v1',
	];
	const dir = join(BENCH, 'contenders');
	const found = readdirSync(dir).filter((name) =>
		existsSync(join(dir, name, 'adapter.mjs')),
	);
	found.sort(
		(a, b) =>
			(order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) ||
			a.localeCompare(b),
	);
	const adapters = [];
	for (const name of found)
		adapters.push(await import(join(dir, name, 'adapter.mjs')));
	return adapters;
}

/** the context an adapter gets (SPEC.md, adapter contract) */
export function adapterContext(env, adapter, port) {
	return {
		repoRoot: REPO,
		contendersDir: env.contenders,
		dir: join(env.contenders, adapter.id),
		wispUrl: env.wisp.url,
		port,
		freePort,
		logDir: env.logDir,
		node: env.node,
		nodeDnsShim: NODE_DNS_SHIM,
	};
}

export async function startEnv({
	holywisp = DEFAULTS.holywisp,
	contenders = DEFAULTS.contenders,
	node = DEFAULTS.node,
	logDir,
	fixtureCtx = {},
}) {
	mkdirSync(logDir, { recursive: true });
	const wisp = await startHolyWisp({ bin: holywisp, logDir });
	const leak = await startLeakCatcher(await freePort());
	const fixture = await startFixture({
		port: await freePort(),
		ctx: fixtureCtx,
	});
	fixtureCtx.fixturePort = fixture.port;
	return {
		wisp,
		leak,
		fixture,
		contenders,
		node,
		holywisp,
		logDir,
		async stop() {
			await fixture.stop();
			await leak.stop();
			await wisp.stop();
		},
	};
}
