// A document the page builds itself and shows from a blob: URL is injected
// and rewritten like a fetched one: its script sees the spoof and the page's
// URL, its markup is routed. Same-origin mode (the host realm reads the
// blob frame's real attributes).
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__el = element;
	await window.controller
		.createFrame(element)
		.go(`${fixture}pages/blobdoc.html`);
}, FIXTURE);
let blob = {};
for (let i = 0; i < 40 && !blob.done; i++) {
	await sleep(500);
	const frame = page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				f.url().includes('/stomp/html/'),
		);
	try {
		blob = (await frame?.evaluate(() => window.__blob)) || {};
	} catch (error) {
		blob = {};
	}
}
ok(
	'the blob document loaded',
	blob.done === true && !blob.error,
	JSON.stringify(blob),
);
ok(
	'a script in a blob: document sees the spoofed top (its parent page) and the page as its URL',
	blob.result?.top === true &&
		typeof blob.result?.href === 'string' &&
		blob.result.href.startsWith(FIXTURE),
	JSON.stringify(blob.result),
);
const real = await page.evaluate(() => {
	const outer = window.__el.contentDocument;
	const inner = outer.querySelector('iframe')?.contentDocument;
	const img = inner?.getElementById('i');
	return img ? Element.prototype.getAttribute.call(img, 'src') : null;
});
ok(
	'markup in a blob: document is routed',
	typeof real === 'string' && real.includes('/stomp/binary/'),
	JSON.stringify(real),
);
ok(
	'blobs that are not HTML documents are untouched',
	blob.others === true &&
		blob.plain === 'abc' &&
		blob.json === '{"a":1}' &&
		blob.image === 4 &&
		blob.untyped === '<b>x</b>' &&
		blob.badBytes === 3,
	JSON.stringify([
		blob.plain,
		blob.json,
		blob.image,
		blob.untyped,
		blob.badBytes,
	]),
);
ok(
	'an HTML blob built from bytes is wrapped like one from strings',
	typeof blob.binaryHTML === 'string' &&
		blob.binaryHTML.startsWith('<!DOCTYPE HTML>') &&
		blob.binaryHTML.includes('loadHTML(') &&
		blob.binaryHTML.includes('&lt;b&gt;x&lt;/b&gt;'),
	JSON.stringify((blob.binaryHTML || '').slice(0, 40)),
);
ok(
	'a File keeps its name and type',
	blob.fileType === 'text/html' && blob.fileName === 'a.html',
	JSON.stringify([blob.fileType, blob.fileName]),
);
await done(browser);
