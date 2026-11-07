// Registering the worker is the controller's job too: StompController.register
// returns an activated registration, and the constructor accepts a
// registration in place of a worker (waiting for it to activate). The
// controllers keep their state in #fields, so nothing a page could reach is
// an own property of the controller or of a frame (lastHandshake excepted:
// the dev loop sets it).
import { done, FIXTURE, HOST, launch, ok, PROXY } from '../lib.mjs';

const PRIVATE = [
	'clientFrames',
	'rpc',
	'port',
	'ready',
	'readyResolve',
	'rules',
	'sandbox',
	'healing',
	'stopServing',
	'onRequest',
	'init',
	'refreshing',
];
const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const result = await page.evaluate(async (fixture) => {
	const out = {};
	const registration = await window.StompController.register('/stomp/');
	out.registered =
		registration instanceof ServiceWorkerRegistration &&
		registration.active?.state === 'activated' &&
		new URL(registration.scope).pathname === '/stomp/';
	const controller = new window.StompController({
		serviceworker: registration,
		transport: window.controller.transport,
		directory: '/stomp/',
		codec: 'xor',
	});
	out.worker = controller.serviceworker === registration.active;
	await controller.wait();
	out.ready = controller.isReady;
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	await frame.go(`${fixture}pages/hist-1.html`);
	out.title = element.contentDocument?.title;
	const own = (object) => Object.getOwnPropertyNames(object);
	out.controllerOwn = own(controller);
	out.frameOwn = own(frame);
	return out;
}, FIXTURE);
ok(
	'register() returns an activated registration for the directory',
	result.registered === true,
	JSON.stringify(result.registered),
);
ok(
	'a controller built on a registration takes its worker and gets ready',
	result.worker === true && result.ready === true && result.title === 'HIST 1',
	JSON.stringify([result.worker, result.ready, result.title]),
);
ok(
	'same-origin: no TypeScript-private member is an own property',
	!PRIVATE.some((name) => result.controllerOwn.includes(name)) &&
		!result.frameOwn.includes('awaitingReport') &&
		result.controllerOwn.includes('lastHandshake'),
	JSON.stringify([result.controllerOwn, result.frameOwn]),
);
await page.close();

// the isolated host's RemoteController and RemoteFrame
const host = await browser.newPage();
await host.goto(HOST);
await host.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const remote = await host.evaluate(() => {
	const frame = window.controller.createFrame(document.createElement('iframe'));
	return {
		controllerOwn: Object.getOwnPropertyNames(window.controller),
		frameOwn: Object.getOwnPropertyNames(frame),
	};
});
ok(
	'isolated: no TypeScript-private member is an own property',
	!PRIVATE.some((name) => remote.controllerOwn.includes(name)) &&
		!remote.frameOwn.includes('awaitingReport') &&
		!remote.frameOwn.includes('refreshing'),
	JSON.stringify([remote.controllerOwn, remote.frameOwn]),
);
await done(browser);
