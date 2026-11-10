// Mixed content as Chrome decides it, by the proxied page's own URL. Every
// proxied page is https (or loopback http) in proxy URL space, so Chrome's
// own enforcement never fires for it; the proxy blocks what Chrome blocks
// (active content: scripts, stylesheets, @import, frames, objects, fetch,
// XHR, EventSource, beacons, workers' requests, ws:) and upgrades what
// Chrome upgrades (images, audio, video) on an https page, honours
// upgrade-insecure-requests, and leaves an http page alone. The fixture
// (test/pages/mixed-content.html, served by test/mixed-servers.mjs) runs
// each load and says what the page saw; the sites' logs say which requests
// arrived. Compared with the same page loaded natively over https and over
// http, in both modes, with the console's "Mixed Content" messages.
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startMixedServers } from '../mixed-servers.mjs';

const servers = await startMixedServers();
const { https: A, http: B } = servers.ports;
const pages = {
	https: `https://mixed.test:${A}/pages/mixed-content.html?b=${B}&tag=https`,
	http: `http://mixed.test:${A}/pages/mixed-content.html?b=${B}&tag=http`,
};

/** the requests a run's tag reached each server with, as `server path c` */
const arrived = (tag) =>
	servers.log
		.filter((entry) => {
			const run = entry.c?.split('.')[0];
			return run === tag || run?.startsWith(`${tag}-`);
		})
		.map((entry) => `${entry.server} ${entry.method} ${entry.path} ${entry.c}`)
		.sort();

/**
 * The console's mixed content messages, ports named, sorted. A worker's own
 * (its WebSocket's) are left out: natively Chrome writes them to the
 * worker's console, which the page's console event does not carry
 */
const mixedMessages = (lines) =>
	lines
		.filter(
			(line) =>
				line.includes('Mixed Content') &&
				!line.includes('/pages/mixed-content-worker.js'),
		)
		.map((line) => line.replaceAll(String(A), 'A').replaceAll(String(B), 'B'))
		.sort();

async function results(frame) {
	for (let i = 0; i < 480; i++) {
		const value = await frame
			?.evaluate(() => (window.__mixed?.done ? window.__mixed.results : null))
			.catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

/**
 * A top-level form that targets http: what the frame shows next (Chrome's
 * "Form is not secure" interstitial from an https page, the site's page
 * from an http one), by the title of the first of `frames()` that has one
 */
async function submitTopForm(frame, tag, frames) {
	await frame
		.evaluate(
			([port, tag]) => {
				const form = document.createElement('form');
				form.action = `http://plain.mixed.test:${port}/frame.html`;
				form.innerHTML = `<input name="c" value="${tag}.form-top">`;
				document.body.append(form);
				form.submit();
			},
			[B, tag],
		)
		.catch(() => {});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		for (const candidate of await frames()) {
			const title = await candidate.title().catch(() => '');
			if (title && title !== 'MIXED CONTENT') return title;
		}
	}
	return null;
}

// native: the fixture hosts resolve to the fixture, its certificate is taken
const nativeBrowser = await launch([
	'--ignore-certificate-errors',
	'--host-resolver-rules=MAP mixed.test 127.0.0.1, MAP *.mixed.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
]);
const native = {};
for (const [scheme, url] of Object.entries(pages)) {
	const page = await nativeBrowser.newPage();
	const lines = [];
	page.on('console', (message) =>
		lines.push(`${message.type()} ${message.text()}`),
	);
	await page.goto(url);
	native[scheme] = {
		results: await results(page.mainFrame()),
		form: await submitTopForm(page.mainFrame(), scheme, async () => [
			page.mainFrame(),
		]),
		arrived: arrived(scheme),
		messages: mixedMessages(lines),
	};
	await page.close();
}
await nativeBrowser.close();

ok(
	'natively, an https page blocks active mixed content and upgrades passive',
	native.https.results?.['script-blocked'] === 'error' &&
		/^load 1 https:/.test(native.https.results?.['img-upgraded']) &&
		native.https.results?.['img-upgrade-fails'] === 'error',
	JSON.stringify(native.https.results),
);
ok(
	'natively, an http page loads everything',
	native.http.results?.['script-blocked'] === 'load',
	JSON.stringify(native.http.results),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const [scheme, url] of Object.entries(pages)) {
		const tag = `${mode}-${scheme}`;
		const page = await openDemo(browser, base);
		const lines = [];
		page.on('console', (message) =>
			lines.push(`${message.type()} ${message.text()}`),
		);
		const proxiedURL = url.replace(`tag=${scheme}`, `tag=${tag}`);
		await submitLanding(page, proxiedURL);
		let frame = null;
		for (let i = 0; i < 120 && !frame; i++) {
			await sleep(250);
			for (const f of page.frames())
				if (
					/\/stomp\/[\w-]+\/html\//.test(f.url()) &&
					(await f.evaluate(() => document.title).catch(() => '')) ===
						'MIXED CONTENT'
				)
					frame = f;
		}
		const proxied = await results(frame);
		const expected = native[scheme].results;
		const rename = (value) =>
			JSON.parse(
				JSON.stringify(value ?? null)
					.replaceAll(`=${tag}`, `=${scheme}`)
					.replaceAll(`c=${tag}`, `c=${scheme}`),
			);
		const seen = rename(proxied);
		const differing = Object.keys({ ...expected, ...seen }).filter(
			(name) =>
				JSON.stringify(expected?.[name]) !== JSON.stringify(seen?.[name]),
		);
		ok(
			`${mode}, ${scheme} page: every load turns out as natively`,
			seen !== null && differing.length === 0,
			differing
				.map(
					(name) =>
						`${name}: native ${JSON.stringify(expected?.[name])} proxied ${JSON.stringify(seen?.[name])}`,
				)
				.join('; ') || (seen === null ? 'no report' : 'the same'),
		);
		const form = await submitTopForm(frame, tag, async () =>
			page.frames().filter((f) => /\/stomp\/[\w-]+\/html/.test(f.url())),
		);
		ok(
			`${mode}, ${scheme} page: a top-level form to http shows what it shows natively`,
			form === native[scheme].form,
			`native ${native[scheme].form} proxied ${form}`,
		);
		const reached = arrived(tag).map((line) => line.replace(`${tag}`, scheme));
		const missing = native[scheme].arrived.filter((l) => !reached.includes(l));
		const extra = reached.filter((l) => !native[scheme].arrived.includes(l));
		ok(
			`${mode}, ${scheme} page: the sites get the requests they get natively`,
			missing.length === 0 && extra.length === 0,
			JSON.stringify({ missing, extra }),
		);
		const messages = mixedMessages(lines).map((line) =>
			line.replaceAll(tag, scheme),
		);
		const absent = native[scheme].messages.filter((l) => !messages.includes(l));
		const added = messages.filter((l) => !native[scheme].messages.includes(l));
		ok(
			`${mode}, ${scheme} page: the console says what it says natively`,
			absent.length === 0 && added.length === 0,
			JSON.stringify({ absent, added }),
		);
		await page.close();
	}
}

servers.close();
await done(browser);
