// A deployment's own helper names: a controller built with `names` has the
// rewriter emit them and the inject bundle live under them, the defaults
// are nowhere, and the tells fixture finds the new names as invisible as the
// old. A bad name (a global of the page, a reserved word, not an identifier,
// used twice, unknown) is a TypeError from the constructor. Both modes: the
// suite builds its own controller from the controller module in a page of
// its own, a StompController on the proxy origin and a RemoteController on
// the host origin against the proxy origin (the names travel to the
// controller frame).
import { randomBytes } from 'node:crypto';
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

const browser = await launch();
const errors = [];
const suffix = () => randomBytes(4).toString('hex');

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const names = {
		access: `hA${suffix()}`,
		globalProxy: `hP${suffix()}`,
		globalName: `hN${suffix()}`,
		client: `hC${suffix()}`,
	};
	const target = `${FIXTURE}pages/tells.html?names=${[
		names.access,
		names.client,
		names.globalProxy,
		names.globalName,
	].join(',')}`;
	// a host page of our own (any document on the origin will do; the demo
	// page would keep its own controller registered next to this one)
	await waitForServer(base);
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	await page.goto(`${base}stomp/controllerFrame.html`);

	const { rejected, error } = await page.evaluate(
		async ({ names, target, isolated, proxyOrigin }) => {
			let step = 'import';
			try {
				const { StompController, RemoteController } =
					await import('/stomp/controller.mjs');
				const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
				const transport = {
					module: `${proxyOrigin}/epoxy/index.mjs`,
					options: [{ wisp }],
				};
				step = 'register';
				const init = isolated
					? { proxyOrigin, directory: '/stomp/', transport, codec: 'xor' }
					: {
							serviceworker: await StompController.register('/stomp/'),
							transport,
							directory: '/stomp/',
							codec: 'xor',
						};
				const Controller = isolated ? RemoteController : StompController;
				const rejected = {};
				for (const [label, bad] of [
					['global', { access: 'Object' }],
					['reserved', { client: 'class' }],
					['identifier', { globalProxy: 'a-b' }],
					['duplicate', { access: 'same', client: 'same' }],
					['unknown', { bogus: 'x' }],
				])
					try {
						new Controller({ ...init, names: bad });
						rejected[label] = 'constructed';
					} catch (error) {
						rejected[label] = `${error.constructor.name}: ${error.message}`;
					}
				step = 'construct';
				const controller = new Controller({ ...init, names });
				step = 'wait';
				await Promise.race([
					controller.wait(),
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error('controller.wait timed out')),
							30000,
						),
					),
				]);
				step = 'frame';
				const frame = controller.createFrame();
				document.body.append(frame.element);
				window.__names = { controller, frame };
				step = 'go';
				await frame.go(target);
				return { rejected };
			} catch (error) {
				return { rejected: {}, error: `${step}: ${error.stack}` };
			}
		},
		{
			names,
			target,
			isolated: mode === 'isolated',
			proxyOrigin: new URL(PROXY).origin,
		},
	);
	if (error) console.log(`${mode} setup error`, error);
	ok(
		`${mode}: a name the page has, a reserved word, a non-identifier, a duplicate or an unknown key is a TypeError`,
		Object.values(rejected).length === 5 &&
			Object.values(rejected).every((message) =>
				message.startsWith('TypeError:'),
			),
		JSON.stringify(rejected),
	);
	let tells = null;
	let frame = null;
	for (let i = 0; i < 40 && !tells; i++) {
		await sleep(250);
		frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
		tells = await frame?.evaluate(() => window.__tells).catch(() => null);
	}
	tells ||= {};
	ok(
		`${mode}: the page runs rewritten under the new names: the real URL, itself as top`,
		tells.rewritten === target,
		JSON.stringify(tells.rewritten),
	);
	ok(
		`${mode}: the new names are as invisible to the page as the defaults were`,
		['windowNames', 'locationNames', 'evalNames', 'documentNames'].every(
			(key) => Array.isArray(tells[key]) && tells[key].length === 0,
		) &&
			['windowAsks', 'locationAsks', 'evalAsks'].every(
				(key) => Array.isArray(tells[key]) && tells[key].length === 0,
			) &&
			tells.plainHasOwn === true &&
			JSON.stringify(tells.plainNames) === JSON.stringify([names.client]),
		JSON.stringify(tells),
	);
	// the real globals, read from outside the rewrite (the `in` operator is a
	// documented tell): the new names are there, the defaults are not
	const present = await frame
		?.evaluate(
			(n) => [
				n.access in window,
				n.client in window,
				'$s$j' in window,
				'$P$s' in window,
			],
			names,
		)
		.catch(() => null);
	ok(
		`${mode}: the window carries the new names and none of the defaults`,
		JSON.stringify(present) === JSON.stringify([true, true, false, false]),
		JSON.stringify(present),
	);
	await page.close();
}
await done(browser, errors);
