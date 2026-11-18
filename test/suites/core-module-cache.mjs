// The rewriter's wasm core module is asked for by its hash
// (`core.wasm?<hash>`, src/routeURL.ts coreFile), as the rewriter library is,
// and the demo lets browsers keep it for good under that hash. A proxied
// top whose first task rewrites before the controller's compiled module
// reaches it fetches the module with a synchronous request (the cold-start
// fixture does: its first script evals); the module was served no-cache, so
// that request was a revalidation round trip to the host the script waited
// for (40 ms on a link of 40 ms). Now the HTTP cache answers it from the
// controller's own fetch. Compared with the page's native load.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/cold-start.html`;
const CORE = /\/core\.wasm(\?|$)/;
const read = (frame) => frame.evaluate(() => window.__cold);

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
await nativePage.waitForFunction(() => window.__cold?.ready === true);
const native = await read(nativePage.mainFrame());
await nativeBrowser.close();

const browser = await launch();
const page = await openDemo(browser, PROXY);
const cdp = await page.context().newCDPSession(page);
const responses = new Map();
cdp.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
	if (CORE.test(request.url))
		responses.set(requestId, { url: request.url, type, network: false });
});
cdp.on('Network.responseReceived', ({ requestId, response }) => {
	const entry = responses.get(requestId);
	if (!entry) return;
	entry.status = response.status;
	entry.cached = response.fromDiskCache || response.fromMemoryCache;
	entry.cacheControl =
		response.headers['cache-control'] ?? response.headers['Cache-Control'];
});
cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
	const entry = responses.get(requestId);
	if (entry) entry.bytes = encodedDataLength;
});
await cdp.send('Network.enable');
// the controller's own fetch of the module, done
await page
	.waitForFunction(
		(source) =>
			performance
				.getEntriesByType('resource')
				.some((entry) => new RegExp(source).test(entry.name)),
		CORE.source,
		{ timeout: 15000 },
	)
	.catch(() => {});
await sleep(200);
const before = new Set(responses.keys());
await submitOmni(page, target);
const top = await waitActive(page, `window.__cold?.ready === true`);
const proxied = await read(top);
await sleep(200);
const asked = [...responses]
	.filter(([id]) => !before.has(id))
	.map(([, r]) => r);
ok(
	"the first proxied top's synchronous fetch of the core module is answered by the HTTP cache, with no request to the host",
	asked.length >= 1 &&
		asked.every((r) => /\?[0-9a-f]{16}$/.test(r.url) && r.cached === true),
	JSON.stringify(asked),
);
const served = await (
	await fetch(asked[0]?.url ?? `${PROXY}core.wasm`)
).headers;
ok(
	'the demo serves the module under its hash immutable, and under another hash no-cache',
	/immutable/.test(served.get('cache-control') ?? '') &&
		(
			await fetch((asked[0]?.url ?? `${PROXY}core.wasm`).replace(/\?.*$/, '?0'))
		).headers.get('cache-control') === 'no-cache',
	served.get('cache-control'),
);
ok(
	"the proxied page's first script rewrites as natively",
	JSON.stringify(proxied) === JSON.stringify(native),
	`${JSON.stringify(proxied)}, natively ${JSON.stringify(native)}`,
);
ok(
	'nothing threw loading the page',
	page.errors.length === 0,
	JSON.stringify(page.errors),
);
await done(browser);
