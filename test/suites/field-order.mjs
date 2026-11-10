// A cross-origin CORS request goes out with its fields in the order Chrome
// sends them. Origin comes from Blink first for a module script or a
// crossorigin image, but from the network stack, after Accept, for a fetch
// or an XHR: the worker put it first for every CORS GET (browserleaks'
// HTTP/2 page showed it, and a JA4H-style hash of the order sees it). A
// recorder of the suite's own, on another origin than the fixture's,
// keeps the field names as they arrived; compared with the page loaded
// natively, in both modes, without Host and Connection (the transport's).
import { createServer } from 'node:http';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const recorded = new Map();
const recorder = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	const key = url.searchParams.get('k');
	if (key && req.method !== 'OPTIONS')
		recorded.set(
			key,
			req.rawHeaders
				.filter((_, i) => i % 2 === 0)
				.map((name) => name.toLowerCase())
				.filter((name) => name !== 'host' && name !== 'connection'),
		);
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-headers', '*');
	const image = key?.endsWith('-image');
	res.setHeader(
		'content-type',
		image
			? 'image/gif'
			: key?.endsWith('-module')
				? 'text/javascript'
				: 'text/plain',
	);
	res.end(
		image
			? Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')
			: key?.endsWith('-module')
				? 'export {};'
				: 'ok',
	);
});
// every interface: localhost may resolve to ::1 for the demo's wisp
await new Promise((resolve) => recorder.listen(0, resolve));
// localhost is another origin than the fixture's 127.0.0.1, and secure
// (fetch metadata goes to it)
const R = `http://localhost:${recorder.address().port}`;
const KINDS = ['fetch', 'post', 'xhr', 'module', 'image'];
const page = (run) => `${FIXTURE}pages/field-order.html?r=${R}&run=${run}`;

async function wait(frames) {
	for (let i = 0; i < 80; i++) {
		for (const frame of frames())
			if (await frame.evaluate(() => window.__fieldOrder).catch(() => false))
				return true;
		await sleep(250);
	}
	return false;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(page('native'));
await wait(() => [nativePage.mainFrame()]);
await nativePage.close();
ok(
	'natively: every request arrived, a fetch with Origin after Accept',
	KINDS.every((kind) => recorded.has(`native-${kind}`)) &&
		recorded.get('native-fetch').indexOf('origin') >
			recorded.get('native-fetch').indexOf('accept'),
	JSON.stringify(Object.fromEntries(recorded)),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = await openDemo(browser, base);
	await submitLanding(tab, page(mode));
	await wait(() =>
		tab.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const kind of KINDS) {
		const native = recorded.get(`native-${kind}`)?.join(' ');
		const proxied = recorded.get(`${mode}-${kind}`)?.join(' ');
		ok(
			`${mode}: a ${kind}'s fields come in Chrome's order`,
			proxied === native,
			`native ${native} proxied ${proxied}`,
		);
	}
	await tab.close();
}

recorder.close();
await done(browser);
