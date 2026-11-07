// A deployment's own helper names: a controller built with `names` has the
// rewriter emit them and the inject bundle live under them, the defaults
// are nowhere, and the tells fixture finds the new names as invisible as the
// old. A bad name (a global of the page, a reserved word, not an identifier,
// used twice, unknown) is a TypeError from the constructor. Same-origin
// mode: the suite builds its own controller, from the controller module, in
// a page of its own on the demo origin.
import { randomBytes } from 'node:crypto';
import {
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

const browser = await launch();
// a host page of our own on the demo origin (any document there will do; the
// demo page would keep its own controller registered next to this one)
await waitForServer(PROXY);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const suffix = () => randomBytes(4).toString('hex');
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

const { rejected, error } = await page.evaluate(
	async ({ names, target }) => {
		const { StompController } = await import('/stomp/controller.mjs');
		const registration = await StompController.register('/stomp/');
		const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
		const init = {
			serviceworker: registration,
			transport: { module: '/epoxy/index.mjs', options: [{ wisp }] },
			directory: '/stomp/',
			codec: 'xor',
		};
		const rejected = {};
		for (const [label, bad] of [
			['global', { access: 'Object' }],
			['reserved', { client: 'class' }],
			['identifier', { globalProxy: 'a-b' }],
			['duplicate', { access: 'same', client: 'same' }],
			['unknown', { bogus: 'x' }],
		])
			try {
				new StompController({ ...init, names: bad });
				rejected[label] = 'constructed';
			} catch (error) {
				rejected[label] = `${error.constructor.name}: ${error.message}`;
			}
		let step = 'construct';
		try {
			const controller = new StompController({ ...init, names });
			await controller.wait();
			step = 'frame';
			const frame = controller.createFrame();
			document.body.append(frame.element);
			window.__names = { controller, frame };
			step = 'go';
			await frame.go(target);
			return { rejected };
		} catch (error) {
			return { rejected, error: `${step}: ${error.stack}` };
		}
	},
	{ names, target },
);
if (error) console.log('setup error', error);
ok(
	'a name the page has, a reserved word, a non-identifier, a duplicate or an unknown key is a TypeError',
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
	'the page runs rewritten under the new names: the real URL, itself as top',
	tells.rewritten === target,
	JSON.stringify(tells.rewritten),
);
ok(
	'the new names are as invisible to the page as the defaults were',
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
	.evaluate(
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
	'the window carries the new names and none of the defaults',
	JSON.stringify(present) === JSON.stringify([true, true, false, false]),
	JSON.stringify(present),
);
await done(browser, errors);
