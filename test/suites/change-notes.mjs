// The service worker's notes of a change of the jar go to the documents the
// change is for, not to every window: ten responses that set a cookie of
// the page's host reach the page and its same-host frame, and a frame of
// another host hears none of them (an ad-heavy page keeps a hundred frames
// of the ad networks' cookie syncs, and every change went to each one).
// The same-host frame reads the cookie as native Chrome does, and a
// document that hears a note writes nothing to the proxy origin's storage
// (a stamp written by each one that heard it was an event in every
// document of the origin). The notes are counted from an isolated world of
// each frame (CDP), which sees the container's messages and no hook.
import {
	done,
	FIXTURE,
	frameTarget,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/change-notes.html`;
const COUNT = 10;
const NOTE = '$stomp$cookiesChanged';

async function top(page, proxied) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame.evaluate(() => window.__cn).catch(() => null);
			if (value?.ready) return frame;
		}
	}
	return null;
}

/** count the notes `frame`'s container hears from now on; returns a reader */
async function countNotes(frame) {
	const { session, frameId } = await frameTarget(frame);
	const { executionContextId } = await session.send(
		'Page.createIsolatedWorld',
		{ frameId, worldName: 'change-notes' },
	);
	await session.send('Runtime.evaluate', {
		contextId: executionContextId,
		expression: `(() => {
			globalThis.__notes = 0;
			navigator.serviceWorker.addEventListener('message', (event) => {
				const data = event.data;
				if (data && typeof data === 'object' && ${JSON.stringify(NOTE)} in data)
					globalThis.__notes++;
			});
		})()`,
	});
	return async () => {
		const { result } = await session.send('Runtime.evaluate', {
			contextId: executionContextId,
			expression: 'globalThis.__notes',
			returnByValue: true,
		});
		await session.detach().catch(() => {});
		return result.value;
	};
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const nativeTop = await top(nativePage, false);
const nativeSeen = await nativeTop?.evaluate((n) => window.__run(n), COUNT);
await nativePage.close();
ok(
	'natively, the same-host frame reads the cookie the responses set',
	nativeSeen === 'hcseen=1',
	JSON.stringify(nativeSeen),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const frame = await top(page, true);
	ok(`${mode}: the page and its frames loaded`, !!frame);
	if (!frame) {
		await page.close();
		continue;
	}
	const named = {};
	for (const child of frame.childFrames())
		named[await child.evaluate(() => window.name).catch(() => '')] = child;
	const { same, other } = named;
	const reads = await Promise.all([frame, same, other].map(countNotes));
	// the writes of the proxy origin's own localStorage the notes cause (each
	// is a storage event in every document of the proxy origin)
	const { session: storage } = await frameTarget(frame);
	let stamps = 0;
	const stamped = ({ key }) => {
		if (String(key).startsWith('$stomp$cookies:')) stamps++;
	};
	storage.on('DOMStorage.domStorageItemAdded', stamped);
	storage.on('DOMStorage.domStorageItemUpdated', stamped);
	await storage.send('DOMStorage.enable');
	const seen = await frame.evaluate((n) => window.__run(n), COUNT);
	const [atTop, atSame, atOther] = await Promise.all(reads.map((r) => r()));
	await storage.detach().catch(() => {});
	ok(
		`${mode}: the same-host frame reads the cookie as natively`,
		seen === nativeSeen,
		JSON.stringify({ native: nativeSeen, proxied: seen }),
	);
	ok(
		`${mode}: the page and its same-host frame hear of the changes`,
		atTop >= 1 && atSame >= 1,
		JSON.stringify({ atTop, atSame }),
	);
	ok(
		`${mode}: a frame of another host hears none of them`,
		atOther === 0,
		JSON.stringify({ atOther, count: COUNT }),
	);
	ok(
		`${mode}: a document that hears of a change writes no stamp of the jar's for the others, which hear it too`,
		stamps === 0,
		JSON.stringify({ stamps, count: COUNT }),
	);
	await page.close();
}

await done(browser);
