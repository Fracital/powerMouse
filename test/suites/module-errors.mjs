// What a page reads of a module graph that fails: a static import of a name
// its module does not export (a script's, a JSON module's, an ambiguous
// star export), a module the engine refuses for a module-level early error
// (a duplicate export, an export of a name the module does not declare), as
// a dependency, as the root, inline and through import(). Each failure's
// error event (message, and the error's message) and each import()'s
// rejection must read as natively: the browser's message names the module
// by the page's URL, never by the route the rewriter wrote, and a module the
// rewriter declines but the browser refuses anyway is refused with the
// browser's own early error, not STomp's. What still differs is named in
// KNOWN, with the text it reads. Both modes, against the page loaded
// natively.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/module-errors.html`;

async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		const report = await getFrame()
			?.evaluate(() => window.__moduleErrors ?? null)
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return { events: [], dynamic: {} };
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every module that fails reports its error',
	native.events.length === 8 && Object.keys(native.dynamic).length === 3,
	JSON.stringify(native),
);
if (process.env.MODULE_ERRORS_VERBOSE) console.log(JSON.stringify(native));

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

const fileOf = (line) => JSON.parse(line).file;
/** a native report with every specifier the page wrote as the page's URL */
const spelled = (text) =>
	text.replace(
		/'(\.\.?\/[^']*)'/g,
		(_, written) => `'${new URL(written, PAGE).href}'`,
	);
const WRITE = "Failed to execute 'write' on 'Document': ";
// What still reads otherwise than natively, and how: each is held to that
// exact text, and one that reads as natively again fails the suite.
const KNOWN = {
	// The browser names a module by the specifier the page wrote; the
	// rewriter wrote the module's route there, and what is given back is
	// the URL the route stands for: the page's spelling of it ("./a.js")
	// is in no route, and a route that kept it would make each spelling of
	// a module another module
	'module-errors-json.js': spelled,
	'module-errors-missing.js': spelled,
	'module-errors-star.js': spelled,
	'dynamic missing': spelled,
	// V8 checks a module's undeclared exports in the order of their names:
	// one after `eval`, the end of a module the rewriter declines
	// (src/rewriteJS.ts UNREWRITTEN_MODULE_END), is reported after it
	'module-errors-undefined.js': (line) =>
		line.replaceAll('unresolvableName', 'eval'),
	// a script of the page's markup is written by the shell (loadHTML), and
	// a SyntaxError of one is reported with the binding's prefix, a script
	// of either kind: the message and the error's, not the stack
	'module-errors.html': (line) => {
		const event = JSON.parse(line);
		return JSON.stringify({
			...event,
			message: event.message.replace(/^(Uncaught SyntaxError: )/, `$1${WRITE}`),
			error: `${WRITE}${event.error}`,
		});
	},
};
const used = new Set();
const compare = (mode, what, key, want, have) => {
	if (want === have) {
		ok(`${mode}: ${what} reads as natively`, true);
		return;
	}
	const known = KNOWN[key];
	if (known) used.add(key);
	ok(
		`${mode}: ${what} reads as natively${known ? ' (or as known)' : ''}`,
		!!known && have === known(want),
		`native ${want} proxied ${have}${known ? ` known ${known(want)}` : ''}`,
	);
};

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	if (process.env.MODULE_ERRORS_VERBOSE) console.log(JSON.stringify(proxied));
	for (const line of native.events) {
		const file = fileOf(line);
		compare(
			mode,
			`the error of ${file}`,
			file,
			line,
			proxied.events.find((other) => fileOf(other) === file),
		);
	}
	ok(
		`${mode}: no other error is reported`,
		proxied.events.length === native.events.length,
		proxied.events.join(' | '),
	);
	for (const [name, want] of Object.entries(native.dynamic))
		compare(
			mode,
			`import() of the ${name} module`,
			`dynamic ${name}`,
			want,
			proxied.dynamic[name],
		);
	await page.close();
}
const idle = Object.keys(KNOWN).filter((key) => !used.has(key));
ok(
	'every difference named as known is still one',
	idle.length === 0,
	idle.join(' | '),
);

await done(browser);
