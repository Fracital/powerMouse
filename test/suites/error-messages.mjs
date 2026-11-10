// An error thrown by code the JS rewriter rewrote reads as natively: its
// message names the page's own expression (V8 prints the failing callee from
// the code: `o[k] is not a function`, not the access API's helper), and its
// name, constructor (the page's realm), string, stack header and first frame
// (without the position, which is the rewritten code's) are the native ones.
// Every rewritten form fails at least once (test/pages/error-messages.js):
// routed identifier reads (location, top, eval), computed reads, calls and
// constructions, `in`, optional chains, postMessage, patterns that name an
// unforgeable, writes, eval and new Function, the operators that consume a
// helper's value (calls, `new`, iteration, destructuring), four uncaught
// errors read by the window's error event, code an about:blank child's
// Function made (its errors are the child realm's) and a dedicated worker's
// (test/pages/error-messages-worker.js). Both demo modes, against the page
// loaded natively.
// Cases the proxy cannot match are in RECORDED: each is printed with both
// readings, and fails once it matches (so the list stays true). The
// messages are not written down anywhere: V8 rewords them between versions,
// and the proxy must say what the running V8 says.
// ERRORS_DUMP=<path> writes both records of each mode there.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/error-messages.html`;

// what cannot read as natively, and why
const TAGGED =
	'a tagged template calls its tag itself, with the strings object made once for its place in the code, so the call cannot move into a helper: V8 names the helper that read the tag';
const EARLIER_LINK =
	'the helper is handed the value of the chain before it (`o?.u`), undefined whether `o` short-circuited or `o.u` is undefined, and answers undefined for both, where natively only the first skips the rest';
const RECORDED = {
	'top.nope`x`': TAGGED,
	'o[k]`x`': TAGGED,
	'o?.u[k]': EARLIER_LINK,
	'o?.u[k]()': EARLIER_LINK,
};

async function report(find) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		const value = await (
			await find()
		)
			?.evaluate(() =>
				window.__errorMessages?.done
					? JSON.stringify(window.__errorMessages.results)
					: null,
			)
			.catch(() => null);
		if (value) return JSON.parse(value);
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(async () => nativePage.mainFrame());
await nativePage.close();
const names = Object.keys(native ?? {});
ok(
	'natively, the page ran every case',
	names.length > 80,
	JSON.stringify(native)?.slice(0, 500),
);

const dump = {};
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	dump[mode] = { native, proxied };
	ok(`${mode}: the page ran every case`, !!proxied);
	for (const name of names) {
		const same =
			JSON.stringify(proxied?.[name]) === JSON.stringify(native[name]);
		const detail = `${JSON.stringify(native[name])} -> ${JSON.stringify(proxied?.[name])}`;
		if (name in RECORDED) {
			console.log(
				`${mode}: ${name}, recorded (${RECORDED[name]}), not matched: ${detail}`,
			);
			ok(`${mode}: ${name} is still recorded`, !same, detail);
		} else ok(`${mode}: ${name} fails as natively`, same, detail);
	}
	await page.close();
}
if (process.env.ERRORS_DUMP)
	(await import('node:fs')).writeFileSync(
		process.env.ERRORS_DUMP,
		JSON.stringify(dump, null, '\t'),
	);
await done(browser);
