// Relocatable asset names (Fracital WS3): the bundle boots from an arbitrary
// directory with every served file renamed, a page proxies through it, a
// worker gets its renamed inject, and no URL anyone requested carries the
// package name: neither what the host page requested nor what the service
// worker fetched (the fixture logs every path it served). Isolated mode: the
// controller frame is asked for by its renamed name and told its script.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PORT,
	PROXY,
	sleep,
} from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
const before = (await (await fetch(`${FIXTURE}requests`)).json()).length;
await page.goto(
	`${FIXTURE}pages/neutral-host.html?wisp=${encodeURIComponent(`ws://127.0.0.1:${PORT}/wisp/`)}`,
);
let neutral = {};
for (let i = 0; i < 90 && !neutral.done; i++) {
	await sleep(500);
	try {
		neutral = (await page.evaluate(() => window.__neutral)) || {};
	} catch (error) {
		neutral = {};
	}
}
ok(
	'the renamed bundle boots from /neutral/ and proxies a page, the transport in its renamed worker',
	neutral.done === true &&
		!neutral.error &&
		neutral.title === 'HIST 1' &&
		neutral.fetched === 200 &&
		neutral.worker === 'ran' &&
		neutral.transportHost === 'worker',
	JSON.stringify({
		error: neutral.error,
		title: neutral.title,
		fetched: neutral.fetched,
		worker: neutral.worker,
		transportHost: neutral.transportHost,
	}),
);
const served = (await (await fetch(`${FIXTURE}requests`)).json()).slice(before);
const neutralServed = served.filter((p) => p.startsWith('/neutral/'));
ok(
	'the worker and the pages fetched the renamed inject bundles, the renamed rewriter library, the renamed transport worker and the renamed rewrite workers',
	neutralServed.includes('/neutral/sw.js') &&
		neutralServed.includes('/neutral/doc.js') &&
		neutralServed.includes('/neutral/wk.js') &&
		neutralServed.includes('/neutral/lib.js') &&
		neutralServed.includes('/neutral/tw.js') &&
		neutralServed.includes('/neutral/rw.js'),
	JSON.stringify([...new Set(neutralServed)]),
);
const hostURLs = [...(neutral.resources || []), neutral.scriptURL || ''];
const offending = [...served, ...hostURLs].filter((u) => /stomp/i.test(u));
ok(
	'no requested URL contains the package name',
	offending.length === 0 && hostURLs.length > 0,
	JSON.stringify(offending.slice(0, 5)),
);

// isolated mode: the demo host asks for the frame by its (here unchanged)
// name and tells it its script
const isolated = await browser.newPage();
await isolated.goto(HOST);
await isolated.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const remote = await isolated.evaluate(
	async (proxy) => {
		const controller = new window.StompRemoteController({
			proxyOrigin: proxy,
			directory: '/stomp/',
			codec: 'xor',
			transport: {
				module: `${proxy}/epoxy/index.mjs`,
				options: [{ wisp: `ws://127.0.0.1:${location.port}/wisp/` }],
			},
			assets: {
				controllerFrame: 'controllerFrame.html',
				controllerFrameScript: 'controllerFrame.js',
			},
		});
		const src = controller.element.src;
		const ready = await Promise.race([
			controller.wait().then(() => true),
			new Promise((r) => setTimeout(() => r('timeout'), 20000)),
		]);
		return { src, ready };
	},
	PROXY.replace(/\/$/, ''),
);
ok(
	'a RemoteController asks for the frame by its asset name and names its script',
	remote.src.endsWith(
		'/stomp/controllerFrame.html?script=controllerFrame.js',
	) && remote.ready === true,
	JSON.stringify(remote),
);
await done(browser);
