// A controller whose host gives no id keeps one from visit to visit
// (src/controller/id.ts): routed URLs start with the id, the rewrite cache's
// key includes the address, and the browser keeps a script's compiled code
// only for the same URL. The demo gives none. A tab opened while another is
// open gets an id of its own, tabs that open together too (and none is lost
// from the kept list), a tab opened after both closed gets the first one
// again, a reloaded tab keeps its own, a duplicated tab does not take its
// original's, and a returning visit asks for a script under the URL it
// had. The ids are kept in
// the host origin's localStorage, in isolated mode too, under a key that
// names neither the project nor a proxy and is in the build verbatim.
// `cookies.clear()` for every site forgets them, for every open tab from its
// next reload. There is no public call for any of it; the module's own
// functions are checked in a page of their own: the kept list never grows
// past 16, a forgotten id is not written back, and without Web Locks or
// storage the id is a new random one and nothing is kept.
// One context for every tab (a page from browser.newPage() would get storage
// of its own).
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	OUT,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const KEY = 'kept-tab-ids';
const root = fileURLToPath(new URL('../../', import.meta.url));

const browser = await launch();
const context = await browser.newContext();
const errors = [];

const ready = (page) =>
	page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
async function open(base = PROXY, { session = null, target = context } = {}) {
	const page = await target.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	// what a duplicated tab starts with: its original's sessionStorage
	if (session !== null)
		await page.addInitScript(
			({ key, session }) => {
				if (sessionStorage.getItem(key) === null)
					sessionStorage.setItem(key, session);
			},
			{ key: KEY, session },
		);
	await page.goto(base);
	await ready(page);
	return page;
}
const idOf = (page) => page.evaluate(() => window.controller.id);
const kept = (page) =>
	page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), KEY);
const sessionOf = (page) =>
	page.evaluate((key) => sessionStorage.getItem(key), KEY);
// a closed tab lets go of its id a moment after it is gone
const close = async (page) => {
	await page.close();
	await sleep(1000);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the surface: nothing to call, and the key is in the build as written
{
	const page = await open();
	const surface = await page.evaluate(() => ({
		controller: Object.getOwnPropertyNames(window.StompController),
		remote: Object.getOwnPropertyNames(window.StompRemoteController),
	}));
	ok(
		'neither controller has a call for its id',
		![...surface.controller, ...surface.remote].some((name) =>
			/id/i.test(name),
		),
		JSON.stringify(surface),
	);
	for (const file of ['Controller.js', 'controller.mjs']) {
		const text = readFileSync(`${root}dist/${file}`, 'utf8');
		ok(`dist/${file} has the key as it is written`, text.includes(KEY), file);
	}
	// the address does not exist before the controller has its id: nothing
	// is routed under a guess. An empty id is none (what a host that read
	// `id` too early would pass back)
	const early = await page.evaluate(async () => {
		const make = async (id) => {
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: window.controller.transport,
				directory: '/stomp/',
				...(id === undefined ? {} : { id }),
			});
			const before = [controller.id, controller.config.directory];
			// asked before the id is there: answered once it is
			const routed = await controller.route('https://a.test/');
			await controller.wait();
			return {
				before,
				id: controller.id,
				address: controller.config.directory,
				routed: new URL(routed).pathname,
			};
		};
		return {
			none: await make(undefined),
			empty: await make(''),
			own: await make('mine'),
		};
	});
	const settled = (one) =>
		/^[A-Za-z0-9]{8}$/.test(one.id) &&
		one.address === `/stomp/${one.id}/` &&
		one.routed.startsWith(one.address);
	ok(
		'a controller given no id has no id and no address until it has the one it keeps',
		same(early.none.before, ['', '']) && settled(early.none),
		JSON.stringify(early.none),
	);
	ok(
		'an empty id is none',
		same(early.empty.before, ['', '']) &&
			settled(early.empty) &&
			early.empty.id !== early.none.id,
		JSON.stringify(early.empty),
	);
	ok(
		"a host's own id is the address at once",
		same(early.own.before, ['mine', '/stomp/mine/']) &&
			early.own.id === 'mine' &&
			early.own.routed.startsWith('/stomp/mine/'),
		JSON.stringify(early.own),
	);
	// start over: this tab's id is not the suite's first
	await page.evaluate((key) => localStorage.removeItem(key), KEY);
	await close(page);
}

const first = await open();
const firstId = await idOf(first);
const second = await open();
const secondId = await idOf(second);
ok(
	'a tab opened while another is open gets an id of its own, and both are kept',
	/^[A-Za-z0-9]{8}$/.test(firstId) &&
		/^[A-Za-z0-9]{8}$/.test(secondId) &&
		firstId !== secondId &&
		same(await kept(second), [firstId, secondId]),
	JSON.stringify({ firstId, secondId, kept: await kept(second) }),
);
// the routed URLs start with it
const routed = await second.evaluate(() => window.controller.config.directory);
ok(
	'the id names the controller address',
	routed === `/stomp/${secondId}/`,
	routed,
);

await second.reload();
await ready(second);
ok(
	'a reloaded tab keeps its id',
	(await idOf(second)) === secondId,
	await idOf(second),
);

// a duplicated tab has its original's sessionStorage: the original holds
// the id, so the copy takes another, and the original is not replaced
{
	const copy = await open(PROXY, { session: await sessionOf(second) });
	const copyId = await idOf(copy);
	ok(
		'a duplicated tab does not take the id its original holds',
		copyId !== secondId &&
			copyId !== firstId &&
			(await idOf(second)) === secondId &&
			same(await kept(copy), [firstId, secondId, copyId]),
		JSON.stringify({ copyId, kept: await kept(copy) }),
	);
	await close(copy);
}

await close(first);
await close(second);
const third = await open();
ok(
	'a tab opened after every tab closed gets the first id again',
	(await idOf(third)) === firstId,
	await idOf(third),
);

// a returning visit: the script a proxied page loads has the routed URL it
// had
{
	const visit = async (page) => {
		const scripts = [];
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		// the proxied frame is the host's own process in this mode
		cdp.on('Network.responseReceived', (event) => {
			if (/\/js:\w+\//.test(event.response.url))
				scripts.push({
					url: event.response.url,
					store: event.response.cacheStorageCacheName ?? '',
				});
		});
		await submitLanding(
			page,
			`${FIXTURE}pages/rewrite-cache.html?s=${encodeURIComponent('name=visit&cc=no-cache')}`,
		);
		await waitActive(page, () => document.title === 'REWRITE CACHE');
		await sleep(1500);
		return scripts;
	};
	const before = await visit(third);
	await close(third);
	const again = await open();
	const after = await visit(again);
	const inserted = (list) =>
		list.filter((script) => script.url.startsWith(`${PROXY}stomp/${firstId}/`));
	ok(
		'a returning visit asks for its scripts under the routed URLs it had',
		(await idOf(again)) === firstId &&
			before.length > 0 &&
			inserted(before).length === before.length &&
			same(
				[...new Set(before.map((script) => script.url))].sort(),
				[...new Set(after.map((script) => script.url))].sort(),
			),
		JSON.stringify({ before, after }),
	);
	await close(again);
}

// tabs that open together: one claim at a time picks and writes, so each
// has an id of its own and none is lost from the list
{
	const pages = await Promise.all([open(), open(), open(), open()]);
	const ids = await Promise.all(pages.map(idOf));
	const list = await kept(pages[0]);
	ok(
		'four tabs opened together get four ids, the kept ones first, and every one is kept',
		new Set(ids).size === 4 &&
			ids.includes(firstId) &&
			ids.includes(secondId) &&
			ids.every((id) => list.includes(id)) &&
			new Set(list).size === list.length,
		JSON.stringify({ ids, list }),
	);
	for (const page of pages) await page.close();
	await sleep(1000);
}

// every site's cookies cleared: the ids are forgotten with them. The tab
// keeps the one it holds until it reloads, and a forgotten id does not come
// back with a reload
{
	const page = await open();
	const id = await idOf(page);
	await page.evaluate(() => window.controller.cookies.clear('https://a.test'));
	ok(
		"one site's cookies cleared: the ids stay",
		(await kept(page)).includes(id),
		JSON.stringify(await kept(page)),
	);
	await page.evaluate(() => window.controller.cookies.clear());
	ok(
		'cookies.clear() for every site forgets the kept ids, and the open tab keeps its own',
		same(await kept(page), []) &&
			(await sessionOf(page)) === null &&
			(await idOf(page)) === id,
		JSON.stringify({ kept: await kept(page), id: await idOf(page) }),
	);
	const other = await open();
	const otherId = await idOf(other);
	ok(
		'the next tab gets a new id, the only one kept',
		otherId !== id && otherId !== firstId && same(await kept(other), [otherId]),
		JSON.stringify({ otherId, kept: await kept(other) }),
	);
	await page.reload();
	await ready(page);
	const reloaded = await idOf(page);
	ok(
		'and the tab that held a forgotten id gets a new one when it reloads',
		reloaded !== id &&
			reloaded !== otherId &&
			same(await kept(page), [otherId, reloaded]),
		JSON.stringify({ reloaded, kept: await kept(page) }),
	);
	await close(page);
	await close(other);
}

// isolated mode: the ids are the host origin's, the controller frame is
// given its id and keeps none on the proxy origin
{
	const isolated = await browser.newContext();
	const one = await open(HOST, { target: isolated });
	const mode = await one.evaluate(
		() => window.controller instanceof window.StompRemoteController,
	);
	const id = await idOf(one);
	const frame = one
		.frames()
		.find((frame) => /controllerFrame/.test(frame.url()));
	const onProxy = frame
		? await frame.evaluate((key) => localStorage.getItem(key), KEY)
		: 'no controller frame';
	ok(
		'isolated: the id is kept on the host origin, and is the address the controller frame serves',
		mode === true &&
			same(await kept(one), [id]) &&
			(await one.evaluate(() => window.controller.config.directory)) ===
				`/stomp/${id}/`,
		JSON.stringify({ mode, id, kept: await kept(one) }),
	);
	ok('isolated: the proxy origin keeps none', onProxy === null, onProxy);
	await close(one);
	const two = await open(HOST, { target: isolated });
	ok(
		'isolated: a returning visit has the same id',
		(await idOf(two)) === id,
		await idOf(two),
	);
	await two.evaluate(() => window.controller.cookies.clear());
	ok(
		'isolated: cookies.clear() for every site forgets the kept ids',
		same(await kept(two), []),
		JSON.stringify(await kept(two)),
	);
	await isolated.close();
}

// the module itself, in a page of its own on another origin (the fixture's)
let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP controller-ids module checks: esbuild is not installed');
}
if (esbuild) {
	mkdirSync(OUT, { recursive: true });
	const bundle = `${OUT}controller-ids-module.js`;
	await esbuild.build({
		entryPoints: [`${root}src/controller/id.ts`],
		bundle: true,
		platform: 'browser',
		format: 'iife',
		globalName: 'ids',
		outfile: bundle,
		logLevel: 'silent',
	});
	const moduleContext = await browser.newContext();
	const blank = async ({ before = null } = {}) => {
		const page = await moduleContext.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		if (before) await page.addInitScript(before);
		await page.goto(`${FIXTURE}pages/rewrite-cache.html`);
		await page.addScriptTag({ path: bundle });
		return page;
	};

	const page = await blank();
	const many = await page.evaluate(async (key) => {
		const got = [];
		for (let i = 0; i < 20; i++) got.push(await window.ids.keptControllerId());
		return { got, kept: JSON.parse(localStorage.getItem(key)) };
	}, KEY);
	ok(
		'twenty controllers in one document hold twenty ids',
		new Set(many.got).size === 20,
		JSON.stringify(many.got),
	);
	ok(
		'and the kept list is the last sixteen: it never grows past that',
		same(many.kept, many.got.slice(-16)),
		JSON.stringify(many.kept),
	);
	ok(
		"the tab's own list is no longer",
		JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key), KEY))
			.length === 16,
	);

	// forgetting waits its turn: a claim that read the list before it does
	// not write the forgotten ids back
	const raced = await page.evaluate(async (key) => {
		const claim = window.ids.keptControllerId();
		const forgotten = window.ids.forgetControllerIds();
		const id = await claim;
		await forgotten;
		return { id, kept: localStorage.getItem(key) };
	}, KEY);
	ok(
		'forgetting while a claim is under way leaves nothing kept',
		raced.kept === null && /^[A-Za-z0-9]{8}$/.test(raced.id),
		JSON.stringify(raced),
	);
	await page.close();

	// without Web Locks: a new random id, nothing kept
	const lockless = await blank({
		before: () =>
			Object.defineProperty(Navigator.prototype, 'locks', {
				get: () => undefined,
			}),
	});
	const plain = await lockless.evaluate(
		async (key) => ({
			ids: [
				await window.ids.keptControllerId(),
				await window.ids.keptControllerId(),
			],
			kept: localStorage.getItem(key),
		}),
		KEY,
	);
	ok(
		'without Web Locks each controller has a new random id and none is kept',
		plain.ids.every((id) => /^[A-Za-z0-9]{8}$/.test(id)) &&
			plain.ids[0] !== plain.ids[1] &&
			plain.kept === null,
		JSON.stringify(plain),
	);
	await lockless.close();

	// storage that refuses (as in a sandboxed document)
	const refused = await blank({
		before: () => {
			const refuse = () => {
				throw new DOMException('refused', 'SecurityError');
			};
			Object.defineProperty(window, 'localStorage', { get: refuse });
			Object.defineProperty(window, 'sessionStorage', { get: refuse });
		},
	});
	const bare = await refused.evaluate(async () => {
		const got = [
			await window.ids.keptControllerId(),
			await window.ids.keptControllerId(),
		];
		await window.ids.forgetControllerIds();
		return got;
	});
	ok(
		'where storage refuses each controller has a new random id, and forgetting does not throw',
		bare.every((id) => /^[A-Za-z0-9]{8}$/.test(id)) && bare[0] !== bare[1],
		JSON.stringify(bare),
	);
	await refused.close();

	// a claim that does not get its turn settles for an id of its own
	const stuck = await blank();
	const late = await stuck.evaluate(async (key) => {
		// another holder of the claims' lock that never lets go
		navigator.locks.request(key, () => new Promise(() => {}));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const start = performance.now();
		const id = await window.ids.keptControllerId();
		return {
			id,
			ms: Math.round(performance.now() - start),
			kept: localStorage.getItem(key),
		};
	}, KEY);
	ok(
		'a claim that never gets its turn has a random id within a few seconds, not kept',
		/^[A-Za-z0-9]{8}$/.test(late.id) &&
			late.ms >= 2500 &&
			late.ms < 6000 &&
			late.kept === null,
		JSON.stringify(late),
	);
	await moduleContext.close();
}

await done(browser, errors);
