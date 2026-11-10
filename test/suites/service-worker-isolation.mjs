// One proxied site's emulated service worker never sees or serves another
// site's requests, clients or caches (docs/service-workers.md), and nothing
// real is ever registered on the proxy origin. Site A (the suite's own
// server, test/sw-site.mjs) registers a worker whose scope is A's whole
// origin (Service-Worker-Allowed: /) and remembers every request it gets;
// then site B (the fixture, sw-iso-b.html, no worker) opens in another tab,
// fetches a probe of its own and one of A's (A's worker would answer both
// "from A"), puts a secret in a cache, and asks for registrations and for
// A's; then A, in a third tab, asks its worker what it saw. Both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startSite } from '../sw-site.mjs';

const site = await startSite();
const b = new URL(FIXTURE).origin;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

async function wait(page, key) {
	let value = null;
	for (let i = 0; i < 160 && !value?.[key]; i++) {
		await sleep(250);
		value = await page
			.frames()
			.findLast((frame) => ROUTED.test(frame.url()))
			?.evaluate(() => window.__sw)
			.catch(() => null);
	}
	return value ?? {};
}

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	const recorder = await recordRequests(page.context());
	const scopes = new Set();
	const cdp = await page.context().newCDPSession(page);
	cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
		for (const registration of registrations)
			if (!registration.isDeleted) scopes.add(registration.scopeURL);
	});
	await cdp.send('ServiceWorker.enable');

	await submitLanding(page, `${site.origin}/a/iso.html?run=${mode}&step=1`);
	const first = await wait(page, 'done');
	ok(
		`${mode}: site A's worker takes A's whole origin`,
		first.done && first.log?.join() === 'cacheable cacheable from A',
		JSON.stringify(first),
	);

	await submitLanding(
		page,
		`${FIXTURE}pages/sw-iso-b.html?a=${encodeURIComponent(site.origin)}`,
	);
	const other = (await wait(page, 'done')).result ?? {};
	ok(
		`${mode}: A's worker answers none of B's requests, to B or to A`,
		!!other.own && other.own !== 'from A' && other.toA !== 'from A',
		JSON.stringify(other),
	);
	ok(
		`${mode}: B sees no registration and no controller, and may not register or read A's`,
		other.registrations === 0 &&
			other.registration === 'undefined' &&
			other.controller === 'null' &&
			other.registerA === 'SecurityError' &&
			other.getA === 'SecurityError',
		JSON.stringify(other),
	);

	const secret = `${b}/pages/secret`;
	await submitLanding(
		page,
		`${site.origin}/a/iso.html?run=${mode}&step=2&secret=${encodeURIComponent(secret)}`,
	);
	const report = (await wait(page, 'done')).report ?? {};
	ok(
		`${mode}: A's worker saw requests of A only`,
		Array.isArray(report.seen) &&
			report.seen.length > 0 &&
			report.seen.every((url) => url.startsWith(`${site.origin}/`)),
		JSON.stringify(report.seen),
	);
	ok(
		`${mode}: A's worker's clients are A's pages only, B's tab open beside them`,
		Array.isArray(report.clients) &&
			report.clients.length >= 2 &&
			report.clients.every((url) => url.startsWith(`${site.origin}/`)),
		JSON.stringify(report.clients),
	);
	ok(
		`${mode}: A's worker's caches hold neither B's cache nor Stomp's own HTTP cache`,
		Array.isArray(report.keys) &&
			report.keys.length === 0 &&
			report.shared === null &&
			report.stomp === null,
		JSON.stringify(report),
	);
	ok(
		`${mode}: the only real registration is Stomp's own`,
		scopes.size > 0 && [...scopes].every((scope) => scope.endsWith('/stomp/')),
		JSON.stringify([...scopes]),
	);
	ok(
		`${mode}: no request left past the proxy`,
		recorder.raw().length === 0,
		JSON.stringify(recorder.raw().map((entry) => entry.url)),
	);
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await cdp.detach().catch(() => {});
	await page.close();
}
await site.close();
await done(browser);
