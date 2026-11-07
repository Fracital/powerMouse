// The host's error page: a controller given `errorPage` shows that document,
// under the frame's URL and with the failure's status, for a document the
// proxy itself failed to produce (a blocked rule, the refusal to proxy its own
// origin, an unreachable origin), with globalThis.stompError describing the
// failure; the request report carries `kind`. It is never cached: once the
// rule is gone the real page loads. Same-origin mode, a controller of our own.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const proxy = new URL(PROXY).origin;
const result = await page.evaluate(
	async ({ fixture, proxy }) => {
		const log = [];
		const controller = new window.StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: window.controller.directory.pathname,
			codec: 'xor',
			errorPage: '/examples/error.html',
			onRequest: (info) => log.push(info),
			rules: [
				{ match: { url: 'http://*:*/pages/hist-1.html' }, action: 'block' },
			],
		});
		await controller.wait();
		const show = async (url) => {
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(url);
			await loaded;
			await new Promise((resolve) => setTimeout(resolve, 300));
			const doc = element.contentDocument;
			return {
				url: frame.url,
				title: doc?.title ?? 'unreadable',
				heading: doc?.getElementById('title')?.textContent ?? null,
				error: doc?.defaultView?.stompError ?? null,
				retry: !!doc?.getElementById('retry'),
				element,
			};
		};
		const out = {};
		const blocked = await show(`${fixture}pages/hist-1.html`);
		out.blocked = { ...blocked, element: undefined };
		out.refused = { ...(await show(`${proxy}/`)), element: undefined };
		out.transport = {
			...(await show('http://127.0.0.1:9/down.html')),
			element: undefined,
		};
		// the host's page never reports a client id, so the worker reports the
		// failure without one and the controller does not hold it
		await new Promise((resolve) => setTimeout(resolve, 500));
		out.kinds = log
			.filter((info) => info.kind)
			.map((info) => [info.kind, info.status, info.url.split('/').pop()]);
		// the rule gone, the same frame reloads to the real page: nothing cached
		await controller.setRules([]);
		const reloaded = new Promise((resolve) =>
			blocked.element.addEventListener('load', resolve, { once: true }),
		);
		blocked.element.contentWindow.location.reload();
		await reloaded;
		out.afterRetry = blocked.element.contentDocument?.title ?? 'unreadable';
		return out;
	},
	{ fixture: FIXTURE, proxy },
);
const shows = (shown, kind, status) =>
	shown?.heading !== null &&
	shown?.retry === true &&
	shown?.error?.kind === kind &&
	shown?.error?.status === status &&
	typeof shown?.error?.error === 'string';
ok(
	'a blocked navigation shows the host page with stompError naming the real URL',
	shows(result.blocked, 'blocked', 403) &&
		// the host page is not an injected page: frame.url has nothing to read
		result.blocked.url === null &&
		result.blocked.error.url === `${FIXTURE}pages/hist-1.html`,
	JSON.stringify(result.blocked),
);
ok(
	'the refusal to proxy the proxy origin shows the host page',
	shows(result.refused, 'refused', 403),
	JSON.stringify(result.refused),
);
ok(
	'an unreachable origin shows the host page with the transport error',
	shows(result.transport, 'transport', 502),
	JSON.stringify(result.transport),
);
ok(
	'the request reports carry the kind',
	JSON.stringify(result.kinds) ===
		JSON.stringify([
			['blocked', 403, 'hist-1.html'],
			['refused', 403, ''],
			['transport', 0, 'down.html'],
		]),
	JSON.stringify(result.kinds),
);
ok(
	'the error page is not cached: a retry after the rule is gone loads the real page',
	result.afterRetry === 'HIST 1',
	JSON.stringify(result.afterRetry),
);
await done(browser);
