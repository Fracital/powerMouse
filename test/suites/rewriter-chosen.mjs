// A top page must not choose the rewriter the frames under it share. Under
// `rewriter: 'wasm'` a proxied top's rewriter library instantiates the
// module the controller compiled, for itself and every frame under it,
// whatever their site (src/inject/dom/rewriterRealm.ts). The page here
// passed no hook: it replaces the browser's own MessagePort.prototype.close
// and plays, on each port closed, a message that hands over a module of its
// own making (test/pages/rewriter-chosen.wat). The frame under it is of
// another site; its scripts run as they do natively, and none of them is
// the top page's. Its own controller with `rewriter: 'wasm'`, both modes,
// whatever backend the run is.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
} from '../lib.mjs';

const browser = await launch();
const target = `${FIXTURE}pages/rewriter-chosen.html`;
const EXPECTED = { ran: ['eval', 'function', 'inserted'], marked: null };

/** the child frame's report, once it made one */
async function childReport(pages) {
	for (let i = 0; i < 120; i++) {
		for (const frame of pages().flatMap((p) => p.frames())) {
			const report = await frame
				.evaluate(() =>
					document.title === 'REWRITER CHOSEN CHILD' ? window.__report : null,
				)
				.catch(() => null);
			if (report) return report;
		}
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await childReport(() => [nativePage]);
ok(
	'natively, the frame of another site runs its own scripts',
	JSON.stringify(native) === JSON.stringify(EXPECTED),
	JSON.stringify(native),
);
await nativePage.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const ready = await page.evaluate(
		async ({ mode, proxy }) => {
			const options = { codec: 'xor', cache: false, rewriter: 'wasm' };
			const controller =
				mode === 'isolated'
					? new window.StompRemoteController({
							proxyOrigin: proxy.replace(/\/$/, ''),
							directory: '/stomp/',
							transport: {
								module: `${proxy}epoxy/index.mjs`,
								options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
							},
							...options,
						})
					: new window.StompController({
							serviceworker: window.controller.serviceworker,
							transport: window.controller.transport,
							directory: window.controller.directory.pathname,
							id: 'rewriter-chosen',
							...options,
						});
			const ready = await Promise.race([
				controller.wait().then(() => true),
				new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
			]);
			window.__chosenController = controller;
			return ready;
		},
		{ mode, proxy: PROXY },
	);
	ok(`${mode}: the controller with the wasm rewriter shook hands`, ready);
	await page.evaluate(async (url) => {
		const element = document.createElement('iframe');
		element.id = '__chosenFrame';
		document.body.append(element);
		await window.__chosenController.createFrame(element).go(url);
	}, target);
	const proxied = await childReport(() => page.context().pages());
	ok(
		`${mode}: a frame of another site runs its own scripts, not a rewriter the top page chose`,
		JSON.stringify(proxied) === JSON.stringify(EXPECTED),
		JSON.stringify(proxied),
	);
	await page.context().close();
}
await done(browser);
