// The host's request log: with onRequest set, every proxied request reports
// its real URL, status, time, cache flag and the frame it belongs to; with
// it unset the config carries no requestLog and nothing is sent. The suite
// constructs its own controller on the demo's service worker (same origin),
// which replaces the demo's for its directory.
import { done, FIXTURE, launch, ok, openDemo, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);

const result = await page.evaluate(async (fixture) => {
	const old = window.controller;
	window.__log = [];
	const controller = new window.StompController({
		// the demo page is outside the service worker's scope: take the
		// registration's worker, not navigator.serviceWorker.controller
		serviceworker: (await navigator.serviceWorker.getRegistration('/stomp/'))
			.active,
		transport: old.transport,
		directory: '/stomp/',
		codec: 'xor',
		cache: true,
		onRequest: (info) =>
			window.__log.push({ ...info, frame: info.frame ? 'frame' : null }),
	});
	// the same reports as `request` events, for handlers added later
	window.__events = [];
	controller.addEventListener('request', (event) =>
		window.__events.push(event.detail.url),
	);
	await controller.wait();
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	await frame.go(`${fixture}pages/cache.html`);
	await new Promise((resolve) => setTimeout(resolve, 6000));
	// a head stylesheet, a CSS image and a keepalive POST
	await frame.go(`${fixture}pages/reqlog.html`);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	return {
		log: window.__log,
		events: window.__events,
		config: controller.config,
		sameFrame: window.__log.every(
			(e) => e.frame === null || e.frame === 'frame',
		),
	};
}, FIXTURE);

const log = result.log || [];
const byFile = (name) => log.filter((e) => e.url.endsWith(`/pages/${name}`));
ok(
	'the page load itself is reported with its real URL',
	byFile('cache.html').some(
		(e) => e.status === 200 && e.destination === 'iframe',
	),
	JSON.stringify(byFile('cache.html').map((e) => [e.status, e.destination])),
);
ok(
	'a fetch is reported with status, time and size',
	byFile('nostore.json').length === 2 &&
		byFile('nostore.json').every(
			(e) => e.status === 200 && e.ms >= 0 && e.bytes !== null,
		),
	JSON.stringify(byFile('nostore.json')),
);
ok(
	'the second fetch of a fresh file is reported as cached',
	byFile('fresh.json')
		.map((e) => e.cached)
		.join(',') === 'false,true',
	JSON.stringify(byFile('fresh.json').map((e) => e.cached)),
);
ok(
	'the document request itself carries its frame',
	byFile('cache.html').some(
		(e) => e.destination === 'iframe' && e.frame === 'frame',
	),
	JSON.stringify(byFile('cache.html').map((e) => [e.destination, e.frame])),
);
ok(
	'requests carry the frame once the page reported its client id',
	byFile('nostore.json').some((e) => e.frame === 'frame'),
	JSON.stringify(log.map((e) => e.frame)),
);
ok(
	'a head stylesheet fetched before the page reported carries its frame',
	byFile('reqlog.css').length === 1 &&
		byFile('reqlog.css')[0].frame === 'frame',
	JSON.stringify(byFile('reqlog.css')),
);
ok(
	'a CSS image is reported without the #url() fragment',
	byFile('sprite.svg').length === 1 &&
		!log.some((e) => e.url.includes('#url(')),
	JSON.stringify(log.filter((e) => /sprite/.test(e.url)).map((e) => e.url)),
);
const beacon = log.find(
	(e) => e.method === 'POST' && e.url.endsWith('/echo-headers'),
);
ok(
	'a keepalive POST is reported with destination fetch',
	beacon?.destination === 'fetch',
	JSON.stringify(beacon),
);
ok(
	'every report is also a request event',
	JSON.stringify(result.events) === JSON.stringify(log.map((e) => e.url)),
	JSON.stringify([result.events?.length, log.length]),
);
ok(
	'the controller config asks the service worker for the log',
	result.config.requestLog === true,
	JSON.stringify(result.config),
);
// the demo itself passes onRequest (its request viewer), so a controller of
// our own, bound to a worker that never answers, shows the default
ok(
	'without onRequest the config asks for nothing',
	(await page.evaluate(
		() =>
			new window.StompController({
				serviceworker: { postMessage() {} },
				transport: window.controller.transport,
				directory: '/nowhere/',
				codec: 'xor',
			}).config.requestLog,
	)) === undefined,
);

await done(browser, page.errors);
