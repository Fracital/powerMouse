// A browser that blocks third-party cookies (Brave and incognito windows by
// default, a setting in Chrome) gives a frame of another site no service
// worker and no storage. The demo opened as localhost isolates on 127.0.0.1,
// another site, so its controller frame could not register the worker and
// nothing loaded ("The user denied permission to use Service Worker"), while
// the same-origin live demo worked. RemoteController.wait() now rejects with
// a StorageBlockedError that says so, and the demo's local default falls
// back to the same-origin controller instead of stopping there.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
	CHROME,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const ARGS = [
	'--no-sandbox',
	'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
];

const ready = (page) =>
	page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);

/** the title of the active tab's page once it has one other than the shell's */
async function tabTitle(page, timeout = 30000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const handle = await page.$('.frame:not(.hidden)');
		const frame = handle && (await handle.contentFrame());
		try {
			const title = frame && (await frame.evaluate(() => document.title));
			if (title) return title;
		} catch (error) {
			// navigating
		}
		await sleep(250);
	}
	return null;
}

await waitForServer(HOST);

// a profile whose cookie setting blocks third-party cookies
const profile = mkdtempSync(join(tmpdir(), 'stomp-storage-blocked-'));
mkdirSync(join(profile, 'Default'));
writeFileSync(
	join(profile, 'Default', 'Preferences'),
	JSON.stringify({ profile: { cookie_controls_mode: 1 } }),
);
const context = await chromium.launchPersistentContext(profile, {
	executablePath: CHROME,
	headless: true,
	args: ARGS,
	viewport: { width: 1280, height: 800 },
});
const errors = [];
try {
	const page = context.pages()[0] || (await context.newPage());
	page.on('pageerror', (error) => errors.push(error.message));
	const consoleLines = [];
	page.on('console', (message) => consoleLines.push(message.text()));
	await page.goto(HOST);
	await ready(page);
	const status = await page.evaluate(
		() => document.getElementById('logMsg').textContent,
	);
	ok(
		'blocked third-party cookies: the localhost demo gets ready',
		status === 'Ready',
		status,
	);
	const mode = await page.evaluate(() => ({
		remote: 'proxyOrigin' in (window.controller || {}),
		frames: document.querySelectorAll('iframe[title="Stomp controller"]')
			.length,
	}));
	ok(
		'it runs the same-origin controller, without the blocked controller frame',
		!mode.remote && mode.frames === 0,
		JSON.stringify(mode),
	);
	ok(
		'the console says why isolation is off',
		consoleLines.some((line) =>
			/blocks storage for http:\/\/127\.0\.0\.1/.test(line),
		),
		JSON.stringify(consoleLines.filter((line) => /Mode|Isolation/.test(line))),
	);
	await submitLanding(page, `${FIXTURE}pages/hist-1.html`);
	const title = await tabTitle(page);
	ok('a page loads through it', title === 'HIST 1', String(title));

	// what a host of its own sees from RemoteController
	const rejected = await page.evaluate(async (proxy) => {
		const remote = new window.StompRemoteController({
			proxyOrigin: proxy,
			directory: '/stomp/',
			transport: {
				module: `${proxy}epoxy/index.mjs`,
				options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
			},
			codec: 'xor',
		});
		try {
			await Promise.race([
				remote.wait(),
				new Promise((resolve, reject) =>
					setTimeout(() => reject(new Error('no answer in 20 s')), 20000),
				),
			]);
			return { name: 'resolved' };
		} catch (error) {
			return { name: error.name, message: error.message };
		} finally {
			remote.element.remove();
		}
	}, PROXY);
	ok(
		'RemoteController.wait() rejects with a StorageBlockedError that names the cause',
		rejected.name === 'StorageBlockedError' &&
			/third-party cookies/.test(rejected.message) &&
			!rejected.message.startsWith('StorageBlockedError'),
		JSON.stringify(rejected),
	);
} finally {
	await context.close();
	rmSync(profile, { recursive: true, force: true });
}

// the control: a browser that allows them keeps the isolated controller
const browser = await launch();
const page = await browser.newPage();
await page.goto(HOST);
await ready(page);
const control = await page.evaluate(() => ({
	status: document.getElementById('logMsg').textContent,
	remote: 'proxyOrigin' in (window.controller || {}),
}));
ok(
	'third-party cookies allowed: localhost stays isolated',
	control.status === 'Ready' && control.remote,
	JSON.stringify(control),
);
await done(browser, errors);
