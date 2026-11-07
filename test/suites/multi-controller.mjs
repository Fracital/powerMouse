// Two StompController instances on one scope (two host tabs) live side by
// side in the service worker: each has an address of its own under the
// scope (`/stomp/<id>/`), sees only its own requests, and the one that
// registered first keeps navigating after the second arrived. The same id
// passed twice still replaces (a reload that kept its id). The cookie jar is
// per scope, so a cookie one controller's frame set travels on the other's
// requests. A routed URL whose controller is gone (a closed tab) is answered
// by the newest live controller of the scope with the same codec; when none
// has that codec the host's error page shows kind `controller`. Same-origin
// mode on the demo origin, controllers of our own next to the demo's.
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

/** go(url) bounded: the first controller's route() never settles when the worker dropped it */
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

// ---- the same id twice replaces ---------------------------------------------

const twin = await page.evaluate(
	`(async (fixture) => {
	${GO}
	const out = {};
	const logA = [];
	const logB = [];
	const a = make({ id: 'twin', onRequest: (info) => logA.push(info.url) });
	await a.wait();
	const b = make({ id: 'twin', onRequest: (info) => logB.push(info.url) });
	await b.wait();
	out.ids = [a.id, b.id];
	// the worker dropped a: its calls never settle
	out.aRoute = await Promise.race([
		a.route(fixture + 'pages/hist-1.html').then(() => 'answered', (e) => String(e)),
		new Promise((resolve) => setTimeout(() => resolve('unanswered'), 2000)),
	]);
	const fb = show(b);
	out.b = await go(fb, fixture + 'pages/hist-1.html');
	out.bTitle = title(fb);
	await new Promise((resolve) => setTimeout(resolve, 500));
	out.logA = logA.length;
	out.logB = logB.map((url) => url.split('/').pop());
	return out;
})(${JSON.stringify(FIXTURE)})`,
);
ok(
	'the same id passed twice replaces the first controller',
	twin.ids?.[0] === 'twin' &&
		twin.ids?.[1] === 'twin' &&
		twin.aRoute === 'unanswered' &&
		twin.b === 'went' &&
		twin.bTitle === 'HIST 1' &&
		twin.logA === 0 &&
		twin.logB?.includes('hist-1.html'),
	JSON.stringify(twin),
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
	async ({ xor, b64 }) => {
		const load = async (url) => {
			const element = document.createElement('iframe');
			document.body.append(element);
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			element.src = url;
			await Promise.race([
				loaded,
				new Promise((resolve) => setTimeout(resolve, 20000)),
			]);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const win = element.contentWindow;
			return {
				title: win?.document?.title ?? 'unreadable',
				path: win?.location?.pathname ?? null,
				error: win?.stompError ?? null,
			};
		};
		return { xor: await load(xor), b64: await load(b64) };
	},
	{ xor: gone.xor, b64: gone.b64 },
);
const liveIds = [...(two.ids ?? []), 'twin'];
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

await done(
	browser,
	errors.filter((e) => !/404|Controller replaced/.test(e)).slice(0, 5),
);
