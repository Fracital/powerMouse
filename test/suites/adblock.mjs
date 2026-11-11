// The built-in blocker through the proxy (docs/adblock.md), with a list and
// resources that are fixture files (test/pages/adblock-list.txt), fetched by
// the service worker through the transport like any page's request.
//
// Off (the default): the controller's config has no `adblock`, the module is
// never fetched, nothing asks the worker for rules, and the page loads
// everything and hides nothing.
//
// On: a blocked request never reaches the fixture server (its hit counters
// stay where they were) and is a network error to the page, as a content
// blocker's is; the request's type and party come from the real URLs (a
// third-party rule blocks the other host only, an XHR rule the fetch and
// not the image); `$redirect` answers with the resource, `$removeparam`
// sends the request without the parameter, `$csp` reaches the document;
// the lists' selectors hide their elements with nothing added to the DOM or
// to the page's view of its style sheets; procedural filters, actions and
// scriptlets run, the scriptlets over the proxy's hooks with the page's own
// URLs. Same-origin mode, controllers of our own (each replaces the last
// in the worker).
import { done, FIXTURE, HOST, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
const requested = [];
page.on('request', (request) => requested.push(request.url()));
const policies = [];
page.on('response', (response) => {
	const policy = response.headers()['content-security-policy'];
	if (policy) policies.push(policy);
});
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const hits = async () => (await fetch(`${FIXTURE}hits`)).json();
const count = (table, file) => table[file]?.requests ?? 0;

/** a controller with `adblock`, a frame on the fixture page, and what the page reports */
const visit = (adblock, pages) =>
	page.evaluate(
		async ({ adblock, pages }) => {
			const log = [];
			const controller = new window.StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: window.controller.directory.pathname,
				codec: 'xor',
				cache: false,
				onRequest: (info) => log.push(info),
				...(adblock ? { adblock } : {}),
			});
			await controller.wait();
			const modules = await controller.wasmModules();
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			const out = { config: controller.config, modules, reports: {} };
			for (const [name, url] of Object.entries(pages)) {
				const load = new Promise((resolve) =>
					element.addEventListener('load', resolve, { once: true }),
				);
				await frame.go(url);
				await load;
				const win = element.contentWindow;
				for (let i = 0; i < 100 && !win.__adblockReport && !win.__worker; i++)
					await new Promise((resolve) => setTimeout(resolve, 100));
				try {
					out.reports[name] = win.__adblockReport
						? await win.__adblockReport()
						: {
								ran: element.contentDocument.getElementById('ran')?.textContent,
								worker: win.__worker,
							};
				} catch (error) {
					out.reports[name] = { threw: String(error?.stack ?? error) };
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
			out.log = log.map(({ url, status, error, kind }) => ({
				url,
				status,
				error,
				kind,
			}));
			element.remove();
			return out;
		},
		{ adblock, pages },
	);

const site = `${FIXTURE}pages/adblock.html`;
const otherSite = site.replace('127.0.0.1', 'localhost');

// off
const before = await hits();
const off = await visit(null, { page: site });
const afterOff = await hits();
const offReport = off.reports.page;
ok(
	'off: the config says nothing of the blocker',
	!('adblock' in off.config),
	JSON.stringify(off.config),
);
ok(
	'off: the module is never fetched and the worker is never asked for rules',
	!requested.some((url) => /blocker\.wasm|\/adblock$/.test(url)),
	requested.filter((url) => /blocker\.wasm|\/adblock$/.test(url)).join(' '),
);
ok(
	'off: every script runs, the image and the fetches load',
	JSON.stringify(offReport.ran) ===
		JSON.stringify(['blocked', 'allowed', 'redirect', 'third', 'domain']) &&
		offReport.pixel === 'load' &&
		offReport.typedFetch === 200 &&
		offReport.thirdParty === 'load' &&
		offReport.param === 200,
	JSON.stringify(offReport),
);
ok(
	'off: the requests reach the site',
	[
		'adblock-blocked.js',
		'adblock-pixel.svg',
		'adblock-frame.html',
		'adblock-redirect.js',
	].every((file) => count(afterOff, file) > count(before, file)),
	JSON.stringify(afterOff),
);
ok(
	'off: nothing is hidden, removed or injected',
	Object.values(offReport.shown).every((shown) => shown === true) &&
		offReport.gone === false &&
		offReport.trackAttribute === '1' &&
		offReport.classes === 'adblock-class tracked' &&
		offReport.spy === null &&
		offReport.flag === null &&
		offReport.inlineStyles.length === 0,
	JSON.stringify(offReport),
);

// on
const on = await visit(
	{
		lists: [
			{ url: `${FIXTURE}pages/adblock-list.txt`, trusted: true },
			`${FIXTURE}pages/adblock-untrusted.txt`,
		],
		resources: `${FIXTURE}pages/adblock-resources.json`,
	},
	{
		page: site,
		other: otherSite,
		csp: `${FIXTURE}pages/adblock-csp.html`,
	},
);
const afterOn = await hits();
const report = on.reports.page;
const other = on.reports.other;
console.log('INFO on:', JSON.stringify(report));
ok('on: the config carries the option', on.config.adblock === true);
ok(
	'on: the module is fetched once, from the directory',
	requested.filter((url) => url.endsWith('/stomp/blocker.wasm')).length === 1,
	requested.filter((url) => url.includes('blocker')).join(' '),
);
ok(
	'on: the service worker holds the module, and no rewrite worker was handed it',
	on.modules.serviceWorker.includes('blocker') &&
		!on.modules.rewriteWorkers.flat().includes('blocker') &&
		!off.modules.serviceWorker.includes('blocker'),
	JSON.stringify([off.modules, on.modules]),
);
ok(
	'on: the lists and the resources were fetched through the proxy, not by the browser',
	count(afterOn, 'adblock-list.txt') === 1 &&
		count(afterOn, 'adblock-untrusted.txt') === 1 &&
		count(afterOn, 'adblock-resources.json') === 1 &&
		!requested.some((url) => url.includes('adblock-list')),
	JSON.stringify([
		count(afterOn, 'adblock-list.txt'),
		count(afterOn, 'adblock-resources.json'),
	]),
);
ok(
	'a blocked script never runs, an excepted one and a first-party one do',
	JSON.stringify(report.ran) === JSON.stringify(['allowed', 'third', 'domain']),
	JSON.stringify(report.ran),
);
ok(
	'blocked requests never reach the site',
	[
		'adblock-blocked.js',
		'adblock-pixel.svg',
		'adblock-frame.html',
		'adblock-redirect.js',
	].every((file) => count(afterOn, file) === count(afterOff, file)),
	JSON.stringify(
		Object.fromEntries(
			Object.entries(afterOn).filter(([file]) => file.startsWith('adblock')),
		),
	),
);
ok(
	'a blocked fetch is the network error a content blocker gives',
	report.typedFetch === 'TypeError: Failed to fetch',
	String(report.typedFetch),
);
ok(
	'a blocked image fires error',
	report.pixel === 'error',
	String(report.pixel),
);
ok(
	'the type is the real one: the XHR rule lets the same URL through as an image',
	// once from each of the two sites
	count(afterOn, 'adblock-typed.json') ===
		count(afterOff, 'adblock-typed.json') + 2,
	JSON.stringify([
		count(afterOff, 'adblock-typed.json'),
		count(afterOn, 'adblock-typed.json'),
	]),
);
ok(
	'the party is the real one: the third-party rule blocks the other host only',
	report.thirdParty === 'error' &&
		report.ran.includes('third') &&
		// the first-party load on 127.0.0.1; on localhost both are the reverse
		other.ran.includes('third'),
	JSON.stringify([report.thirdParty, report.ran, other.ran]),
);
ok(
	'a $domain rule applies under the site it names',
	report.ran.includes('domain') && !other.ran.includes('domain'),
	JSON.stringify(other.ran),
);
ok(
	'$redirect answers the script with the stand-in: it loads and the real one never runs',
	report.redirectLoad === 'load' && !report.ran.includes('redirect'),
	String(report.redirectLoad),
);
const logged = (file) => on.log.filter((entry) => entry.url.includes(file));
ok(
	'$removeparam sends the request without the parameter',
	report.param === 200 &&
		logged('adblock-param.json').some((entry) =>
			entry.url.endsWith('adblock-param.json?keep=1'),
		) &&
		!logged('adblock-param.json').some((entry) =>
			entry.url.includes('utm_source'),
		),
	JSON.stringify(logged('adblock-param.json')),
);
ok(
	'the host is told what was blocked',
	logged('adblock-blocked.js').some(
		(entry) =>
			entry.status === 0 &&
			entry.kind === 'blocked' &&
			/blocker/.test(entry.error),
	),
	JSON.stringify(logged('adblock-blocked.js')),
);
ok('an unlisted request is untouched', report.plain === 200);

ok(
	'the generic, site and attribute rules hide their elements',
	report.shown.generic === false &&
		report.shown['adblock-generic-id'] === false &&
		report.shown.attr === false &&
		report.shown.specific === false &&
		report.shown.kept === true,
	JSON.stringify(report.shown),
);
ok(
	'an element added later is hidden once its class is known',
	report.shown.late === false,
);
ok(
	'procedural filters hide what they match',
	report.shown.procedural === false && report.shown.upward === false,
	JSON.stringify(report.shown),
);
ok(
	'action filters style, remove, and strip attributes and classes',
	report.styledColor === 'rgb(1, 2, 3)' &&
		report.shown.styled === true &&
		report.gone === true &&
		report.trackAttribute === null &&
		report.classes === 'adblock-class',
	JSON.stringify([
		report.styledColor,
		report.gone,
		report.trackAttribute,
		report.classes,
	]),
);
ok(
	'nothing is added to the DOM or to the sheets the page can list',
	report.adopted === 0 && report.sheets === 0 && report.styleElements === 0,
	JSON.stringify([report.adopted, report.sheets, report.styleElements]),
);
ok(
	"the page's adopted sheets are its own list, and still apply",
	JSON.stringify(report.adoptedAfter) ===
		JSON.stringify([2, true, true, true, true]) &&
		report.adoptedBad === 'TypeError' &&
		report.adoptedKept === 2 &&
		report.keptOutline === 'solid',
	JSON.stringify([
		report.adoptedAfter,
		report.adoptedBad,
		report.adoptedKept,
		report.keptOutline,
	]),
);
ok(
	"the page's hooked accessor reads as the browser's, and no request of the blocker shows in its timing",
	report.adoptedGetter === offReport.adoptedGetter &&
		/\[native code\]/.test(report.adoptedGetter) &&
		report.timing.length > 0 &&
		!report.timing.some(
			(name) => name.includes(new URL(PROXY).host) || /\/adblock$/.test(name),
		),
	JSON.stringify([report.adoptedGetter, report.timing]),
);
ok(
	'only a procedural match carries an inline style',
	JSON.stringify(report.inlineStyles.sort()) ===
		JSON.stringify(['procedural', 'upward']),
	JSON.stringify(report.inlineStyles),
);
ok(
	"a scriptlet runs before the page's scripts and sees the page's own URL",
	report.spy?.href === site && report.spy?.origin === new URL(site).origin,
	JSON.stringify(report.spy),
);
ok(
	"a scriptlet's wrapper sits over the proxy's hook: it sees the URLs the page passed",
	report.spy?.urls.includes('/pages/adblock-typed.json') &&
		report.spy.urls.includes('/pages/hdr.json'),
	JSON.stringify(report.spy?.urls),
);
ok(
	'trusted scriptlets run for a trusted list only, and leave no function behind',
	report.trusted === true &&
		report.untrusted === null &&
		report.flag === true &&
		report.leakedFunctions.length === 0,
	JSON.stringify([
		report.trusted,
		report.untrusted,
		report.flag,
		report.leakedFunctions,
	]),
);
ok(
	'another site gets its exception, and no site rule or scriptlet',
	other.shown.generic === true &&
		other.shown.late === false &&
		other.shown.specific === true &&
		other.shown.procedural === true &&
		other.spy === null &&
		other.gone === false,
	JSON.stringify(other),
);
ok(
	"a list's $csp reaches the document, without the policy that would stop the shell",
	policies.some((policy) => policy.includes("worker-src 'none'")) &&
		!policies.some((policy) => policy.includes('script-src')) &&
		on.reports.csp.ran === 'yes' &&
		!!on.reports.csp.worker &&
		on.reports.csp.worker !== 'made',
	JSON.stringify([policies, on.reports.csp]),
);

// off again, on the worker that just ran the blocker
const again = await visit(null, { page: site });
ok(
	'off again: a controller without the option blocks and hides nothing',
	again.reports.page.ran.length === 5 &&
		Object.values(again.reports.page.shown).every((shown) => shown === true) &&
		again.reports.page.spy === null,
	JSON.stringify(again.reports.page),
);

// isolation mode: the host page is on another origin, and the option goes
// through the controller frame to the proxy origin's worker
const host = await browser.newPage();
await host.goto(HOST);
await host.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const remoteConfig = await host.evaluate(
	async ({ proxy, fixture, site }) => {
		const remote = new window.StompRemoteController({
			proxyOrigin: proxy.replace(/\/$/, ''),
			directory: '/stomp/',
			transport: {
				module: `${proxy}epoxy/index.mjs`,
				options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
			},
			codec: 'xor',
			cache: false,
			adblock: {
				lists: [{ url: `${fixture}pages/adblock-list.txt`, trusted: true }],
				resources: `${fixture}pages/adblock-resources.json`,
			},
		});
		await remote.wait();
		const element = document.createElement('iframe');
		document.body.append(element);
		await remote.createFrame(element).go(site);
		return remote.config;
	},
	{ proxy: PROXY, fixture: FIXTURE, site },
);
let isolated = null;
for (let i = 0; i < 80 && !isolated; i++) {
	for (const frame of host.frames())
		try {
			if (
				await frame.evaluate(() => typeof window.__adblockReport === 'function')
			)
				isolated = await frame.evaluate(() => window.__adblockReport());
		} catch (error) {
			// a frame that is navigating, or not ours
		}
	if (!isolated) await sleep(250);
}
ok(
	'isolated: the option reaches the proxy origin, which blocks, hides and runs scriptlets',
	remoteConfig?.adblock === true &&
		JSON.stringify(isolated?.ran) ===
			JSON.stringify(['allowed', 'third', 'domain']) &&
		isolated.typedFetch === 'TypeError: Failed to fetch' &&
		isolated.shown.generic === false &&
		isolated.shown.procedural === false &&
		isolated.spy?.href === site,
	JSON.stringify([remoteConfig, isolated]),
);
await done(browser);
