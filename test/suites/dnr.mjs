// chrome.declarativeNetRequest through the proxy (docs/extensions-dnr.md):
// extensions' rulesets installed in the service worker (controller.dnr)
// block, redirect (to a URL, by regexSubstitution, by transform, to an
// extensionPath), upgrade and change the request's and the response's
// headers (the Set-Cookie the jar would take among them) of the requests a
// proxied page makes and of its navigation, as Chrome's network stack does
// with the same rules: priorities and allow rules within an extension,
// block over redirect over allow between extensions, allowAllRequests for
// the requests of the document it matched, rules on response headers,
// dynamic rules added and removed, and the feedback calls (getMatchedRules,
// testMatchOutcome). Uninstalled, the requests go as before. A controller
// of our own (it replaces the demo's in the worker), as the rules suite.
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const result = await page.evaluate(async (fixture) => {
	const log = [];
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
		onRequest: (info) => log.push(info),
	});
	await controller.wait();
	const out = {};
	const rule = (id, condition, action, priority) => ({
		id,
		...(priority ? { priority } : {}),
		condition,
		action,
	});
	const rules = [
		rule(
			1,
			{ urlFilter: '/pages/hdr.json', resourceTypes: ['xmlhttprequest'] },
			{ type: 'block' },
		),
		rule(2, { urlFilter: '/pages/hdr.json?allowed' }, { type: 'allow' }, 2),
		rule(
			3,
			{ urlFilter: '/pages/fresh.json?dnr-redirect' },
			{
				type: 'redirect',
				redirect: { url: `${fixture}pages/nostore.json?from=dnr` },
			},
		),
		rule(
			4,
			{ regexFilter: '^(http://127\\.0\\.0\\.1:[0-9]+)/dnr-regex/(.*)$' },
			{ type: 'redirect', redirect: { regexSubstitution: '\\1/pages/\\2' } },
		),
		rule(
			5,
			{ urlFilter: '/pages/fresh.json?dnr-transform' },
			{
				type: 'redirect',
				redirect: {
					transform: {
						queryTransform: {
							removeParams: ['utm_source'],
							addOrReplaceParams: [{ key: 'k', value: 'dnr' }],
						},
					},
				},
			},
		),
		rule(
			6,
			{ urlFilter: '/dnr-extension-path' },
			{
				type: 'redirect',
				redirect: { extensionPath: '/pages/fresh.json?ext' },
			},
		),
		rule(7, { urlFilter: '/dnr-upgrade' }, { type: 'upgradeScheme' }),
		rule(
			8,
			{ urlFilter: '/echo-headers?dnr-request' },
			{
				type: 'modifyHeaders',
				requestHeaders: [
					{ header: 'x-dnr', operation: 'set', value: 'one' },
					{ header: 'accept-language', operation: 'remove' },
					{ header: 'accept', operation: 'append', value: 'text/dnr' },
				],
			},
		),
		rule(
			9,
			{ urlFilter: '/pages/fresh.json?dnr-response' },
			{
				type: 'modifyHeaders',
				responseHeaders: [
					{ header: 'x-dnr-response', operation: 'set', value: 'yes' },
					{ header: 'cache-control', operation: 'remove' },
					{ header: 'x-dnr-list', operation: 'append', value: 'a' },
				],
			},
			2,
		),
		// a lower priority rule's changes to the same response come after
		rule(
			10,
			{ urlFilter: '/pages/fresh.json?dnr-response' },
			{
				type: 'modifyHeaders',
				responseHeaders: [
					{ header: 'x-dnr-list', operation: 'append', value: 'b' },
				],
			},
		),
		rule(
			11,
			{ urlFilter: '/pages/dnr-cookie.json' },
			{
				type: 'modifyHeaders',
				responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
			},
		),
		// the document this matches allows every request it makes
		rule(
			12,
			{
				urlFilter: '/pages/hist-2.html?allow-all',
				resourceTypes: ['main_frame'],
			},
			{ type: 'allowAllRequests' },
			3,
		),
		// a rule on the response's headers
		rule(
			13,
			{
				urlFilter: '/pages/nostore.json?header-condition',
				responseHeaders: [
					{ header: 'content-type', values: ['application/json*'] },
				],
			},
			{ type: 'block' },
		),
		rule(
			14,
			{
				urlFilter: '/pages/hist-1.html?dnr-block',
				resourceTypes: ['main_frame'],
			},
			{ type: 'block' },
		),
		rule(15, { urlFilter: '/pages/fresh.json?cross' }, { type: 'allow' }),
		// a socket never passes the worker: the controller asks for its handshake
		rule(
			16,
			{ urlFilter: '/blocked/ws-echo', resourceTypes: ['websocket'] },
			{ type: 'block' },
		),
	];
	const installed = await controller.dnr({
		op: 'install',
		extension: {
			id: 'a',
			installTime: 1,
			extensionBase: fixture,
			permissions: {
				declarativeNetRequest: true,
				declarativeNetRequestFeedback: true,
			},
			rulesets: [{ id: 'main', rules }],
		},
	});
	out.warnings = installed;
	// a later extension blocks what the first allows: block wins between extensions
	await controller.dnr({
		op: 'install',
		extension: {
			id: 'b',
			installTime: 2,
			rulesets: [
				{
					id: 'other',
					rules: [
						rule(
							1,
							{ urlFilter: '/pages/fresh.json?cross' },
							{ type: 'block' },
						),
					],
				},
			],
		},
	});

	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	const go = async (url) => {
		const load = new Promise((r) =>
			element.addEventListener('load', r, { once: true }),
		);
		await frame.go(url);
		await load;
	};
	await go(`${fixture}pages/hist-1.html`);
	let win = element.contentWindow;
	const fetched = (path, init) =>
		win.fetch(path, init).then(
			async (r) => ({ status: r.status, url: r.url, redirected: r.redirected }),
			(e) => `error ${e.name}`,
		);

	out.blocked = await fetched('/pages/hdr.json');
	out.allowed = await fetched('/pages/hdr.json?allowed');
	out.redirected = await fetched('/pages/fresh.json?dnr-redirect');
	out.regex = await fetched('/dnr-regex/fresh.json?r=1');
	out.transform = await fetched(
		'/pages/fresh.json?dnr-transform&utm_source=x&k=old',
	);
	out.extensionPath = await fetched('/dnr-extension-path');
	out.upgrade = await fetched('/dnr-upgrade?u=1');
	const echoed = await win
		.fetch('/echo-headers?dnr-request', { headers: { accept: 'text/plain' } })
		.then((r) => r.json());
	out.request = {
		dnr: echoed['x-dnr'] ?? null,
		language: echoed['accept-language'] ?? null,
		accept: echoed.accept ?? null,
	};
	const response = await win.fetch('/pages/fresh.json?dnr-response');
	out.response = {
		set: response.headers.get('x-dnr-response'),
		removed: response.headers.get('cache-control'),
		list: response.headers.get('x-dnr-list'),
	};
	await win.fetch('/pages/dnr-cookie.json');
	await win.fetch('/pages/dnr-cookie-kept.json');
	out.cookies = win.document.cookie;
	out.headerCondition = await fetched('/pages/nostore.json?header-condition');
	out.headerConditionOther = await fetched('/pages/nostore.json?no-condition');
	out.cross = await fetched('/pages/fresh.json?cross');
	const socket = (path) =>
		new Promise((resolve) => {
			const ws = new win.WebSocket(
				new URL(path, fixture.replace('http', 'ws')).href,
			);
			ws.onmessage = () => {
				resolve('message');
				ws.close();
			};
			ws.onerror = () => resolve('error');
			setTimeout(() => resolve('timeout'), 10000);
		});
	out.sockets = [
		await socket('/blocked/ws-echo'),
		await socket('/open/ws-echo'),
	];

	// allowAllRequests: the document it matched loads what rule 1 blocks elsewhere
	await go(`${fixture}pages/hist-2.html?allow-all`);
	win = element.contentWindow;
	out.allowAll = await fetched('/pages/hdr.json');
	await go(`${fixture}pages/hist-2.html`);
	win = element.contentWindow;
	out.notAllowAll = await fetched('/pages/hdr.json');

	// a navigation the rules block: a network error, logged as blocked (its
	// report waits for the frame to say who it is, a few seconds at most)
	await go(`${fixture}pages/hist-1.html?dnr-block`);
	const blockedNavigation = () =>
		log.filter((i) => i.url.includes('hist-1.html?dnr-block'));
	for (let i = 0; i < 100 && !blockedNavigation().length; i++)
		await new Promise((r) => setTimeout(r, 100));
	out.navigationLog = blockedNavigation().map((i) => [i.status, i.error]);
	await go(`${fixture}pages/hist-2.html`);
	win = element.contentWindow;

	// dynamic rules, added and removed
	const dynamicRule = rule(
		100,
		{ urlFilter: '/pages/fresh.json?dynamic' },
		{ type: 'block' },
	);
	const before = await fetched('/pages/fresh.json?dynamic');
	await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'updateDynamicRules',
		args: [{ addRules: [dynamicRule] }],
	});
	const during = await fetched('/pages/fresh.json?dynamic');
	out.dynamicRules = await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'getDynamicRules',
		args: [],
	});
	await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'updateDynamicRules',
		args: [{ removeRuleIds: [100] }],
	});
	const after = await fetched('/pages/fresh.json?dynamic');
	out.dynamic = [before, during, after];
	out.duplicate = await controller
		.dnr({
			op: 'call',
			id: 'a',
			method: 'updateDynamicRules',
			args: [{ addRules: [dynamicRule, dynamicRule] }],
		})
		.then(
			() => 'resolved',
			(e) => e.message,
		);

	// feedback
	out.matched = await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'getMatchedRules',
		args: [{}],
	});
	out.test = await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'testMatchOutcome',
		args: [{ url: `${fixture}pages/hdr.json`, type: 'xmlhttprequest' }],
	});
	out.regexSupported = await controller.dnr({
		op: 'call',
		id: 'a',
		method: 'isRegexSupported',
		args: [{ regex: '(?=a)' }],
	});
	out.stats = await controller.dnr({ op: 'stats' });

	await controller.dnr({ op: 'uninstall', id: 'a' });
	await controller.dnr({ op: 'uninstall', id: 'b' });
	out.uninstalled = await fetched('/pages/hdr.json');
	await new Promise((r) => setTimeout(r, 300));
	out.log = log
		.filter((i) => /dnr-upgrade|dnr-redirect/.test(i.url))
		.map((i) => [i.url, i.status, i.error ?? null]);
	return out;
}, FIXTURE);

const fixtureOrigin = FIXTURE.replace(/\/$/, '');
const show = (value) => JSON.stringify(value);
ok(
	'the rulesets install without warnings',
	Array.isArray(result.warnings) && !result.warnings.length,
	show(result.warnings),
);
ok(
	'a block rule fails the request (ERR_BLOCKED_BY_CLIENT)',
	result.blocked === 'error TypeError',
	show(result.blocked),
);
ok(
	'a higher priority allow rule lets it through',
	result.allowed?.status === 200,
	show(result.allowed),
);
ok(
	'a redirect rule sends the request to its URL',
	result.redirected?.status === 200 &&
		result.redirected.redirected &&
		result.redirected.url === `${fixtureOrigin}/pages/nostore.json?from=dnr`,
	show(result.redirected),
);
ok(
	'a regexSubstitution redirect rewrites the URL',
	result.regex?.status === 200 &&
		result.regex.url === `${fixtureOrigin}/pages/fresh.json?r=1`,
	show(result.regex),
);
ok(
	'a transform redirect edits the query',
	result.transform?.status === 200 &&
		// (Chrome writes every kept parameter as key=value)
		result.transform.url ===
			`${fixtureOrigin}/pages/fresh.json?dnr-transform=&k=dnr`,
	show(result.transform),
);
ok(
	"an extensionPath redirect resolves against the extension's base",
	result.extensionPath?.status === 200 &&
		result.extensionPath.url === `${fixtureOrigin}/pages/fresh.json?ext`,
	show(result.extensionPath),
);
ok(
	'an upgradeScheme rule sends the request to https',
	result.log.some(
		([url, status, error]) =>
			url.startsWith('http://') &&
			url.includes('/dnr-upgrade') &&
			status === 307 &&
			/redirected by extension a, rule 7/.test(error),
	) &&
		result.log.some(
			([url]) => url.startsWith('https://') && url.includes('/dnr-upgrade'),
		),
	show(result.log),
);
ok(
	'request headers are set, removed and appended to',
	result.request.dnr === 'one' &&
		result.request.language === null &&
		result.request.accept === 'text/plain, text/dnr',
	show(result.request),
);
ok(
	'response headers are set and removed, and appended to in priority order',
	result.response.set === 'yes' &&
		result.response.removed === null &&
		result.response.list === 'a, b',
	show(result.response),
);
ok(
	'a removed Set-Cookie never reaches the jar',
	/dnr_kept=1/.test(result.cookies) && !/dnr_stripped/.test(result.cookies),
	show(result.cookies),
);
ok(
	"a rule on the response's headers blocks at headers received",
	result.headerCondition === 'error TypeError' &&
		result.headerConditionOther?.status === 200,
	show([result.headerCondition, result.headerConditionOther]),
);
ok(
	'a block of a later extension beats an allow of another',
	result.cross === 'error TypeError',
	show(result.cross),
);
ok(
	'a WebSocket the rules block is refused, another opens',
	result.sockets[0] === 'error' && result.sockets[1] === 'message',
	show(result.sockets),
);
ok(
	'allowAllRequests allows the requests of the document it matched only',
	result.allowAll?.status === 200 && result.notAllowAll === 'error TypeError',
	show([result.allowAll, result.notAllowAll]),
);
ok(
	'a blocked navigation is logged as blocked',
	result.navigationLog.some(
		([status, error]) =>
			status === 0 && /blocked by extension a, rule 14/.test(error ?? ''),
	),
	show(result.navigationLog),
);
ok(
	'a dynamic rule applies once added and stops once removed',
	result.dynamic[0]?.status === 200 &&
		result.dynamic[1] === 'error TypeError' &&
		result.dynamic[2]?.status === 200,
	show(result.dynamic),
);
ok(
	'getDynamicRules answers the rule as added',
	result.dynamicRules?.length === 1 && result.dynamicRules[0].id === 100,
	show(result.dynamicRules),
);
ok(
	"a duplicate rule id is refused with Chrome's message",
	result.duplicate === 'Rule with id 100 does not have a unique ID.',
	show(result.duplicate),
);
ok(
	'getMatchedRules lists the rules that matched',
	Array.isArray(result.matched?.rulesMatchedInfo) &&
		[1, 3, 4, 7, 8, 9, 13, 100].every((id) =>
			result.matched.rulesMatchedInfo.some((info) => info.rule.ruleId === id),
		),
	show(result.matched?.rulesMatchedInfo?.map((info) => info.rule.ruleId)),
);
ok(
	'testMatchOutcome names the rule that would match',
	result.test?.matchedRules?.length === 1 &&
		result.test.matchedRules[0].ruleId === 1,
	show(result.test),
);
ok(
	'isRegexSupported refuses what RE2 does not parse',
	result.regexSupported?.isSupported === false,
	show(result.regexSupported),
);
ok(
	'the worker reports what matching costs per request',
	result.stats?.requests > 0 && result.stats.p50 > 0 && result.stats.p50 < 1000,
	show(result.stats),
);
ok(
	'uninstalled, the request goes out',
	result.uninstalled?.status === 200,
	show(result.uninstalled),
);
await done(browser);
