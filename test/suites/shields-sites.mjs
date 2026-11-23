// Per-site shields follow the tab's site, and strict HTTPS requires it
// (docs/adblock.md "Per-site shields"), in classic tabs and dialed ones.
//
// Strict HTTPS (Brave's "require HTTPS"): a site's top-level page asked for
// over http is upgraded to https; a site that has no https (the https load
// fails at TLS, test/mixed-servers.mjs's plain.mixed.test) gets the
// "Connection is not secure" interstitial and nothing goes to it over http
// until "Continue to site" is picked, which then loads the http page. Under
// "upgrade" the same site's page loads over http as it was asked for, and a
// site that has https is upgraded under strict and loads over https.
//
// Every frame's shields are its tab's top-level page's, as Brave keys them,
// however deep the frame and whatever its site: a frame of another site two
// levels down (pages/shields-frames-*.html, the fixture's other host name)
// gets the top's setting, never its own site's entry. Shields down at the
// top: its scripts run and its requests have their cookies (its own site's
// entry blocks both); shields up at the top blocking scripts and cookies:
// none run and its requests have no cookies (its own site's shields are
// down). Its frame's navigation and its image are read at the fixture (their
// Sec-Fetch-Storage-Access, or their Cookie where the request has no
// partition), its script by its beacon.
import {
	activeFrame,
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';
import { startMixedServers } from '../mixed-servers.mjs';

const servers = await startMixedServers();
const { https: A, http: B } = servers.ports;
const fixtureJSON = async (path) => (await fetch(`${FIXTURE}${path}`)).json();
const fixturePort = new URL(FIXTURE).port;

const browser = await launch();
const errors = [];

/** the requests that reached the plain (http only) server with case tag `c` */
const plainArrived = (c) =>
	servers.log.filter((entry) => entry.server === 'plain' && entry.c === c);

/**
 * The active frame's title and the origin its page saw, once `want` holds
 * of them (else the last read)
 */
async function shown(page, want, timeout = 30000) {
	let value = null;
	for (const start = Date.now(); Date.now() - start < timeout;) {
		const frame = await activeFrame(page);
		value =
			(await frame
				?.evaluate(() => ({
					title: document.title,
					origin: document.getElementById('origin')?.textContent ?? null,
					host: document.querySelector('strong')?.textContent ?? null,
				}))
				.catch(() => null)) ?? value;
		if (value && want(value)) return value;
		await sleep(250);
	}
	return value;
}
/** the fixture's page, loaded from `origin` */
const pageAt = (origin) => (value) =>
	value.title === 'shields https' && value.origin === origin;
/** the strict interstitial, for `host` */
const interstitial = (host) => (value) =>
	value.title === 'Connection is not secure' && value.host === host;

async function strict(label, base, run) {
	const strictHost = `${run}.plain.mixed.test`;
	const upgradeHost = `${run}-up.plain.mixed.test`;
	const page = await openDemo(browser, base);
	await page.evaluate(
		([strictHost, upgradeHost]) => {
			window.controller.shields.set(strictHost, { httpsUpgrade: 'strict' });
			window.controller.shields.set(upgradeHost, { httpsUpgrade: 'upgrade' });
			window.controller.shields.set('mixed.test', { httpsUpgrade: 'strict' });
		},
		[strictHost, upgradeHost],
	);
	await sleep(500); // the shields reach the worker before the navigation

	// a site with https: upgraded, and loads over https
	await submitLanding(
		page,
		`http://mixed.test:${A}/pages/shields-https.html?c=${run}-secure`,
	);
	const secureAt = pageAt(`https://mixed.test:${A}`);
	const secure = await shown(page, secureAt);
	ok(
		`${label}strict: a site with https asked for over http loads over https`,
		!!secure && secureAt(secure),
		JSON.stringify(secure),
	);

	// a site with no https: the interstitial, and nothing sent over http
	const blockedTag = `${run}-strict`;
	await submitOmni(
		page,
		`http://${strictHost}:${B}/pages/shields-https.html?c=${blockedTag}`,
	);
	const blocked = await shown(page, interstitial(strictHost));
	ok(
		`${label}strict: a site with no https shows the interstitial`,
		!!blocked && interstitial(strictHost)(blocked),
		JSON.stringify(blocked),
	);
	await sleep(1000);
	ok(
		`${label}strict: nothing went to the site over http before the user went on`,
		plainArrived(blockedTag).length === 0,
		JSON.stringify(plainArrived(blockedTag)),
	);
	// "Continue to site": the http page, knowingly
	await (await activeFrame(page))?.click('#proceed-button').catch(() => {});
	const proceededAt = pageAt(`http://${strictHost}:${B}`);
	const proceeded = await shown(page, proceededAt);
	ok(
		`${label}strict: "Continue to site" loads the site's page over http`,
		!!proceeded &&
			proceededAt(proceeded) &&
			plainArrived(blockedTag).length > 0,
		JSON.stringify([proceeded, plainArrived(blockedTag)]),
	);

	// upgrade: the same kind of site loads over http, no interstitial
	const upgradeTag = `${run}-upgrade`;
	await submitOmni(
		page,
		`http://${upgradeHost}:${B}/pages/shields-https.html?c=${upgradeTag}`,
	);
	const fallenAt = pageAt(`http://${upgradeHost}:${B}`);
	const fallen = await shown(page, fallenAt);
	ok(
		`${label}upgrade: a site with no https loads over http`,
		!!fallen && fallenAt(fallen) && plainArrived(upgradeTag).length > 0,
		JSON.stringify([fallen, plainArrived(upgradeTag)]),
	);
	errors.push(...page.errors);
	await page.close();
}

/** what the frames two levels down did and sent under one setting */
async function deepFrames(page, key) {
	await submitOmni(page, `${FIXTURE}pages/shields-frames-top.html?k=${key}`);
	let img = null;
	let nav = null;
	for (let i = 0; i < 120 && !(img && nav); i++) {
		await sleep(250);
		img ??= await fixtureJSON(`echo-headers/recorded?k=${key}-img`);
		nav ??= await fixtureJSON(`echo-headers/recorded?k=${key}-nav`);
	}
	// (the script runs before the image's answer could tell it ran)
	let ran = null;
	for (let i = 0; i < 12 && !ran?.ran; i++) {
		await sleep(250);
		ran = await fixtureJSON(`echo-post/log?k=${key}`);
	}
	return { img, nav, ran: !!ran?.ran };
}

/** whether a request was sent its cookies: its storage access, or its Cookie where it has none */
const credentialed = (headers) =>
	headers?.['sec-fetch-storage-access'] !== undefined
		? headers['sec-fetch-storage-access'] === 'active'
		: /(^|; )sf=1/.test(headers?.cookie ?? '');

async function frames(label, base, run) {
	const page = await openDemo(browser, base);
	// a cookie of the frames' site, which a request that may send cookies
	// without a partition sends
	await submitLanding(
		page,
		`http://localhost:${fixturePort}/pages/shields-frames-top.html?k=${run}-seed`,
	);
	await waitActive(page, () => document.title === 'shields frames top');
	await (
		await activeFrame(page)
	).evaluate(() => {
		document.cookie = 'sf=1; path=/';
	});
	await sleep(500);

	// shields down at the top, the frames' own site blocking scripts and
	// cookies: the top's setting holds
	await page.evaluate(() => {
		window.controller.shields.set('127.0.0.1', { enabled: false });
		window.controller.shields.set('localhost', {
			cookies: 'all',
			blockScripts: true,
		});
	});
	await sleep(500);
	const down = await deepFrames(page, `${run}-down`);
	console.log(`# ${label}top down: ${JSON.stringify(down)}`);
	ok(
		`${label}shields down at the top: a third-party frame two levels down runs its scripts`,
		down.ran,
		JSON.stringify(down),
	);
	ok(
		`${label}shields down at the top: that frame's navigation and its image keep their cookies`,
		credentialed(down.nav) && credentialed(down.img),
		JSON.stringify([down.nav, down.img]),
	);

	// shields up at the top blocking scripts and cookies, the frames' own
	// site's shields down: the top's setting holds
	await page.evaluate(() => {
		window.controller.shields.set('127.0.0.1', {
			enabled: true,
			cookies: 'all',
			blockScripts: true,
		});
		window.controller.shields.set('localhost', { enabled: false });
	});
	await sleep(500);
	const up = await deepFrames(page, `${run}-up`);
	console.log(`# ${label}top up: ${JSON.stringify(up)}`);
	ok(
		`${label}shields up at the top: a third-party frame two levels down runs no script`,
		!up.ran && !!up.img,
		JSON.stringify(up),
	);
	ok(
		`${label}shields up at the top: that frame's navigation and its image have no cookies`,
		!!up.nav && !!up.img && !credentialed(up.nav) && !credentialed(up.img),
		JSON.stringify([up.nav, up.img]),
	);
	await page.evaluate(() => {
		window.controller.shields.set('127.0.0.1', {
			cookies: 'allow',
			blockScripts: false,
		});
		window.controller.shields.set('localhost', {
			enabled: true,
			cookies: 'allow',
			blockScripts: false,
		});
	});
	errors.push(...page.errors);
	await page.close();
}

for (const [label, base, run] of [
	['', `${PROXY}?nopool`, 'classic'],
	['dialing: ', `${PROXY}?nopool&mode=just-call-stomp`, 'dial'],
]) {
	await strict(label, base, run);
	await frames(label, base, run);
}

servers.close();
await done(browser, errors);
