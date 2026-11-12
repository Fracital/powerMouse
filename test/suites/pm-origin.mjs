// Cross-origin postMessage origins, as a Cloudflare Turnstile widget and its
// embedder exchange them. Every proxied site shares the proxy's one origin,
// so the membrane has to carry the real origins: a message between two
// proxied sites must arrive with event.origin set to the sender's real
// origin, and targetOrigin must gate by the real origins. A top on one site
// (127.0.0.1) embeds an iframe on another (localhost); each posts the other
// with an explicit targetOrigin (its real origin, a third origin, and `*`)
// and records what it received. Every value is compared with the same pages
// loaded natively, in both demo modes. (Measured 2026-11-12: STomp already
// delivers these as natively, so this guards the membrane against a
// regression; the Turnstile loop is the interactive-challenge escalation, a
// separate fidelity gap, not a postMessage fault.)
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const A = new URL(FIXTURE).origin;
const B = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const target = `${FIXTURE}pages/pm-origin.html?child=${encodeURIComponent(B)}`;

/** the origins each role received a message under, by tag, once both are done */
async function collect(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const roles = {};
		for (const frame of page.frames()) {
			const pm = await frame
				.evaluate(() => window.__pm ?? null)
				.catch(() => null);
			if (pm?.done) roles[pm.role] = pm;
		}
		if (roles.top && roles.child) return roles;
	}
	return {};
}

/** the origin a role saw for `tag`, or 'withheld' when the message never arrived */
const seen = (role, tag) =>
	role?.got.find((m) => m.tag === tag)?.origin ?? 'withheld';

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await collect(nativePage);
await nativePage.close();
ok(
	'natively, the pages report',
	!!native.top && !!native.child,
	JSON.stringify(Object.keys(native)),
);
// the native truths the comparison rests on: the receiver sees the sender's
// real origin, and a wrong targetOrigin is withheld
ok(
	'natively, the child sees the top real origin, and a wrong targetOrigin is withheld',
	seen(native.child, 'to-child-right') === A &&
		seen(native.child, 'to-child-star') === A &&
		seen(native.child, 'to-child-wrong') === 'withheld',
	JSON.stringify(native.child?.got),
);
ok(
	'natively, the top sees the child real origin, and a wrong targetOrigin is withheld',
	seen(native.top, 'to-parent-right') === B &&
		seen(native.top, 'to-parent-star') === B &&
		seen(native.top, 'to-parent-wrong') === 'withheld',
	JSON.stringify(native.top?.got),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await collect(page);
	for (const [role, tags] of [
		['child', ['to-child-right', 'to-child-star', 'to-child-wrong']],
		['top', ['to-parent-right', 'to-parent-star', 'to-parent-wrong']],
	])
		for (const tag of tags)
			ok(
				`${mode}: ${role} ${tag} origin is Chrome's`,
				seen(proxied[role], tag) === seen(native[role], tag),
				JSON.stringify({
					proxied: seen(proxied[role], tag),
					native: seen(native[role], tag),
				}),
			);
	await page.close();
}

await done(browser);
