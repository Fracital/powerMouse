// The document bundle's deferred parts (src/inject/dom/deferredParts.ts):
// the service worker container's objects, the Cookie Store API's methods and
// the Fingerprint module are in no document bundle. They are the last
// statement of the rewriter library's file, which a proxied top's shell
// loads before the bundle; a document under that top evaluates the text its
// top holds the first time it needs a part, in its own realm, with no
// request; a document with no top to take it from (sandboxed without
// allow-same-origin, under a top of another build) reads the file with the
// light library's one request.
//
// Checked against native Chrome on one fixture, in the top and in a child of
// every kind (from a URL, srcdoc, a written about:blank, a blob document,
// sandboxed): the container, its promises and errors, the Cookie Store
// API's answers and byte limits, and that the page sees no name of the
// parts. In same-origin mode the frames under the top make no request for
// the file. With a fingerprinting surface on, a frame farbles as its top
// does (the Fingerprint module, deferred, applied in the frame).
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
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deferred-parts.html`;
const host = new URL(FIXTURE).hostname;
const LIBRARY = /\/rewriterLib\.js(\?|$)/;
const KINDS = ['url', 'srcdoc', 'blank', 'blob'];

async function answersOf(frame) {
	const top = await frame.evaluate(() => window.__deferredAnswers());
	const children = {};
	for (const kind of [...KINDS, 'sandboxed'])
		children[kind] = await frame.evaluate((kind) => window.__child(kind), kind);
	return { top, children };
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = await answersOf(nativePage.mainFrame());
const nativeCores = await nativePage.evaluate(
	() => navigator.hardwareConcurrency,
);
await nativeBrowser.close();
ok(
	'natively, the fixture answers in the top and in every child',
	native.top.registrations === 0 &&
		typeof native.top.get === 'string' &&
		Object.values(native.children).every((answer) => !answer.error),
	JSON.stringify(native),
);

/** every request for the rewriter library's file the tab makes from now on */
async function watchLibrary(page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	const asked = [];
	cdp.on('Network.requestWillBeSent', ({ request, frameId }) => {
		if (LIBRARY.test(request.url)) asked.push({ url: request.url, frameId });
	});
	return {
		asked,
		clear: () => asked.splice(0),
		stop: () => cdp.detach().catch(() => {}),
	};
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What differs from native in a child of these kinds at 8d040b33 as well,
// before any part was deferred (the same in both modes): recorded, not
// compared, so the rest of each answer still is. A written about:blank runs
// its creator's bundle, whose promise it hands over, and natively has no
// registrations to get; a blob document's cookie jar is the creator's
// (natively it stores nothing); a sandboxed child's container refusal names
// the sandbox, natively that service workers are disabled.
const KNOWN = {
	blank: ['ownPromise', 'registrations'],
	blob: [
		'registrations',
		'set',
		'get',
		'deleted',
		'twoByteAtLimit',
		'surrogateUnder',
	],
	sandboxed: ['container', 'controller', 'foreign', 'registrations'],
};
/** `answer` against native's, but for the kind's known divergences */
function compared(kind, answer, natively) {
	const known = KNOWN[kind] ?? [];
	const strip = (value) =>
		Object.fromEntries(
			Object.entries(value).filter(([key]) => !known.includes(key)),
		);
	const differ = known.filter((key) => !same(answer[key], natively[key]));
	if (differ.length)
		console.log(
			`${kind}: known divergences, not compared: ${JSON.stringify(
				Object.fromEntries(
					differ.map((key) => [key, [answer[key], natively[key]]]),
				),
			)}`,
		);
	return same(strip(answer), strip(natively));
}

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the isolated mode's proxied frames are another process's
	const watch = mode === 'same-origin' ? await watchLibrary(page) : null;
	await submitLanding(page, target);
	const top = await waitActive(
		page,
		`typeof window.__deferredAnswers === 'function' && typeof window.__child === 'function'`,
	);
	await sleep(300);
	watch?.clear();

	const proxiedTop = await top.evaluate(() => window.__deferredAnswers());
	ok(
		`${mode}: the top answers as natively`,
		same(proxiedTop, native.top),
		`${JSON.stringify(proxiedTop)}, natively ${JSON.stringify(native.top)}`,
	);
	for (const kind of KINDS) {
		const answer = await top.evaluate((kind) => window.__child(kind), kind);
		ok(
			`${mode}: a child ${kind === 'url' ? 'from a URL' : `(${kind})`} answers as natively`,
			compared(kind, answer, native.children[kind]),
			`${JSON.stringify(answer)}, natively ${JSON.stringify(native.children[kind])}`,
		);
	}
	if (watch)
		ok(
			`${mode}: the top and the children under it make no request for the file`,
			watch.asked.length === 0,
			JSON.stringify(watch.asked),
		);
	const sandboxed = await top.evaluate(() => window.__child('sandboxed'));
	ok(
		`${mode}: a child sandboxed without allow-same-origin answers as natively`,
		compared('sandboxed', sandboxed, native.children.sandboxed),
		`${JSON.stringify(sandboxed)}, natively ${JSON.stringify(native.children.sandboxed)}`,
	);
	await watch?.stop();
	await page.close();
}

// a frame under a top of another build takes nothing from it: it reads the
// file itself, and answers the same
{
	const page = await openDemo(browser, PROXY);
	await submitLanding(page, target);
	const top = await waitActive(page, `typeof window.__child === 'function'`);
	const name = await page.evaluate(() => window.controller.config.names.client);
	const answer = await top.evaluate(async (name) => {
		const client = window[name];
		Reflect.defineProperty(client, 'deferredPartsText', {
			configurable: true,
			value: () => null,
		});
		try {
			return await window.__child('url');
		} finally {
			Reflect.deleteProperty(client, 'deferredPartsText');
		}
	}, name);
	ok(
		'a child under a top of another build answers as natively',
		same(answer, native.children.url),
		`${JSON.stringify(answer)}, natively ${JSON.stringify(native.children.url)}`,
	);
	await page.close();
}

// with a fingerprinting surface on, the Fingerprint module (a deferred part)
// applies in the top and in a frame of the same site alike
{
	const page = await openDemo(browser, PROXY);
	await page.evaluate(
		(host) =>
			window.controller.shields.set(host, {
				enabled: true,
				blockFingerprinting: true,
				fingerprint: { hardwareConcurrency: true },
			}),
		host,
	);
	await sleep(500);
	await submitLanding(page, target);
	const top = await waitActive(page, `typeof window.__child === 'function'`);
	const cores = await top.evaluate(async () => {
		const frame = document.createElement('iframe');
		frame.src = 'deferred-parts-child.html';
		const loaded = new Promise((resolve) => (frame.onload = resolve));
		document.body.append(frame);
		await loaded;
		return {
			top: navigator.hardwareConcurrency,
			child: frame.contentWindow.navigator.hardwareConcurrency,
		};
	});
	// the module caps it at 2 (a runner with two cores or fewer reads its own)
	ok(
		'with hardwareConcurrency limited, a frame reads the capped count its top reads',
		cores.top === Math.min(nativeCores, 2) && cores.child === cores.top,
		`${JSON.stringify(cores)}, natively ${nativeCores}`,
	);
	await page.close();
}

await done(browser);
