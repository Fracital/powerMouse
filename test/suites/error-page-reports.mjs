// A document the proxy failed to produce (here an origin that refuses the
// connection) is answered with an error page: the host's own (`errorPage`,
// examples/error.html) or the router's built-in page. That page runs no
// inject, and the worker's script in its head reports for it as a proxied
// document reports for itself: a navigate report with the URL that failed
// (the real one, not its route) and the page's title, read after the page's
// own script set it and again when it changes, so `frame.url`,
// `frame.title`, `onNavigate` and the `navigate` events show the failure and
// not the page before it. The failed document's request report is the
// frame's (`frame` set, `status` 0, `kind` transport). A navigation an
// extension's declarativeNetRequest rule blocks gets the host's page and
// reports the same way. Both controllers:
// same origin (StompController) and isolated (RemoteController), each with
// and without `errorPage`.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
} from '../lib.mjs';

const browser = await launch();
const proxy = new URL(PROXY).origin;

// the title each page ends with once its script ran
const TITLES = {
	host: 'Could not reach the site',
	builtin: 'Error',
};
const CHANGED = 'Title changed by the page';

for (const [mode, base] of [
	['same origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	for (const kind of ['host', 'builtin']) {
		const name = `${mode}, ${kind === 'host' ? "the host's errorPage" : 'no errorPage'}`;
		const failing = `http://127.0.0.1:9/down.html?mode=${mode === 'isolated' ? 'iso' : 'same'}&page=${kind}`;
		// a controller of its own, the frame on a page first so its title
		// and URL are that page's, then on the URL that fails
		const before = await page.evaluate(
			async ({ proxy, fixture, isolated, errorPage, failing }) => {
				const transport = {
					module: `${proxy}/epoxy/index.mjs`,
					options: [{ wisp: `${proxy.replace(/^http/, 'ws')}/wisp/` }],
				};
				const options = {
					codec: 'xor',
					...(errorPage ? { errorPage: '/examples/error.html' } : {}),
					onRequest: () => {},
				};
				const controller = isolated
					? new window.StompRemoteController({
							proxyOrigin: proxy,
							directory: '/stomp/',
							transport,
							...options,
						})
					: new window.StompController({
							serviceworker: window.controller.serviceworker,
							transport: window.controller.transport,
							directory: window.controller.directory.pathname,
							...options,
						});
				await controller.wait();
				const element = document.createElement('iframe');
				element.style.cssText = 'width: 400px; height: 300px';
				document.body.append(element);
				const frame = controller.createFrame(element);
				const state = {
					navigates: [],
					frameNavigates: [],
					requests: [],
					failing,
				};
				window.__reports = state;
				window.__frame = frame;
				window.__controller = controller;
				controller.addEventListener('navigate', (event) => {
					if (event.detail.frame !== frame) return;
					state.navigates.push({ ...event.detail.info });
				});
				frame.addEventListener('navigate', (event) =>
					state.frameNavigates.push({ ...event.detail }),
				);
				controller.addEventListener('request', (event) => {
					const info = event.detail;
					state.requests.push({
						url: info.url,
						destination: info.destination,
						status: info.status,
						kind: info.kind ?? null,
						hasClient: typeof info.client === 'string',
						frame:
							info.frame === frame
								? 'this frame'
								: info.frame
									? 'another frame'
									: null,
					});
				});
				await frame.go(`${fixture}pages/hist-1.html`);
				for (let i = 0; i < 100 && frame.title !== 'HIST 1'; i++)
					await new Promise((resolve) => setTimeout(resolve, 100));
				const shown = { url: frame.url, title: frame.title };
				state.navigates.length = 0;
				state.frameNavigates.length = 0;
				const loaded = new Promise((resolve) =>
					element.addEventListener('load', resolve, { once: true }),
				);
				await Promise.race([
					frame.go(failing),
					new Promise((resolve) => setTimeout(resolve, 15000)),
				]);
				await Promise.race([
					loaded,
					new Promise((resolve) => setTimeout(resolve, 15000)),
				]);
				return shown;
			},
			{
				proxy,
				fixture: FIXTURE,
				isolated: mode === 'isolated',
				errorPage: kind === 'host',
				failing,
			},
		);
		ok(
			`${name}: the frame showed the page before the failure`,
			before.title === 'HIST 1' && before.url === `${FIXTURE}pages/hist-1.html`,
			JSON.stringify(before),
		);
		const read = () =>
			page.evaluate(() => ({
				...window.__reports,
				url: window.__frame.url,
				title: window.__frame.title,
			}));
		const failedRequest = (state) =>
			state.requests.find(
				(request) =>
					request.url === state.failing && request.destination === 'iframe',
			);
		let state = await read();
		for (
			let i = 0;
			i < 60 &&
			!(
				state.navigates.some((info) => info.title === TITLES[kind]) &&
				failedRequest(state)
			);
			i++
		) {
			await sleep(250);
			state = await read();
		}
		const report = state.navigates.find((info) => info.title === TITLES[kind]);
		ok(
			`${name}: the error page reports its navigation with the failed URL and its title`,
			report?.url === failing,
			JSON.stringify(state.navigates),
		);
		ok(
			`${name}: the frame's own navigate event says the same`,
			state.frameNavigates.some(
				(info) => info.url === failing && info.title === TITLES[kind],
			),
			JSON.stringify(state.frameNavigates),
		);
		ok(
			`${name}: frame.url is the failed URL and frame.title the page's title`,
			state.url === failing && state.title === TITLES[kind],
			JSON.stringify({ url: state.url, title: state.title }),
		);
		const request = failedRequest(state);
		ok(
			`${name}: the failed document's request report names its frame`,
			request?.frame === 'this frame' &&
				request.hasClient &&
				request.status === 0 &&
				request.kind === 'transport',
			JSON.stringify(request ?? state.requests),
		);

		// the page changes its title: the host hears it again
		let changed = false;
		for (const frame of page.frames()) {
			if (frame === page.mainFrame()) continue;
			const title = await frame
				.evaluate(() => document.title)
				.catch(() => null);
			if (title !== TITLES[kind]) continue;
			changed = await frame
				.evaluate((title) => {
					if (
						!document.getElementById('retry') &&
						!document.getElementById('errname')
					)
						return false;
					document.title = title;
					return true;
				}, CHANGED)
				.catch(() => false);
			if (changed) break;
		}
		let retitled = null;
		for (let i = 0; changed && i < 40 && !retitled; i++) {
			state = await read();
			retitled = state.navigates.find((info) => info.title === CHANGED) ?? null;
			if (!retitled) await sleep(250);
		}
		ok(
			`${name}: a title the page changes later is reported again`,
			changed && retitled?.url === failing && (await read()).title === CHANGED,
			JSON.stringify({ changed, navigates: state.navigates }),
		);

		// a navigation an extension's declarativeNetRequest rule blocks gets
		// the host's page too (without one, a network error as in Chrome)
		if (kind === 'host') {
			const blockedUrl = `${FIXTURE}pages/hist-2.html?dnr-error-page=${mode === 'isolated' ? 'iso' : 'same'}`;
			await page.evaluate(async (blockedUrl) => {
				const state = window.__reports;
				state.navigates.length = 0;
				state.requests.length = 0;
				state.failing = blockedUrl;
				await window.__controller.dnr({
					op: 'install',
					extension: {
						id: 'error-page-reports',
						installTime: 1,
						rulesets: [
							{
								id: 'main',
								rules: [
									{
										id: 1,
										condition: {
											urlFilter: '?dnr-error-page=',
											resourceTypes: ['main_frame'],
										},
										action: { type: 'block' },
									},
								],
							},
						],
					},
				});
				await Promise.race([
					window.__frame.go(blockedUrl),
					new Promise((resolve) => setTimeout(resolve, 15000)),
				]);
			}, blockedUrl);
			const BLOCKED = 'Blocked by this host';
			state = await read();
			for (
				let i = 0;
				i < 60 &&
				!(
					state.navigates.some((info) => info.title === BLOCKED) &&
					failedRequest(state)
				);
				i++
			) {
				await sleep(250);
				state = await read();
			}
			ok(
				`${name}: a page a DNR rule blocks reports its navigation with the blocked URL`,
				state.navigates.some(
					(info) => info.url === blockedUrl && info.title === BLOCKED,
				) &&
					state.url === blockedUrl &&
					state.title === BLOCKED,
				JSON.stringify({
					navigates: state.navigates,
					url: state.url,
					title: state.title,
				}),
			);
			const blocked = failedRequest(state);
			ok(
				`${name}: the blocked document's request report names its frame`,
				blocked?.frame === 'this frame' &&
					blocked.hasClient &&
					blocked.kind === 'blocked',
				JSON.stringify(blocked ?? state.requests),
			);
			await page.evaluate(() =>
				window.__controller.dnr({
					op: 'uninstall',
					id: 'error-page-reports',
				}),
			);
		}
		await page.evaluate(() => {
			window.__frame.element.remove();
			window.__controller.element?.remove?.();
		});
	}
	await page.close();
}

await done(browser);
