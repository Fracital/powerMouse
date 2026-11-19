// A worker reaches the network from whatever document started it, as
// natively: the page itself (and a worker's worker), an about:blank frame
// (a worker the parent starts in it, one its own script starts, a blob:
// worker, a worker's worker, a frame two levels down), a srcdoc frame, a
// frame the parent wrote, a blob: document, a frame whose contentWindow
// the parent read before it loaded (reCAPTCHA's anchor frame) and an
// about:blank popup. Each worker imports a script, fetches and opens a
// WebSocket, and the document opens a WebSocket of its own; every answer
// is compared with the same page loaded natively, and a blob: worker of an
// about:blank frame ends when the frame is removed. A document that no
// service worker controls used to find no transport ("could not provision
// a transport for a worker", its socket threw), and a worker's worker
// never got one: the nearest controlled document asks for it, and a
// worker's own transport serves its workers. Both demo modes.
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

const target = `${FIXTURE}pages/worker-realms.html`;
const PREFIX = 'worker-realms ';

/** the page's report (a console message) and every warning on the way */
function listen(page) {
	const state = { report: null, warnings: [] };
	const watch = (message) => {
		const text = message.text();
		if (text.startsWith(PREFIX))
			state.report = JSON.parse(text.slice(PREFIX.length));
		else if (/^Stomp: /.test(text)) state.warnings.push(text.split('\n')[0]);
	};
	page.on('console', watch);
	page.context().on('page', (popup) => popup.on('console', watch));
	return state;
}

async function wait(state) {
	for (let i = 0; i < 960 && !state.report; i++) await sleep(250);
	return state.report;
}

const works = (value) =>
	value?.socket === 'message' &&
	value?.worker?.imported === true &&
	value?.worker?.fetched === 'worker realms data' &&
	value?.worker?.socket === 'message' &&
	(value.removed === undefined || value.removed === 'ended');
const allWork = (report) =>
	report?.done === true &&
	Object.keys(report).length >= 14 &&
	Object.entries(report).every(
		([name, value]) => name === 'done' || works(value),
	);

const browser = await launch();
// (a native load on a busy machine has seen a worker fail to start: up to
// three, until one where every case works)
let native = null;
for (let attempt = 0; attempt < 3 && !allWork(native); attempt++) {
	const nativePage = await browser.newPage();
	const nativeState = listen(nativePage);
	await nativePage.goto(target);
	native = await wait(nativeState);
	await nativePage.close();
}
const cases = Object.keys(native ?? {}).filter((name) => name !== 'done');
ok(
	'natively, every document starts a worker that imports, fetches and opens a socket, and opens a socket of its own',
	allWork(native),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const state = listen(page);
	await submitLanding(page, target);
	const proxied = await wait(state);
	ok(
		`${mode}: the page reported`,
		proxied?.done === true,
		JSON.stringify(proxied),
	);
	for (const name of cases)
		ok(
			`${mode}: ${name}: the worker and the document's socket answer as natively`,
			JSON.stringify(proxied?.[name]) === JSON.stringify(native[name]),
			JSON.stringify({ native: native[name], proxied: proxied?.[name] }),
		);
	const missing = state.warnings.filter((text) =>
		/transport|controller/.test(text),
	);
	ok(
		`${mode}: no document went without a transport`,
		missing.length === 0,
		JSON.stringify(missing),
	);
	await page.close();
}
await done(browser);
