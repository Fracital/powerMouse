// Two StompController instances on one scope (two host tabs) live side by
// side in the service worker: each has an address of its own under the
// scope (`/stomp/<id>/`), sees only its own requests, and the one that
// registered first keeps navigating after the second arrived. The same id
// passed twice still replaces (a reload that kept its id): the replaced
// controller's calls reject with "Controller replaced" and a request in
// flight on its transport fails at once. The cookie jar is per scope, so a
// cookie one controller's frame set travels on the other's requests. A
// routed URL whose controller is gone (a closed tab) is answered by the
// newest live controller of the scope with the same codec; when none has
// that codec the host's error page shows kind `controller`; a URL of the
// shape before addresses (`/stomp/html/...`) goes to the newest controller.
// A controller whose tab is not fully active (the back/forward cache; stood
// in for by re-pointing the client the worker checks, since Playwright
// cannot drive the cache) has its documents answered elsewhere but keeps its
// registration and serves again when the tab is back. The inject bundles
// answer under an address too, for a worker of the previous build. Same-
// origin mode on the demo origin, controllers of our own next to the demo's.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
// one context for both host tabs: a page from browser.newPage() gets a
// context of its own, with its own service worker and storage
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);

/** shared page-side helpers; go(url) is bounded so a dead controller cannot hang the suite */
const GO = `
	const go = (frame, url, ms = 15000) =>
		Promise.race([
			frame.go(url).then(() => 'went'),
			new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
		]);
	const show = (controller) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		return controller.createFrame(element);
	};
	const title = (frame) => frame.element.contentDocument?.title ?? 'unreadable';
	// a bare (unmanaged) frame at a routed URL: where the worker sends it
	const load = async (url, ms = 20000) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const loaded = new Promise((resolve) =>
			element.addEventListener('load', resolve, { once: true }),
		);
		element.src = url;
		await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, ms))]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const win = element.contentWindow;
		try {
			return {
				title: win?.document?.title ?? 'unreadable',
				path: win?.location?.pathname ?? null,
				type: win?.document?.contentType ?? null,
				error: win?.stompError ?? null,
			};
		} catch (error) {
			// the frame left this origin: nothing of it can be read
			return { crossOrigin: String(error), src: element.src };
		}
	};
	const { StompController } = await import('/stomp/controller.mjs');
	const make = (extra = {}) =>
		new StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: window.controller.directory.pathname,
			codec: 'xor',
			errorPage: '/examples/error.html',
			...extra,
		});
`;

// ---- two controllers, one scope ---------------------------------------------

const two = await page.evaluate(
	`(async (fixture) => {
	${GO}
	const out = {};
	const first = window.controller;
	const log1 = [];
	const log2 = [];
	first.addEventListener('request', (event) => log1.push(event.detail.url));
	const f1 = show(first);
	out.firstBefore = await go(f1, fixture + 'pages/hist-1.html');
	out.firstTitleBefore = title(f1);

	const second = make({ onRequest: (info) => log2.push(info.url) });
	await second.wait();
	window.__second = second;
	const f2 = show(second);
	out.second = await go(f2, fixture + 'pages/hist-2.html');
	out.secondTitle = title(f2);
	out.secondURL = f2.element.contentWindow.location.pathname;

	// the first controller is still served after the second registered
	out.firstAfter = await go(f1, fixture + 'pages/hist-2.html');
	out.firstTitleAfter = title(f1);
	out.firstURL = f1.element.contentWindow.location.pathname;
	await new Promise((resolve) => setTimeout(resolve, 500));
	out.log1 = log1.map((url) => url.split('/').pop());
	out.log2 = log2.map((url) => url.split('/').pop());

	out.ids = [first.id, second.id];
	out.scopes = [first.directory.pathname, second.directory.pathname];
	out.addresses = [first.config.directory, second.config.directory];
	out.configScopes = [first.config.scope, second.config.scope];
	out.routed = await second.route('https://example.com/');
	try {
		new StompController({
			serviceworker: first.serviceworker,
			transport: first.transport,
			directory: first.directory.pathname,
			id: 'not valid!',
		});
		out.badId = 'constructed';
	} catch (error) {
		out.badId = error.constructor.name;
	}
	// the inject bundle asked for under an address (a shell from a worker
	// of the build before addresses) is the scope's file
	out.asset = await load(second.config.directory + 'injectDocument.js');
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
ok(
	'the first frame still navigates after the second controller registered',
	two.firstBefore === 'went' &&
		two.firstTitleBefore === 'HIST 1' &&
		two.firstAfter === 'went' &&
		two.firstTitleAfter === 'HIST 2',
	JSON.stringify([
		two.firstBefore,
		two.firstTitleBefore,
		two.firstAfter,
		two.firstTitleAfter,
	]),
);
ok(
	'the second controller serves its own frame',
	two.second === 'went' && two.secondTitle === 'HIST 2',
	JSON.stringify([two.second, two.secondTitle]),
);
ok(
	'each controller sees only its own requests',
	two.log1?.includes('hist-1.html') &&
		two.log1?.includes('hist-2.html') &&
		two.log2?.includes('hist-2.html') &&
		!two.log2?.includes('hist-1.html') &&
		two.log1.length === 2 &&
		two.log2.length === 1,
	JSON.stringify([two.log1, two.log2]),
);
ok(
	'controller.id is minted (8 chars) and controller.directory stays the scope',
	Array.isArray(two.ids) &&
		two.ids.every((id) => /^[A-Za-z0-9_-]{8}$/.test(id)) &&
		two.ids[0] !== two.ids[1] &&
		two.scopes?.every((scope) => scope === '/stomp/'),
	JSON.stringify([two.ids, two.scopes]),
);
ok(
	'config.directory is the address under the scope, config.scope the scope',
	two.addresses?.[0] === `/stomp/${two.ids?.[0]}/` &&
		two.addresses?.[1] === `/stomp/${two.ids?.[1]}/` &&
		two.configScopes?.every((scope) => scope === '/stomp/'),
	JSON.stringify([two.addresses, two.configScopes]),
);
ok(
	'routed URLs and frame URLs carry the address',
	typeof two.routed === 'string' &&
		two.routed.startsWith(`${PROXY}stomp/${two.ids?.[1]}/html/`) &&
		two.secondURL?.startsWith(`/stomp/${two.ids?.[1]}/html/`) &&
		two.firstURL?.startsWith(`/stomp/${two.ids?.[0]}/html/`),
	JSON.stringify([two.routed, two.secondURL, two.firstURL]),
);
ok(
	'an id outside [A-Za-z0-9_-]{1,32} is a TypeError',
	two.badId === 'TypeError',
	String(two.badId),
);
ok(
	"the inject bundle under an address is served from the scope (a previous build's shell)",
	two.asset?.path === '/stomp/injectDocument.js' &&
		two.asset?.type === 'text/javascript',
	JSON.stringify(two.asset),
);

// ---- the same id twice replaces ---------------------------------------------

const twin = await page.evaluate(
	`(async (fixture) => {
	${GO}
	const out = {};
	const logA = [];
	const logB = [];
	const a = make({ id: 'twin', onRequest: (info) => logA.push(info.url) });
	await a.wait();
	const fa = show(a);
	out.a = await go(fa, fixture + 'pages/hist-1.html');
	// a request in flight on a's transport when b takes the id: the fixture
	// answers /slow after five seconds, the worker's bound is a minute
	const started = Date.now();
	const slow = fa.element.contentWindow
		.fetch('/slow')
		.then((response) => ({ status: response.status }), (error) => ({ error: String(error) }))
		.then((result) => ({ ...result, ms: Date.now() - started }));
	// b only once the fixture has the request: made sooner, b's init can
	// reach the worker before the frame's fetch does, which then routes to b
	// (the address is b's by then) and is served normally after five seconds
	for (let i = 0; i < 100; i++) {
		const served = await fa.element.contentWindow
			.fetch('/requests')
			.then((response) => response.json(), () => []);
		if (served.includes('/slow')) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const b = make({ id: 'twin', onRequest: (info) => logB.push(info.url) });
	await b.wait();
	out.ids = [a.id, b.id];
	out.aRoute = await Promise.race([
		a.route(fixture + 'pages/hist-1.html').then(() => 'answered', (e) => String(e)),
		new Promise((resolve) => setTimeout(() => resolve('unanswered'), 5000)),
	]);
	out.aCookies = await a.cookies.get(fixture).then(() => 'answered', (e) => String(e));
	out.slow = await slow;
	const fb = show(b);
	out.b = await go(fb, fixture + 'pages/hist-1.html');
	out.bTitle = title(fb);
	// a's frame lives at the address b now owns: b serves and logs it
	const aLogged = logA.length;
	out.afterReplaced = await fa.element.contentWindow
		.fetch('/echo-headers')
		.then((response) => response.status, (error) => String(error));
	// b does not know a's frame: its report waits the attribution grace first
	await new Promise((resolve) => setTimeout(resolve, 2500));
	out.aLoggedMore = logA.length - aLogged;
	out.logB = logB.map((url) => url.split('/').pop());
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
ok(
	'the same id passed twice replaces the first controller, whose calls reject with "Controller replaced"',
	twin.ids?.[0] === 'twin' &&
		twin.ids?.[1] === 'twin' &&
		twin.aRoute === 'Error: Controller replaced' &&
		twin.aCookies === 'Error: Controller replaced' &&
		twin.b === 'went' &&
		twin.bTitle === 'HIST 1' &&
		twin.afterReplaced === 200 &&
		twin.aLoggedMore === 0 &&
		twin.logB?.includes('echo-headers') &&
		twin.logB?.includes('hist-1.html'),
	JSON.stringify(twin),
);
ok(
	"a request in flight on the replaced controller's transport fails at once",
	twin.a === 'went' &&
		twin.slow &&
		twin.slow.status !== 200 &&
		twin.slow.ms < 4000,
	JSON.stringify(twin.slow),
);

// ---- the cookie jar is shared by the scope ----------------------------------

const jar = await page.evaluate(
	`(async (fixture) => {
	${GO}
	const out = {};
	const first = window.controller;
	const second = window.__second;
	const fixtureOrigin = new URL(fixture).origin;
	await first.cookies.clear(fixtureOrigin);
	// cookie-set.html answers with Set-Cookie: ma=1 and sess=1
	const f2 = show(second);
	out.set = await go(f2, fixture + 'pages/cookie-set.html');
	const f1 = show(first);
	out.show = await go(f1, fixture + 'pages/cookie-show.html');
	out.cookie = f1.element.contentDocument?.getElementById('c')?.textContent;
	out.sent = await f1.element.contentWindow
		.fetch('/echo-headers')
		.then((response) => response.json())
		.then((headers) => headers.cookie ?? null);
	out.jar1 = await first.cookies.get(fixture + 'pages/x');
	out.jar2 = await second.cookies.get(fixture + 'pages/x');
	await first.cookies.clear(fixtureOrigin);
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
ok(
	"a cookie set through one controller's frame is sent from the other's",
	jar.set === 'went' &&
		jar.show === 'went' &&
		/\bma=1\b/.test(jar.cookie ?? '') &&
		/\bma=1\b/.test(jar.sent ?? '') &&
		jar.jar1 === jar.jar2 &&
		/\bma=1\b/.test(jar.jar1 ?? ''),
	JSON.stringify(jar),
);

// ---- a controller whose tab is not fully active --------------------------------

// The worker serves a document at an address only while the client that
// registered the controller is fully active; a tab in the back/forward
// cache is not. Playwright cannot park a page there, so the suite re-points
// the client the worker checks (an internal message) to one that does not
// exist, then back to this page.
const parked = await page.evaluate(
	`(async (fixture) => {
	${GO}
	const CLIENT = '$stomp$controllerClient';
	const out = {};
	const c = make({ id: 'parked' });
	await c.wait();
	const fc = show(c);
	out.before = await go(fc, fixture + 'pages/hist-1.html');
	const url = await c.route(fixture + 'pages/hist-2.html');
	c.serviceworker.postMessage({
		[CLIENT]: { directory: c.config.directory, client: 'no-such-client' },
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	out.away = await load(url);
	// the tab is back: the sender's own client again
	c.serviceworker.postMessage({ [CLIENT]: { directory: c.config.directory } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	out.back = await load(url);
	out.route = await c.route(fixture + 'pages/hist-1.html').then(() => 'answered', (e) => String(e));
	out.again = await go(fc, fixture + 'pages/hist-2.html');
	out.againPath = fc.element.contentWindow.location.pathname;
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
ok(
	'a document for a controller whose tab is not active is answered by another live controller',
	parked.before === 'went' &&
		parked.away?.title === 'HIST 2' &&
		typeof parked.away?.path === 'string' &&
		!parked.away.path.startsWith('/stomp/parked/'),
	JSON.stringify(parked.away),
);
ok(
	'the controller keeps its registration and serves again once its tab is back',
	parked.back?.title === 'HIST 2' &&
		parked.back?.path?.startsWith('/stomp/parked/html/') &&
		parked.route === 'answered' &&
		parked.again === 'went' &&
		parked.againPath?.startsWith('/stomp/parked/html/'),
	JSON.stringify([parked.back, parked.route, parked.again, parked.againPath]),
);

// ---- an address whose controller is gone ------------------------------------

// another host tab in the same context: two controllers (xor like the
// demo's, and base64, which nothing else on this origin uses), a routed URL
// from each, then the tab closes and takes them with it
const other = await context.newPage();
await other.goto(PROXY);
await other.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const gone = await other.evaluate(
	`(async (fixture) => {
	${GO}
	const xor = make({ id: 'gone-xor' });
	const b64 = make({ id: 'gone-b64', codec: 'base64' });
	await xor.wait();
	await b64.wait();
	const out = {
		xor: await xor.route(fixture + 'pages/hist-2.html'),
		b64: await b64.route(fixture + 'pages/hist-1.html'),
	};
	// the frame actually loaded once, so the worker created both servers
	const f = show(b64);
	out.loaded = await go(f, fixture + 'pages/hist-1.html');
	out.loadedTitle = title(f);
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
await other.close();
await sleep(500);
ok(
	'the other tab minted routed URLs under its own addresses',
	gone.xor?.startsWith(`${PROXY}stomp/gone-xor/html/`) &&
		gone.b64?.startsWith(`${PROXY}stomp/gone-b64/html/`) &&
		gone.loaded === 'went' &&
		gone.loadedTitle === 'HIST 1',
	JSON.stringify(gone),
);

const stale = await page.evaluate(
	`(async ({ xor, b64 }) => {
	${GO}
	return {
		xor: await load(xor),
		b64: await load(b64),
		// the shape before addresses: /stomp/html/<encoded>
		legacy: await load(xor.replace('/stomp/gone-xor/', '/stomp/')),
	};
})(${JSON.stringify({ xor: gone.xor, b64: gone.b64 })})`,
);
const liveIds = [...(two.ids ?? []), 'twin', 'parked'];
ok(
	'a routed URL with an unknown id loads through a live controller of the same codec',
	stale.xor?.title === 'HIST 2' &&
		liveIds.some((id) => stale.xor?.path?.startsWith(`/stomp/${id}/html/`)),
	JSON.stringify(stale.xor),
);
ok(
	'with no live controller of its codec the host error page shows kind controller',
	stale.b64?.error?.kind === 'controller' &&
		stale.b64?.title === 'Page unavailable' &&
		stale.b64?.path?.startsWith('/stomp/gone-b64/html/'),
	JSON.stringify(stale.b64),
);
ok(
	'a URL of the shape before addresses loads through the newest live controller',
	stale.legacy?.title === 'HIST 2' &&
		liveIds.some((id) => stale.legacy?.path?.startsWith(`/stomp/${id}/html/`)),
	JSON.stringify(stale.legacy),
);

await done(browser, errors.slice(0, 5));
