// Origin isolation: host on localhost, proxy on 127.0.0.1. The host can
// neither read nor be navigated by a proxied page, and the page believes it
// is a top-level window.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	omni,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const docHeaders = [];
page.on('response', (r) => {
	if (
		r.request().resourceType() === 'document' &&
		r.url().includes('/stomp/html/')
	)
		docHeaders.push(r.headers());
});

ok('controller ready', (await page.textContent('#logMsg')) === 'Ready');
await page
	.waitForFunction(
		() =>
			window.controller &&
			window.controller.proxyOrigin &&
			window.controller.proxyOrigin !== location.origin,
		null,
		{ timeout: 15000 },
	)
	.then(
		() => ok('isolation mode active', true),
		() => ok('isolation mode active', false),
	);
ok(
	'controller frame is on the proxy origin',
	await page.evaluate(
		(proxy) =>
			[...document.querySelectorAll('iframe')].some((f) =>
				f.src.startsWith(`${proxy}stomp/controllerFrame.html`),
			),
		PROXY,
	),
);

const proxied = () =>
	page
		.frames()
		.filter((f) => f.url().startsWith(`${PROXY}stomp/html/`))
		.at(-1);
const waitFrame = async (pred, timeout = 40000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const frame = proxied();
		if (frame) {
			try {
				if (await frame.evaluate(pred)) return frame;
			} catch (error) {
				// navigating
			}
		}
		await sleep(250);
	}
	throw new Error('frame condition timeout');
};

await submitLanding(page, 'https://example.com');
const f1 = await waitFrame(() => document.title === 'Example Domain');
ok(
	'proxied page renders in a cross-origin frame',
	f1.url().startsWith(`${PROXY}stomp/html/`),
	f1.url().slice(0, 60),
);
ok(
	'frame is sandboxed without top navigation',
	await page.evaluate(() => {
		const s =
			document.querySelector('.frame:not(.hidden)').getAttribute('sandbox') ||
			'';
		return (
			s.includes('allow-same-origin') &&
			s.includes('allow-scripts') &&
			!s.includes('allow-top-navigation')
		);
	}),
);
ok(
	'frame carries no name a page could read',
	await page.evaluate(
		() => !document.querySelector('.frame:not(.hidden)').name,
	),
);
ok(
	'host cannot read the frame document',
	await page.evaluate(() => {
		try {
			return (
				document.querySelector('.frame:not(.hidden)').contentDocument === null
			);
		} catch (error) {
			return true;
		}
	}),
);
await sleep(1200);
ok(
	'address bar shows the real URL via the controller frame',
	(await omni(page)) === 'https://example.com/',
	await omni(page),
);
const csp = docHeaders.at(-1)?.['content-security-policy'] ?? null;
ok(
	'service worker sends frame-ancestors for the host and itself',
	csp === `frame-ancestors 'self' ${HOST.slice(0, -1)}`,
	String(csp),
);

// raw script in the frame (outside the rewriter): browser-level limits hold
const raw = await f1.evaluate(() => {
	const r = {};
	const t = (k, f) => {
		try {
			r[k] = f();
		} catch (e) {
			r[k] = 'threw ' + e.name;
		}
	};
	t('parentDoc', () => parent.document.title);
	t('topDoc', () => top.document.title);
	t('topNav', () => {
		top.location.href = 'https://example.org/';
		return 'allowed';
	});
	return r;
});
// `parent` is a property hook, so even raw script gets the page itself;
// `top` is unforgeable, so raw script sees the real, cross-origin host
ok(
	'raw script: parent resolves to the page itself, top document unreachable',
	raw.parentDoc === 'Example Domain' && raw.topDoc.startsWith('threw'),
	JSON.stringify(raw),
);
ok(
	'raw script: top navigation blocked by sandbox',
	raw.topNav === 'threw SecurityError',
	raw.topNav,
);
await sleep(500);
ok(
	'host page still on the host after escape attempts',
	page.url().startsWith(HOST),
	page.url(),
);

// the fixture's own script runs through the rewriter: the full spoof
await submitLanding(page, `${FIXTURE}escape.html`);
const f2 = await waitFrame(
	() =>
		document.title === 'escape fixture' &&
		document.getElementById('result').textContent.includes('topIsSelf'),
);
const r = JSON.parse(
	await f2.evaluate(() => document.getElementById('result').textContent),
);
ok(
	'page believes it is top (top/parent === window)',
	r.topIsSelf === true && r.parentIsSelf === true,
	JSON.stringify([r.topIsSelf, r.parentIsSelf]),
);
ok('frameElement is null', r.frameElement === null, String(r.frameElement));
ok(
	'ancestorOrigins is empty',
	r.ancestorOrigins === 0,
	String(r.ancestorOrigins),
);
ok(
	'referrer does not reveal the host',
	r.referrer === '',
	JSON.stringify(r.referrer),
);
ok('window.name is empty', r.name === '', JSON.stringify(r.name));
ok('outer size equals inner size', r.outerEqualsInner === true);
ok(
	'parent.document / top.document resolve to the page itself',
	r.parentDocTitle === 'escape fixture' && r.topDocTitle === 'escape fixture',
	JSON.stringify([r.parentDocTitle, r.topDocTitle]),
);
ok(
	'top.location.href is the real page URL',
	r.topLocationHref === `${FIXTURE}escape.html`,
	String(r.topLocationHref),
);
await page.evaluate(() =>
	document
		.querySelector('.frame:not(.hidden)')
		.contentWindow.postMessage('hello from host', '*'),
);
await sleep(500);
const r2 = JSON.parse(
	await f2.evaluate(() => document.getElementById('result').textContent),
);
ok(
	'host postMessage never reaches the page',
	r2.gotMessage === undefined,
	JSON.stringify(r2.gotMessage),
);

// `top.location = evil` from page script navigates the page itself, never the host
await submitLanding(page, `${FIXTURE}escape.html?nav=1`);
await waitFrame(() => document.title === 'Example Domain', 40000).then(
	() =>
		ok(
			'top.location = evil navigated the frame itself through the proxy',
			true,
		),
	() =>
		ok(
			'top.location = evil navigated the frame itself through the proxy',
			false,
		),
);
ok(
	'host page unaffected by top.location write',
	page.url().startsWith(HOST),
	page.url(),
);

// navigation controls still work across the origin boundary
await submitLanding(page, 'https://en.wikipedia.org/wiki/Web_proxy');
await waitFrame(() => !!document.querySelector('#firstHeading'));
await sleep(1500);
const beforeClick = await omni(page);
await proxied().evaluate((b) => {
	const a = [...document.links].find(
		(x) =>
			/^https:\/\/en\.wikipedia\.org\/wiki\/[^:#?]+$/.test(x.href) &&
			x.href !== b.split('#')[0] &&
			!/Main_Page/.test(x.href),
	);
	a.click();
}, beforeClick);
await page.waitForFunction(
	(b) => document.querySelector('#omni input').value !== b,
	beforeClick,
	{ timeout: 30000 },
);
const afterClick = await omni(page);
ok(
	'in-frame link updates the address bar',
	afterClick.startsWith('https://en.wikipedia.org/wiki/'),
	afterClick,
);
await page.click('#back');
await page
	.waitForFunction(
		(b) => document.querySelector('#omni input').value === b,
		beforeClick,
		{ timeout: 30000 },
	)
	.then(
		() => ok('back works through the controller frame', true),
		() => ok('back works through the controller frame', false),
	);
await page.click('#recents');
await page.waitForSelector('.cardLabel');
await sleep(500);
const urls = await page.evaluate(() =>
	[...document.querySelectorAll('.cardLabel .url')].map((t) => t.textContent),
);
ok(
	'tab switcher shows URLs from the controller frame',
	urls.some((t) => /wikipedia/i.test(t)),
	urls.join(' | '),
);

await done(browser, page.errors.filter((e) => !/404/.test(e)).slice(0, 3));
