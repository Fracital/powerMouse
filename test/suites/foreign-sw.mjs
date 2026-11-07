// A host application with a service worker of its own (a root worker in
// control of the host page) boots a StompController next to it. The foreign
// worker posts to its clients a message shaped like Stomp's revive broadcast
// (and a plain one) while the controller is starting and again later, and
// the transport module is slow to arrive, so the stomp worker's own startup
// revive lands before the first handshake; the controller must stay on its
// own worker, resolve wait(), and keep serving its frames.
import { done, FIXTURE, launch, ok, PROXY, waitForServer } from '../lib.mjs';

const browser = await launch();
await waitForServer(PROXY);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// the transport module arrives slowly (the 2.2 MB epoxy module over a real
// network), so the first handshake waits while the stomp worker's own
// startup revive lands: the window in which the controller used to adopt
// the foreign worker in control of the page
await page.route('**/epoxy/index.mjs', async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue();
});
await page.goto(`${PROXY}test/host.html`);
await page.waitForFunction(() => window.__foreignReady, null, {
	timeout: 30000,
});

const result = await page.evaluate(
	async ({ fixture, proxy }) => {
		const out = {
			foreign: navigator.serviceWorker.controller?.scriptURL ?? null,
		};
		const { StompController } = await import('/stomp/controller.mjs');
		const registration = await StompController.register('/stomp/');
		const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
		const controller = new StompController({
			serviceworker: registration,
			transport: { module: '/epoxy/index.mjs', options: [{ wisp }] },
			directory: '/stomp/',
			codec: 'xor',
		});
		const timeout = (ms, value) =>
			new Promise((resolve) => setTimeout(() => resolve(value), ms));
		// the foreign worker broadcasts while the controller is still starting
		// (its transport worker is loading), as a root worker activating with
		// the host page does
		navigator.serviceWorker.controller.postMessage('broadcast');
		out.wait = await Promise.race([
			controller.wait().then(() => 'resolved'),
			timeout(20000, 'timed out'),
		]);
		out.workerBefore = controller.serviceworker.scriptURL;
		// the foreign worker broadcasts again, well after our handshake
		await timeout(2500);
		navigator.serviceWorker.controller.postMessage('broadcast');
		await timeout(1500);
		out.workerAfter = controller.serviceworker.scriptURL;
		out.readyAfter = controller.isReady;
		out.stillForeign = navigator.serviceWorker.controller?.scriptURL ?? null;
		const frame = controller.createFrame();
		document.body.append(frame.element);
		out.go = await Promise.race([
			frame.go(`${fixture}pages/hist-1.html`).then(() => 'went'),
			timeout(15000, 'timed out'),
		]);
		out.title = frame.element.contentDocument?.title ?? 'unreadable';
		out.proxy = proxy;
		return out;
	},
	{ fixture: FIXTURE, proxy: new URL(PROXY).origin },
);
ok(
	'the host page is controlled by the foreign root worker',
	typeof result.foreign === 'string' &&
		result.foreign.endsWith('/test/root-sw.js'),
	JSON.stringify(result.foreign),
);
ok(
	'wait() resolves on the stomp worker, not the foreign one',
	result.wait === 'resolved' &&
		result.workerBefore?.startsWith(`${result.proxy}/stomp/`),
	JSON.stringify([result.wait, result.workerBefore]),
);
ok(
	"the foreign worker's revive-shaped broadcast leaves the controller on its own worker, ready",
	result.workerAfter === result.workerBefore &&
		result.readyAfter === true &&
		result.stillForeign?.endsWith('/test/root-sw.js'),
	JSON.stringify([result.workerAfter, result.readyAfter, result.stillForeign]),
);
ok(
	'a frame loads after the broadcast',
	result.go === 'went' && result.title === 'HIST 1',
	JSON.stringify([result.go, result.title]),
);
await done(browser, errors);
