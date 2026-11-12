// The demo's controller setup (packages/demo/src/index.tsx and
// pages/BrowserView.tsx) without its UI, with the Controller's default scramjet
// config as packages/bootstrap uses. The service worker path, transport
// options and plugins come from bench/configs/scramjet.json through
// /bench-config.js.
import EpoxyTransport from '/epoxy/index.mjs';

const CFG = window.BENCH_CONFIG;
const { Controller } = window.$scramjetController;
const utils = window.$scramjetUtils;
const element = document.getElementById('bench-frame');

// the demo's waitForControllerOrReady, without its 10 s give-up
async function waitForController() {
	if (navigator.serviceWorker.controller) return;
	await new Promise((resolve) => {
		navigator.serviceWorker.addEventListener('controllerchange', resolve, {
			once: true,
		});
		if (navigator.serviceWorker.controller) resolve();
	});
}

let frame;
const info = { contender: 'scramjet', wisp: CFG.wisp };
const ready = (async () => {
	const registration = await navigator.serviceWorker.register(
		CFG.serviceWorker,
	);
	await navigator.serviceWorker.ready;
	await waitForController();
	const sw = navigator.serviceWorker.controller ?? registration.active;
	const controller = new Controller({
		serviceworker: sw,
		transport: new EpoxyTransport(CFG.transportOptions),
	});
	window.controller = controller;
	await controller.wait();
	frame = controller.createFrame(element, {
		plugins: CFG.plugins.map((name) => new utils[name]()),
	});
	info.flags = { ...controller.scramjetConfig.flags };
	info.prefix = frame.prefix;
	info.versions = {
		scramjet: window.$scramjet.versionInfo,
		controller: window.$scramjetController.versionInfo,
		utils: utils.versionInfo,
	};
})();

window.__bench = {
	ready,
	frame: element,
	info,
	async go(url) {
		await ready;
		frame.go(url);
	},
};
