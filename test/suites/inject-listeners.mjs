// The listeners a proxied document's inject keeps on the browser's objects,
// counted with CDP (DOMDebugger.getEventListeners on the objects found on
// the heap, so no getter of the page's is read): every message the service
// worker sends a window (it tells every window of each change of the jar
// and of storage) reaches one listener of the client's on the container,
// not one per module; and a document that never looked at cookieStore
// keeps no listener on it, as natively, so the browser tells it of no
// change of the proxy origin's cookies (each answer of the synchronous
// bridge is one). Once the page reads cookieStore and listens, the change
// events it hears are those native Chrome reports for the same page.
// Compared with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/inject-listeners.html`;

/** the listeners on the one instance of `ctor` in the frame's main world, by type */
async function listenersOn(frame, ctor) {
	const { session, frameId } = await frameTarget(frame);
	try {
		// the frame's main world (Runtime.enable reports the contexts there are)
		const contexts = [];
		session.on('Runtime.executionContextCreated', ({ context }) =>
			contexts.push(context),
		);
		await session.send('Runtime.enable');
		const context = contexts.find(
			(c) => c.auxData?.isDefault && c.auxData.frameId === frameId,
		);
		if (!context) throw new Error('no main world for the frame');
		const { result: proto } = await session.send('Runtime.evaluate', {
			expression: `${ctor}.prototype`,
			contextId: context.id,
		});
		const { objects } = await session.send('Runtime.queryObjects', {
			prototypeObjectId: proto.objectId,
		});
		const { result: first } = await session.send('Runtime.callFunctionOn', {
			objectId: objects.objectId,
			functionDeclaration: 'function () { return this[0]; }',
		});
		if (!first.objectId) return {};
		const { listeners } = await session.send('DOMDebugger.getEventListeners', {
			objectId: first.objectId,
		});
		const counts = {};
		for (const listener of listeners)
			counts[listener.type] = (counts[listener.type] ?? 0) + 1;
		return counts;
	} finally {
		await session.detach().catch(() => {});
	}
}

async function shown(page, proxied) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame.evaluate(() => window.__il).catch(() => null);
			if (value?.ready) return frame;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const nativeFrame = await shown(nativePage, false);
await sleep(500);
const nativeBefore = await listenersOn(nativeFrame, 'CookieStore');
const nativeEvents = await nativeFrame.evaluate(() => window.__listen());
const nativeAfter = await listenersOn(nativeFrame, 'CookieStore');
await nativePage.close();
ok(
	'natively, a page that never read cookieStore has no listener on it',
	!nativeBefore.change,
	JSON.stringify(nativeBefore),
);
ok(
	'natively, the page hears its cookies written and deleted',
	JSON.stringify(nativeEvents) ===
		JSON.stringify(['+il_a', '-il_a', '-il_seed']),
	JSON.stringify(nativeEvents),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const frame = await shown(page, true);
	ok(`${mode}: the page loaded`, !!frame);
	if (!frame) {
		await page.close();
		continue;
	}
	await sleep(1000);
	const container = await listenersOn(frame, 'ServiceWorkerContainer');
	// the client's modules, and the copies' channel (src/inject/dom/loadGrants.ts)
	ok(
		`${mode}: the worker's messages reach at most two listeners of the inject's on the container`,
		(container.message ?? 0) >= 1 && container.message <= 2,
		JSON.stringify(container),
	);
	const before = await listenersOn(frame, 'CookieStore');
	ok(
		`${mode}: a page that never read cookieStore has no listener on it, as natively`,
		(before.change ?? 0) === (nativeBefore.change ?? 0),
		JSON.stringify({ native: nativeBefore, proxied: before }),
	);
	const events = await frame.evaluate(() => window.__listen());
	ok(
		`${mode}: the page hears the change events native Chrome reports, none of the proxy's own cookies`,
		JSON.stringify(events) === JSON.stringify(nativeEvents),
		JSON.stringify({ native: nativeEvents, proxied: events }),
	);
	const after = await listenersOn(frame, 'CookieStore');
	// the page's own, and the inject's that keeps the browser's events from it
	ok(
		`${mode}: once the page listens, the inject's listener is there before the page's`,
		after.change === (nativeAfter.change ?? 0) + 1,
		JSON.stringify({ native: nativeAfter, proxied: after }),
	);
	await page.close();
}

await done(browser);
