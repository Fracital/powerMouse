// An extension's life as the extensions page manages it (docs/extensions.md
// "Managing extensions"), on STomp in both host modes and, when CHROME can
// load an unpacked extension over CDP (Extensions.loadUnpacked), on native
// Chrome driven through chrome://extensions' own developerPrivate, with no
// network: two fixtures built here, a probe and a watcher with
// "management".
// - management's events the watcher hears for the probe's install,
//   disable, enable, reload and removal, in Chrome's order;
// - the error console: manifest errors, the service worker's, a content
//   script's and an extension page's errors (no console.log, no worker
//   warning), clearing one and all, Collect errors off, developer mode off
//   clearing everything;
// - shortcuts: the manifest's, one set, one Chrome refuses (it clears), one
//   taken from another command, a scope, commands.getAll seeing them, and
//   (STomp) runCommand reaching commands.onCommand with the tab;
// - site access: on click withholds the content script, specific sites and
//   all sites give it back;
// - disable: a content script already in a page loses its extension
//   (runtime.id undefined, "Extension context invalidated."); enable runs
//   no onInstalled; reload runs onInstalled `update` and keeps the errors;
// - (STomp) views, pack() and the CRX3 it makes (signature, id, install,
//   the same id again from the key), and the info fields by source.
/* global chrome */
import { createHash, verify } from 'node:crypto';
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
	waitForServer,
} from '../lib.mjs';

const target = `${FIXTURE}pages/ext-other.html`;
const TARGET = 'no extension here';

const probe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Lifecycle Probe',
		version: '1.0',
		homepage_url: 'https://example.com/probe',
		background: { service_worker: 'background.js' },
		action: { default_popup: 'popup.html', default_title: 'Lifecycle' },
		permissions: ['storage', 'tabs', 'notapermission'],
		host_permissions: ['http://127.0.0.1/*'],
		content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
		commands: {
			_execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } },
			'do-thing': {
				description: 'Do the thing',
				suggested_key: { default: 'Alt+Shift+D' },
			},
			'no-key': { description: 'A command with no key' },
		},
		bogus_key: 1,
	}),
	'background.js': `
const events = { installed: [], commands: [] };
const keep = () => chrome.storage.local.set(events);
chrome.storage.local.get(null).then((kept) => {
	for (const key of Object.keys(events))
		if (Array.isArray(kept[key])) events[key].unshift(...kept[key]);
});
chrome.runtime.onInstalled.addListener((details) => {
	events.installed.push(details.reason + ':' + (details.previousVersion ?? ''));
	keep();
});
chrome.runtime.onStartup.addListener(() => {
	events.installed.push('startup');
	keep();
});
chrome.commands.onCommand.addListener((name, tab) => {
	events.commands.push(name + ':' + (tab ? typeof tab.id : 'none'));
	keep();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (message === 'boom') {
		console.log('probe sw log');
		console.warn('probe sw warn');
		console.error('probe sw console error');
		setTimeout(() => {
			throw new Error('probe sw uncaught');
		});
		Promise.reject(new Error('probe sw rejection'));
		respond('boomed');
		return;
	}
	if (message === 'state') {
		chrome.commands.getAll().then((commands) =>
			respond({
				installed: events.installed,
				commands: events.commands,
				getAll: commands.map((command) => command.name + '=' + command.shortcut).sort(),
			}),
		);
		return true;
	}
	respond('pong');
});`,
	'content.js': `
document.documentElement.dataset.lcRan = 'yes';
const heldRuntime = chrome.runtime;
const ASKS = { Boomsw: 'boom', State: 'state', Ping: 'ping' };
window.addEventListener('message', (event) => {
	const ask = event.data && event.data.lc;
	if (!ask || (!['Boomcs', 'Id', 'Apis', 'Held', 'Unread'].includes(ask) && !ASKS[ask])) return;
	const answer = (value) => {
		document.documentElement.dataset['lc' + ask] = JSON.stringify(value);
	};
	if (ask === 'Boomcs') {
		console.log('probe content log');
		console.warn('probe content warn');
		console.error('probe content console error');
		answer('boomed');
		throw new Error('probe content uncaught');
	}
	if (ask === 'Id') return answer(String(chrome.runtime && chrome.runtime.id));
	// (i18n: a namespace this script never read before)
	if (ask === 'Unread') return answer(typeof chrome.i18n);
	if (ask === 'Apis')
		return answer(['runtime', 'storage', 'i18n', 'extension'].filter((name) => name in chrome));
	try {
		(ask === 'Held' ? heldRuntime : chrome.runtime).sendMessage(ASKS[ask] || 'ping').then(answer, (error) =>
			answer('rejected:' + error.message),
		);
	} catch (error) {
		answer('threw:' + error.message);
	}
});`,
	'popup.html':
		'<!doctype html><meta charset="utf-8"><title>Lifecycle popup</title><p>popup</p>',
	'page.html':
		'<!doctype html><meta charset="utf-8"><title>lifecycle page</title><script src="page.js"></script>',
	'page.js': `
console.log('probe page log');
console.warn('probe page warn');
setTimeout(() => {
	throw new Error('probe page uncaught');
});`,
};

const watcher = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Lifecycle Watcher',
		version: '1.0',
		permissions: ['management', 'storage'],
		background: { service_worker: 'watch.js' },
		content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['watch-cs.js'] }],
	}),
	'watch.js': `
const events = [];
const log = (value) => {
	events.push(value);
	chrome.storage.local.set({ events });
};
chrome.management.onInstalled.addListener((info) => log('installed:' + info.name + ':' + info.enabled));
chrome.management.onUninstalled.addListener((id) => log('uninstalled:' + (id.length === 32 ? 'id' : id)));
chrome.management.onEnabled.addListener((info) => log('enabled:' + info.name));
chrome.management.onDisabled.addListener((info) => log('disabled:' + info.name));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
	if (message === 'watched') respond(events.filter((event) => !event.includes('Watcher')));
});`,
	'watch-cs.js': `
window.addEventListener('message', (event) => {
	if (!event.data || event.data.lc !== 'Watch') return;
	chrome.runtime.sendMessage('watched').then((list) => {
		document.documentElement.dataset.lcWatch = JSON.stringify(list);
	});
});`,
};

// ---- the two arms' moves ---------------------------------------------------

/** ask the content scripts of the target page something, and read the answer */
async function ask(frame, key, timeout = 8000) {
	if (!frame) return null;
	await frame
		.evaluate((key) => {
			delete document.documentElement.dataset[`lc${key}`];
			window.postMessage({ lc: key }, '*');
		}, key)
		.catch(() => {});
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await frame
			.evaluate((key) => document.documentElement.dataset[`lc${key}`], key)
			.catch(() => undefined);
		if (value !== undefined) return JSON.parse(value);
		await sleep(150);
	}
	return null;
}

/** an error list as both arms are compared: severity, message, where (ids out) */
const errorRows = (list, id) =>
	(list ?? [])
		.filter((error) => /probe|manifest|Permission/i.test(error.message))
		.map((error) =>
			[
				// (a manifest error has no severity: the errors page shows it as a warning)
				String(
					error.severity ??
						(String(error.type).toLowerCase() === 'manifest' ? 'warn' : ''),
				).toLowerCase(),
				error.message,
				String(error.source ?? '')
					.replaceAll(id, 'ID')
					.replace(/^https?:\/\/[^/]+\//, 'SITE/'),
			].join(' | '),
		)
		.sort();

/** a command list as both arms are compared */
const commandRows = (list) =>
	(list ?? []).map((command) => `${command.name}=${command.shortcut}`).sort();

/** the native arm: Chrome 157 with the fixtures loaded unpacked */
async function nativeArm() {
	const dir = mkdtempSync(join(tmpdir(), 'stomp-lifecycle-'));
	const write = (name, files) => {
		for (const [path, text] of Object.entries(files)) {
			const full = join(dir, name, path);
			mkdirSync(join(full, '..'), { recursive: true });
			writeFileSync(full, text);
		}
		return join(dir, name);
	};
	const profile = join(dir, 'profile');
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: CHROME,
		headless: false, // (--headless=new below: the old headless runs no extension)
		args: [
			'--headless=new',
			'--no-sandbox',
			'--no-first-run',
			'--enable-unsafe-extension-debugging',
			'--disable-features=DisableLoadExtensionCommandLineSwitch',
		],
		ignoreDefaultArgs: [
			'--disable-extensions',
			'--enable-automation',
			'--disable-component-extensions-with-background-pages',
			'--headless',
			'--hide-scrollbars',
		],
	});
	const close = async () => {
		await Promise.race([context.close().catch(() => {}), sleep(10000)]);
		rmSync(dir, { recursive: true, force: true });
	};
	const session = await context.browser().newBrowserCDPSession();
	let watcherId;
	try {
		({ id: watcherId } = await session.send('Extensions.loadUnpacked', {
			path: write('watcher', watcher),
		}));
	} catch (error) {
		await close();
		return { skipped: String(error.message ?? error) };
	}
	const manage = await context.newPage();
	await manage.goto('chrome://extensions/');
	await manage.waitForFunction(() => !!globalThis.chrome?.developerPrivate);
	// (no native call may hang the suite: chrome://extensions can sit on one)
	const bounded = (label, promise) =>
		Promise.race([
			promise,
			sleep(10000).then(() => {
				throw new Error(`native ${label} timed out`);
			}),
		]);
	const dp = (method, ...args) =>
		bounded(
			method,
			manage.evaluate(
				async ([method, args]) => chrome.developerPrivate[method](...args),
				[method, args],
			),
		);
	const mgmt = (method, ...args) =>
		bounded(
			method,
			manage.evaluate(
				async ([method, args]) => chrome.management[method](...args),
				[method, args],
			),
		);
	const { id } = await session.send('Extensions.loadUnpacked', {
		path: write('probe', probe),
	});
	const info = () => dp('getExtensionInfo', id);
	const tab = await context.newPage();
	await tab.goto(target);
	const host = {
		id,
		watcherId,
		frame: () => tab.mainFrame(),
		reloadTarget: async () => {
			await tab.reload();
			await sleep(1200);
		},
		openPage: async () => {
			const extensionPage = await context.newPage();
			await extensionPage.goto(`chrome-extension://${id}/page.html`);
			await sleep(1200);
			await extensionPage.close();
		},
		devMode: (on) => dp('updateProfileConfiguration', { inDeveloperMode: on }),
		errors: async () => {
			const got = await info();
			return [...got.manifestErrors, ...got.runtimeErrors];
		},
		clearErrors: (ids) =>
			dp('deleteExtensionErrors', {
				extensionId: id,
				...(ids ? { errorIds: ids } : {}),
			}),
		collect: (on) =>
			dp('updateExtensionConfiguration', {
				extensionId: id,
				errorCollection: on,
			}),
		commands: async () =>
			(await info()).commands.map((command) => ({
				name: command.name,
				shortcut: command.keybinding,
				scope: command.scope.toLowerCase(),
			})),
		setShortcut: (name, shortcut) =>
			dp('updateExtensionCommand', {
				extensionId: id,
				commandName: name,
				keybinding: shortcut,
			}),
		setScope: (name, scope) =>
			dp('updateExtensionCommand', {
				extensionId: id,
				commandName: name,
				scope: scope.toUpperCase(),
			}),
		siteAccess: async (access, hosts = []) => {
			await dp('updateExtensionConfiguration', {
				extensionId: id,
				hostAccess:
					access === 'all'
						? 'ON_ALL_SITES'
						: hosts.length
							? 'ON_SPECIFIC_SITES'
							: 'ON_CLICK',
			});
			for (const site of hosts) await dp('addHostPermission', id, site);
		},
		enable: (on) => mgmt('setEnabled', id, on),
		reload: () => dp('reload', id, { failQuietly: true }),
		remove: async () => {
			try {
				await bounded(
					'Extensions.uninstall',
					session.send('Extensions.uninstall', { id }),
				);
			} catch (error) {
				await mgmt('uninstall', id, { showConfirmDialog: false });
			}
		},
		gone: async () =>
			!(await mgmt('getAll')).some((extension) => extension.id === id),
		views: async () =>
			(await info()).views.map((view) => ({
				kind:
					view.type === 'EXTENSION_SERVICE_WORKER_BACKGROUND'
						? 'service_worker'
						: view.type.toLowerCase(),
				displayUrl: view.url,
			})),
	};
	return { host, close };
}

/** the STomp arm: a controller of `mode` with the fixtures installed */
async function stompArm(browser, mode, base) {
	await waitForServer(base);
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${base}stomp/controllerFrame.html`);
	const setup = await page.evaluate(
		async ({ isolated, proxyOrigin, watcher, probe }) => {
			const { StompController, RemoteController } =
				await import('/stomp/controller.mjs');
			const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
			const transport = {
				module: `${proxyOrigin}/epoxy/index.mjs`,
				options: [{ wisp }],
			};
			const controller = isolated
				? new RemoteController({
						proxyOrigin,
						directory: '/stomp/',
						transport,
						codec: 'xor',
					})
				: new StompController({
						serviceworker: await StompController.register('/stomp/'),
						transport,
						directory: '/stomp/',
						codec: 'xor',
					});
			await controller.wait();
			window.__controller = controller;
			const changes = [];
			controller.extensions.onChange((change) =>
				changes.push(`${change.type}:${change.id ?? ''}`),
			);
			window.__changes = changes;
			// (a fresh profile: what an earlier run left goes)
			for (const info of await controller.extensions.list())
				await controller.extensions.remove(info.id);
			await controller.extensions.setDeveloperMode(false);
			const watched = await controller.extensions.install(watcher, {
				filename: 'lifecycle-watcher',
			});
			const installed = await controller.extensions.install(probe, {
				filename: 'lifecycle-probe',
			});
			const frame = controller.createFrame();
			document.body.append(frame.element);
			window.__frame = frame;
			return { id: installed.id, watcherId: watched.id, info: installed };
		},
		{
			isolated: mode === 'isolated',
			proxyOrigin: new URL(PROXY).origin,
			watcher,
			probe,
		},
	);
	let { id } = setup;
	const api = (method, ...args) =>
		page.evaluate(
			async ([method, args]) => {
				try {
					return {
						value: await window.__controller.extensions[method](...args),
					};
				} catch (error) {
					return { error: `${error.code ?? ''}:${error.message}` };
				}
			},
			[method, args],
		);
	const value = async (method, ...args) => {
		const answer = await api(method, ...args);
		if (answer.error) throw new Error(`${method}: ${answer.error}`);
		return answer.value;
	};
	/** the newest frame whose document is the target page */
	const frame = async () => {
		for (let tries = 0; tries < 100; tries++) {
			for (const found of [...page.frames()].reverse()) {
				const title = await found
					.evaluate(() => document.readyState === 'complete' && document.title)
					.catch(() => '');
				if (title === TARGET) return found;
			}
			await sleep(150);
		}
		return null;
	};
	const go = async (url) => {
		await page.evaluate((url) => window.__frame.go(url), url);
		await sleep(1200);
	};
	const host = {
		id,
		watcherId: setup.watcherId,
		installedInfo: setup.info,
		page,
		api,
		value,
		frame,
		reloadTarget: () => go(target),
		openPage: async () => {
			const url = await page.evaluate(
				(id) =>
					window.__controller.extensions.resolveUrl(
						`chrome-extension://${id}/page.html`,
					),
				id,
			);
			await go(url);
			await go(target);
		},
		devMode: (on) => value('setDeveloperMode', on),
		errors: () => value('errors', id),
		clearErrors: (ids) =>
			ids ? value('clearErrors', id, ids) : value('clearErrors', id),
		collect: (on) => value('setCollectErrors', id, on),
		commands: async () =>
			(await value('commands')).filter((command) => command.id === id),
		setShortcut: (name, shortcut) => value('setShortcut', id, name, shortcut),
		setScope: (name, scope) => value('setCommandScope', id, name, scope),
		siteAccess: (access, hosts = []) =>
			access === 'all'
				? value('setSiteAccess', id, 'all', null)
				: value('setSiteHosts', id, hosts),
		enable: (on) => value(on ? 'enable' : 'disable', id),
		reload: () => value('reload', id),
		remove: () => value('remove', id),
		gone: async () => (await value('get', id)) === null,
		views: () => value('views', id),
		tabId: () =>
			page.evaluate(() => window.__controller.tabIdOf(window.__frame)),
		/** the probe again, as a fresh install (the scenario removed it) */
		reinstall: async () => {
			host.installedInfo = await value('install', probe, {
				filename: 'lifecycle-probe',
			});
			id = host.id = host.installedInfo.id;
			await go(target);
		},
	};
	await go(target);
	return { host, close: () => context.close() };
}

// ---- the scenario, the same moves on each arm --------------------------------

/** wait until `read` gives something `accept` takes (or the time is up) */
async function until(read, accept, timeout = 10000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		last = await read();
		if (accept(last)) return last;
		await sleep(250);
	}
	return last;
}

async function scenario(label, host) {
	const out = {};
	const { id } = host;
	await host.devMode(true);
	await sleep(500);
	out.id = await ask(await host.frame(), 'Id');
	out.startState = await ask(await host.frame(), 'State');
	out.manifestErrors = errorRows(
		(await host.errors()).filter((error) => error.manifestKey),
		id,
	);
	// each context's errors (developer mode on: collected)
	await ask(await host.frame(), 'Boomsw');
	await ask(await host.frame(), 'Boomcs');
	await host.openPage();
	const all = await until(
		() => host.errors(),
		(list) =>
			list.some((error) => error.message.includes('page uncaught')) &&
			list.some((error) => error.message.includes('sw rejection')),
	);
	out.errors = errorRows(all, id);
	out.views = (await host.views())?.map(
		(view) => `${view.kind} ${String(view.displayUrl).replaceAll(id, 'ID')}`,
	);
	// clear one, then all
	const first = all.find((error) => !error.manifestKey);
	await host.clearErrors([first.id]);
	out.afterClearOne = (await host.errors()).length === all.length - 1;
	await host.clearErrors();
	out.afterClearAll = (await host.errors()).length;
	// Collect errors off: nothing is kept
	await host.collect(false);
	await sleep(300);
	await host.reloadTarget();
	await ask(await host.frame(), 'Boomcs');
	await sleep(1000);
	out.collectOff = (await host.errors()).filter(
		(error) => !error.manifestKey,
	).length;
	await host.collect(true);
	await sleep(300);
	await host.reloadTarget();
	await ask(await host.frame(), 'Boomcs');
	await until(
		() => host.errors(),
		(list) => list.some((error) => error.message.includes('content uncaught')),
	);
	await host.devMode(false);
	await sleep(300);
	out.devModeOff = (await host.errors()).length;
	await host.devMode(true);
	await sleep(300);

	// shortcuts
	out.commandsAtInstall = commandRows(await host.commands());
	await host.setShortcut('do-thing', 'Ctrl+Shift+U');
	out.commandsSet = commandRows(await host.commands());
	await host.setShortcut('do-thing', 'Ctrl+Alt+K');
	out.commandsRefused = commandRows(await host.commands());
	await host.setShortcut('do-thing', 'Ctrl+Shift+U');
	await host.setShortcut('no-key', 'Ctrl+Shift+U');
	out.commandsTaken = commandRows(await host.commands());
	await host.setScope('no-key', 'global');
	out.scope = (await host.commands()).find(
		(command) => command.name === 'no-key',
	)?.scope;
	await host.reloadTarget();
	out.getAll = (await ask(await host.frame(), 'State'))?.getAll;

	// site access
	await host.siteAccess('click');
	await host.reloadTarget();
	out.onClick = await (
		await host.frame()
	)?.evaluate(() => document.documentElement.dataset.lcRan ?? 'withheld');
	await host.siteAccess('specific', ['http://127.0.0.1/*']);
	await host.reloadTarget();
	out.specific = await (
		await host.frame()
	)?.evaluate(() => document.documentElement.dataset.lcRan ?? 'withheld');
	await host.siteAccess('all');
	await host.reloadTarget();
	out.allSites = await (
		await host.frame()
	)?.evaluate(() => document.documentElement.dataset.lcRan ?? 'withheld');

	// disable under a page, enable, reload
	const page = await host.frame();
	await host.enable(false);
	await sleep(1000);
	out.disabledId = await ask(page, 'Id');
	out.disabledPing = await ask(page, 'Ping');
	out.disabledHeld = await ask(page, 'Held');
	out.disabledApis = await ask(page, 'Apis');
	out.disabledUnread = await ask(page, 'Unread');
	await host.enable(true);
	await sleep(1500);
	await host.reloadTarget();
	out.afterEnable = (await ask(await host.frame(), 'State'))?.installed;
	const before = (await host.errors()).length;
	await host.reload();
	await sleep(2500);
	await host.reloadTarget();
	out.afterReload = (await ask(await host.frame(), 'State'))?.installed;
	out.reloadKeepsErrors = (await host.errors()).length === before;

	// remove, then what the watcher heard of it all
	await host.remove();
	await sleep(1000);
	out.gone = await host.gone();
	await host.reloadTarget();
	out.watched = await ask(await host.frame(), 'Watch');
	console.log(`${label}: ${JSON.stringify(out)}`);
	return out;
}

/** what Chrome 157 does, by the moves above (as native Chrome gave it) */
function judge(label, out, native) {
	const same = (key, expected) => {
		const want = native ? native[key] : expected;
		ok(
			`${label}: ${key}${native ? " as native Chrome's" : ''}`,
			JSON.stringify(out[key]) === JSON.stringify(want),
			`got ${JSON.stringify(out[key])} want ${JSON.stringify(want)}`,
		);
	};
	ok(
		`${label}: the content script runs with its id`,
		out.id === out.id && !!out.id,
	);
	same('startState', {
		installed: ['install:'],
		commands: [],
		getAll: ['_execute_action=Ctrl+Shift+Y', 'do-thing=Alt+Shift+D', 'no-key='],
	});
	same('manifestErrors', [
		"warn | Permission 'notapermission' is unknown. | manifest.json",
		"warn | Unrecognized manifest key 'bogus_key'. | manifest.json",
	]);
	same('errors', [
		'error | Uncaught (in promise) Error: probe sw rejection | chrome-extension://ID/background.js',
		'error | Uncaught Error: probe content uncaught | chrome-extension://ID/content.js',
		'error | Uncaught Error: probe page uncaught | chrome-extension://ID/page.js',
		'error | Uncaught Error: probe sw uncaught | chrome-extension://ID/background.js',
		'error | probe content console error | chrome-extension://ID/content.js',
		'error | probe sw console error | chrome-extension://ID/background.js',
		"warn | Permission 'notapermission' is unknown. | manifest.json",
		"warn | Unrecognized manifest key 'bogus_key'. | manifest.json",
		'warn | probe content warn | chrome-extension://ID/content.js',
		'warn | probe page warn | chrome-extension://ID/page.js',
	]);
	same('views', ['service_worker chrome-extension://ID/background.js']);
	same('afterClearOne', true);
	same('afterClearAll', 0);
	same('collectOff', 0);
	same('devModeOff', 0);
	same('commandsAtInstall', [
		'_execute_action=Ctrl+Shift+Y',
		'do-thing=Alt+Shift+D',
		'no-key=',
	]);
	same('commandsSet', [
		'_execute_action=Ctrl+Shift+Y',
		'do-thing=Ctrl+Shift+U',
		'no-key=',
	]);
	same('commandsRefused', [
		'_execute_action=Ctrl+Shift+Y',
		'do-thing=',
		'no-key=',
	]);
	same('commandsTaken', [
		'_execute_action=Ctrl+Shift+Y',
		'do-thing=',
		'no-key=Ctrl+Shift+U',
	]);
	same('scope', 'global');
	same('getAll', [
		'_execute_action=Ctrl+Shift+Y',
		'do-thing=',
		'no-key=Ctrl+Shift+U',
	]);
	same('onClick', 'withheld');
	same('specific', 'yes');
	same('allSites', 'yes');
	same('disabledId', 'undefined');
	// (a namespace read before stays, its calls throwing; one never read
	// reads undefined)
	same('disabledPing', 'threw:Extension context invalidated.');
	same('disabledHeld', 'threw:Extension context invalidated.');
	same('disabledApis', ['runtime', 'storage', 'i18n', 'extension']);
	same('disabledUnread', 'undefined');
	same('afterEnable', ['install:']);
	same('afterReload', ['install:', 'update:1.0']);
	same('reloadKeepsErrors', true);
	same('gone', true);
	same('watched', [
		'enabled:Lifecycle Probe',
		'installed:Lifecycle Probe:true',
		'disabled:Lifecycle Probe',
		'enabled:Lifecycle Probe',
		'disabled:Lifecycle Probe',
		'enabled:Lifecycle Probe',
		'installed:Lifecycle Probe:true',
		'disabled:Lifecycle Probe',
		'uninstalled:id',
	]);
}

// ---- STomp-only checks: runCommand, pack, info -------------------------------

/** a CRX3's parts, read here (protobuf fields 2 and 10000) */
function readCrx(bytes) {
	const buffer = Buffer.from(bytes);
	if (
		buffer.toString('latin1', 0, 4) !== 'Cr24' ||
		buffer.readUInt32LE(4) !== 3
	)
		return null;
	const headerLength = buffer.readUInt32LE(8);
	const header = buffer.subarray(12, 12 + headerLength);
	const zip = buffer.subarray(12 + headerLength);
	const fields = (message) => {
		const out = [];
		let at = 0;
		const varint = () => {
			let value = 0;
			let shift = 0;
			for (;;) {
				const byte = message[at++];
				value += (byte & 0x7f) * 2 ** shift;
				if (!(byte & 0x80)) return value;
				shift += 7;
			}
		};
		while (at < message.length) {
			const key = varint();
			const length = varint();
			out.push([Math.floor(key / 8), message.subarray(at, at + length)]);
			at += length;
		}
		return out;
	};
	const top = fields(header);
	const proof = fields(top.find(([field]) => field === 2)[1]);
	const signedData = top.find(([field]) => field === 10000)[1];
	return {
		publicKey: proof.find(([field]) => field === 1)[1],
		signature: proof.find(([field]) => field === 2)[1],
		signedData,
		crxId: fields(signedData).find(([field]) => field === 1)[1],
		zip,
	};
}

const idOf = (bytes) =>
	[...createHash('sha256').update(bytes).digest().subarray(0, 16)]
		.map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
		.join('');

async function stompOnly(label, host) {
	const { id, page } = host;
	// runCommand: a named command reaches onCommand with the tab
	const tabId = await host.tabId();
	const ran = await host.value('runCommand', id, 'do-thing', tabId);
	const heard = await until(
		async () => (await ask(await host.frame(), 'State'))?.commands,
		(list) => list?.includes('do-thing:number'),
	);
	ok(
		`${label}: runCommand fires commands.onCommand with the tab`,
		ran === 'command' && heard?.includes('do-thing:number'),
		JSON.stringify({ ran, heard }),
	);
	const action = await host.value('runCommand', id, '_execute_action', tabId);
	ok(
		`${label}: _execute_action acts as a click (popup)`,
		action === 'popup',
		String(action),
	);

	// info fields by source
	const info = host.installedInfo;
	ok(
		`${label}: an unpacked install's info: size, path, homepage, store page, errors, site access`,
		info.size > 1000 &&
			info.path === 'lifecycle-probe' &&
			info.homepageUrl === 'https://example.com/probe' &&
			info.webStoreUrl === null &&
			info.collectErrors === true &&
			typeof info.errorCount === 'number' &&
			info.siteAccess?.withheld === false &&
			info.requestedHosts.includes('http://127.0.0.1/*') &&
			info.allHostsRequested === false &&
			Array.isArray(info.permissionWarnings) &&
			!info.permissionWarnings.some((warning) =>
				/127\.0\.0\.1/.test(warning.message + warning.details.join(' ')),
			),
		JSON.stringify({
			size: info.size,
			path: info.path,
			homepageUrl: info.homepageUrl,
			webStoreUrl: info.webStoreUrl,
			collectErrors: info.collectErrors,
			siteAccess: info.siteAccess,
			permissionWarnings: info.permissionWarnings,
		}),
	);
	const hosts = await host.api('setSiteHosts', id, ['https://example.net']);
	ok(
		`${label}: setSiteHosts refuses a site that is no match pattern, as Chrome does`,
		hosts.error === 'bad-source:Invalid host.',
		JSON.stringify(hosts),
	);

	// pack: a CRX3 of the files, signed, installable under its id
	const packed = await page.evaluate(async (files) => {
		const out = await window.__controller.extensions.pack(files);
		const again = await window.__controller.extensions.pack(files, {
			key: out.key,
		});
		const bytes = new Uint8Array(await out.crx.arrayBuffer());
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const installed = await window.__controller.extensions.install(out.crx, {
			filename: 'packed.crx',
		});
		const result = {
			id: out.id,
			again: again.id,
			againKey: again.key,
			key: out.key,
			crx: btoa(binary),
			type: out.crx.type,
			installed: {
				id: installed.id,
				source: installed.source,
				path: installed.path,
				collectErrors: installed.collectErrors,
				name: installed.name,
			},
		};
		await window.__controller.extensions.remove(installed.id);
		return result;
	}, watcher);
	const crx = readCrx(Buffer.from(packed.crx, 'base64'));
	const signed = crx
		? Buffer.concat([
				Buffer.from('CRX3 SignedData\x00', 'latin1'),
				(() => {
					const length = Buffer.alloc(4);
					length.writeUInt32LE(crx.signedData.length);
					return length;
				})(),
				crx.signedData,
				crx.zip,
			])
		: null;
	const valid =
		!!crx &&
		verify(
			'sha256',
			signed,
			{ key: crx.publicKey, format: 'der', type: 'spki' },
			crx.signature,
		);
	ok(
		`${label}: pack() makes a CRX3 signed with RSA SHA-256 whose id is its key's`,
		valid &&
			idOf(crx.publicKey) === packed.id &&
			crx.crxId.length === 16 &&
			idOf(crx.publicKey).startsWith(
				[...crx.crxId]
					.map((byte) =>
						String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)),
					)
					.join(''),
			) &&
			/^-----BEGIN PRIVATE KEY-----/.test(packed.key) &&
			packed.type === 'application/x-chrome-extension',
		JSON.stringify({ valid, id: packed.id, type: packed.type }),
	);
	ok(
		`${label}: the key packs it again under the same id, and the CRX installs under it`,
		packed.again === packed.id &&
			packed.againKey === null &&
			packed.installed.id === packed.id &&
			packed.installed.source === 'package' &&
			packed.installed.path === 'packed.crx' &&
			packed.installed.collectErrors === false,
		JSON.stringify({
			again: packed.again,
			installed: packed.installed,
		}),
	);
	const changes = await page.evaluate(() => window.__changes);
	ok(
		`${label}: onChange tells errors and commands changes`,
		changes.includes(`errors:${id}`) && changes.includes(`commands:${id}`),
		changes.slice(-12).join(' '),
	);
}

// ---- the run -------------------------------------------------------------------

let native = null;
const nativeRun = await nativeArm().catch((error) => ({
	skipped: String(error.stack ?? error),
}));
if (nativeRun.skipped)
	console.log(
		`native arm skipped: this Chrome loads no unpacked extension over CDP (${nativeRun.skipped.split('\n')[0]})`,
	);
else {
	try {
		native = await scenario('native', nativeRun.host);
		judge('native', native, null);
	} finally {
		await nativeRun.close();
	}
}

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
].filter(
	([mode]) => !process.env.EXT_MODES || process.env.EXT_MODES.includes(mode),
)) {
	const arm = await stompArm(browser, mode, base);
	try {
		const out = await scenario(mode, arm.host);
		judge(mode, out, native);
		await arm.host.reinstall();
		await stompOnly(mode, arm.host);
		// (a later run starts clean)
		await arm.host.api('remove', arm.host.watcherId);
		await arm.host.devMode(false);
	} finally {
		await arm.close();
	}
}

await done(browser);
