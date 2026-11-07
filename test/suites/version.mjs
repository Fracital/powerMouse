// The build id baked into the controller bundle, the service worker and the
// inject bundle must agree: the controller handshake checks it (wait()
// rejects otherwise) and the page client checks the bundle it runs from.
// One build cannot produce a mismatch, so this checks that all three carry
// the same id and that it is the package version (or STOMP_BUILD). The
// self-healing on a mismatch is checked with a fake worker that answers an
// old build: the controller must move to the registration's real worker and
// wait() must resolve instead of rejecting.
import { readFileSync } from 'node:fs';
import { done, launch, ok, openDemo, PROXY } from '../lib.mjs';

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

await done(browser, page.errors);
