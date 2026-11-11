// Early errors: a script the browser refuses to compile is refused through
// the proxy as it is natively, with the SyntaxError the page would read
// natively, however the page hands the code over; and a script the browser
// takes still compiles. The cases are rust/host/early-errors.txt (4,418
// texts written from the specification's early-error clauses, each with
// V8's verdict as a classic script, a strict one and a module).
//
// First the record is held to this Chrome: every classic form is compiled
// (never run) over the protocol, every module form imported with a last
// import that throws. Then test/pages/early-errors.html tries the texts
// natively and through the proxy, both demo modes, and the answers are
// compared text by text:
//
// - `new Function(text)` for every text: compiled, never called, so the
//   ones the browser takes are held too (a rewrite must not break them);
// - an inline script element, a direct eval and an indirect eval for every
//   text the browser refuses as a script (as a strict one when only strict
//   code refuses it): nothing of it runs natively;
// - a script element with a source and import() for a part of them (each
//   is a request through the service worker), and a dedicated worker for a
//   smaller part.
//
// What is compared is the error's name and message. Source positions are
// measured apart, as in error-surfaces: they are the page's own for a
// script handed back as it was, and move for one the rewriter rewrote into
// something the browser still refuses.
//
// KNOWN names what differs and why, by text; a name nothing needs any more
// fails the suite. The wasm backend declines what its parser refuses to the
// JavaScript rewriter, so that rewriter's defects show under both.
import { readCases, STRICT } from '../../rust/host/early-lib.mjs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	REWRITER,
	sleep,
	submitLanding,
} from '../lib.mjs';

const WASM = REWRITER.rewriter === 'wasm';
const PAGE = `${FIXTURE}pages/early-errors.html`;
const cases = readCases().filter((entry) => entry.code !== undefined);

// The JavaScript rewriter's parser takes these and V8 does not, and what
// it prints of them compiles: the script runs through the proxy. Under the
// wasm backend too, whose parser refuses them: what it cannot parse is the
// JavaScript rewriter's to decide
// (`00e1` no longer: its parser takes it for a string, which is printed as
// written and refused, as natively)
const JS_RUNS = [
	'new a.b?.()',
	"import.defer('a')",
	'(...(a)) => 1',
	'for (var a = () => b in c;;);',
	'for (() => a in b;;);',
	'class A { async m }',
	'class A { async m = 1 }',
	'@a class A {}',
	'class A { @a m() {} }',
	"var a; export { a as 'b', a as b }",
];
// ... and these two run forever when they do, so only `new Function` is
// handed them
const NEVER_RUN = new Set([
	'for (var a = () => b in c;;);',
	'for (() => a in b;;);',
]);
// The JavaScript rewriter alone: scripts V8 takes that it prints into ones
// V8 refuses (parentheses its printer drops around a loop head's target;
// what it dropped around a class heritage and the string statements it
// printed as directives are kept now)
const JS_BREAKS = [
	'for ((let) of a);',
	'for ((let.a) of b);',
	'for ((async) of a);',
];
const KNOWN = new Map(JS_RUNS.map((text) => [text, 'runs']));
if (!WASM) for (const text of JS_BREAKS) KNOWN.set(text, 'breaks');
const needed = new Set();

const browser = await launch();

// --- the record against this Chrome -------------------------------------
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
console.log(`Chrome ${browser.version()}`);
{
	const cdp = await nativePage.context().newCDPSession(nativePage);
	await cdp.send('Runtime.enable');
	const forms = cases.flatMap((entry) => [
		{ entry, form: 'script', code: entry.code, recorded: entry.recorded[0] },
		{
			entry,
			form: 'strict',
			code: STRICT + entry.code,
			recorded: entry.recorded[1],
		},
	]);
	const stale = [];
	for (let at = 0; at < forms.length; at += 200)
		await Promise.all(
			forms.slice(at, at + 200).map(async ({ entry, form, code, recorded }) => {
				const answer = await cdp.send('Runtime.compileScript', {
					expression: code,
					sourceURL: '',
					persistScript: false,
				});
				if (!!answer.exceptionDetails !== (recorded === '-'))
					stale.push(`${entry.line} (${form}): ${entry.text}`);
			}),
		);
	const imported = await nativePage.evaluate(
		(lines) => window.__early.imported(lines),
		cases.map((entry) => entry.line),
	);
	cases.forEach((entry, index) => {
		if (imported[index] === 'ran')
			stale.push(`${entry.line} (module): RAN: ${entry.text}`);
		else if ((imported[index] !== 'compiles') !== (entry.recorded[2] === '-'))
			stale.push(`${entry.line} (module): ${entry.text}`);
	});
	ok(
		`this Chrome's verdicts are the recorded ones (${forms.length + cases.length} scripts)`,
		stale.length === 0,
		stale.slice(0, 20).join(' | '),
	);
}

// --- the carriers --------------------------------------------------------
// what the browser refuses as a script, in the form it refuses it in
const refused = cases
	.filter((entry) => entry.recorded[0] === '-' || entry.recorded[1] === '-')
	.filter((entry) => !NEVER_RUN.has(entry.text))
	.map((entry) => ({
		entry,
		form: entry.recorded[0] === '-' ? 'script' : 'strict',
		code: entry.recorded[0] === '-' ? entry.code : STRICT + entry.code,
	}));
const fetched = refused.filter((_, index) => index % 4 === 0);
const workers = refused.filter((_, index) => index % 40 === 0);
const modules = cases.filter(
	(entry, index) => index % 3 === 0 && !NEVER_RUN.has(entry.text),
);

/** every carrier's answers in a frame: `{ carrier: [[entry, answer], ...] }` */
async function answers(frame) {
	const call = (carrier, argument) =>
		frame.evaluate(
			([carrier, argument]) => window.__early[carrier](argument),
			[carrier, argument],
		);
	const pair = (list, got) =>
		list.map((item, index) => [item.entry ?? item, got[index]]);
	const codes = refused.map(({ code }) => code);
	return {
		compiled: pair(
			cases,
			await call(
				'compiled',
				cases.map((entry) => entry.code),
			),
		),
		inline: pair(refused, await call('inline', codes)),
		direct: pair(refused, await call('direct', codes)),
		indirect: pair(refused, await call('indirect', codes)),
		network: pair(
			fetched,
			await call(
				'network',
				fetched.map(({ entry, form }) => [entry.line, form]),
			),
		),
		imported: pair(
			modules,
			await call(
				'imported',
				modules.map((entry) => entry.line),
			),
		),
		worker: pair(
			workers,
			await call(
				'worker',
				workers.map(({ entry, form }) => [entry.line, form]),
			),
		),
	};
}
const said = (answer) =>
	typeof answer === 'string' ? answer : String(answer?.message);
const position = (answer) =>
	typeof answer === 'string' ? '' : `${answer?.lineno}:${answer?.colno}`;

const native = await answers(nativePage.mainFrame());
await nativePage.close();
for (const [carrier, list] of Object.entries(native))
	console.log(`natively: ${carrier}: ${list.length} texts`);
{
	// (a text refused as a script may be taken as eval code or a function's
	// body, and the other way around: the carriers' own verdicts are
	// whatever this Chrome gives, compared below; the script element's is
	// the recorded one)
	const wrong = native.inline.filter(
		([, answer]) => !/SyntaxError/.test(said(answer)),
	);
	ok(
		'natively: an inline script of every text the record refuses is a SyntaxError',
		wrong.length === 0,
		wrong
			.slice(0, 10)
			.map(([entry, answer]) => `${entry.line}: ${said(answer)}`)
			.join(' | '),
	);
}

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	let frame;
	for (let i = 0; i < 240 && !frame; i++) {
		const candidate = frameOf(page);
		if (
			await candidate
				?.evaluate(() => typeof window.__early === 'object')
				.catch(() => false)
		)
			frame = candidate;
		else await sleep(250);
	}
	if (!ok(`${mode}: the page loads`, !!frame)) {
		await page.close();
		continue;
	}
	const proxied = await answers(frame);
	for (const [carrier, list] of Object.entries(native)) {
		const differ = [];
		let known = 0;
		let moved = 0;
		list.forEach(([entry, want], index) => {
			const have = proxied[carrier][index][1];
			if (said(want) === said(have)) {
				if (position(want) !== position(have)) moved++;
				return;
			}
			if (KNOWN.has(entry.text)) {
				known++;
				needed.add(entry.text);
				return;
			}
			differ.push(
				`${entry.line}: ${entry.text}: native ${said(want)}, proxied ${said(have)}`,
			);
		});
		ok(
			`${mode}: ${carrier}: ${list.length} texts are answered as natively${known ? ` (${known} named as known)` : ''}`,
			differ.length === 0,
			differ.length
				? `${differ.length} differ: ${differ.slice(0, 12).join(' | ')}`
				: '',
		);
		if (moved)
			console.log(
				`${mode}: ${carrier}: measured ${moved} of ${list.length} with the native message at another line or column (rewritten code)`,
			);
	}
	await page.close();
}

const idle = [...KNOWN.keys()].filter((text) => !needed.has(text));
ok(
	'every difference named as known is still one',
	idle.length === 0,
	idle.join(' | '),
);

await done(browser);
