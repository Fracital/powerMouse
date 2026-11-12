// The demo's "Sign in with token" for Discord: the chrome button (#toolToken)
// that writes a pasted Discord token into the proxied page's OWN localStorage
// over a same-browser MessagePort, mirroring the community bookmarklet.
//
// A real Discord login needs real credentials, so the suite serves a plain
// fixture at a discord.com host instead (through the test transport,
// demo/public/test/mixed-transport.mjs, with the fixture port in the URL:
// https://discord.com:<port>/...). The demo's gate reads the page's real host
// (discord.com), so the button behaves exactly as it does on the real site.
// No real token or Discord code is involved.
//
// It proves, in both rewriter modes:
//  - the button is hidden on a non-discord page and shown on the discord host
//    once that page has handed over its port;
//  - a valid token is sent, written JSON-quoted into the page's own
//    localStorage, and the page navigates to /channels/@me;
//  - a cancelled, empty, or whitespace-bearing entry sends and stores nothing;
//  - a token pasted with its own quotes is unwrapped once;
//  - SECURITY: the token value never appears in any proxied request (the
//    demo's own request log) nor in anything the fixture origin received, so
//    it never leaves the browser.
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	omni,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';

const FIX = new URL(FIXTURE);
// the same fixture, reached once as its own host (not discord) and once as a
// discord.com host through the test transport
const NON_DISCORD = `${FIXTURE}pages/discord-token.html`;
const DISCORD = `https://discord.com:${FIX.port}/pages/discord-token.html`;
const CHANNELS = `https://discord.com:${FIX.port}/channels/@me`;

const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last */
async function until(page, read, want, timeout = 30000, arg) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const tokenHidden = (page) =>
	page.evaluate(() => document.getElementById('toolToken').hidden);
const statusText = (page) =>
	page.evaluate(() => document.getElementById('chromeStatus').textContent);

/** the proxied page's own localStorage.token, read in the frame's realm */
async function storedToken(page) {
	const frame = await activeFrame(page);
	if (!frame) return 'NO_FRAME';
	return frame
		.evaluate(() => {
			try {
				return localStorage.getItem('token');
			} catch {
				return 'THREW';
			}
		})
		.catch(() => 'DETACHED');
}

/** poll the proxied page's localStorage.token until it is `want`, else last */
async function pollStored(page, want, timeout = 10000) {
	const start = Date.now();
	let value = null;
	while (Date.now() - start < timeout) {
		value = await storedToken(page);
		if (value === want) return value;
		await sleep(200);
	}
	return value;
}

/** clear the proxied page's own localStorage, in its realm */
async function clearStore(page) {
	const frame = await activeFrame(page);
	await frame?.evaluate(() => localStorage.clear()).catch(() => {});
}

/**
 * Queue a prompt() answer, click #toolToken, and wait for the click to run.
 * `answer === null` cancels the prompt; a string accepts it with that text.
 */
async function clickToken(page, answer) {
	page.__dialogs.push(answer);
	await page.click('#toolToken');
	await sleep(400); // the prompt was answered and the handler ran
}

async function run(mode, base) {
	await waitForServer(base);
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	const page = await context.newPage();
	page.__dialogs = [];
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	// answer prompts from the queue: a queued null cancels, a string accepts
	page.on('dialog', async (dialog) => {
		const answer = page.__dialogs.length ? page.__dialogs.shift() : null;
		if (answer === null) await dialog.dismiss();
		else await dialog.accept(answer);
	});
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	// listen to the demo's OWN controller: every proxied request reports here
	// (the same reports as the request viewer), so the suite can prove the
	// token never rode out on one
	await page.evaluate(() => {
		window.__reqs = [];
		window.controller.addEventListener('request', (event) => {
			const info = event.detail || {};
			window.__reqs.push({
				url: String(info.url || ''),
				method: String(info.method || ''),
				destination: String(info.destination || ''),
			});
		});
	});

	// a non-discord page: no port, so the button stays hidden
	await submitLanding(page, NON_DISCORD);
	await until(
		page,
		() => document.querySelector('.frame:not(.hidden)'),
		Boolean,
	);
	await until(
		page,
		() => document.getElementById('logMsg').textContent !== 'Loading…',
		Boolean,
	);
	await sleep(1500);
	ok(
		`${mode}: the button is hidden on a non-discord page`,
		(await tokenHidden(page)) === true,
	);

	// the discord host: the page hands over its port and the button shows
	await submitOmni(page, DISCORD);
	const shown = await until(
		page,
		() => !document.getElementById('toolToken').hidden,
		Boolean,
	);
	ok(
		`${mode}: the button shows on the discord host once its port arrives`,
		shown === true,
		`omni=${await omni(page)}`,
	);
	ok(
		`${mode}: nothing is stored before the token is sent`,
		(await storedToken(page)) === null,
		String(await storedToken(page)),
	);

	// cancelling the prompt sends and stores nothing
	await clickToken(page, null);
	ok(
		`${mode}: cancelling the prompt stores nothing`,
		(await storedToken(page)) === null,
		String(await storedToken(page)),
	);

	// an empty entry: the status says so and nothing is stored
	await clickToken(page, '   ');
	ok(
		`${mode}: a whitespace-only (empty) entry stores nothing and warns`,
		(await storedToken(page)) === null &&
			/does not look like a token/.test(await statusText(page)),
		`${await storedToken(page)} / ${await statusText(page)}`,
	);

	// a token with whitespace inside it is rejected, nothing stored
	await clickToken(page, 'has a space');
	ok(
		`${mode}: a token with whitespace inside is rejected`,
		(await storedToken(page)) === null &&
			/does not look like a token/.test(await statusText(page)),
		`${await storedToken(page)} / ${await statusText(page)}`,
	);
	ok(
		`${mode}: the button is still shown after the rejected entries`,
		(await tokenHidden(page)) === false,
	);

	// a valid plain token: written JSON-quoted into the page's own
	// localStorage, and the page navigates to /channels/@me
	const PLAIN = 'Mz.AbCdEf123.ghIJKLmnop-qRsTuv';
	await clickToken(page, PLAIN);
	const reached = await until(
		page,
		() => document.querySelector('#omni input').value,
		(v) => v === CHANNELS,
	);
	ok(
		`${mode}: a valid token navigates to /channels/@me`,
		reached === CHANNELS,
		`omni=${await omni(page)}`,
	);
	// read it back on the page the tab landed on (same origin, so it persisted)
	const plainStored = await pollStored(page, JSON.stringify(PLAIN));
	ok(
		`${mode}: the token is written JSON-quoted into the page's own localStorage`,
		plainStored === JSON.stringify(PLAIN),
		String(plainStored),
	);

	// a token pasted with its own quotes is unwrapped exactly once. The
	// /channels/@me document is a discord host too, so it offers a fresh port;
	// clear the store first so the earlier token does not mask the result.
	await until(
		page,
		() => !document.getElementById('toolToken').hidden,
		Boolean,
	);
	await clearStore(page);
	const QUOTED_INNER = 'Qt.unwrap0nce.XYZ-789';
	await clickToken(page, JSON.stringify(QUOTED_INNER)); // paste '"...token..."'
	const quotedStored = await pollStored(page, JSON.stringify(QUOTED_INNER));
	ok(
		`${mode}: a quoted token is unwrapped once (stored === "${QUOTED_INNER}")`,
		quotedStored === JSON.stringify(QUOTED_INNER),
		String(quotedStored),
	);

	// SECURITY: the token values never rode out on a proxied request, and the
	// fixture origin never received them. The token lived only in the page's
	// localStorage, over the MessagePort, in this browser.
	const reqs = await page.evaluate(() => window.__reqs || []);
	const blob = JSON.stringify(reqs);
	const leakedInReqs = [PLAIN, QUOTED_INNER].filter((t) => blob.includes(t));
	ok(
		`${mode}: no proxied request URL carries the token`,
		leakedInReqs.length === 0,
		`reqs=${reqs.length} leaked=${JSON.stringify(leakedInReqs)}`,
	);
	// what the fixture origin actually received over the wire
	const served = await fetch(`${FIXTURE}requests`)
		.then((r) => r.json())
		.catch(() => []);
	const servedBlob = JSON.stringify(served);
	const leakedInServed = [PLAIN, QUOTED_INNER].filter((t) =>
		servedBlob.includes(t),
	);
	ok(
		`${mode}: the fixture origin never received the token`,
		leakedInServed.length === 0,
		`leaked=${JSON.stringify(leakedInServed)}`,
	);

	await context.close();
}

await Promise.all([run('same-origin', PROXY), run('isolated', HOST)]);
await done(browser, errors);
