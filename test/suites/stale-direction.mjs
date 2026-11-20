// A build mismatch has two directions. A page newer than its worker (the
// worker is still installing) heals: the controller switches to the new
// worker when it activates and fires `rebind`. A tab that was open during a
// deploy is the other way round: the browser installs the new worker, the
// controller adopts it, and the handshake finds the worker newer than the
// page. No newer worker comes, so no rebind either, and the console said
// "the new worker has not activated yet, continuing with the old one",
// which was wrong. `stale.newer` now says which side is newer, and the
// console says plainly that the page needs a reload. Both are played with
// fake workers in a fake registration, which the controller treats as the
// browser's.
import { readFileSync } from 'node:fs';
import { done, launch, ok, openDemo, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
const warnings = [];
page.on('console', (message) => {
	if (message.type() === 'warning') warnings.push(message.text());
});
// the controller starts only where its host serves the rewriter's files
for (const [file, contentType] of [
	['rewriterLib.js', 'text/javascript'],
	['core.wasm', 'application/wasm'],
])
	await page.route(
		new RegExp(`/nowhere/${file.replace('.', '\\.')}(\\?|$)`),
		(route) =>
			route.fulfill({
				contentType,
				body: readFileSync(new URL(`../../dist/${file}`, import.meta.url)),
			}),
	);

// workers that answer the handshake with a build, and a registration the
// test moves them through
await page.addScriptTag({
	content: `window.__fakes = {
	worker(build, state = 'activated') {
		const listeners = [];
		return {
			state,
			scriptURL: location.origin + '/nowhere/serviceWorker.js',
			addEventListener(type, listener) {
				if (type === 'statechange') listeners.push(listener);
			},
			removeEventListener() {},
			activate() {
				this.state = 'activated';
				for (const listener of listeners) listener();
			},
			postMessage(data, transfer) {
				if (!data || !('$stomp$controllerInit' in data)) return;
				transfer[0].postMessage({
					stomp: { $type: 'request', $method: 'ready', $args: { build }, $token: 0 },
				});
			},
		};
	},
	registration({ active, installing = null }) {
		const found = [];
		const registration = Object.create(ServiceWorkerRegistration.prototype);
		Object.defineProperties(registration, {
			scope: { value: location.origin + '/nowhere/' },
			active: { value: active, writable: true },
			installing: { value: installing, writable: true },
			waiting: { value: null, writable: true },
			update: { value: async () => registration },
			addEventListener: {
				value(type, listener) {
					if (type === 'updatefound') found.push(listener);
				},
			},
			removeEventListener: { value() {} },
			updatefound: { value: () => found.forEach((listener) => listener()) },
		});
		return registration;
	},
};`,
});

const build = await page.evaluate(() => window.controller.build);

// the tab open during a deploy: the page's build first, then the deploy's
const deployed = await page.evaluate(async () => {
	const { worker, registration } = window.__fakes;
	const old = worker(window.controller.build);
	const fake = registration({ active: old });
	const controller = new window.StompController({
		serviceworker: fake,
		transport: window.controller.transport,
		directory: '/nowhere/',
		codec: 'xor',
	});
	await controller.wait();
	const before = controller.stale;
	const events = [];
	controller.addEventListener('stale', (event) => events.push(event.detail));
	controller.addEventListener('rebind', () => events.push('rebind'));
	// the browser finds the new worker, installs it and activates it
	const next = worker('9.9.9+deployed', 'installing');
	fake.installing = next;
	fake.updatefound();
	fake.active = next;
	fake.installing = null;
	next.activate();
	const until = Date.now() + 20000;
	while (!events.length && Date.now() < until)
		await new Promise((resolve) => setTimeout(resolve, 100));
	// a moment more, for a rebind that should not come
	await new Promise((resolve) => setTimeout(resolve, 1000));
	return {
		before,
		events,
		stale: controller.stale,
		bound: controller.serviceworker === next,
	};
});
ok(
	'a tab open during a deploy agreed with its worker before',
	deployed.before === null,
	JSON.stringify(deployed.before),
);
ok(
	'after the deploy, stale says the worker is the newer build, and no rebind comes',
	deployed.bound &&
		deployed.events.length === 1 &&
		deployed.events[0]?.newer === 'worker' &&
		deployed.events[0]?.worker === '9.9.9+deployed' &&
		deployed.events[0]?.controller === build &&
		deployed.stale?.newer === 'worker',
	JSON.stringify(deployed),
);
ok(
	'the console says the page needs a reload, not that a new worker has not activated',
	warnings.some((line) => /reload the page to run build 9\.9\.9/.test(line)) &&
		!warnings.some((line) => /has not activated yet/.test(line)),
	JSON.stringify(warnings),
);

// the page newer than its worker: a worker of its build is installing
warnings.length = 0;
const updating = await page.evaluate(async () => {
	const { worker, registration } = window.__fakes;
	const old = worker('0.0.0+old');
	const next = worker(window.controller.build, 'installing');
	const fake = registration({ active: old, installing: next });
	const controller = new window.StompController({
		serviceworker: fake,
		transport: window.controller.transport,
		directory: '/nowhere/',
		codec: 'xor',
	});
	const events = [];
	controller.addEventListener('stale', (event) => events.push(event.detail));
	controller.addEventListener('rebind', () => events.push('rebind'));
	await controller.wait();
	const stale = controller.stale;
	// the new worker activates late: the controller switches to it
	fake.active = next;
	fake.installing = null;
	next.activate();
	const until = Date.now() + 10000;
	while (events.length < 2 && Date.now() < until)
		await new Promise((resolve) => setTimeout(resolve, 100));
	return { stale, events, after: controller.stale };
});
ok(
	'a page newer than its worker: stale says the controller is newer, then rebind comes',
	updating.stale?.newer === 'controller' &&
		updating.stale?.worker === '0.0.0+old' &&
		updating.events[1] === 'rebind' &&
		updating.after === null,
	JSON.stringify(updating),
);
ok(
	'its console says the new worker has not activated yet',
	warnings.some((line) => /has not activated yet/.test(line)),
	JSON.stringify(warnings),
);

await done(browser, page.errors);
