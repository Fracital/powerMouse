// Proxy-ception: the demo loads its own origin through itself, and the inner
// demo is one more proxied site, contained like any other. Both modes: the
// same-origin page (127.0.0.1) loads 127.0.0.1, the isolated one (localhost,
// its proxy on 127.0.0.1) loads localhost, whose own controller frame is
// then of the outer proxy's origin. In each:
// - the inner demo's homepage renders and its controller is Ready;
// - the inner STomp registers its service worker, an emulated one: the
//   browser's own registrations of the proxy origin stay the outer's one;
// - the inner STomp proxies a fixture page (its routes, its id, not the
//   outer's) and the page reads what it reads natively: its URL, origin,
//   eval and Function (the inner rewriter's first task), cookies, storage,
//   a fetch, a blob: URL, a frame, a dedicated worker (and where its error
//   is reported) and a shared worker;
// - storage is apart both ways: localStorage and cookies the host's page
//   set are not the inner demo's, and the inner demo's are not the real
//   origin's;
// - the inner demo cannot reach the outer service worker (a request for the
//   outer address's whoami is the server's answer, not the worker's), its
//   config (the outer codec key in its IndexedDB) or a real-origin cookie.
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

const target = `${FIXTURE}pages/proxyception.html`;
// what the fixture page reads, compared with its native load
const KEYS = [
	'href',
	'origin',
	'windowOrigin',
	'documentURL',
	'evalHref',
	'functionHref',
	'topIsSelf',
	'cookie',
	'storage',
	'fetch',
	'blobOrigin',
	'blobText',
	'frameTitle',
	'frameHref',
	'worker',
	'workerError',
	'shared',
	'error',
];

const depth = (frame) => {
	let d = 0;
	for (let f = frame.parentFrame(); f; f = f.parentFrame()) d++;
	return d;
};
const within = (frame, ancestor) => {
	for (let f = frame.parentFrame(); f; f = f.parentFrame())
		if (f === ancestor) return true;
	return false;
};

/** poll `fn` until it answers something truthy, or null after `ms` */
async function until(fn, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			// a frame between documents: try again
		}
		await sleep(500);
	}
	return null;
}

/** in a frame of the real proxy origin: its service worker registrations and the codec key in its IndexedDB */
const realState = () =>
	(async () => {
		const registrations = (await navigator.serviceWorker.getRegistrations())
			.length;
		const key = await new Promise((resolve) => {
			const open = indexedDB.open('stompConfig');
			open.onerror = () => resolve(null);
			open.onsuccess = () => {
				try {
					const get = open.result
						.transaction('consts')
						.objectStore('consts')
						.get('codecKey:xor');
					get.onsuccess = () => resolve(get.result ?? null);
					get.onerror = () => resolve(null);
				} catch (error) {
					resolve(null);
				}
			};
		});
		return { registrations, key, cookie: document.cookie };
	})();

const browser = await launch();
const native = await (async () => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(target);
	const value = await until(
		() => page.evaluate(() => window.__pc?.done && window.__pc),
		20000,
	);
	await context.close();
	return value;
})();
ok(
	'natively, the fixture page reports (sanity)',
	native?.done && native.href === target && !native.error,
	JSON.stringify(native),
);

const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const proxyOrigin = new URL(PROXY).origin;
	// a fresh browser profile each, so one mode's storage is not the other's
	const context = await browser.newContext();
	await context.addCookies([
		{ name: 'outer', value: 'real', url: base },
		{ name: 'outer', value: 'real', url: PROXY },
	]);
	const page = await openDemo(context, base);
	errors.push(...page.errors);
	const outerId = await page.evaluate(() => window.controller.id);
	await page.evaluate(() => localStorage.setItem('outer-only', 'real'));
	// the real proxy origin's own document: the host page, or the isolated
	// host's controller frame
	const realFrame = () =>
		mode === 'same-origin'
			? page.mainFrame()
			: page.frames().find(
					(f) =>
						depth(f) === 1 &&
						// asked for by its hash (`controllerFrame.html?<hash>&script=...`)
						new URL(f.url()).pathname.endsWith('/stomp/controllerFrame.html'),
				);
	const before = await realFrame().evaluate(realState);
	const unroute = (url) =>
		page.evaluate((u) => window.controller.unroute(u), url).catch(() => null);

	await submitLanding(page, base);
	// the outer tab that shows the inner demo
	const innerDemo = await until(async () => {
		for (const f of page.frames())
			if (depth(f) === 1 && (await unroute(f.url())) === base) return f;
		return null;
	}, 30000);
	// the inner controller tunnels its transport through the outer one: give
	// its boot the patience a single transport gets elsewhere
	const status = await until(
		() =>
			innerDemo
				?.evaluate(() => document.getElementById('logMsg')?.textContent || '')
				.then((s) => /^(Ready|Error)/.test(s) && s),
		90000,
	);
	// (the frame was found by its route, which the outer controller reads
	// as the demo's own URL)
	const home = await innerDemo
		?.evaluate(() => ({
			title: document.title,
			landing: !!document.getElementById('landing'),
			commits: document.querySelectorAll('#commits li, #commits a').length,
		}))
		.catch((error) => String(error));
	ok(
		`${mode}: the inner demo's homepage renders and its controller is Ready`,
		status === 'Ready' && home?.landing && /powerMouse/i.test(home.title),
		JSON.stringify({ status, home }),
	);
	if (status !== 'Ready') {
		await context.close();
		continue;
	}

	// the inner STomp's own real-origin document: the inner demo itself, or
	// the isolated inner demo's controller frame (of the outer proxy origin)
	const innerReal = await until(async () => {
		if (mode === 'same-origin') return innerDemo;
		for (const f of page.frames())
			if (
				within(f, innerDemo) &&
				// asked for by its hash (`controllerFrame.html?<hash>&script=...`)
				(await unroute(f.url()))?.split('?')[0] ===
					`${proxyOrigin}/stomp/controllerFrame.html`
			)
				return f;
		return null;
	}, 10000);
	const inner = await innerReal
		?.evaluate(() =>
			navigator.serviceWorker.getRegistrations().then((list) => ({
				scopes: list.map((r) => r.scope),
				active: list.map((r) => r.active?.scriptURL ?? null),
			})),
		)
		.catch((error) => String(error));
	const after = await realFrame().evaluate(realState);
	ok(
		`${mode}: the inner STomp registers its service worker, an emulated one`,
		Array.isArray(inner?.scopes) &&
			inner.scopes.includes(`${proxyOrigin}/stomp/`) &&
			inner.active.some((url) => /\/stomp\/serviceWorker\.js/.test(url)) &&
			before.registrations === 1 &&
			after.registrations === 1,
		JSON.stringify({
			inner,
			real: [before.registrations, after.registrations],
		}),
	);

	// the inner demo proxies the fixture page
	await innerDemo.evaluate((u) => {
		const form = document.getElementById('mainForm');
		form.url.value = u;
		form.requestSubmit();
	}, target);
	const innermost = await until(async () => {
		for (const f of page.frames()) {
			if (!within(f, innerDemo)) continue;
			const real = await unroute(f.url());
			// a route of the inner STomp: on the proxy origin, or with the
			// site pool on one of the inner's own slots (it reads the same
			// config, so it runs a pool of its own on the same ports of the
			// proxy's host)
			if (
				real &&
				new URL(real).hostname === new URL(proxyOrigin).hostname &&
				/^\/stomp\/[\w-]+\/html\//.test(new URL(real).pathname) &&
				(await f.evaluate(() => window.__pc?.done))
			)
				return { frame: f, real };
		}
		return null;
	}, 90000);
	const read = innermost
		? await innermost.frame.evaluate(() => window.__pc)
		: null;
	const innerId = innermost
		? /\/stomp\/([\w-]+)\//.exec(innermost.real)?.[1]
		: null;
	ok(
		`${mode}: the inner STomp proxies the fixture page through its own routes`,
		!!read && !!innerId && innerId !== outerId,
		JSON.stringify({ real: innermost?.real, outerId }),
	);
	const differ = read
		? KEYS.filter(
				(key) => JSON.stringify(read[key]) !== JSON.stringify(native?.[key]),
			)
		: KEYS;
	ok(
		`${mode}: the page proxied by the inner STomp reads what it reads natively`,
		differ.length === 0,
		JSON.stringify(
			Object.fromEntries(
				differ.map((key) => [
					key,
					{ native: native?.[key], proxied: read?.[key] },
				]),
			),
		),
	);

	// storage apart, both ways
	const innerView = await innerDemo.evaluate(() => {
		const seen = {
			outerOnly: localStorage.getItem('outer-only'),
			cookie: document.cookie,
		};
		localStorage.setItem('inner-only', 'emulated');
		document.cookie = 'inner=emulated; path=/';
		return seen;
	});
	const hostView = await page.evaluate(() => ({
		innerOnly: localStorage.getItem('inner-only'),
		outerOnly: localStorage.getItem('outer-only'),
	}));
	const realCookies = (await context.cookies()).map((c) => c.name);
	ok(
		`${mode}: the inner demo's storage and cookies are apart from the real origin's, both ways`,
		innerView.outerOnly === null &&
			!/(^|; )outer=/.test(innerView.cookie) &&
			hostView.innerOnly === null &&
			hostView.outerOnly === 'real' &&
			!realCookies.includes('inner'),
		JSON.stringify({ innerView, hostView, realCookies }),
	);

	// the outer service worker, its config and a real-origin cookie are out
	// of reach: the outer address's whoami is the server's answer (404) to
	// the inner demo, the worker's (a client id, as JSON) to a frame of the
	// real origin (a navigation, which the worker takes whatever the page)
	const whoami = `/stomp/${outerId}/whoami`;
	const outerAnswer = await realFrame().evaluate(
		(path) =>
			new Promise((resolve) => {
				const frame = document.createElement('iframe');
				frame.style.display = 'none';
				frame.onload = () => {
					const text = frame.contentDocument?.body?.textContent ?? '';
					frame.remove();
					try {
						JSON.parse(text);
						resolve(200);
					} catch (error) {
						resolve(text.slice(0, 60));
					}
				};
				frame.src = path;
				document.body.append(frame);
			}),
		whoami,
	);
	const serverAnswer = (await fetch(`${proxyOrigin}${whoami}`)).status;
	const innerAnswer = await innerReal.evaluate(
		(path) =>
			fetch(path).then(
				(r) => r.status,
				(error) => String(error),
			),
		whoami,
	);
	const innerState = await innerReal.evaluate(realState).catch(String);
	ok(
		`${mode}: the inner demo cannot reach the outer service worker, its config or a real-origin cookie`,
		outerAnswer === 200 &&
			innerAnswer === serverAnswer &&
			innerAnswer !== 200 &&
			typeof before.key === 'string' &&
			innerState?.key !== before.key &&
			!/(^|; )outer=/.test(innerState?.cookie ?? ''),
		JSON.stringify({
			outerAnswer,
			serverAnswer,
			innerAnswer,
			outerKey: before.key && `${before.key.slice(0, 4)}...`,
			innerKey: innerState?.key && `${String(innerState.key).slice(0, 4)}...`,
			innerCookie: innerState?.cookie,
		}),
	);
	errors.push(...page.errors);
	await context.close();
}
await done(browser, errors);
