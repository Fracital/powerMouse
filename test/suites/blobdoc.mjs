// A document the page builds itself and shows from a blob: URL is injected
// and rewritten like a fetched one: its script sees the spoof and the page's
// URL, its markup is routed, and the Blob reads back as the page made it.
// Same-origin mode (a world of the frame's own reads the blob frame's real
// attributes).
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
} from '../lib.mjs';

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
				/\/stomp\/[\w-]+\/html\//.test(f.url()),
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
// the real attribute, in a world of the frame's own that no hook reaches
// (the frame can be of another origin than this page: a site pool's slot)
const outerFrame = await (
	await page.evaluateHandle(() => window.__el)
)
	.asElement()
	.contentFrame();
const real = await evaluateIsolated(outerFrame, () => {
	const inner = document.querySelector('iframe')?.contentDocument;
	const img = inner?.getElementById('i');
	return img ? img.getAttribute('src') : null;
});
ok(
	'markup in a blob: document is routed',
	typeof real === 'string' && /\/stomp\/[\w-]+\/binary(;[^/]*)?\//.test(real),
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
	"an HTML blob reads back the page's own bytes, as natively",
	blob.binaryHTML === '<b>x</b>' &&
		typeof blob.htmlText === 'string' &&
		blob.htmlText.startsWith('<!doctype html><title>BLOB</title>') &&
		blob.htmlSize === blob.htmlLength,
	JSON.stringify([
		blob.binaryHTML,
		(blob.htmlText || '').slice(0, 40),
		blob.htmlSize,
		blob.htmlLength,
	]),
);
ok(
	'a File keeps its name and type',
	blob.fileType === 'text/html' && blob.fileName === 'a.html',
	JSON.stringify([blob.fileType, blob.fileName]),
);
await done(browser);
