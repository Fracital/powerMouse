// A frame whose sandbox the page builds through its token list
// (`iframe.sandbox.add`, `.value =`, as reCAPTCHA does for its anchor frame)
// loads through the service worker: the token list writes the attribute
// without any attribute hook seeing it, so the frame was really sandboxed,
// without allow-same-origin its navigation went to the proxy server (a 404
// on stomp.fracit.al) and without allow-scripts nothing ran. The page reads
// the attribute and its token list calls back as it does natively, with the
// same MutationObserver records. Same-origin mode (the host realm reads the
// frame's real attributes).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const NAMES = ['recaptcha', 'added', 'value'];
const PAGE = `${FIXTURE}pages/sandbox-tokens.html`;

/** the page's report once every child has reported or the wait ran out */
const report = () => ({
	read: window.__read ?? null,
	children: Object.keys(window.__children ?? {}).sort(),
});

const browser = await launch();

// the ground truth: the same page, served natively
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
let native = null;
for (let i = 0; i < 40; i++) {
	native = await nativePage.evaluate(report);
	if (native.children.length === NAMES.length) break;
	await sleep(250);
}
ok(
	'natively every child runs',
	native.children.join() === [...NAMES].sort().join(),
	JSON.stringify(native.children),
);

const page = await openDemo(browser, PROXY);
// a routed document the proxy server answered: the service worker never saw
// its navigation
const unserved = [];
page.on('response', (response) => {
	const request = response.request();
	if (
		request.resourceType() === 'document' &&
		/\/stomp\/[\w-]+\/html[:/]/.test(response.url()) &&
		!response.fromServiceWorker()
	)
		unserved.push(`${response.status()} ${response.url()}`);
});
await submitLanding(page, PAGE);
let proxied = null;
for (let i = 0; i < 80; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	proxied = await frame?.evaluate(report).catch(() => null);
	if (proxied?.children.length === NAMES.length) break;
}
// give a frame that went to the server time to answer
await sleep(1000);

ok(
	'every child frame runs through the proxy',
	proxied?.children.join() === [...NAMES].sort().join(),
	JSON.stringify(proxied?.children),
);
ok(
	'no child navigation skips the service worker',
	unserved.length === 0,
	unserved.join(' '),
);

const real = await page.evaluate((names) => {
	const doc = document.querySelector('.frame:not(.hidden)').contentDocument;
	return names.map((name) => {
		const element = Document.prototype.getElementById.call(doc, name);
		return element && Element.prototype.getAttribute.call(element, 'sandbox');
	});
}, NAMES);
ok(
	'the real frames carry no sandbox',
	real.every((value) => value === null),
	JSON.stringify(real),
);

ok(
	'the page reads its sandboxes back as natively',
	JSON.stringify(proxied?.read?.frames) === JSON.stringify(native.read.frames),
	`${JSON.stringify(proxied?.read?.frames)} vs ${JSON.stringify(native.read.frames)}`,
);
const steps = (read) => JSON.stringify(read?.steps);
ok(
	'token list calls return and leave what they do natively',
	steps(proxied?.read) === steps(native.read),
	`${steps(proxied?.read)} vs ${steps(native.read)}`,
);
const records = (read) => JSON.stringify(read?.records);
ok(
	'the page observes the token list writes it made',
	records(proxied?.read) === records(native.read),
	`${records(proxied?.read)} vs ${records(native.read)}`,
);
await done(browser, page.errors);
