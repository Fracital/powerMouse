// Host code in every proxied realm (`init.hooks`, scramjet's
// Frame.hooks.init.pre/post as scripts that travel): pre runs before the
// inject installs its hooks and post after, before the page's first script,
// in the page, its nested frame, its about:blank child, its srcdoc frame and
// (opted in) its worker, each told where it is. A throwing hook never breaks
// the page and reaches the host as `hookerror`; a `{ url }` is fetched once
// by the controller; a URL that cannot be fetched reports and rejects wait()
// while the controller still serves. Both modes, a host page of our own per
// origin, several controllers side by side.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

const PRE = `
	self.__pre = { phase: stomp.phase, url: stomp.url, origin: stomp.origin, nested: stomp.nested,
		isTop: stomp.isTop, kind: stomp.kind, frameId: stomp.frameId, hasWindow: stomp.window === self };
	self.__nativeFetch = self.fetch;`;
const POST = `
	self.__post = { phase: stomp.phase, url: stomp.url, kind: stomp.kind, fetchChanged: self.fetch !== self.__nativeFetch };
	if (stomp.kind === 'document')
		self.addEventListener('DOMContentLoaded', () => {
			const style = document.createElement('style');
			style.textContent = 'body { margin-top: 7px }';
			document.head.append(style);
		});`;

const browser = await launch();
const errors = [];
const origin = new URL(FIXTURE).origin;
const target = `${FIXTURE}pages/hooks.html`;

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	await waitForServer(base);
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	await page.goto(`${base}stomp/controllerFrame.html`);
	const isolated = mode === 'isolated';

	// the controllers: full hooks with workers, no workers, a throwing pre, a
	// hook from a URL, a URL that 404s; each with a frame on the fixture page
	const setup = await page.evaluate(
		async ({ isolated, proxyOrigin, target, PRE, POST, fixture }) => {
			const { StompController, RemoteController } =
				await import('/stomp/controller.mjs');
			const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
			const transport = {
				module: `${proxyOrigin}/epoxy/index.mjs`,
				options: [{ wisp }],
			};
			const base = isolated
				? { proxyOrigin, directory: '/stomp/', transport, codec: 'xor' }
				: {
						serviceworker: await StompController.register('/stomp/'),
						transport,
						directory: '/stomp/',
						codec: 'xor',
					};
			const Controller = isolated ? RemoteController : StompController;
			const out = { rejected: {}, events: {} };
			for (const [label, bad] of [
				['not an object', 'x'],
				['unknown key', { init: {}, bogus: 1 }],
				['bad phase', { init: { during: { source: '' } } }],
				['bad script', { init: { pre: { source: 1 } } }],
				['both forms', { init: { pre: { source: '', url: '/x' } } }],
			])
				try {
					new Controller({ ...base, hooks: bad });
					out.rejected[label] = 'constructed';
				} catch (error) {
					out.rejected[label] = error.constructor.name;
				}
			const make = async (label, hooks) => {
				const events = [];
				const controller = new Controller({
					...base,
					hooks,
					onHookError: (info) => events.push({ via: 'callback', ...info }),
				});
				controller.addEventListener('hookerror', (event) =>
					events.push({ via: 'event', ...event.detail.info }),
				);
				out.events[label] = events;
				let waitError = null;
				try {
					await controller.wait();
				} catch (error) {
					waitError = `${error.constructor.name}: ${error.message}`;
				}
				out[`${label}Wait`] = waitError;
				const frame = controller.createFrame();
				document.body.append(frame.element);
				await Promise.race([
					frame.go(target),
					new Promise((resolve) => setTimeout(resolve, 20000)),
				]);
				window.__frames = window.__frames || {};
				window.__frames[label] = frame;
				out[`${label}Id`] = controller.id;
			};
			await make('full', {
				init: { pre: { source: PRE }, post: { source: POST } },
				workers: true,
			});
			await make('noWorkers', {
				init: { pre: { source: PRE }, post: { source: POST } },
			});
			await make('throwing', {
				init: {
					pre: { source: "throw new Error('boom')" },
					post: { source: POST },
				},
			});
			await make('fromUrl', {
				init: { post: { url: `${fixture}pages/hook-post.js` } },
			});
			await make('missing', {
				init: { post: { url: `${fixture}pages/no-such-hook.js` } },
			});
			return out;
		},
		{
			isolated,
			proxyOrigin: new URL(PROXY).origin,
			target,
			PRE,
			POST,
			fixture: FIXTURE,
		},
	);

	// the fixture's record from each controller's frame, by the frame element
	const record = async (label) => {
		for (let i = 0; i < 60; i++) {
			const handle = await page.evaluateHandle(
				(label) => window.__frames[label].element,
				label,
			);
			const frame = await handle.asElement()?.contentFrame();
			const value = await frame
				?.evaluate(() => window.__hooks)
				.catch(() => null);
			if (value?.done) return value;
			await sleep(250);
		}
		return {};
	};
	const full = await record('full');
	const noWorkers = await record('noWorkers');
	const throwing = await record('throwing');
	const fromUrl = await record('fromUrl');
	const missing = await record('missing');
	const collected = setup.events;

	ok(
		`${mode}: a bad hooks shape is a TypeError from the constructor`,
		Object.values(setup.rejected).length === 5 &&
			Object.values(setup.rejected).every((name) => name === 'TypeError'),
		JSON.stringify(setup.rejected),
	);
	ok(
		`${mode}: pre runs before the inject's hooks and post after, before the page's first script`,
		full.pre?.phase === 'pre' &&
			full.post?.phase === 'post' &&
			full.post?.fetchChanged === true &&
			full.start?.pre === true &&
			full.start?.post === true &&
			full.marginTop === '7px',
		JSON.stringify([full.pre, full.post, full.start, full.marginTop]),
	);
	ok(
		`${mode}: the hook is told where it is: the real URL and origin, top, kind, the controller id, the real global`,
		full.pre?.url === target &&
			full.pre?.origin === origin &&
			full.pre?.isTop === true &&
			full.pre?.nested === false &&
			full.pre?.kind === 'document' &&
			full.pre?.frameId === setup.fullId &&
			full.pre?.hasWindow === true,
		JSON.stringify([full.pre, setup.fullId]),
	);
	ok(
		`${mode}: a nested frame, an about:blank child and a srcdoc frame run the hooks as nested realms`,
		full.child?.pre?.nested === true &&
			full.child?.pre?.isTop === false &&
			full.child?.pre?.url === `${FIXTURE}pages/hooks-child.html` &&
			full.child?.post?.phase === 'post' &&
			full.blank?.pre === true &&
			full.blank?.post === true &&
			full.blank?.nested === true &&
			full.blank?.url === target &&
			full.srcdoc?.pre === true &&
			full.srcdoc?.post === true &&
			full.srcdoc?.nested === true,
		JSON.stringify([full.child, full.blank, full.srcdoc]),
	);
	ok(
		`${mode}: a worker runs the hooks only with hooks.workers`,
		full.worker?.pre?.kind === 'worker' &&
			full.worker?.pre?.url === `${FIXTURE}pages/hooks-worker.js` &&
			full.worker?.post?.phase === 'post' &&
			noWorkers.worker?.pre === null &&
			noWorkers.worker?.post === null &&
			noWorkers.pre?.phase === 'pre',
		JSON.stringify([full.worker, noWorkers.worker]),
	);
	const boom = (collected.throwing ?? []).filter((e) => e.url === target);
	ok(
		`${mode}: a throwing pre leaves the page working, post still runs, and the host hears about it`,
		throwing.done === true &&
			throwing.pre === undefined &&
			throwing.post?.phase === 'post' &&
			throwing.marginTop === '7px' &&
			boom.some(
				(e) =>
					e.via === 'callback' &&
					e.phase === 'pre' &&
					e.message === 'boom' &&
					e.kind === 'document',
			) &&
			boom.some((e) => e.via === 'event' && e.phase === 'pre'),
		JSON.stringify([
			throwing.pre,
			throwing.post,
			throwing.marginTop,
			boom.slice(0, 2),
		]),
	);
	ok(
		`${mode}: a hook from a URL is fetched once by the controller and runs`,
		fromUrl.fromUrl === 'post' && setup.fromUrlWait === null,
		JSON.stringify([fromUrl.fromUrl, setup.fromUrlWait]),
	);
	const missingEvents = collected.missing ?? [];
	ok(
		`${mode}: a hook URL that cannot be fetched is reported and the controller serves without it`,
		missing.done === true &&
			missing.fromUrl === undefined &&
			setup.missingWait === null &&
			missingEvents.some(
				(e) => e.phase === 'url' && /no-such-hook\.js/.test(e.url),
			),
		JSON.stringify([
			missing.done,
			setup.missingWait,
			missingEvents.slice(0, 1),
		]),
	);
	await page.close();
}
await done(browser, errors);
