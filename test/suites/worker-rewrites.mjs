// What a dedicated worker evaluates from text, natively and through the
// proxy: `new Function`, `eval`, a timer's string, `importScripts` of a
// data: URL, a module's `import()` of one, in a classic worker, a module
// worker, a blob: worker, a worker of a worker, a frame's worker and a
// service worker (test/pages/worker-rewrites*). Each reads the worker's own
// location, which only rewritten code reads as the page's, so the answers
// of the two loads must be the same, with either rewriter.
//
// With `rewriter: 'wasm'` the rewrite is the module's, not the JavaScript
// library's: a dedicated worker is handed the compiled module by the
// context that starts it, in its first message (docs/rust-plan.md, "One
// module, many realms"). The suite reads the functions the workers made as
// the browser holds them (the worker's own `toString` answers the page's
// text either way): the module keeps a comment, the JavaScript rewriter
// prints none. What a classic worker evaluates while its own script runs
// comes before any message can, and stays the JavaScript library's.
import { readFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const WASM = process.env.STOMP_REWRITER === 'wasm';
const ROUTED = /\/stomp\/[\w-]+\/html\//;
const browser = await launch();

/** `value` with every object's keys in order: the answers come in the order the workers finished */
const sorted = (value) =>
	value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, sorted(value[key])]),
			)
		: value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
/** where two answers differ, for a failure's detail */
function differences(native, proxied) {
	const out = [];
	for (const name of new Set([
		...Object.keys(native ?? {}),
		...Object.keys(proxied ?? {}),
	])) {
		const a = native?.[name];
		const b = proxied?.[name];
		if (same(a, b)) continue;
		if (a && b && typeof a === 'object' && typeof b === 'object')
			out.push(...differences(a, b).map((line) => `${name}.${line}`));
		else out.push(`${name}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
	}
	return out;
}

/** the page's `global` once it has every one of `names` */
async function answers(frame, global, names) {
	let value = {};
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		value =
			(await frame()
				?.evaluate((global) => window[global], global)
				.catch(() => null)) ?? {};
		if (names.every((name) => value[name] !== undefined)) break;
	}
	return value;
}

const FIRST = ['classic', 'module', 'blob', 'frame'];
const AGAIN = ['classicAgain', 'moduleAgain', 'blobAgain', 'pageLarge'];

/** start the fixture's workers (`early`: its first script does), then send each a second message; the answers */
async function run(frame, early) {
	if (!early) await frame().evaluate(() => window.start());
	await answers(frame, '__wr', FIRST);
	await frame().evaluate(() => window.again());
	return answers(frame, '__wr', [...FIRST, ...AGAIN]);
}

/**
 * The functions the page's workers made from text, by the stage that made
 * them, as the browser holds them: the worker's own `toString` is hooked,
 * the debugger's description of a function is its real text
 */
async function made(page, frame) {
	const out = {};
	// and the page's own
	for (const stage of ['pageLarge', 'pageAfterLarge'])
		try {
			const handle = await frame?.().evaluateHandle(
				(stage) => window.__made?.[stage],
				stage,
			);
			const text = String(handle);
			if (handle && text !== 'undefined') out[stage] = [{ kind: 'page', text }];
		} catch (error) {
			// no such frame
		}
	for (const worker of page.workers()) {
		const kind = worker.url().startsWith('blob:') ? 'blob' : 'url';
		try {
			const stages = await worker.evaluate(() =>
				Object.keys(self.__made ?? {}),
			);
			for (const stage of stages) {
				const handle = await worker.evaluateHandle(
					(stage) => self.__made[stage],
					stage,
				);
				(out[stage] ??= []).push({ kind, text: String(handle) });
			}
		} catch (error) {
			// a worker that is gone
		}
	}
	return out;
}
/** whether every function made at `stage` (and at least one) is the module's rewrite */
const byModule = (functions, stage) =>
	!!functions[stage]?.length &&
	functions[stage].every(
		({ text }) => text.includes('/* kept */') && text.includes('.get(location'),
	);

/** a failed check's detail: what the browser holds for `stage` */
const report = (functions, stage) =>
	byModule(functions, stage) ? '' : JSON.stringify(functions[stage] ?? null);

const fixture = (query = '') => `${FIXTURE}pages/worker-rewrites.html${query}`;

/** whether every worker of the fixture answered */
const everyWorker = (result) =>
	[...FIRST, ...AGAIN].every((name) => typeof result?.[name] === 'object');

/**
 * What `work` reads of a native load of `url`, loaded again (three loads at
 * most) until `complete` holds of it: now and then Chrome aborts the fetch
 * of the frame's worker's script as it starts (net::ERR_ABORTED), and that
 * worker never runs, natively, so it never answers however long the suite
 * waits. Each load is a page of its own
 */
async function native(url, work, complete = () => true) {
	let result;
	for (let attempt = 0; attempt < 3; attempt++) {
		const page = await browser.newPage();
		await page.goto(url);
		result = await work(() => page.mainFrame());
		await page.close();
		if (complete(result)) break;
	}
	return result;
}

async function proxied(url, work) {
	const page = await openDemo(browser);
	await submitLanding(page, url);
	const frame = () => page.frames().findLast((f) => ROUTED.test(f.url()));
	// the fixture's document, once its scripts ran: the frame is routed
	// before that
	for (let i = 0; i < 160; i++) {
		const ready = await frame()
			?.evaluate(() => document.readyState === 'complete')
			.catch(() => false);
		if (ready) break;
		await sleep(250);
	}
	// the top's library holds the module before the workers start (what the
	// page evaluates is the module's rewrite): they are handed it in their
	// first message
	if (WASM)
		for (let i = 0; i < 100; i++) {
			const text = await frame()
				.evaluateHandle(() => new Function('/* kept */ return location.href;'))
				.then(String, () => '');
			if (text.includes('/* kept */')) break;
			await sleep(100);
		}
	const result = await work(frame);
	return { page, frame, result };
}

// workers started once the page has loaded
{
	const expected = await native(
		fixture(),
		(frame) => run(frame, false),
		everyWorker,
	);
	const answered = everyWorker(expected);
	ok(
		'natively, every worker answers',
		answered,
		answered ? '' : JSON.stringify(expected).slice(0, 600),
	);
	let page;
	let functions = {};
	// a module worker's first message reaches it while its preamble loads
	// the inject, which is a race the worker wins unless the machine is
	// busy: tried again before it is believed lost
	for (let attempt = 0; attempt < 3; attempt++) {
		await page?.close();
		const loaded = await proxied(fixture(), (frame) => run(frame, false));
		page = loaded.page;
		if (attempt === 0)
			ok(
				'proxied, what the workers evaluate reads as it does natively',
				same(expected, loaded.result),
				differences(expected, loaded.result).join('; ').slice(0, 600),
			);
		if (!WASM) break;
		functions = await made(page, loaded.frame);
		if (byModule(functions, 'moduleTop')) break;
	}
	if (WASM) {
		const check = (name, stage) =>
			ok(name, byModule(functions, stage), report(functions, stage));
		check(
			"a classic worker's rewrite for the page's first message is the module's",
			'message',
		);
		check('and for a later one', 'again');
		check('and of a data: script it imports', 'data');
		check("a module worker's is from its first statement", 'moduleTop');
		check('and of a data: module it imports', 'moduleData');
		check('and for its messages', 'moduleAgain');
		check(
			'and of a data: module it imports where it is served, rewritten during its own rewrite',
			'moduleStatic',
		);
		check("a blob: worker's is", 'blobFirst');
		check(
			"a frame's worker's is (the frame holds no module: its top does)",
			'frame',
		);
		check(
			"a worker of a worker's is, once its parent holds the module",
			'nestedAgain',
		);
		check('and from its first message when its parent held it', 'late');
		// the instance that rewrote the large function was past what a
		// page's thread keeps (test/suites/wasm-instances.mjs holds the
		// fixture to that): the next rewrite is a new instance's
		check(
			"a function too large for a worker to keep its instance is the module's rewrite",
			'large',
		);
		check('and so is what the worker evaluates after it', 'afterLarge');
		check('in the page as well', 'pageLarge');
		check('and after it', 'pageAfterLarge');
	}
	await page.close();
}

// workers started by the page's first script: with `rewriter: 'wasm'` the
// module has not reached the page yet, and follows the workers' first
// message on a port
{
	const expected = await native(
		fixture('?early'),
		(frame) => run(frame, true),
		everyWorker,
	);
	const { page, result } = await proxied(fixture('?early'), (frame) =>
		run(frame, true),
	);
	ok(
		"workers the page's first script starts read as they do natively",
		same(expected, result),
		differences(expected, result).join('; ').slice(0, 600),
	);
	if (WASM) {
		const functions = await made(page);
		for (const [name, stage] of [
			['a classic worker', 'again'],
			['a module worker', 'moduleAgain'],
			['a blob: worker', 'blobAgain'],
			['a worker of a worker', 'nestedAgain'],
		])
			ok(
				`${name} started before the module reached the page rewrites with it once it has`,
				byModule(functions, stage),
				report(functions, stage),
			);
	}
	await page.close();
}

// a worker that hands itself a module of its own choosing
{
	const forge = (frame) =>
		frame()
			.evaluate(() => window.forge())
			.then(() => answers(frame, '__wr', ['forge']));
	const expected = await native(fixture(), forge);
	const { page, result } = await proxied(fixture(), forge);
	ok(
		'a worker cannot choose its own rewriter: what it evaluates is still rewritten',
		same(expected.forge, result.forge),
		differences(expected, result).join('; ').slice(0, 600),
	);
	// the stand-in module is taken for the rewriter only while it answers
	// the glue's revision
	const revision = (path, pattern) =>
		readFileSync(new URL(path, import.meta.url), 'utf8').match(pattern)?.[1];
	const glue = revision(
		'../../src/wasm/rewriter.ts',
		/export const REVISION = '(\d+)'/,
	);
	ok(
		"the fixture's module answers the revision the glue asks for",
		glue !== undefined &&
			glue ===
				revision(
					'../pages/worker-rewrites-forge.js',
					/const REVISION = '(\d+)'/,
				),
		String(glue),
	);
	if (WASM) {
		const functions = await made(page);
		ok(
			"and by the controller's module",
			byModule(functions, 'forge'),
			report(functions, 'forge'),
		);
	}
	await page.close();
}

// a page's service worker: a dedicated worker of the controller's, handed
// the module the same way
{
	const url = `${FIXTURE}pages/deep/wrsw/worker-rewrites-sw.html`;
	const read = async (frame) => {
		let value;
		for (let i = 0; i < 160 && value === undefined; i++) {
			await sleep(250);
			value = await frame()
				?.evaluate(() => window.__wrsw)
				.catch(() => undefined);
		}
		return value;
	};
	const expected = await native(url, read);
	ok(
		'natively, the service worker answers',
		Array.isArray(expected),
		Array.isArray(expected) ? '' : JSON.stringify(expected),
	);
	const { page, result } = await proxied(url, read);
	ok(
		'what a service worker evaluates reads as it does natively',
		same(expected, result),
		same(expected, result) ? '' : JSON.stringify(result),
	);
	if (WASM) {
		const functions = await made(page);
		ok(
			"and its rewrite is the module's",
			byModule(functions, 'service'),
			report(functions, 'service'),
		);
	}
	await page.close();
}

await done(browser);
