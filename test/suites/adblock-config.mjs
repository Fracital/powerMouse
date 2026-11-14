// The runtime filter-list API (docs/adblock.md "Changing the lists"): the
// controller changes the blocker's lists while it runs, and the service worker
// rebuilds the engine in place. This is what the demo's Filter Lists editor
// drives. Two things are proved end to end, in the browser, against the
// fixture's own list and pages:
//
//   - setAdblockLists with a custom inline filter (the editor's own rules,
//     compiled in place of a fetched list) blocks a request that matched no
//     list before: adblock-allowed.js, allowed by the fixture list, stops
//     running once a custom rule names it.
//   - removing a list stops its rules blocking: with the fixture list gone
//     (only an unrelated inline list left), adblock-blocked.js, which the
//     fixture list blocked, runs again.
//
// The controller is one of the suite's own (the demo runs under ?noadblock, so
// its controller has no blocker). Its lists are fixture files, reached through
// the transport like a page's requests; the real list servers are refused, as
// in every run. Same-origin mode.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();

await page.goto(`${PROXY}?noadblock`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{
		timeout: 45000,
	},
);

const result = await page.evaluate(
	async ({ fixture }) => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const list = `${fixture}pages/adblock-list.txt`;
		const resources = `${fixture}pages/adblock-resources.json`;
		const controller = new window.StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: window.controller.directory.pathname,
			codec: 'xor',
			cache: false,
			// the fixture list blocks /pages/adblock-blocked.js and excepts
			// /pages/adblock-allowed.js; trusted so its scriptlets would run
			adblock: { lists: [{ url: list, trusted: true }], resources },
		});
		await controller.wait();

		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = controller.createFrame(element);

		// load adblock.html and read which of its scripts ran (a blocked script
		// never pushes its mark to __adblockRan)
		const loadOnce = async () => {
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(`${fixture}pages/adblock.html`);
			await loaded;
			const win = element.contentWindow;
			for (let i = 0; i < 100 && !win.__adblockReport; i++) await wait(50);
			const report = win.__adblockReport
				? await win.__adblockReport()
				: { ran: [] };
			return report.ran || [];
		};
		// reload until the engine in force agrees with `predicate(ran)`, for the
		// rebuild after a list change to land (a fixture list compiles in well
		// under a second); returns the last `ran` either way
		const loadUntil = async (predicate) => {
			let ran = [];
			for (let i = 0; i < 25; i++) {
				ran = await loadOnce();
				if (predicate(ran)) return ran;
				await wait(400);
			}
			return ran;
		};

		const out = {};
		// baseline: the fixture list blocks adblock-blocked.js, allows
		// adblock-allowed.js
		out.baseRan = await loadUntil(
			(ran) => ran.includes('allowed') && !ran.includes('blocked'),
		);
		out.defaults = controller.adblockDefaults().map((l) => l.url);
		out.inForce = controller.getAdblockLists().map((l) => l.url);

		// remove the fixture list, leaving only an unrelated inline list: the
		// blocker rebuilds, and adblock-blocked.js is no longer blocked
		out.removed = await controller.setAdblockLists([
			{ url: 'stomp-test:other', filters: '||unrelated.invalid^' },
		]);
		out.afterRemoveRan = await loadUntil((ran) => ran.includes('blocked'));
		out.inForceAfterRemove = controller.getAdblockLists().map((l) => l.url);

		// add a custom inline filter that blocks adblock-allowed.js (the
		// custom-filters editor's own rule): it stops running
		out.custom = await controller.setAdblockLists([
			{ url: 'stomp-test:other', filters: '||unrelated.invalid^' },
			{
				url: 'stomp-filters:my-filters',
				filters: '/pages/adblock-allowed.js$script',
				trusted: false,
			},
		]);
		out.afterCustomRan = await loadUntil((ran) => !ran.includes('allowed'));

		element.remove();
		return out;
	},
	{ fixture: FIXTURE },
);

// the default lists the controller reports, for a UI to show, are the ones it
// was built with
ok(
	'adblockDefaults reports the built-in lists',
	result.defaults.length === 1 &&
		result.defaults[0].endsWith('adblock-list.txt'),
	JSON.stringify(result.defaults),
);
ok(
	'getAdblockLists starts at the defaults',
	result.inForce.length === 1 && result.inForce[0].endsWith('adblock-list.txt'),
	JSON.stringify(result.inForce),
);

// baseline: the list blocks its entry, allows its exception
ok(
	'the default list blocks adblock-blocked.js',
	!result.baseRan.includes('blocked'),
	JSON.stringify(result.baseRan),
);
ok(
	'the default list allows adblock-allowed.js',
	result.baseRan.includes('allowed'),
	JSON.stringify(result.baseRan),
);

// removing the list stops its rules blocking
ok(
	'setAdblockLists applied the removal live',
	result.removed && result.removed.applied === 'live',
	JSON.stringify(result.removed),
);
ok(
	'getAdblockLists reflects the new set',
	result.inForceAfterRemove.length === 1 &&
		result.inForceAfterRemove[0] === 'stomp-test:other',
	JSON.stringify(result.inForceAfterRemove),
);
ok(
	'a disabled list stops blocking its entries (adblock-blocked.js runs again)',
	result.afterRemoveRan.includes('blocked'),
	JSON.stringify(result.afterRemoveRan),
);

// a custom inline filter blocks a request that matched no list before
ok(
	'setAdblockLists applied the custom filter live',
	result.custom && result.custom.applied === 'live',
	JSON.stringify(result.custom),
);
ok(
	'a custom filter rule blocks a matching request (adblock-allowed.js is gone)',
	!result.afterCustomRan.includes('allowed'),
	JSON.stringify(result.afterCustomRan),
);
// the custom set did not carry the fixture list, so its blocked.js runs
ok(
	'the custom set leaves unrelated requests alone (adblock-blocked.js runs)',
	result.afterCustomRan.includes('blocked'),
	JSON.stringify(result.afterCustomRan),
);

await done(browser);
