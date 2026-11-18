// A proxied document's shell asks for the document bundle by the hash of its
// bytes (`injectDocument.js?<hash>`, src/routeURL.ts injectDocumentFile),
// which the demo serves for good under that hash and the service worker
// keeps (serviceWorker.ts documentBundle), so no document waits for a
// revalidation of the bundle with the host before its first script: before,
// every top and frame did (a 304, a round trip of 54 to 129 ms over a link
// of 40 ms). A frame the worker shells and one the page's inject makes
// (srcdoc) name the same file as their top; with the browser's caches off
// the worker's store answers the file under its hash, checked against it; a
// request for another build's hash goes to the host and is never answered
// with or kept as this build's file; the demo serves no-cache under another
// hash. The page is compared with its native load.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/bundle-frames.html`;
const STORE = 'stomp-document-bundles';
const BUNDLE = /\/injectDocument(Full)?\.js(\?|$)/;
const read = (frame) =>
	frame.evaluate(() => ({
		title: document.title,
		frames: Object.keys(window.__frames).sort(),
	}));

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
await nativePage.waitForFunction(
	() => window.__frames?.child && window.__frames?.srcdoc,
);
const native = await read(nativePage.mainFrame());
await nativeBrowser.close();

const browser = await launch();
const page = await openDemo(browser, PROXY);
const cdp = await page.context().newCDPSession(page);
// every request for a bundle the page made, by its id: how it was answered
const loads = new Map();
cdp.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
	if (BUNDLE.test(request.url))
		loads.set(requestId, { url: request.url, type, memory: false });
});
cdp.on('Network.requestServedFromCache', ({ requestId }) => {
	if (loads.has(requestId)) loads.get(requestId).memory = true;
});
cdp.on('Network.responseReceived', ({ requestId, response }) => {
	const load = loads.get(requestId);
	if (load)
		Object.assign(load, {
			status: response.status,
			worker: response.fromServiceWorker,
			store: response.cacheStorageCacheName ?? '',
			disk: response.fromDiskCache,
		});
});
cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
	const load = loads.get(requestId);
	if (load) load.bytes = encodedDataLength;
});
await cdp.send('Network.enable');
const take = () => {
	const taken = [...loads.values()];
	loads.clear();
	return taken;
};
const visit = async () => {
	await submitOmni(page, target);
	// (the document before also has its frames: wait for the new one)
	const frame = await waitActive(
		page,
		`window.__frames?.child === true && window.__frames?.srcdoc === true && !window.__read`,
	);
	const result = await read(frame);
	await frame.evaluate(() => (window.__read = true));
	await sleep(300);
	return { result, frame, loads: take() };
};
const first = await visit();
// another document of the same build
const second = await visit();
const scripts = [...first.loads, ...second.loads].filter(
	(load) => load.type === 'Script',
);
const urls = new Set(scripts.map((load) => load.url));
const url = [...urls][0] ?? `${PROXY}stomp/injectDocument.js`;
const hash = url.match(/\?([0-9a-f]{16})$/)?.[1];
ok(
	"the top, its shelled frame and its srcdoc frame load one file of one build, named by its bytes' hash",
	scripts.length >= 6 && urls.size === 1 && !!hash,
	JSON.stringify(scripts),
);
ok(
	"no document revalidates the bundle with the host: each load is the browser's kept copy or the worker's",
	scripts.length >= 6 &&
		scripts.every(
			(load) =>
				load.status === 200 &&
				load.bytes === 0 &&
				(load.memory || load.disk || load.store === STORE),
		),
	JSON.stringify(scripts),
);

// a document whose bundle the browser's caches do not give (DevTools' cache
// off): the worker answers it from its store
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const third = await visit();
await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
const stored = third.loads.filter((load) => load.type === 'Script');
ok(
	"with the browser's caches off, the worker answers each from its store, under the hash",
	stored.length >= 3 &&
		stored.every(
			(load) =>
				load.url === url &&
				load.worker === true &&
				load.store === STORE &&
				load.status === 200,
		),
	JSON.stringify(stored),
);

// how another build's hash is answered, to a load of the proxied document's
// (an image the browser's own prototypes make, which no hook routes)
const other = url.replace(/\?.*$/, '?0000000000000000');
await evaluateIsolated(
	second.frame,
	(address) =>
		new Promise((resolve) => {
			const image = new Image();
			image.onload = image.onerror = resolve;
			image.src = address;
		}),
	other,
);
await sleep(200);
const otherLoad = take();
const kept = await page.evaluate(
	async (store) =>
		(await (await caches.open(store)).keys()).map((request) => request.url),
	STORE,
);
ok(
	"another build's hash goes to the host, and the worker keeps nothing under it",
	otherLoad.length === 1 &&
		otherLoad[0].status === 200 &&
		!otherLoad[0].store &&
		!kept.includes(other) &&
		kept.includes(url),
	JSON.stringify({ otherLoad, kept }),
);
const served = (await fetch(url)).headers.get('cache-control');
const unhashed = (await fetch(other)).headers.get('cache-control');
ok(
	'the demo serves the bundle for good under its hash, and no-cache under another',
	/immutable/.test(served ?? '') && unhashed === 'no-cache',
	JSON.stringify({ served, unhashed }),
);
ok(
	'the proxied page and its frames load as natively, twice',
	JSON.stringify(first.result) === JSON.stringify(native) &&
		JSON.stringify(second.result) === JSON.stringify(native),
	`${JSON.stringify([first.result, second.result])}, natively ${JSON.stringify(native)}`,
);
ok(
	'nothing threw loading the page',
	page.errors.length === 0,
	JSON.stringify(page.errors),
);
await done(browser);
