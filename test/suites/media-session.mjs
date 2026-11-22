// The browser fetches a media session's artwork itself, for its media
// controls, outside the page and its service worker: through the proxy the
// page's artwork URLs must reach the worker, none the site directly, and
// read back as the page wrote them, compared with the page loaded natively
// in both modes. The page is asked for its answer without a user
// activation: Playwright's evaluate is a user's gesture to Chrome, and one
// that reached the tab's frame before the page's own document began is an
// activation that document starts with from another, which the proxy
// answers as natively a page the user did not touch: play() is refused,
// nothing plays and the browser fetches no artwork (in a mode of about one
// run in five of CI's, and in every run that polled every 10 ms).
import {
	done,
	evaluateQuietly,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const fixture = new URL(FIXTURE);
// a cross-site absolute URL: the fixture under its other name
const cross = `http://localhost:${fixture.port}`;
const target = `${FIXTURE}pages/media-session.html`;
const marked = (url) => /[?&]ms=/.test(url);
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);

const nativeContext = await browser.newContext();
await nativeContext.addInitScript(`window.__cross = ${JSON.stringify(cross)}`);
const nativeFetched = [];
nativeContext.on('request', (request) => {
	if (marked(request.url())) nativeFetched.push(request.url());
});
const nativePage = await nativeContext.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 60 && !native?.done; i++) {
	await sleep(250);
	native = await evaluateQuietly(nativePage.mainFrame(), 'window.__ms');
}
await nativeContext.close();
ok(
	'natively, the browser fetches the current artwork',
	nativeFetched.some((url) => /ms=setter/.test(url)),
	JSON.stringify(nativeFetched),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page
		.context()
		.addInitScript(`window.__cross = ${JSON.stringify(cross)}`);
	const recorder = await recordRequests(page.context());
	// what the browser's own artwork fetch got: routed, served by the worker
	const artwork = [];
	page.context().on('response', (response) => {
		if (
			/\/binary(;[^/]*)?\//.test(response.url()) &&
			response.request().resourceType() === 'other'
		)
			artwork.push([response.status(), response.fromServiceWorker()]);
	});
	await submitLanding(page, target);
	let proxied = null;
	for (let i = 0; i < 80 && !proxied?.done; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url())) {
				const value = await evaluateQuietly(frame, 'window.__ms');
				if (value?.done) proxied = value;
			}
	}
	const raw = recorder.raw().filter((entry) => marked(entry.url));
	ok(
		`${mode}: no artwork request reaches a site past the proxy`,
		proxied?.done && raw.length === 0,
		JSON.stringify(raw.map((entry) => entry.url)),
	);
	const through = recorder.log.filter(
		(entry) => entry.kind === 'worker' && marked(decodeURIComponent(entry.url)),
	);
	ok(
		`${mode}: the browser's artwork fetch is served by the service worker`,
		artwork.length > 0 &&
			artwork.every(([status, worker]) => status === 200 && worker),
		JSON.stringify({ artwork, play: proxied?.play ?? 'played' }),
	);
	ok(
		`${mode}: the artwork reads back as the page wrote it`,
		JSON.stringify([proxied?.read, proxied?.readSetter]) ===
			JSON.stringify([native?.read, native?.readSetter]),
		JSON.stringify({
			native: [native?.read, native?.readSetter],
			proxied: [proxied?.read, proxied?.readSetter],
			through: through.length,
		}),
	);
	await page.close();
}
await done(browser);
