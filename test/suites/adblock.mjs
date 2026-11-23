// The built-in blocker through the proxy (docs/adblock.md), with a list and
// resources that are fixture files (test/pages/adblock-list.txt), fetched by
// the service worker through the transport like any page's request.
//
// Off (`adblock: false`): the controller's config has no `adblock`, the
// module is never fetched, nothing asks the worker for rules, and the page
// loads everything and hides nothing.
//
// By default (the option left out) the blocker is on with the default lists,
// which are asked of the transport and of nothing else; lists that cannot be
// had and a module the host does not serve leave the proxy working without
// it, said once on the console. With no engine stored, a navigation waits
// for the directory's engine snapshot (a second at the most) and not for the
// lists, which replace it once fetched and built; with no snapshot either, it
// does not wait.
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
//
// WebSockets never pass the service worker: the controller asks it from the
// handshake hook and refuses a listed socket, which then fails as a socket
// the browser could not connect does (measured in the suite, natively) and
// never reaches the fixture's /ws-echo, from a window, a dedicated worker,
// a shared worker and a service worker alike.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { done, FIXTURE, HOST, launch, ok, OUT, PROXY, sleep } from '../lib.mjs';

// an engine snapshot of a fixture list (adblock-yt-spa.txt), compiled and
// serialized as scripts/adblock-snapshot.mjs makes the directory's, and not
// gzipped (as a host that answered the file with Content-Encoding: gzip
// hands it to the worker): the controller is told it is the directory's
// (assets.adblockSnapshot), and the fixture serves it (/out/)
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
writeFileSync(
	`${OUT}adblock-snapshot-entry.mjs`,
	`export { BlockerInstance, OP, FLAG_TRUSTED } from ${JSON.stringify(`${root}src/blocker/instance.ts`)};\n` +
		`export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n`,
);
await build({
	entryPoints: [`${OUT}adblock-snapshot-entry.mjs`],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	outfile: `${OUT}adblock-snapshot-engine.mjs`,
	logLevel: 'silent',
});
{
	const { BlockerInstance, OP, FLAG_TRUSTED, compileModule } = await import(
		`${OUT}adblock-snapshot-engine.mjs`
	);
	const builder = new BlockerInstance(
		await compileModule(readFileSync(`${root}dist/blocker.wasm`)),
	);
	builder.call(
		readFileSync(`${root}test/pages/adblock-yt-spa.txt`, 'utf8'),
		OP.addList | FLAG_TRUSTED,
	);
	builder.call('', OP.build);
	writeFileSync(`${OUT}adblock-snapshot-spa.dat`, builder.bytes());
}

const browser = await launch();
const page = await browser.newPage();
const requested = [];
page.on('request', (request) => requested.push(request.url()));
const consoleLines = [];
page.on('console', (message) =>
	consoleLines.push([message.type(), message.text()]),
);
// every request of the context, the service worker's among them
const contextRequested = [];
page.context().on('request', (request) => contextRequested.push(request.url()));
const policies = [];
// what the directory's engine snapshot was answered with, by its URL
const snapshotAnswers = [];
page.context().on('response', (response) => {
	if (/\/adblock-snapshot\.dat/.test(response.url()))
		snapshotAnswers.push([
			response.url(),
			response.status(),
			response.headers()['cache-control'],
			response.headers()['content-type'],
			response.headers()['content-encoding'] ?? null,
		]);
});
page.on('response', (response) => {
	const policy = response.headers()['content-security-policy'];
	if (policy) policies.push(policy);
});
// the demo's own controller runs without the blocker (the run's default is
// the fixture list, test/run.mjs): the module's fetches counted below are
// those of this suite's controllers
await page.goto(`${PROXY}?noadblock`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const hits = async () => (await fetch(`${FIXTURE}hits`)).json();
const count = (table, file) => table[file]?.requests ?? 0;

/**
 * a controller with `adblock` (left out when undefined), a frame on the
 * fixture page, and what the page reports. `mirror`: what the transport
 * answers the default lists' URLs with (a URL of the fixture each, `null`
 * for one that is not there), `delay` ms late: the controller's transport
 * is the demo's, wrapped, and `asked` is every URL off this machine that it
 * was asked for. `assets`: the controller's `assets`. `until`: the name of
 * a script of the page; the last page is loaded again, a second apart,
 * until that script no longer runs (the engine was built meanwhile), and
 * the report of the load after that one is `reports.built`
 */
const visit = (
	adblock,
	pages,
	{ mirror = null, delay = 0, assets, until = '' } = {},
) =>
	page.evaluate(
		async ({ adblock, pages, mirror, delay, assets, until, fixture }) => {
			const log = [];
			const asked = [];
			const real = window.controller.transport;
			const transport = !mirror
				? real
				: new Proxy(real, {
						get(target, key) {
							if (key === 'request')
								return async (remote, ...rest) => {
									let url = new URL(remote);
									if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
										asked.push(url.href);
										if (delay)
											await new Promise((resolve) =>
												setTimeout(resolve, delay),
											);
										// a URL not mapped answers 404 (the fixture's
										// pages/ answers any name with a page)
										url = new URL(
											mirror[url.href] ??
												`${fixture}early-js?n=adblock-missing`,
										);
									}
									return target.request(url, ...rest);
								};
							const value = Reflect.get(target, key);
							return typeof value === 'function' ? value.bind(target) : value;
						},
					});
			const controller = new window.StompController({
				serviceworker: window.controller.serviceworker,
				transport,
				directory: window.controller.directory.pathname,
				codec: 'xor',
				cache: false,
				onRequest: (info) => log.push(info),
				...(adblock === undefined ? {} : { adblock }),
				...(assets ? { assets } : {}),
			});
			await controller.wait();
			const modules = await controller.wasmModules();
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			const out = { config: controller.config, modules, reports: {}, ms: {} };
			for (const [name, url] of Object.entries(pages)) {
				const load = new Promise((resolve) =>
					element.addEventListener('load', resolve, { once: true }),
				);
				const started = performance.now();
				await frame.go(url);
				await load;
				out.ms[name] = Math.round(performance.now() - started);
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
			let settledLoads = 0;
			for (let i = 0; until && i < 30; i++) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				const load = new Promise((resolve) =>
					element.addEventListener('load', resolve, { once: true }),
				);
				await frame.go(Object.values(pages).at(-1));
				await load;
				const win = element.contentWindow;
				for (let j = 0; j < 100 && !win.__adblockReport; j++)
					await new Promise((resolve) => setTimeout(resolve, 100));
				out.reports.built = await win.__adblockReport();
				// the load during which the engine was built has the rules for
				// its requests and not those of its shell: the one after it counts
				if (out.reports.built.ran.includes(until)) continue;
				if (settledLoads++) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
			out.log = log.map(({ url, status, error, kind }) => ({
				url,
				status,
				error,
				kind,
			}));
			out.asked = asked;
			element.remove();
			return out;
		},
		{ adblock, pages, mirror, delay, assets, until, fixture: FIXTURE },
	);

const site = `${FIXTURE}pages/adblock.html`;
const otherSite = site.replace('127.0.0.1', 'localhost');
const socketSite = (tag) => `${FIXTURE}pages/adblock-ws.html?tag=${tag}`;
/** whether the handshake of the socket `kind` a phase's `context` opened reached the fixture */
const reached = async (kind, tag, context) =>
	(await (
		await fetch(
			`${FIXTURE}echo-headers/recorded?k=adblock-ws-${kind}.${tag}.${context}`,
		)
	).json()) !== null;
/** a socket's sequence without what names the one socket */
const shape = (sequence) =>
	JSON.stringify(
		(sequence ?? []).map((step) =>
			step[0] === 'message' ? ['message', typeof step[1]] : step,
		),
	);
const opened = (sequence) =>
	Array.isArray(sequence) && sequence.some((step) => step[0] === 'open');

// the browser's own sequences, from the fixture page loaded without the
// proxy: a socket to a port nothing listens on (what a page sees of a socket
// a content blocker refused is the same: error, then close with 1006, both
// CLOSED and in one task; Chrome for Testing 156 with a declarativeNetRequest
// rule, 2026-11-10) and one that connects
const deadPort = await new Promise((resolve, reject) => {
	const probe = createServer();
	probe.on('error', reject);
	probe.listen(0, '127.0.0.1', () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
const nativePage = await browser.newPage();
await nativePage.goto(socketSite('native'));
const nativeRefused = shape(
	await nativePage.evaluate(
		(url) => window.__socketSequence(url),
		`ws://127.0.0.1:${deadPort}/ws-echo`,
	),
);
const nativeOpen = shape(
	await nativePage.evaluate(
		(url) => window.__socketSequence(url),
		`${FIXTURE.replace('http', 'ws')}ws-echo?k=adblock-ws-open.native.window`,
	),
);
await nativePage.close();
ok(
	'natively a refused socket is an error and a close with 1006 in one task, both CLOSED',
	nativeRefused ===
		JSON.stringify([
			['constructed', 0],
			['microtask', 0],
			['error', 3, '[object Event]', false, false],
			['close', 3, 1006, '', false, '', '', 0],
			['task queued in error'],
		]),
	nativeRefused,
);

// off
const before = await hits();
const off = await visit(
	false,
	{ page: site, sockets: socketSite('off') },
	{ mirror: {} },
);
const afterOff = await hits();
const offReport = off.reports.page;
ok(
	'off: the config says nothing of the blocker',
	!('adblock' in off.config),
	JSON.stringify(off.config),
);
ok(
	'off: the module is never fetched and the worker is never asked for rules',
	![...requested, ...contextRequested].some((url) =>
		/blocker\.wasm|\/adblock$/.test(url),
	),
	[...requested, ...contextRequested]
		.filter((url) => /blocker\.wasm|\/adblock$/.test(url))
		.join(' '),
);
ok(
	'off: no list and no resources are asked for, of the transport or of anything',
	off.asked.length === 0 &&
		count(afterOff, 'adblock-resources.json') ===
			count(before, 'adblock-resources.json'),
	JSON.stringify(off.asked),
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

const offSockets = off.reports.sockets;
ok(
	'off: every socket connects, from the window and from each kind of worker',
	Object.values(offSockets.window).every(opened) &&
		[offSockets.worker, offSockets.shared, offSockets.serviceWorker].every(
			(context) => opened(context.blocked) && opened(context.open),
		) &&
		(await reached('blocked', 'off', 'window')) &&
		(await reached('blocked', 'off', 'worker')) &&
		shape(offSockets.window.blocked) === nativeOpen,
	JSON.stringify([offSockets, nativeOpen]),
);
ok(
	'off: the worker is not asked about sockets and reports none',
	!off.log.some((entry) => entry.url.startsWith('ws')),
	JSON.stringify(off.log.filter((entry) => entry.url.startsWith('ws'))),
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
		sockets: socketSite('on'),
		socketsOther: socketSite('other').replace('127.0.0.1', 'localhost'),
	},
);
const afterOn = await hits();
const report = on.reports.page;
const other = on.reports.other;
console.log('INFO on:', JSON.stringify(report));
ok('on: the config carries the option', on.config.adblock === true);
ok(
	'on: the module is fetched once, from the directory',
	// (asked for by its hash, src/version.ts BLOCKER)
	requested.filter((url) => /\/stomp\/blocker\.wasm(\?|$)/.test(url)).length ===
		1,
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
	// fetched through the proxy at least once (the exact count is timing-
	// dependent under parallel/loaded CI; what matters is it went through the
	// proxy, not the browser)
	count(afterOn, 'adblock-list.txt') >= 1 &&
		count(afterOn, 'adblock-untrusted.txt') >= 1 &&
		count(afterOn, 'adblock-resources.json') >= 1 &&
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
	"a list's $csp reaches the document, without the policy that would stop the shell, its worker-src naming only the proxy's own worker",
	policies.some((policy) =>
		/worker-src http:\/\/[^ ,;]+\/stomp\/[\w-]+\/sealer$/.test(policy),
	) &&
		!policies.some((policy) => policy.includes('script-src')) &&
		on.reports.csp.ran === 'yes' &&
		!!on.reports.csp.worker &&
		on.reports.csp.worker !== 'made',
	JSON.stringify([policies, on.reports.csp]),
);

// WebSockets
const sockets = on.reports.sockets;
const socketsOther = on.reports.socketsOther;
console.log('INFO sockets:', JSON.stringify(sockets));
ok(
	'a listed socket fails as a socket the browser could not connect does',
	shape(sockets.window.blocked) === nativeRefused &&
		shape(sockets.window.plain) === nativeRefused &&
		shape(sockets.window.third) === nativeRefused,
	JSON.stringify([sockets.window, nativeRefused]),
);
ok(
	'and never reaches the site',
	!(await reached('blocked', 'on', 'window')) &&
		!(await reached('plain', 'on', 'window')) &&
		!(await reached('third', 'on', 'window')),
);
ok(
	'an unlisted socket connects and echoes, as natively',
	shape(sockets.window.open) === nativeOpen &&
		sockets.window.open.some(
			(step) =>
				step[0] === 'message' && /adblock-ws-open\.on\.window/.test(step[1]),
		) &&
		(await reached('open', 'on', 'window')),
	JSON.stringify([sockets.window.open, nativeOpen]),
);
ok(
	'an exception rule lets a listed socket through, and a rule for another type does not block it',
	opened(sockets.window.excepted) &&
		opened(sockets.window.image) &&
		(await reached('excepted', 'on', 'window')) &&
		(await reached('image', 'on', 'window')),
	JSON.stringify([sockets.window.excepted, sockets.window.image]),
);
ok(
	"a socket's party and $domain come from the page that opens it",
	opened(sockets.window.firstParty) &&
		opened(sockets.window.domain) &&
		shape(socketsOther.window.domain) === nativeRefused &&
		shape(socketsOther.window.third) === nativeRefused &&
		opened(socketsOther.window.firstParty),
	JSON.stringify([sockets.window, socketsOther.window]),
);
for (const [context, name, key] of [
	['worker', 'a dedicated worker', 'worker'],
	['shared', 'a shared worker', 'shared'],
	['serviceWorker', 'a service worker', 'sw'],
])
	ok(
		`${name}'s listed socket is refused the same way, and its unlisted one connects`,
		shape(sockets[context].blocked) === nativeRefused &&
			shape(sockets[context].open) === nativeOpen &&
			!(await reached('blocked', 'on', key)) &&
			(await reached('open', 'on', key)),
		JSON.stringify(sockets[context]),
	);
const socketLog = on.log.filter((entry) => entry.url.startsWith('ws'));
ok(
	'the host is told of a blocked socket, and of no other',
	socketLog.length > 0 &&
		socketLog.every(
			(entry) =>
				entry.status === 0 &&
				entry.kind === 'blocked' &&
				/blocker/.test(entry.error) &&
				/adblock-ws-(blocked|plain|third|domain)\./.test(entry.url),
		) &&
		socketLog.some((entry) => entry.url.includes('adblock-ws-blocked.on.sw')),
	JSON.stringify(socketLog),
);

// off again, on the worker that just ran the blocker
const again = await visit(false, { page: site });
ok(
	'off again: a controller with the option off blocks and hides nothing',
	again.reports.page.ran.length === 5 &&
		Object.values(again.reports.page.shown).every((shown) => shown === true) &&
		again.reports.page.spy === null,
	JSON.stringify(again.reports.page),
);

// by default: a controller that says nothing of the blocker has it, with
// the default lists. Their servers are not this machine's, and this browser
// resolves no name but the loopback ones (lib.mjs launch), so the
// controller's transport answers their URLs from the fixture and notes what
// it was asked: a list that arrives came through the transport
// the default resources are uBlock Origin's, the directory's own file
// (scripts/adblock-resources.mjs), which the worker reads from its origin
const RESOURCES = `${PROXY}stomp/adblock-resources.json`;
const EASYLIST = 'https://easylist.to/easylist/easylist.txt';
const UBLOCK = 'https://ublockorigin.github.io/uAssets/filters/';
const LISTS = [
	EASYLIST,
	'https://easylist.to/easylist/easyprivacy.txt',
	...[
		'filters.min.txt',
		'unbreak.min.txt',
		'badware.min.txt',
		'privacy.min.txt',
		'resource-abuse.txt',
		'quick-fixes.min.txt',
	].map((file) => UBLOCK + file),
];
const everything = (report) =>
	JSON.stringify(report?.ran) ===
		JSON.stringify(['blocked', 'allowed', 'redirect', 'third', 'domain']) &&
	Object.values(report.shown).every((shown) => shown === true) &&
	report.spy === null;
const said = (type, pattern) =>
	consoleLines.filter(([kind, text]) => kind === type && pattern.test(text));
const unservedAssets = { blocker: 'adblock-unserved.wasm' };
/** a directory that does not serve the engine snapshot (a host that copies the files it always copied) */
const noSnapshot = { adblockSnapshot: 'adblock-unserved.dat' };

// a host that does not serve the module (one that took the package's new
// version and copies the files it always copied)
consoleLines.length = 0;
const unserved = await visit(
	undefined,
	{ page: site },
	{ mirror: {}, assets: unservedAssets },
);
ok(
	'default, the module not served: the proxy works without the blocker and asks for no list',
	!('adblock' in unserved.config) &&
		everything(unserved.reports.page) &&
		unserved.asked.length === 0,
	JSON.stringify([unserved.config.adblock, unserved.reports, unserved.asked]),
);
ok(
	'default, the module not served: said once on the console, and not as a warning',
	said('info', /content blocker is off, its module did not load/).length ===
		1 && said('warning', /blocker/).length === 0,
	JSON.stringify(consoleLines),
);
consoleLines.length = 0;
const refused = await visit(
	true,
	{ page: site },
	{ mirror: {}, assets: unservedAssets },
);
ok(
	'asked for, the module not served: the warning of before, and the proxy works without the blocker',
	said('warning', /the blocker module did not load/).length === 1 &&
		said('info', /content blocker/).length === 0 &&
		!('adblock' in refused.config) &&
		everything(refused.reports.page),
	JSON.stringify([consoleLines, refused.config.adblock, refused.reports]),
);

// no list to be had and no snapshot (the resources come first, and without
// them nothing is built): the page loads unfiltered, at once
const workerLines = [];
for (const worker of page.context().serviceWorkers())
	worker.on('console', (message) =>
		workerLines.push([message.type(), message.text()]),
	);
const listless = await visit(
	undefined,
	{ page: site },
	{ mirror: {}, assets: noSnapshot },
);
ok(
	'default, no list to be had and no snapshot: asked of the transport, and the page loads unfiltered without a wait',
	listless.config.adblock === true &&
		listless.asked.includes(EASYLIST) &&
		!listless.asked.includes(RESOURCES) &&
		everything(listless.reports.page) &&
		listless.ms.page < 4000,
	JSON.stringify([listless.asked, listless.ms, listless.reports]),
);
await sleep(300);
const listlessAgain = await visit(
	undefined,
	{ page: site },
	{ mirror: {}, assets: noSnapshot },
);
ok(
	'default, no list to be had and no snapshot: the next controller tries again, and the worker says once that the blocker is off',
	listlessAgain.asked.includes(EASYLIST) &&
		workerLines.filter(
			([kind, text]) =>
				kind === 'info' &&
				/content blocker is off: no filter list could be fetched/.test(text),
		).length === 1 &&
		!workerLines.some(([kind]) => kind === 'warning'),
	JSON.stringify([listlessAgain.asked, workerLines]),
);

// no list to be had, the directory's snapshot served (assets/adblock-
// snapshot.dat.gz, every default list, gzipped): the worker reads it from
// its own origin by its hash, as the bytes it is (no Content-Encoding), and
// the host lets the browser keep it for good; the worker gunzips it, the
// page waits for it alone, and the snapshot serves (nothing says the blocker
// is off, as it would once the lists failed with no snapshot loaded). The
// snapshot has every rule of the default lists, so their refresh waits for
// the pages to go quiet (src/server/blocker.ts listTurn): none is asked
// within the visit
const snapshotted = await visit(undefined, { page: site }, { mirror: {} });
console.log('INFO snapshot:', JSON.stringify(snapshotted.reports.page));
ok(
	"default, no list to be had: the directory's gzipped snapshot is read from its own origin by its hash, as bytes, kept for good, and the lists wait for the pages to go quiet",
	snapshotted.config.adblock === true &&
		!snapshotted.asked.includes(EASYLIST) &&
		snapshotted.reports.page?.ran?.includes('allowed') &&
		snapshotted.ms.page < 4000 &&
		snapshotAnswers.length >= 1 &&
		snapshotAnswers.every(
			([url, status, cache, type, encoding]) =>
				/\/stomp\/adblock-snapshot\.dat\.gz\?[0-9a-f]{16}$/.test(url) &&
				url.startsWith(PROXY) &&
				status === 200 &&
				/immutable/.test(cache ?? '') &&
				type === 'application/octet-stream' &&
				encoding === null,
		),
	JSON.stringify([
		snapshotted.asked,
		snapshotted.ms,
		snapshotAnswers,
		snapshotted.reports,
	]),
);
ok(
	'default, no list to be had: the snapshot is gunzipped and serves, and nothing more says the blocker is off',
	workerLines.filter(([, text]) => /content blocker is off/.test(text))
		.length === 1 && !workerLines.some(([kind]) => kind === 'warning'),
	JSON.stringify(workerLines),
);

// the lists a second and a half away each, with no engine stored yet (a
// first visit), and the directory's snapshot one of a fixture list:
// the first navigation waits for the snapshot (a second at the most) and not
// for the lists, whose engine replaces it once built. A page that loaded
// before an engine served runs none of the scriptlets for as long as it is
// open, and a YouTube watch page is open for every video after it: a related
// video is the player's fetch of the next one's data (adblock-yt-spa.html,
// the player's fetch taken from a frame of its own), so its pre-roll ads
// played on every in-app navigation
const mirror = {
	[`${UBLOCK}filters.min.txt`]: `${FIXTURE}pages/adblock-list.txt`,
	[`${UBLOCK}quick-fixes.min.txt`]: `${FIXTURE}pages/adblock-yt-spa.txt`,
	[EASYLIST]: `${FIXTURE}pages/adblock-untrusted.txt`,
};
const listServers = (url) =>
	/^https?:\/\/(easylist\.to|ublockorigin\.github\.io|raw\.githubusercontent\.com)\//.test(
		url,
	);
const beforeDefault = await hits();
consoleLines.length = 0;
const first = await visit(
	undefined,
	{ spa: `${FIXTURE}pages/adblock-yt-spa.html`, page: site },
	{
		mirror,
		delay: 1500,
		assets: { adblockSnapshot: `${FIXTURE}out/adblock-snapshot-spa.dat` },
		until: 'blocked',
	},
);
const built = first.reports.built;
ok(
	"default: the first navigation waits for the snapshot, not the lists, and the player's next video comes without its ad slots (trusted-prevent-dom-bypass, trusted-rpfr)",
	first.config.adblock === true &&
		first.reports.spa?.grabbed === true &&
		JSON.stringify(first.reports.spa.keys) ===
			JSON.stringify([
				'playabilityStatus',
				'playerAds',
				'adPlacements',
				'no_ads',
				'videoDetails',
			]) &&
		first.reports.spa.video === 'stompNext' &&
		first.ms.spa < 2000,
	JSON.stringify([first.ms, first.reports.spa]),
);
const afterDefault = await hits();
ok(
	'default: the default lists are asked of the transport, once each, and the resources of the directory, by the worker',
	JSON.stringify([...first.asked].sort()) ===
		JSON.stringify([...LISTS].sort()) &&
		count(afterDefault, 'adblock-list.txt') ===
			count(beforeDefault, 'adblock-list.txt') + 1 &&
		count(afterDefault, 'adblock-resources.json') ===
			count(beforeDefault, 'adblock-resources.json') &&
		contextRequested.includes(RESOURCES),
	JSON.stringify([
		first.asked,
		contextRequested.filter((url) => url.includes('resources')),
	]),
);
ok(
	'default: the browser itself asks no list server',
	!requested.some(listServers) && !contextRequested.some(listServers),
	JSON.stringify([...requested, ...contextRequested].filter(listServers)),
);
ok(
	"default: once built the engine blocks, hides and runs uBlock Origin's scriptlets, trusted for uBlock Origin lists only",
	JSON.stringify(built?.ran) ===
		JSON.stringify(['allowed', 'third', 'domain']) &&
		built.typedFetch === 'TypeError: Failed to fetch' &&
		built.shown.generic === false &&
		built.shown.procedural === false &&
		built.set === true &&
		built.trustedSet === true &&
		built.untrustedSet === null &&
		built.leakedFunctions.length === 0,
	JSON.stringify(built),
);
ok(
	'default: a list that is not there is left out without a warning',
	!workerLines.some(([kind]) => kind === 'warning') &&
		said('warning', /filter list|blocker/).length === 0,
	JSON.stringify([workerLines, consoleLines]),
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
		window.__remoteFrame = remote.createFrame(element);
		await window.__remoteFrame.go(site);
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
// its transport is hosted in the controller frame's worker: the refusal
// crosses from the controller to that worker
await host.evaluate(
	(url) => window.__remoteFrame.go(url),
	socketSite('isolated'),
);
let isolatedSockets = null;
for (let i = 0; i < 80 && !isolatedSockets; i++) {
	for (const frame of host.frames())
		try {
			if (
				await frame.evaluate(
					() =>
						document.title === 'adblock sockets' &&
						typeof window.__adblockReport === 'function',
				)
			)
				isolatedSockets = await frame.evaluate(() => window.__adblockReport());
		} catch (error) {
			// a frame that is navigating, or not ours
		}
	if (!isolatedSockets) await sleep(250);
}
ok(
	'isolated: a listed socket is refused through the transport worker, from the window and a worker',
	remoteConfig?.workerTransport === true &&
		shape(isolatedSockets?.window.blocked) === nativeRefused &&
		shape(isolatedSockets.window.open) === nativeOpen &&
		shape(isolatedSockets.worker.blocked) === nativeRefused &&
		opened(isolatedSockets.worker.open) &&
		!(await reached('blocked', 'isolated', 'window')) &&
		!(await reached('blocked', 'isolated', 'worker')) &&
		(await reached('open', 'isolated', 'window')),
	JSON.stringify([remoteConfig, isolatedSockets]),
);
// `false` crosses to the controller frame as it is: left out there, it
// would be the default
const offHost = await browser.newPage();
await offHost.goto(HOST);
await offHost.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const remoteOff = await offHost.evaluate(async (proxy) => {
	const remote = new window.StompRemoteController({
		proxyOrigin: proxy.replace(/\/$/, ''),
		directory: '/stomp/',
		transport: {
			module: `${proxy}epoxy/index.mjs`,
			options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
		},
		codec: 'xor',
		cache: false,
		adblock: false,
	});
	await remote.wait();
	return remote.config;
}, PROXY);
ok(
	'isolated: `adblock: false` reaches the proxy origin, whose config has no blocker',
	remoteOff && !('adblock' in remoteOff),
	JSON.stringify(remoteOff),
);
await offHost.close();

// the demo: on unless something says off (here the run's fixture list,
// STOMP_ADBLOCK in test/run.mjs), and its toggle shows it
const demo = await browser.newPage();
await demo.goto(PROXY);
await demo.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const demoState = await demo.evaluate(() => ({
	adblock: window.controller.config.adblock,
	toggle: document.getElementById('adblock').checked,
}));
ok(
	'demo: the blocker is on by default, and the Block ads toggle is checked',
	demoState.adblock === true && demoState.toggle === true,
	JSON.stringify(demoState),
);
await demo.close();

// Per-site shields (the demo's content-blocker UI, docs/adblock.md): shields
// down for a site turns the blocker off for it, no blocked request, no
// cosmetic hiding, no scriptlet, without breaking STomp's own rewriting;
// shields up blocks again. The state is keyed by the page's host and reaches
// the worker over the controller's `shields` RPC.
const shieldsRun = await page.evaluate(
	async ({ fixture, site }) => {
		const log = [];
		const controller = new window.StompController({
			serviceworker: window.controller.serviceworker,
			transport: window.controller.transport,
			directory: window.controller.directory.pathname,
			codec: 'xor',
			cache: false,
			onRequest: (info) => log.push(info),
			adblock: {
				lists: [{ url: `${fixture}pages/adblock-list.txt`, trusted: true }],
				resources: `${fixture}pages/adblock-resources.json`,
			},
		});
		await controller.wait();
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = controller.createFrame(element);
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const load = async (url) => {
			const loaded = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(url);
			await loaded;
			const win = element.contentWindow;
			for (let i = 0; i < 100 && !win.__adblockReport; i++) await wait(50);
			return win.__adblockReport ? await win.__adblockReport() : null;
		};
		const host = new URL(site).hostname;
		// blocks of the page's own blocked script since a mark: a request only
		// the blocker stops, so the count is not disturbed by late reports of
		// the previous load's report-time fetches
		const mark = () => {
			const at = log.length;
			return () =>
				log
					.slice(at)
					.filter(
						(e) =>
							e.error &&
							e.error.includes('content blocker') &&
							e.url.includes('adblock-blocked.js'),
					).length;
		};
		// the engine builds on the first load(s); load until the blocker is on
		let up = null;
		for (let i = 0; i < 25; i++) {
			up = await load(site);
			if (up && !up.ran.includes('blocked')) break;
			await wait(600);
		}
		// let late block reports from the shields-up load drain before marking,
		// so the shields-down window counts only its own requests
		await wait(700);
		const downBlocks = mark();
		controller.shields.set(host, { enabled: false });
		await wait(500);
		const down = await load(site);
		await wait(700);
		const downCount = downBlocks();
		const upBlocks = mark();
		// aggressive: the page's own blocked script is a first-party
		// request, which standard mode (a new entry's) leaves to the user's
		// own filters, as Brave's does (the speedtest suite)
		controller.shields.set(host, { enabled: true, mode: 'aggressive' });
		await wait(500);
		const again = await load(site);
		await wait(700);
		const againCount = upBlocks();
		element.remove();
		return { up, down, again, downCount, againCount, host };
	},
	{ fixture: FIXTURE, site },
);
console.log('INFO shields:', JSON.stringify(shieldsRun));
ok(
	'shields up (default): the blocker runs, a blocked script never runs, the elements are hidden, the scriptlet ran',
	!shieldsRun.up.ran.includes('blocked') &&
		shieldsRun.up.gone === true &&
		shieldsRun.up.spy !== null &&
		shieldsRun.up.trackAttribute === null,
	JSON.stringify(shieldsRun.up),
);
ok(
	'shields down: the blocked request now runs, nothing is hidden, no scriptlet, and the rewritten page still works',
	shieldsRun.down.ran.includes('blocked') &&
		shieldsRun.down.gone === false &&
		shieldsRun.down.spy === null &&
		shieldsRun.down.trackAttribute === '1' &&
		shieldsRun.down.ran.includes('allowed') &&
		shieldsRun.down.href === site,
	JSON.stringify(shieldsRun.down),
);
ok(
	'shields down: no request is reported blocked by the content blocker',
	shieldsRun.downCount === 0,
	String(shieldsRun.downCount),
);
ok(
	'shields up again (aggressive): the blocker blocks once more',
	!shieldsRun.again.ran.includes('blocked') &&
		shieldsRun.again.gone === true &&
		shieldsRun.again.spy !== null &&
		shieldsRun.againCount > 0,
	JSON.stringify([shieldsRun.again.ran, shieldsRun.againCount]),
);

await done(browser);
