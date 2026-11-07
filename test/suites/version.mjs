// The build id baked into the controller bundle, the service worker and the
// inject bundle must agree: the controller handshake checks it (wait()
// rejects otherwise) and the page client checks the bundle it runs from.
// One build cannot produce a mismatch, so this checks that all three carry
// the same id and that it is the package version (or STOMP_BUILD). The
// self-healing on a mismatch is checked with a fake worker that answers an
// old build: the controller must move to the registration's real worker and
// wait() must resolve instead of rejecting. When there is nothing to move to,
// wait() still resolves, on the old worker, with `stale` set. A routed
// request that never answers gets a 504 within the worker's bound.
import { readFileSync } from 'node:fs';
import { done, FIXTURE, launch, ok, openDemo, PROXY } from '../lib.mjs';

const pkg = JSON.parse(
	readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const browser = await launch();
const page = await openDemo(browser, PROXY);
const hostBuild = await page.evaluate(() => window.controller.config.build);
ok(
	'the controller config carries the service worker build id',
	typeof hostBuild === 'string' && hostBuild.startsWith(pkg.version),
	JSON.stringify(hostBuild),
);
await page.evaluate(async () => {
	const element = document.createElement('iframe');
	document.body.append(element);
	await window.controller.createFrame(element).go('https://example.com/');
	await new Promise((resolve) =>
		element.addEventListener('load', resolve, { once: true }),
	);
});
const pageBuild = await page.evaluate(() => {
	const frame = document.querySelector('iframe:not(.frame)');
	return frame.contentWindow.$P$s.config.build;
});
ok(
	'the page client got the same build id from the shell',
	pageBuild === hostBuild,
	JSON.stringify(pageBuild),
);
ok(
	'wait() resolved, so the controller and the service worker agree',
	(await page.evaluate(() =>
		window.controller.wait().then(
			() => true,
			(e) => String(e),
		),
	)) === true,
);

// last: a second controller for the same directory replaces the demo's in
// the service worker
const healed = await page.evaluate(async () => {
	const INIT = '$stomp$controllerInit';
	const RPC = 'stomp';
	// a worker of another build: answers the handshake with a stale id
	const stale = {
		postMessage(data, transfer) {
			if (!data || !(INIT in data)) return;
			transfer[0].postMessage({
				[RPC]: {
					$type: 'request',
					$method: 'ready',
					$args: { build: '0.0.0+stale' },
					$token: 0,
				},
			});
		},
	};
	const started = Date.now();
	const controller = new window.StompController({
		serviceworker: stale,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
	});
	const result = await controller.wait().then(
		() => 'resolved',
		(error) => String(error),
	);
	return {
		result,
		seconds: Math.round((Date.now() - started) / 1000),
		rebound: controller.serviceworker !== stale,
		build: controller.config.build,
	};
});
ok(
	"a controller handed a worker of another build moves to the registration's worker and wait() resolves",
	healed.result === 'resolved' && healed.rebound && healed.build === hostBuild,
	JSON.stringify(healed),
);

// the fake worker again, for a directory with no registration to update
// from: nothing to heal with, so the controller settles for it
const settled = await page.evaluate(async () => {
	const INIT = '$stomp$controllerInit';
	const RPC = 'stomp';
	const stale = {
		postMessage(data, transfer) {
			if (!data || !(INIT in data)) return;
			transfer[0].postMessage({
				[RPC]: {
					$type: 'request',
					$method: 'ready',
					$args: { build: '0.0.0+stale' },
					$token: 0,
				},
			});
		},
	};
	const controller = new window.StompController({
		serviceworker: stale,
		transport: window.controller.transport,
		directory: '/nowhere/',
		codec: 'xor',
	});
	const events = [];
	controller.addEventListener('stale', (event) => events.push(event.detail));
	const started = Date.now();
	await controller.wait();
	return {
		seconds: Math.round((Date.now() - started) / 1000),
		isReady: controller.isReady,
		stale: controller.stale,
		build: controller.config.build,
		events,
	};
});
ok(
	'a mismatch with nothing to heal from resolves wait() on the old worker and marks the controller stale',
	settled.isReady &&
		settled.seconds <= 8 &&
		settled.stale?.worker === '0.0.0+stale' &&
		settled.stale?.controller === hostBuild &&
		settled.build === '0.0.0+stale' &&
		settled.events.length === 1,
	JSON.stringify(settled),
);

// a routed request that never answers: 504 within the bound, and the worker
// keeps serving (a short bound for the test, through the internal option)
const slow = await page.evaluate(async (fixture) => {
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
		fetchTimeout: 1500,
	});
	await controller.wait();
	const element = document.createElement('iframe');
	document.body.append(element);
	const loaded = new Promise((resolve) =>
		element.addEventListener('load', resolve, { once: true }),
	);
	await controller.createFrame(element).go(`${fixture}pages/hist-1.html`);
	await loaded;
	const win = element.contentWindow;
	const started = Date.now();
	const status = await win.fetch('/slow').then(
		(response) => response.status,
		(error) => String(error),
	);
	const ms = Date.now() - started;
	const after = await win.fetch('/pages/hdr.json').then(
		(response) => response.status,
		(error) => String(error),
	);
	return { status, ms, after };
}, FIXTURE);
ok(
	'a routed request that hangs is answered 504 within the bound and the worker keeps serving',
	slow.status === 504 && slow.ms < 4000 && slow.after === 200,
	JSON.stringify(slow),
);

// isolated mode: the host's RemoteController mirrors the inner controller's
// state, so a host can listen the same way in both modes
const remotePage = await openDemo(browser);
const remote = await remotePage.evaluate(() => {
	const controller = window.controller;
	let listens = true;
	try {
		controller.addEventListener('stale', () => {});
		controller.addEventListener('rebind', () => {});
	} catch (error) {
		listens = String(error);
	}
	return {
		eventTarget: controller instanceof EventTarget,
		stale: controller.stale,
		listens,
	};
});
ok(
	'RemoteController is an EventTarget with stale null while the builds agree',
	remote.eventTarget && remote.stale === null && remote.listens === true,
	JSON.stringify(remote),
);

await done(browser, page.errors);
