// The demo's controller setup (demo/public/pm/main.js) without its UI. The
// controller options come from bench/configs/stomp.json through
// /bench-config.js; this page adds only the service worker registration.
import { StompController } from '/stomp/controller.mjs';

const CFG = window.BENCH_CONFIG;
const element = document.getElementById('bench-frame');
// what the demo's tabs allow a proxied page to ask the browser for
element.allow = CFG.frameAllow.join('; ');

let frame;
const ready = (async () => {
	// register()'s promise, unawaited: the controller's transport and
	// workers start while a first visit's service worker installs
	const controller = new StompController({
		serviceworker: StompController.register(CFG.controller.directory),
		...CFG.controller,
	});
	window.controller = controller;
	await controller.wait();
	frame = controller.createFrame(element);
})();

window.__bench = {
	ready,
	frame: element,
	info: { contender: 'stomp', ...CFG },
	async go(url) {
		await ready;
		frame.go(url);
	},
};
