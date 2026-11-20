// The host's error page: a controller given `errorPage` shows that document,
// under the frame's URL and with the failure's status, for a document the
// proxy itself failed to produce (a blocked rule, an unreachable origin), with
// globalThis.stompError describing the failure; the request report carries
// `kind`. It is never cached: once the rule is gone the real page loads. A
// page of the proxy's own origin is no failure: it loads as the page it is
// (docs/proxyception.md). Same-origin mode, a controller of our own.
import { done, FIXTURE, HOST, launch, ok, PROXY } from '../lib.mjs';

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
		// a deployment that renames the global (names.error): the page reads it
		// under that name and nothing is written under the default
		{
			const renamed = new window.StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: window.controller.directory.pathname,
				codec: 'xor',
				errorPage: '/examples/error.html',
				names: { error: 'proxyFailure' },
				rules: [
					{ match: { url: 'http://*:*/pages/hist-1.html' }, action: 'block' },
				],
			});
			await renamed.wait();
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = renamed.createFrame(element);
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(`${fixture}pages/hist-1.html`);
			await loaded;
			await new Promise((resolve) => setTimeout(resolve, 300));
			const win = element.contentDocument?.defaultView;
			out.renamed = {
				renamed: win?.proxyFailure ?? null,
				defaultName: win?.stompError ?? null,
			};
		}
		const blocked = await show(`${fixture}pages/hist-1.html`);
		out.blocked = { ...blocked, element: undefined };
		// the proxy's own page, proxied: the demo, as it reads natively (this
		// very document is that page, loaded natively)
		out.own = { ...(await show(`${proxy}/`)), element: undefined };
		out.nativeTitle = document.title;
		out.transport = {
			...(await show('http://127.0.0.1:9/down.html')),
			element: undefined,
		};
		// the host's page tells the host its client id, so the controller
		// holds the report only until it did
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
		// the host page is not an injected page: frame.url is what its
		// report said (error-page-reports)
		result.blocked.url === `${FIXTURE}pages/hist-1.html` &&
		result.blocked.error.url === `${FIXTURE}pages/hist-1.html`,
	JSON.stringify(result.blocked),
);
ok(
	"a page of the proxy's own origin loads as the page it is, not the host's error page",
	result.own?.url === `${proxy}/` &&
		result.own.title === result.nativeTitle &&
		result.own.error === null &&
		result.own.retry === false,
	JSON.stringify([result.own, result.nativeTitle]),
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
			['transport', 0, 'down.html'],
		]),
	JSON.stringify(result.kinds),
);
ok(
	'the error page is not cached: a retry after the rule is gone loads the real page',
	result.afterRetry === 'HIST 1',
	JSON.stringify(result.afterRetry),
);
ok(
	'names.error renames the global the worker writes into the error page',
	result.renamed?.renamed?.kind === 'blocked' &&
		result.renamed?.renamed?.url === `${FIXTURE}pages/hist-1.html` &&
		result.renamed?.defaultName === null,
	JSON.stringify(result.renamed),
);

// A routed script request that reaches the host instead of the service worker
// comes from a document the worker does not control (an about:blank frame or
// popup the page built: an ad network's cookie-sync frame is the common one),
// whose subresource loads skip the worker. The host answers a script route
// with an empty JavaScript body, never its text/html error page, so Chrome
// does not refuse the script for its MIME type ("not executable") and log it.
// A node fetch has no service worker, so it reaches the host as those loads do.
const scriptRoute = await fetch(`${HOST}stomp/notacontroller/js:generic/junk`);
const scriptBody = await scriptRoute.text();
const moduleRoute = await fetch(
	`${HOST}stomp/notacontroller/js:genericModule/junk`,
);
await moduleRoute.body?.cancel();
const styleRoute = await fetch(`${HOST}stomp/notacontroller/css/junk`);
await styleRoute.body?.cancel();
ok(
	'a script route the worker never claims is answered as JavaScript, not the host error page',
	scriptRoute.ok &&
		/^(?:text|application)\/javascript/.test(
			scriptRoute.headers.get('content-type') ?? '',
		) &&
		scriptBody === '',
	`${scriptRoute.status} ${scriptRoute.headers.get('content-type')} len=${scriptBody.length}`,
);
ok(
	'a module script route the worker never claims is also answered as JavaScript',
	moduleRoute.ok &&
		/^(?:text|application)\/javascript/.test(
			moduleRoute.headers.get('content-type') ?? '',
		),
	`${moduleRoute.status} ${moduleRoute.headers.get('content-type')}`,
);
ok(
	'a non-script route the worker never claims is left as the host 404',
	styleRoute.status === 404 &&
		/text\/html/.test(styleRoute.headers.get('content-type') ?? ''),
	`${styleRoute.status} ${styleRoute.headers.get('content-type')}`,
);

await done(browser);
