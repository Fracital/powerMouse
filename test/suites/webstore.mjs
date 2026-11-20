// The Chrome Web Store's "Add to Chrome" (docs/extensions.md "The Chrome Web
// Store"). A server here plays the store and its update service: a detail
// page at https://chromewebstore.google.com/detail/... (through the
// suite transport) that calls
// chrome.webstorePrivate and chrome.management as the real store's page
// does, its icon, and the package clients2.google.com hands out. It proves,
// on the isolated host and the same-origin one:
//  - the store's page has the two namespaces and chrome.runtime, in
//    Chrome's order and shapes (functions of length 0 shown as native, the
//    enums, the events); a page of another host has none of them;
//  - a call that does not fit its schema throws Chrome's TypeError, and a
//    bad id, a bad icon or a completeInstall with no approval answer
//    Chrome's errors (with the Result the callback gets);
//  - a call with no click behind it shows no dialog and answers
//    user_gesture_required;
//  - the button's click shows the host's dialog (Add "<name>"?, It can:,
//    Chrome's warnings, the store's icon); Cancel answers user_cancelled,
//    Add extension installs: completeInstall downloads the package once,
//    management.onInstalled fires and the page shows Remove from Chrome,
//    the bar gets the extension's button and its content script runs on
//    its site but not on the store's;
//  - after a reload the store sees it installed (getAll, getExtensionStatus
//    enabled, Chrome's ExtensionInfo fields);
//  - Remove from Chrome asks (Remove "<name>"?), Cancel keeps it with
//    Chrome's error, Remove takes it off: onUninstalled, the bar's button
//    goes, and after a reload the page offers Add to Chrome again;
//  - with the network (no SKIP_NETWORK), the real store's ChatGPT page shows
//    an enabled Add to Chrome, and its click the host's dialog.
/* global chrome -- the store page's, in the functions evaluated there */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseCrx } from '../../src/extensions/crx.ts';
import { readZip } from '../../src/extensions/zip.ts';
import {
	activeFrame,
	done,
	evaluateQuietly,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';
// The fixture serves the unmodified Store CRX3 of MIT-licensed Video Speed
// Controller 0.11.2 (LICENSE is in the package), not a ZIP with a chosen id.
const ID = 'nffaoalbilbmmfgbnbgppjihopabppdk';
const PACKAGE = readFileSync(
	new URL('../fixtures/videospeed-0.11.2.crx', import.meta.url),
);
const entries = readZip(parseCrx(PACKAGE).zip);
const file = (name) => entries.find((entry) => entry.name === name).read();
const MANIFEST_TEXT = new TextDecoder().decode(await file('manifest.json'));
const NAME = JSON.parse(MANIFEST_TEXT).name;
const ICON = await file('assets/icons/icon16.png');
const WARNING = 'Read and change all your data on all websites';

/** the detail page: the calls the real store's page makes, and its buttons */
const detailPage = (icon) => `<!doctype html><meta charset="utf-8">
<title>${NAME} - Chrome Web Store</title>
<button id="action" disabled>Loading</button>
<script>
const ID = ${JSON.stringify(ID)};
const MANIFEST = ${JSON.stringify(MANIFEST_TEXT)};
const log = (window.__log = []);
// (the store reads the error so)
const failed = () =>
	chrome.extension?.lastError?.message || chrome.runtime?.lastError?.message;
const button = document.getElementById('action');
let installed = false;
let busy = false;
const render = () => {
	button.disabled = busy;
	button.textContent = busy
		? 'Working'
		: installed
			? 'Remove from Chrome'
			: 'Add to Chrome';
};
chrome.management.getAll((all) => {
	log.push(['getAll', all.map((info) => info.id)]);
	installed = all.some((info) => info.id === ID);
	render();
});
chrome.management.onInstalled.addListener((info) => {
	log.push(['onInstalled', info.id]);
	if (info.id === ID) {
		installed = true;
		busy = false;
		render();
	}
});
chrome.management.onUninstalled.addListener((id) => {
	log.push(['onUninstalled', id]);
	if (id === ID) {
		installed = false;
		busy = false;
		render();
	}
});
chrome.webstorePrivate.getExtensionStatus(ID, MANIFEST, (status) =>
	log.push(['status', status]),
);
button.onclick = () => {
	busy = true;
	render();
	if (installed)
		chrome.management.uninstall(ID, { showConfirmDialog: true }, () => {
			const error = failed();
			log.push(['uninstall', error ?? null]);
			if (error) {
				busy = false;
				render();
			}
		});
	else
		chrome.webstorePrivate.beginInstallWithManifest3(
			{
				id: ID,
				manifest: MANIFEST,
				localizedName: ${JSON.stringify(NAME)},
				esbAllowlist: true,
				iconUrl: ${JSON.stringify(icon)},
			},
			(result) => {
				const error = failed();
				log.push(['begin', result, error ?? null]);
				if (error) {
					busy = false;
					return render();
				}
				chrome.webstorePrivate.completeInstall(ID, () => {
					const error = failed();
					log.push(['complete', error ?? null]);
					if (error) {
						busy = false;
						render();
					}
				});
			},
		);
};
</script>`;

let downloads = 0;
let damaged = false;
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://store.test');
	if (url.pathname === '/origin-check') {
		response.writeHead(200, { 'content-type': 'text/html' });
		return response.end('<title>Origin check</title>');
	}
	if (url.pathname.startsWith('/detail/')) {
		response.writeHead(200, { 'content-type': 'text/html' });
		return response.end(detailPage('/icon.png'));
	}
	if (url.pathname === '/icon.png') {
		response.writeHead(200, { 'content-type': 'image/png' });
		return response.end(ICON);
	}
	if (url.pathname === '/bad-icon.png') {
		response.writeHead(200, { 'content-type': 'image/png' });
		return response.end('not a picture');
	}
	if (url.pathname === '/service/update2/crx') {
		downloads++;
		response.writeHead(200, {
			'content-type': 'application/x-chrome-extension',
		});
		if (!damaged) return response.end(PACKAGE);
		const copy = Buffer.from(PACKAGE);
		copy[copy.length - 1] ^= 1;
		return response.end(copy);
	}
	response.writeHead(404);
	response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const STORE = `https://chromewebstore.google.com/detail/store-probe/${ID}`;
const OTHER = `${FIXTURE}pages/bookmark-a.html`;

const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
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

/** the store tab's frame, once its page shows its button */
async function storeFrame(page, text) {
	const start = Date.now();
	while (Date.now() - start < 30000) {
		const frame = await activeFrame(page);
		const shown = await frame
			?.evaluate(() => document.getElementById('action')?.textContent)
			.catch(() => null);
		if (shown && (text === undefined ? shown !== 'Loading' : shown === text))
			return frame;
		await sleep(200);
	}
	return activeFrame(page);
}

const buttonText = (frame) =>
	frame
		.evaluate(() => document.getElementById('action').textContent)
		.catch(() => null);
const pageLog = (frame) => frame.evaluate(() => window.__log).catch(() => null);

/** the host's dialog: its title, lines, items, buttons and icon */
const dialog = (page) =>
	page.evaluate(() => {
		const box = document.getElementById('passkeyPrompt');
		if (!box) return null;
		return {
			title: box.querySelector('.title')?.textContent,
			detail: [...box.querySelectorAll('p.detail')].map((p) => p.textContent),
			items: [...box.querySelectorAll('ul.items > li')].map(
				(li) => li.textContent,
			),
			buttons: [...box.querySelectorAll('.passkeyButtons button')].map(
				(button) => button.textContent,
			),
			icon: box.querySelector('.passkeyHead img')?.getAttribute('src') ?? '',
		};
	});
const answerDialog = async (page, label) => {
	// (its buttons take a click once the guard has passed)
	await sleep(700);
	await page.click(`#passkeyPrompt .passkeyButtons button:text-is("${label}")`);
	await until(page, () => !document.getElementById('passkeyPrompt'), Boolean);
};
const barButtons = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#extActions .extAction')].map(
			(button) => button.title || button.getAttribute('aria-label') || '',
		),
	);

/** a call of the page's, to the store's API: its callback's value and lastError */
const called = (frame, area, name, args) =>
	frame.evaluate(
		([area, name, args]) =>
			new Promise((resolve) =>
				chrome[area][name](...args, (...values) =>
					resolve({
						values,
						error: chrome.runtime.lastError?.message ?? null,
					}),
				),
			),
		[area, name, args],
	);

async function run(mode, base) {
	// Only this browser context replaces the test transport. The live arm
	// receives the real module, and no request can change the fixture's port.
	const page = await openDemo(browser, base, {}, (page) =>
		page.context().route('**/test/mixed-transport.mjs', (route) =>
			route.fulfill({
				status: 200,
				headers: {
					'content-type': 'text/javascript',
					'access-control-allow-origin': '*',
					'cross-origin-resource-policy': 'cross-origin',
				},
				body: `import Epoxy from '../epoxy/index.mjs';
		export default class extends Epoxy {
			request(remote, ...rest) {
				const url = new URL(remote);
				if (url.hostname === 'chromewebstore.google.com' || url.origin === 'https://clients2.google.com') {
					url.protocol = 'http:'; url.hostname = '127.0.0.1'; url.port = '${PORT}';
				}
				return super.request(url, ...rest);
			}
		}`,
			}),
		),
	);
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	const consoleErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});

	// ---- a page of another host has none of it
	await submitLanding(
		page,
		`https://chromewebstore.google.com:${PORT}/origin-check`,
	);
	let frame = null;
	for (let tries = 0; tries < 100 && !frame; tries++) {
		const found = await activeFrame(page);
		if (
			await found
				?.evaluate(() => document.title === 'Origin check')
				.catch(() => false)
		)
			frame = found;
		else await sleep(200);
	}
	const other = await frame.evaluate(() => ({
		webstorePrivate: typeof chrome?.webstorePrivate,
		management: typeof chrome?.management,
	}));
	ok(
		`${mode}: a different port on the store host gets no privileged API`,
		other.webstorePrivate === 'undefined' && other.management === 'undefined',
		JSON.stringify(other),
	);

	// ---- the store's page
	await submitOmni(page, STORE);
	frame = await storeFrame(page, 'Add to Chrome');
	ok(
		`${mode}: the store's page offers Add to Chrome`,
		(await buttonText(frame)) === 'Add to Chrome',
		String(await buttonText(frame)),
	);
	const shape = await frame.evaluate(() => {
		const show = (fn) => Function.prototype.toString.call(fn);
		const keys = Object.keys(chrome);
		const ws = chrome.webstorePrivate;
		const mg = chrome.management;
		return {
			keys,
			wsKeys: Object.keys(ws),
			mgKeys: Object.keys(mg),
			rtKeys: Object.keys(chrome.runtime),
			lengths: [...Object.values(ws), ...Object.values(mg)]
				.filter((value) => typeof value === 'function')
				.every((fn) => fn.length === 0),
			source: show(ws.beginInstallWithManifest3),
			result: ws.Result,
			installType: mg.ExtensionInstallType,
			event: Object.getOwnPropertyNames(Object.getPrototypeOf(mg.onInstalled)),
			sameProto:
				Object.getPrototypeOf(mg.onInstalled) ===
				Object.getPrototypeOf(mg.onUninstalled),
			lastError: 'lastError' in chrome.runtime,
			descriptor: Object.getOwnPropertyDescriptor(chrome, 'webstorePrivate'),
		};
	});
	ok(
		`${mode}: chrome has webstorePrivate, management and runtime after its own members`,
		JSON.stringify(shape.keys.slice(-3)) ===
			'["webstorePrivate","management","runtime"]' &&
			shape.descriptor.writable &&
			shape.descriptor.enumerable &&
			shape.descriptor.configurable,
		JSON.stringify(shape.keys),
	);
	ok(
		`${mode}: webstorePrivate's members are Chrome's, in its order`,
		JSON.stringify(shape.wsKeys) ===
			JSON.stringify([
				'beginInstallWithManifest3',
				'completeInstall',
				'enableAppLauncher',
				'getBrowserLogin',
				'getExtensionStatus',
				'getFullChromeVersion',
				'getIsLauncherEnabled',
				'getMV2DeprecationStatus',
				'getReferrerChain',
				'getStoreLogin',
				'getWebGLStatus',
				'install',
				'isInIncognitoMode',
				'isPendingCustodianApproval',
				'logEnterprisePromoShown',
				'onEnterprisePromoClick',
				'setStoreLogin',
				'shouldShowEnterprisePromotionBanner',
				'ExtensionInstallStatus',
				'MV2DeprecationStatus',
				'PromotionType',
				'Result',
				'WebGlStatus',
			]),
		JSON.stringify(shape.wsKeys),
	);
	ok(
		`${mode}: management's members are Chrome's, in its order`,
		JSON.stringify(shape.mgKeys) ===
			JSON.stringify([
				'onDisabled',
				'onEnabled',
				'onUninstalled',
				'onInstalled',
				'createAppShortcut',
				'generateAppForLink',
				'get',
				'getAll',
				'getPermissionWarningsById',
				'launchApp',
				'setEnabled',
				'setLaunchType',
				'uninstall',
				'ExtensionDisabledReason',
				'ExtensionInstallType',
				'ExtensionType',
				'LaunchType',
			]),
		JSON.stringify(shape.mgKeys),
	);
	ok(
		`${mode}: chrome.runtime is a web page's`,
		JSON.stringify(shape.rtKeys) ===
			JSON.stringify([
				'dynamicId',
				'id',
				'connect',
				'sendMessage',
				'ContextType',
				'OnInstalledReason',
				'OnLoadedReason',
				'OnRestartRequiredReason',
				'PlatformArch',
				'PlatformNaclArch',
				'PlatformOs',
				'RequestUpdateCheckStatus',
			]) && !shape.lastError,
		JSON.stringify(shape.rtKeys),
	);
	ok(
		`${mode}: the functions have length 0 and read as native`,
		shape.lengths &&
			shape.source === 'function beginInstallWithManifest3() { [native code] }',
		shape.source,
	);
	ok(
		`${mode}: the enums are Chrome's (Result's '' key, sorted keys)`,
		shape.result[''] === '' &&
			Object.keys(shape.result)[1] === 'ALREADY_INSTALLED' &&
			shape.result.USER_GESTURE_REQUIRED === 'user_gesture_required' &&
			JSON.stringify(shape.installType) ===
				'{"ADMIN":"admin","DEVELOPMENT":"development","NORMAL":"normal","OTHER":"other","SIDELOAD":"sideload"}',
		JSON.stringify(shape.result),
	);
	ok(
		`${mode}: the events share one prototype with Chrome's members`,
		shape.sameProto &&
			JSON.stringify(shape.event) ===
				'["addListener","removeListener","hasListener","hasListeners","dispatch","constructor"]',
		JSON.stringify(shape.event),
	);
	const loaded = await pageLog(frame);
	ok(
		`${mode}: the page's load calls answer as Chrome's (no extension, installable)`,
		JSON.stringify(loaded.find((entry) => entry[0] === 'getAll')) ===
			'["getAll",[]]' &&
			JSON.stringify(loaded.find((entry) => entry[0] === 'status')) ===
				'["status","installable"]',
		JSON.stringify(loaded),
	);

	// a call that does not fit its schema, and the worker's errors
	const thrown = await frame.evaluate((id) => {
		const caught = (run) => {
			try {
				run();
				return 'no error';
			} catch (error) {
				return `${error.constructor.name}: ${error.message}`;
			}
		};
		return [
			caught(() => chrome.webstorePrivate.getExtensionStatus(5)),
			caught(() =>
				chrome.webstorePrivate.beginInstallWithManifest3({
					id: 'abc',
					manifest: '{}',
				}),
			),
			caught(() =>
				chrome.webstorePrivate.beginInstallWithManifest3({ id }, () => {}),
			),
			caught(() => chrome.management.onInstalled.addListener(5)),
		];
	}, ID);
	ok(
		`${mode}: a call that fits no signature throws Chrome's TypeError`,
		thrown[0] ===
			'TypeError: Error in invocation of webstorePrivate.getExtensionStatus(string id, optional string manifest, optional function callback): No matching signature.',
		thrown[0],
	);
	ok(
		`${mode}: a property's error is Chrome's (its length, a missing one)`,
		thrown[1] ===
			"TypeError: Error in invocation of webstorePrivate.beginInstallWithManifest3(object details, optional function callback): Error at parameter 'details': Error at property 'id': String must have at least 32 characters; found 3." &&
			thrown[2] ===
				"TypeError: Error in invocation of webstorePrivate.beginInstallWithManifest3(object details, optional function callback): Error at parameter 'details': Missing required property 'manifest'.",
		JSON.stringify(thrown.slice(1, 3)),
	);
	ok(
		`${mode}: an event's listener must be a function`,
		/^TypeError: Error in invocation of management\.onInstalled\.addListener/.test(
			thrown[3],
		),
		thrown[3],
	);
	const statusOfBad = await frame.evaluate(() =>
		chrome.webstorePrivate.getExtensionStatus('nope').then(
			(value) => `resolved ${value}`,
			(error) => `${error.constructor.name}: ${error.message}`,
		),
	);
	ok(
		`${mode}: a bad id rejects the promise with Chrome's error`,
		statusOfBad === 'Error: Invalid id',
		statusOfBad,
	);
	const noApproval = await called(frame, 'webstorePrivate', 'completeInstall', [
		ID,
	]);
	ok(
		`${mode}: completeInstall with no approval answers Chrome's error`,
		noApproval.error ===
			`${ID} does not match a previous call to beginInstallWithManifest3`,
		JSON.stringify(noApproval),
	);
	const badIcon = await called(
		frame,
		'webstorePrivate',
		'beginInstallWithManifest3',
		[{ id: ID, manifest: MANIFEST_TEXT, iconUrl: '/bad-icon.png' }],
	);
	ok(
		`${mode}: an icon that is no picture answers icon_error, Image decode failed`,
		JSON.stringify(badIcon) ===
			JSON.stringify({ values: ['icon_error'], error: 'Image decode failed' }),
		JSON.stringify(badIcon),
	);
	const version = await called(
		frame,
		'webstorePrivate',
		'getFullChromeVersion',
		[],
	);
	ok(
		`${mode}: getFullChromeVersion answers the browser's version`,
		/^\d+\.\d+\.\d+\.\d+$/.test(version.values[0]?.version_number ?? ''),
		JSON.stringify(version),
	);
	await frame.evaluate(
		() =>
			new Promise((resolve) =>
				chrome.webstorePrivate.getExtensionStatus('nope', () => resolve()),
			),
	);
	await sleep(300);
	ok(
		`${mode}: an unread lastError is reported on the console, as Chrome's`,
		consoleErrors.includes('Unchecked runtime.lastError: Invalid id'),
		JSON.stringify(consoleErrors.slice(-3)),
	);

	// ---- no click: no dialog, user_gesture_required. Nothing gives the
	// page or the host an activation for the lifespan of one (5 s)
	await sleep(5500);
	const quiet = await evaluateQuietly(
		frame,
		`new Promise((resolve) => chrome.webstorePrivate.beginInstallWithManifest3(
			{ id: ${JSON.stringify(ID)}, manifest: ${JSON.stringify(MANIFEST_TEXT)}, iconUrl: '/icon.png' },
			(result) => resolve({ result, error: chrome.runtime.lastError?.message ?? null, active: navigator.userActivation.isActive })))`,
	);
	ok(
		`${mode}: a call with no click shows no dialog and answers user_gesture_required`,
		quiet?.result === 'user_gesture_required' &&
			quiet.error === 'This function must be called during a user gesture' &&
			(await dialog(page)) === null,
		JSON.stringify(quiet),
	);

	// ---- the click: the host's dialog, cancelled
	const first = downloads;
	await frame.click('#action');
	const asked = await until(
		page,
		() => !!document.getElementById('passkeyPrompt'),
		Boolean,
	);
	const shown = await dialog(page);
	ok(
		`${mode}: the click shows the host's dialog, worded as Chrome's`,
		asked &&
			shown.title === `Add "${NAME}"?` &&
			JSON.stringify(shown.detail) === '["It can:"]' &&
			JSON.stringify(shown.items) === JSON.stringify([WARNING]) &&
			JSON.stringify(shown.buttons) === '["Add extension","Cancel"]' &&
			shown.icon.startsWith('data:image/png;base64,'),
		JSON.stringify(shown),
	);
	await answerDialog(page, 'Cancel');
	await sleep(300);
	let log = await pageLog(frame);
	ok(
		`${mode}: Cancel answers user_cancelled, User cancelled install`,
		JSON.stringify(log.find((entry) => entry[0] === 'begin')) ===
			'["begin","user_cancelled","User cancelled install"]' &&
			(await buttonText(frame)) === 'Add to Chrome' &&
			downloads === first,
		JSON.stringify(log),
	);

	// A host approval cannot make a damaged archive installable.
	damaged = true;
	await frame.click('#action');
	await until(page, () => !!document.getElementById('passkeyPrompt'), Boolean);
	await answerDialog(page, 'Add extension');
	frame = await storeFrame(page, 'Add to Chrome');
	log = await pageLog(frame);
	ok(
		`${mode}: a changed byte fails signature verification and leaves nothing installed`,
		log.some(
			([call, error]) => call === 'complete' && /signature/i.test(error),
		) &&
			(await page.evaluate(
				async () => (await window.controller.extensions.list()).length,
			)) === 0,
		JSON.stringify(log),
	);
	damaged = false;

	// ---- the click again: Add extension
	const before = downloads;
	await frame.click('#action');
	await until(page, () => !!document.getElementById('passkeyPrompt'), Boolean);
	await answerDialog(page, 'Add extension');
	frame = await storeFrame(page, 'Remove from Chrome');
	log = await pageLog(frame);
	ok(
		`${mode}: Add extension installs: begin answers '', completeInstall, onInstalled`,
		(await buttonText(frame)) === 'Remove from Chrome' &&
			JSON.stringify(log.filter((entry) => entry[0] === 'begin').pop()) ===
				'["begin","",null]' &&
			JSON.stringify(log.findLast((entry) => entry[0] === 'complete')) ===
				'["complete",null]' &&
			log.some((entry) => entry[0] === 'onInstalled' && entry[1] === ID),
		JSON.stringify(log),
	);
	ok(
		`${mode}: completeInstall downloaded the package once`,
		downloads - before === 1,
		String(downloads - before),
	);
	const bar = await until(
		page,
		() => document.querySelectorAll('#extActions .extAction').length,
		(count) => count > 0,
	);
	ok(
		`${mode}: the bar has the extension's button`,
		bar > 0,
		JSON.stringify(await barButtons(page)),
	);
	ok(
		`${mode}: no extension scripts the store's page`,
		(await frame.evaluate(() => !!window.VSC)) === false,
	);
	const again = await called(
		frame,
		'webstorePrivate',
		'beginInstallWithManifest3',
		[{ id: ID, manifest: MANIFEST_TEXT }],
	);
	ok(
		`${mode}: a second install answers already_installed`,
		JSON.stringify(again) ===
			JSON.stringify({
				values: ['already_installed'],
				error: 'This item is already installed',
			}),
		JSON.stringify(again),
	);

	// ---- a reload: the store sees it installed
	await submitOmni(page, STORE);
	await sleep(500);
	frame = await storeFrame(page, 'Remove from Chrome');
	const info = await frame.evaluate(async (id) => {
		const all = await chrome.management.getAll();
		return {
			all,
			status: await chrome.webstorePrivate.getExtensionStatus(id),
			warnings: await chrome.management.getPermissionWarningsById(id),
		};
	}, ID);
	const mine = info.all.find((item) => item.id === ID) ?? {};
	ok(
		`${mode}: after a reload the page offers Remove from Chrome, and the status is enabled`,
		(await buttonText(frame)) === 'Remove from Chrome' &&
			info.status === 'enabled',
		`${await buttonText(frame)} ${info.status}`,
	);
	ok(
		`${mode}: getAll answers Chrome's ExtensionInfo`,
		mine.name === NAME &&
			mine.version === '0.11.2' &&
			mine.enabled === true &&
			mine.mayDisable === true &&
			mine.isApp === false &&
			mine.type === 'extension' &&
			mine.installType === 'normal' &&
			mine.offlineEnabled === false &&
			mine.optionsUrl === `chrome-extension://${ID}/ui/options/options.html` &&
			mine.updateUrl === 'https://clients2.google.com/service/update2/crx' &&
			mine.homepageUrl === 'https://github.com/igrigorik/videospeed' &&
			JSON.stringify(mine.permissions) === '["storage"]' &&
			JSON.stringify(mine.hostPermissions) === '[]' &&
			JSON.stringify(mine.icons) ===
				JSON.stringify(
					[16, 48, 128].map((size) => ({
						size,
						url: `chrome://extension-icon/${ID}/${size}/0`,
					})),
				) &&
			JSON.stringify(info.warnings) === JSON.stringify([WARNING]),
		JSON.stringify(info),
	);

	// ---- it works: its content script runs on its site
	await submitLanding(page, OTHER);
	let ran = null;
	for (let tries = 0; tries < 100 && ran !== true; tries++) {
		const found = await activeFrame(page);
		ran = await found?.evaluate(() => !!window.VSC).catch(() => null);
		if (ran !== true) await sleep(200);
	}
	ok(
		`${mode}: the installed extension's content script runs on its site`,
		ran === true,
	);

	// ---- Remove from Chrome: cancelled, then taken
	await submitOmni(page, STORE);
	await sleep(500);
	frame = await storeFrame(page, 'Remove from Chrome');
	await frame.click('#action');
	await until(page, () => !!document.getElementById('passkeyPrompt'), Boolean);
	const removing = await dialog(page);
	ok(
		`${mode}: Remove from Chrome asks Remove "<name>"?`,
		removing?.title === `Remove "${NAME}"?` &&
			JSON.stringify(removing.buttons) === '["Remove","Cancel"]',
		JSON.stringify(removing),
	);
	await answerDialog(page, 'Cancel');
	frame = await storeFrame(page, 'Remove from Chrome');
	log = await pageLog(frame);
	ok(
		`${mode}: Cancel keeps it, with Chrome's error`,
		JSON.stringify(log.find((entry) => entry[0] === 'uninstall')) ===
			JSON.stringify([
				'uninstall',
				`Extension ${ID} uninstall canceled by user.`,
			]),
		JSON.stringify(log),
	);
	await frame.click('#action');
	await until(page, () => !!document.getElementById('passkeyPrompt'), Boolean);
	await answerDialog(page, 'Remove');
	frame = await storeFrame(page, 'Add to Chrome');
	for (let tries = 0; tries < 50; tries++) {
		log = await pageLog(frame);
		if (log?.some((entry) => entry[0] === 'uninstall' && entry[1] === null))
			break;
		await sleep(200);
	}
	ok(
		`${mode}: Remove takes it off: onUninstalled, and the page offers Add to Chrome`,
		(await buttonText(frame)) === 'Add to Chrome' &&
			JSON.stringify(log.filter((entry) => entry[0] === 'uninstall').pop()) ===
				'["uninstall",null]' &&
			log.some((entry) => entry[0] === 'onUninstalled' && entry[1] === ID),
		JSON.stringify(log),
	);
	const gone = await until(
		page,
		() => document.querySelectorAll('#extActions .extAction').length,
		(count) => count === 0,
	);
	ok(`${mode}: the bar's button went with it`, gone === 0, String(gone));
	await submitOmni(page, STORE);
	await sleep(500);
	frame = await storeFrame(page);
	ok(
		`${mode}: after a reload the page offers Add to Chrome again`,
		(await buttonText(frame)) === 'Add to Chrome',
		String(await buttonText(frame)),
	);
	await page.context().close();
}

/** the real store's ChatGPT page: an enabled Add to Chrome, and the host's dialog on its click */
async function live() {
	const page = await openDemo(browser, HOST);
	await submitLanding(
		page,
		'https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg',
	);
	let button = null;
	let frame = null;
	// (the store draws the button disabled, and enables it once its script
	// has asked the API, about 0.6 s later)
	for (let tries = 0; tries < 150 && button?.disabled !== false; tries++) {
		frame = await activeFrame(page);
		button = await frame
			?.evaluate(() => {
				// (the one shown: the page has another for narrow layouts)
				const all = [...document.querySelectorAll('button')].filter(
					(element) => element.textContent.trim() === 'Add to Chrome',
				);
				const found =
					all.find((element) => element.getClientRects().length) ?? all[0];
				if (found) found.dataset.stompTestAdd = '';
				return found ? { disabled: found.disabled } : null;
			})
			.catch(() => null);
		if (button?.disabled !== false) await sleep(200);
	}
	ok(
		'live: the real store offers an enabled Add to Chrome',
		button?.disabled === false,
		JSON.stringify(button),
	);
	if (button?.disabled === false) {
		await frame.click('[data-stomp-test-add]');
		await until(
			page,
			() => !!document.getElementById('passkeyPrompt'),
			Boolean,
			20000,
		);
		const shown = await dialog(page);
		ok(
			"live: its click shows the host's dialog for ChatGPT",
			shown?.title === 'Add "ChatGPT"?',
			JSON.stringify(shown),
		);
		if (shown) await answerDialog(page, 'Cancel');
	}
	await page.context().close();
}

if (!SKIP_NETWORK) await live();
await run('isolated', HOST);
await run('same-origin', PROXY);
server.close();
await done(browser, errors);
