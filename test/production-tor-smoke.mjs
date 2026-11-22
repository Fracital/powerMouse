// A read-only smoke of the deployed Tor client against the Tor network.
// Unlike test/suites/demo-tor.mjs, this does not use the local stand-in.
// Usage: node test/production-tor-smoke.mjs
import { chromium } from 'playwright-core';

const SITE = process.env.STOMP_BASE ?? 'https://stomp.fracit.al/';
const TARGET = 'https://check.torproject.org/api/ip';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(page, read, matches, timeout) {
	const start = Date.now();
	let state;
	while (Date.now() - start < timeout) {
		state = await page.evaluate(read).catch(() => null);
		if (matches(state)) return state;
		await sleep(250);
	}
	throw new Error(`Timed out after ${timeout} ms: ${JSON.stringify(state)}`);
}

const state = () => ({
	url: location.href,
	status: document.getElementById('logMsg')?.textContent ?? '',
	tor: document.getElementById('tor')?.checked ?? null,
	disabled: document.getElementById('tor')?.disabled ?? null,
});

const browser = await chromium.launch({
	executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
	headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors = [];
	const directRequests = [];
	page.on('pageerror', (error) => errors.push(String(error)));
	page.on('request', (request) => {
		if (new URL(request.url()).hostname === 'check.torproject.org')
			directRequests.push(request.url());
	});

	await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });
	const normal = await waitFor(
		page,
		state,
		(s) => s?.status === 'Ready',
		45000,
	);
	if (normal.tor || normal.disabled) {
		throw new Error(
			`Ordinary mode was not available: ${JSON.stringify(normal)}`,
		);
	}
	console.log(`PASS normal mode: ${normal.status}`);

	// The deployed site may precede the Settings > Proxy menu. In a newer
	// deployment, verify that the control is actually exposed there; then
	// dispatch the change without waiting on its location.replace navigation.
	if (
		await page
			.locator('#settingsTab')
			.isVisible()
			.catch(() => false)
	) {
		await page.click('#settingsTab');
		await page.click('#menuProxy');
		if (!(await page.locator('#tor').isVisible()))
			throw new Error('Tor toggle is not visible in Settings > Proxy');
	}
	await page.evaluate(() => document.getElementById('tor').click());
	const tor = await waitFor(
		page,
		state,
		(s) =>
			s?.tor === true &&
			(/^(Ready \(Tor connected\)|Error)/.test(s.status) ||
				s.status.startsWith('Tor could not connect')),
		120000,
	);
	if (!tor.status.startsWith('Ready (Tor connected)') || !tor.tor) {
		throw new Error(`Tor did not become ready: ${JSON.stringify(tor)}`);
	}
	console.log(`PASS Tor mode: ${tor.status}`);

	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.elements.namedItem('url').value = url;
		form.requestSubmit();
	}, TARGET);

	let result = null;
	const start = Date.now();
	while (Date.now() - start < 120000) {
		for (const frame of page.frames()) {
			const text = await frame
				.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '')
				.catch(() => '');
			try {
				const json = JSON.parse(text);
				if (typeof json.IsTor === 'boolean') {
					result = json.IsTor;
					break;
				}
			} catch {
				// The frame has not loaded its JSON response yet.
			}
		}
		if (result !== null) break;
		await sleep(500);
	}

	// Include the host tab itself: its address is visible to the user as
	// well as the child frames' addresses.
	const frameURLs = page.frames().map((frame) => frame.url());
	const leaked = frameURLs.filter((url) =>
		/[?&](?:tor|notor)(?:=|&|$)|[?&]mode=classic\b/.test(url),
	);
	if (result !== true || leaked.length || directRequests.length) {
		throw new Error(
			JSON.stringify({
				isTor: result,
				leaked,
				directRequests,
				frameURLs,
				errors: errors.slice(0, 8),
			}),
		);
	}
	console.log('PASS check.torproject.org: IsTor=true');
	console.log(
		'PASS no Tor-mode markers in proxied frame URLs or direct target requests',
	);
	await context.close();
} finally {
	await browser.close();
}
