// Same-origin requests started in one tick all complete. Two epoxy bugs lost
// some of them (measured 2026-11-07, fixed by deploy/epoxy/patches):
// - a cold transport: every request that finds the transport not ready calls
//   init(), and two concurrent epoxy inits instantiated the wasm module twice;
//   the client built on the first instance never answered (HUNG/went).
// - a connection the server closed while idle (node's keep-alive timeout is
//   5 s): wisp's poll_close never sent its close event, so hyper's pool kept
//   the dead connection and handed it to the next request, which hung.
// Each round is a fresh controller in its own context, so its first requests
// race the transport's init: N navigations of N frames at once, N fetches at
// once from a proxied page, the same again after the fixture has closed the
// idle connections, and (worker host) N raw transport requests at once with
// no STomp in the path.
// libcurl is the control, on a real site: it answers nothing for a loopback
// server through wisp (curl error 52, see transport-worker), so against the
// fixture its frames load the error page. That round needs the internet and
// stays out under SKIP_NETWORK=1, like the suites run.mjs lists.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const COUNTS = [2, 4, 8];
const EPOXY = '/epoxy/index.mjs';
const LIBCURL = '/libcurl/index.mjs';
// longer than the fixture's keep-alive timeout (node's default, 5 s)
const IDLE_MS = 6500;
const TIMEOUT_MS = 10000;
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

// the fixture's walk pages; a query per request keeps the HTTP cache out
const fixtureSite = {
	page: (n, i) => {
		const k = (i % 5) + 1;
		return [`${FIXTURE}pages/walk-${k}.html?n${n}-${i}`, `WALK ${k}`];
	},
	fetch: (tag) => `${FIXTURE}pages/echo.json?${tag}`,
	idle: true,
};
const realSite = {
	page: (n, i) => [`https://example.com/?n${n}-${i}`, 'Example Domain'],
	fetch: (tag) => `https://example.com/?${tag}`,
	idle: false,
};

const browser = await launch();
const errors = [];

/** a fresh controller in its own context; `run` is evaluated next to it */
async function round(module, host, run, args = {}) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	try {
		return await page.evaluate(run, {
			module,
			host,
			timeoutMs: TIMEOUT_MS,
			...args,
		});
	} catch (error) {
		return { error: String(error).slice(0, 300) };
	} finally {
		await context.close();
	}
}

/** navigations and page fetches through the whole proxy */
const proxied = async ({ module, host, timeoutMs, pages, fetches, idleMs }) => {
	const { StompController } = await import('/stomp/controller.mjs');
	const registration = await StompController.register('/stomp/');
	const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
	const controller = new StompController({
		serviceworker: registration,
		transport: { module, options: [{ wisp }], host },
		directory: '/stomp/',
		codec: 'xor',
	});
	await controller.wait();
	const hung = (ms) =>
		new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms));
	const since = (t0) => Math.round(performance.now() - t0);

	const t0 = performance.now();
	const elements = [];
	const navigations = await Promise.all(
		pages.map(([url, title]) => {
			const element = document.createElement('iframe');
			document.body.append(element);
			elements.push(element);
			const frame = controller.createFrame(element);
			return Promise.race([
				frame.go(url).then(() => {
					const got = element.contentDocument?.title;
					return got === title ? `ok@${since(t0)}` : `title ${got}`;
				}),
				hung(timeoutMs),
			]).catch((error) => String(error).slice(0, 80));
		}),
	);

	const win = elements[0].contentWindow;
	const fetchAll = async (urls) => {
		const t1 = performance.now();
		return Promise.all(
			urls.map((url) =>
				Promise.race([
					Reflect.apply(win.fetch, win, [url]).then(async (response) => {
						await response.arrayBuffer();
						return response.status === 200
							? `ok@${since(t1)}`
							: `status ${response.status}`;
					}),
					hung(timeoutMs),
				]).catch((error) => String(error).slice(0, 80)),
			),
		);
	};
	const result = { navigations, fetches: await fetchAll(fetches[0]) };
	if (idleMs) {
		await new Promise((resolve) => setTimeout(resolve, idleMs));
		result.afterIdle = await fetchAll(fetches[1]);
	}
	return result;
};

/** raw transport requests from the host page, no service worker or page */
const raw = async ({ module, host, timeoutMs, urls }) => {
	const { StompController } = await import('/stomp/controller.mjs');
	const registration = await StompController.register('/stomp/');
	const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
	const controller = new StompController({
		serviceworker: registration,
		transport: { module, options: [{ wisp }], host },
		directory: '/stomp/',
		codec: 'xor',
	});
	await controller.wait();
	const t0 = performance.now();
	return Promise.all(
		urls.map((url) =>
			Promise.race([
				controller.transport
					.request(new URL(url), 'GET', null, [], undefined)
					.then(async (response) => {
						await new Response(response.body).arrayBuffer();
						return response.status === 200
							? `ok@${Math.round(performance.now() - t0)}`
							: `status ${response.status}`;
					}),
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), timeoutMs)),
			]).catch((error) => String(error).slice(0, 80)),
		),
	);
};

const allOk = (list) =>
	Array.isArray(list) &&
	list.length > 0 &&
	list.every((r) => r.startsWith('ok@'));

async function proxiedRound(label, module, host, n, site) {
	const indexes = Array.from({ length: n }, (_, i) => i);
	const result = await round(module, host, proxied, {
		pages: indexes.map((i) => site.page(n, i)),
		fetches: ['f', 'idle'].map((tag) =>
			indexes.map((i) => site.fetch(`${tag}${n}-${i}`)),
		),
		idleMs: site.idle ? IDLE_MS : 0,
	});
	ok(
		`${label}: ${n} same-origin navigations started at once on a cold transport all load`,
		allOk(result.navigations),
		JSON.stringify(result.navigations ?? result),
	);
	ok(
		`${label}: ${n} same-origin fetches at once from a proxied page all answer`,
		allOk(result.fetches),
		JSON.stringify(result.fetches ?? result),
	);
	if (site.idle)
		ok(
			`${label}: ${n} fetches at once after the origin closed the idle connections all answer`,
			allOk(result.afterIdle),
			JSON.stringify(result.afterIdle ?? result),
		);
}

for (const host of ['worker', 'page'])
	for (const n of COUNTS) {
		await proxiedRound(`epoxy (${host})`, EPOXY, host, n, fixtureSite);
		if (host === 'worker') {
			const requests = await round(EPOXY, host, raw, {
				urls: Array.from({ length: n }, (_, i) =>
					fixtureSite.fetch(`raw${n}-${i}`),
				),
			});
			ok(
				`epoxy (${host}): ${n} raw transport requests at once on a cold transport all answer`,
				allOk(requests),
				JSON.stringify(requests),
			);
		}
	}

if (SKIP_NETWORK) console.log('SKIP the real-site rounds (SKIP_NETWORK=1)');
else
	for (const [name, module] of [
		['epoxy', EPOXY],
		['libcurl', LIBCURL],
	])
		for (const n of COUNTS)
			await proxiedRound(
				`${name} (worker, example.com)`,
				module,
				'worker',
				n,
				realSite,
			);

await done(browser, errors);
