// The page's own Referrer-Policy decides the Referer the proxy sends: all
// eight policies set by a meta tag, a policy that arrives as a response
// header, and a fetch whose init overrides the document's policy. The
// fixture's /echo-headers answers with the request headers it saw; the
// cross-site target is the fixture's other host name. Same-origin mode.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(() => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__el = element;
	window.__frame = window.controller.createFrame(element);
});
const run = async (file) => {
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/${file}`,
	);
	for (let i = 0; i < 40; i++) {
		await sleep(500);
		const frame = page
			.frames()
			.find(
				(f) =>
					f.parentFrame() === page.mainFrame() &&
					f.url().includes('/stomp/html/'),
			);
		try {
			const ref = await frame?.evaluate(() => window.__ref);
			if (ref?.done && !ref.stale) {
				// a record from the previous page would also say done: mark it
				await frame.evaluate(() => (window.__ref.stale = true));
				return ref;
			}
		} catch (error) {
			// navigating
		}
	}
	return {};
};

const origin = new URL(FIXTURE).origin;
const full = (file) => `${origin}/pages/${file}`;
// [same-origin fetch, cross-site fetch]; 'origin' is the origin with a slash
const EXPECTED = {
	'no-referrer': [null, null],
	'no-referrer-when-downgrade': ['full', 'full'],
	origin: ['origin', 'origin'],
	'origin-when-cross-origin': ['full', 'origin'],
	'same-origin': ['full', null],
	'strict-origin': ['origin', 'origin'],
	'strict-origin-when-cross-origin': ['full', 'origin'],
	'unsafe-url': ['full', 'full'],
};
const resolve = (kind, file) =>
	kind === 'full' ? full(file) : kind === 'origin' ? `${origin}/` : null;
for (const [policy, [same, cross]] of Object.entries(EXPECTED)) {
	const file = `referrer.html?policy=${policy}`;
	const ref = await run(file);
	ok(
		`${policy}: same-origin and cross-site referers follow the policy`,
		ref.same === resolve(same, file) && ref.cross === resolve(cross, file),
		JSON.stringify([ref.same, ref.cross, ref.error]),
	);
	if (policy === 'no-referrer')
		ok(
			'a fetch init overrides the document policy',
			ref.override === full(file),
			JSON.stringify(ref.override),
		);
}
const header = await run('referrer-header.html');
ok(
	'a policy that arrives as a response header applies (same-origin)',
	header.same === full('referrer-header.html') && header.cross === null,
	JSON.stringify([header.same, header.cross, header.error]),
);
ok(
	'the Referrer-Policy header reaches the browser',
	header.header === 'same-origin',
	JSON.stringify(header.header),
);
await done(browser);
