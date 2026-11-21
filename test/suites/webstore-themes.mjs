// Themes from the Chrome Web Store (docs/extensions.md "Themes"). A server
// here plays the store and its update service, as the webstore suite's
// does: a theme's detail page that calls chrome.webstorePrivate and
// chrome.management in the order the real store's page does for a theme
// (measured on Chrome 157), and the packages clients2.google.com hands out.
// The two store packages are the unmodified Store CRX3s of two
// MIT-licensed themes, Omni 1.0.3 (github.com/getomni/google-chrome:
// colors, tints, images, icons, Manifest V2) and Catppuccin Latte 5.0.0
// (github.com/catppuccin/chrome: colors, Manifest V3). A third theme is
// made and signed here (its own key): colors, tints, properties, a new tab
// page image, an image per scale, a localized name, and every key that
// would run code or grant something in an extension. It proves, on the
// isolated host and the same-origin one:
//  - the store's page sees an MV2 theme installable, and Add to Chrome
//    installs it on the click with no dialog: begin answers '',
//    completeInstall, onInstalled with a theme's ExtensionInfo, the page
//    shows Remove from Chrome; with no click it answers
//    user_gesture_required;
//  - the host hears it (extensions.onTheme): Chrome's colors, tints and
//    properties unchanged, each image a blob: URL of the host page that
//    loads;
//  - a second theme replaces it: getAll answers what Chrome 157 answered
//    (the new one enabled, the old one disabled), the old one's status is
//    disabled, and once the store's document that installed the new one is
//    gone the old one is uninstalled;
//  - after a reload of the host the theme is still shown and the store
//    still sees it;
//  - Remove from Chrome asks the host (Remove "<name>"?), and Remove
//    uninstalls it: onUninstalled, onTheme(null);
//  - the signed theme installed by the host replaces the theme at once,
//    its name is localized, its images are read from the package (a
//    missing one left out), and nothing of it runs or is granted: no
//    content script, no background, no rules, no toolbar button, no
//    permissions, its pages not served;
//  - resetTheme() uninstalls every theme.
// And the demo's default theme (docs/themes.md "The default theme"), with
// Omni as the default its config names (the run turns the default off for
// every suite, and Shooting Star's package is not the suite's to keep):
//  - a fresh profile has it installed and off after boot: the worker's
//    theme disabled, none shown, the Themes submenu and the picker list it
//    with Default chosen, and the page has Default's look;
//  - a reload neither downloads it again nor shows it;
//  - removed in the picker and reloaded, it does not come back;
//  - Reset to default is off while Default is shown; from Light it shows
//    Default and leaves the theme installed; with the theme applied it
//    shows Default and uninstalls it, and a reload does not bring it back;
//  - with no list in the config the page asks the update service for
//    Shooting Star (pink), and a failed download leaves the profile as it
//    was and nothing marked offered.
/* global chrome, PMTheme -- the store page's and the demo's, in the functions evaluated there */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
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

/** a store package: its id, bytes and manifest's text */
async function storeTheme(file, id) {
	const bytes = readFileSync(new URL(`../fixtures/${file}`, import.meta.url));
	const entries = readZip(parseCrx(bytes).zip);
	const text = new TextDecoder().decode(
		await entries.find((entry) => entry.name === 'manifest.json').read(),
	);
	return { id, bytes, text, manifest: JSON.parse(text) };
}
const OMNI = await storeTheme(
	'omni-theme-1.0.3.crx',
	'loclkialbcifjohhglkomgamgpolpcoh',
);
const LATTE = await storeTheme(
	'catppuccin-latte-5.0.0.crx',
	'jhjnalhegpceacdhbplhnakmkdliaddd',
);
const THEMES = new Map([OMNI, LATTE].map((theme) => [theme.id, theme]));

/** management.getAll on Chrome 157 right after Latte replaced Omni (native/run5) */
const NATIVE_AFTER_REPLACE = [LATTE, OMNI].map(({ id, manifest }, index) => ({
	description: manifest.description,
	...(index ? { disabledReason: 'unknown' } : {}),
	enabled: !index,
	homepageUrl: `https://chromewebstore.google.com/detail/${id}`,
	hostPermissions: [],
	icons: [16, 48, 128].map((size) => ({
		size,
		url: `chrome://extension-icon/${id}/${size}/0`,
	})),
	id,
	installType: 'normal',
	isApp: false,
	mayDisable: true,
	...(index ? { mayEnable: true } : {}),
	name: manifest.name,
	offlineEnabled: false,
	optionsUrl: '',
	permissions: [],
	shortName: manifest.name,
	type: 'theme',
	updateUrl: 'https://clients2.google.com/service/update2/crx',
	version: manifest.version,
	versionName: '',
}));

// ---- the signed theme of the suite's own ----------------------------------

/** a PNG of `width` x 1 pixels of one color */
function png(width, [r, g, b]) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, 'latin1');
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(row)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** a ZIP of `files`, deflated */
function zip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const body = deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

/** a protobuf length-delimited field */
const field = (number, bytes) => {
	const varint = (value) => {
		const out = [];
		for (; value > 127; value = Math.floor(value / 128))
			out.push((value % 128) | 128);
		out.push(value);
		return Buffer.from(out);
	};
	return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
};

/** a CRX3 of `archive`, signed with a new RSA key (crx_verifier.cc's format), and its id */
function crx3(archive) {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	});
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	const crxId = createHash('sha256').update(spki).digest().subarray(0, 16);
	const signed = field(1, crxId);
	const size = Buffer.alloc(4);
	size.writeUInt32LE(signed.length, 0);
	const signature = sign(
		'sha256',
		Buffer.concat([Buffer.from('CRX3 SignedData\x00'), size, signed, archive]),
		privateKey,
	);
	const header = Buffer.concat([
		field(2, Buffer.concat([field(1, spki), field(2, signature)])),
		field(10000, signed),
	]);
	const start = Buffer.alloc(12);
	start.write('Cr24', 0, 'latin1');
	start.writeUInt32LE(3, 4);
	start.writeUInt32LE(header.length, 8);
	let id = '';
	for (const byte of crxId)
		id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
	return { id, bytes: Buffer.concat([start, header, archive]) };
}

const OWN_THEME = {
	colors: {
		frame: [10, 20, 30],
		toolbar: [40, 50, 60],
		tab_text: [255, 255, 255],
		ntp_background: [1, 2, 3],
		button_background: [0, 0, 0, 0.5],
	},
	tints: { buttons: [0.5, 0.5, 0.5], frame_inactive: [-1, -1, 0.7] },
	properties: {
		ntp_background_alignment: 'bottom',
		ntp_background_repeat: 'no-repeat',
		ntp_logo_alternate: 1,
	},
};
/** the suite's own theme, its background reporting to the store's server on `port` */
const ownTheme = (port) =>
	crx3(
		zip({
			'manifest.json': JSON.stringify({
				manifest_version: 3,
				name: '__MSG_themeName__',
				description: '__MSG_themeDescription__',
				version: '2.1',
				default_locale: 'en',
				theme: {
					...OWN_THEME,
					images: {
						theme_ntp_background: 'images/ntp.png',
						theme_frame: {
							'100_percent': 'images/frame.png',
							'200_percent': './images/frame@2x.png',
						},
						theme_toolbar: 'images/missing.png',
					},
				},
				// what would run or be granted in an extension
				permissions: ['storage', 'declarativeNetRequest', 'tabs'],
				host_permissions: ['<all_urls>'],
				background: { service_worker: 'bg.js' },
				content_scripts: [{ matches: ['<all_urls>'], js: ['run.js'] }],
				declarative_net_request: {
					rule_resources: [{ id: 'block', enabled: true, path: 'rules.json' }],
				},
				action: { default_title: 'Theme button' },
				web_accessible_resources: [
					{ resources: ['*'], matches: ['<all_urls>'] },
				],
			}),
			'_locales/en/messages.json': JSON.stringify({
				themeName: { message: 'Suite Theme' },
				themeDescription: { message: 'A theme of the suite.' },
			}),
			'images/ntp.png': png(40, [200, 10, 10]),
			'images/frame.png': png(10, [10, 200, 10]),
			'images/frame@2x.png': png(20, [10, 10, 200]),
			'bg.js': `fetch('http://127.0.0.1:${port}/ran?background');`,
			'run.js': `document.documentElement.dataset.themeRan = '1';`,
			'page.html': '<script>document.title = "ran"</script>',
			'rules.json': JSON.stringify([
				{
					id: 1,
					priority: 1,
					action: { type: 'block' },
					condition: { urlFilter: 'bookmark-a', resourceTypes: ['main_frame'] },
				},
			]),
		}),
	);

// ---- the store and its update service --------------------------------------

/** a theme's detail page: what the real store's page calls for a theme (native/run1.log) */
const detailPage = ({
	id,
	text,
	manifest,
}) => `<!doctype html><meta charset="utf-8">
<title>${manifest.name} - Chrome Web Store</title>
<button id="action" disabled>Loading</button>
<script>
const ID = ${JSON.stringify(id)};
const MANIFEST = ${JSON.stringify(text)};
const log = (window.__log = []);
const failed = () => chrome.runtime?.lastError?.message;
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
// (the page asks again after every event, as the store's does)
const read = () =>
	chrome.management.getAll((all) => {
		log.push(['getAll', all.map((info) => [info.id, info.enabled])]);
		chrome.webstorePrivate.getExtensionStatus(ID, MANIFEST, (status) => {
			log.push(['status', status]);
			installed = status === 'enabled';
			render();
		});
	});
chrome.management.onInstalled.addListener((info) => {
	log.push(['onInstalled', info.id, info.type]);
	busy = false;
	read();
});
chrome.management.onUninstalled.addListener((id) => {
	log.push(['onUninstalled', id]);
	busy = false;
	read();
});
read();
button.onclick = () => {
	busy = true;
	render();
	if (installed)
		chrome.management.uninstall(ID, { showConfirmDialog: true }, () => {
			const error = failed();
			log.push(['uninstall', error ?? null]);
			busy = false;
			read();
		});
	else
		chrome.webstorePrivate.beginInstallWithManifest3(
			{ id: ID, manifest: MANIFEST, esbAllowlist: true },
			(result) => {
				const error = failed();
				log.push(['begin', result, error ?? null]);
				if (error) {
					busy = false;
					return render();
				}
				chrome.webstorePrivate.completeInstall(ID, () => {
					log.push(['complete', failed() ?? null]);
				});
			},
		);
};
</script>`;

const downloads = new Map();
/** every id the update service was asked for */
const asked = [];
let backgroundRan = 0;
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://store.test');
	if (url.pathname === '/ran') {
		backgroundRan++;
		response.writeHead(204, { 'access-control-allow-origin': '*' });
		return response.end();
	}
	const detail = /^\/detail\/[^/]+\/([a-p]{32})$/.exec(url.pathname);
	if (detail && THEMES.has(detail[1])) {
		response.writeHead(200, { 'content-type': 'text/html' });
		return response.end(detailPage(THEMES.get(detail[1])));
	}
	if (url.pathname === '/service/update2/crx') {
		const id = /id=([a-p]{32})/.exec(url.searchParams.get('x') ?? '')?.[1];
		asked.push(id);
		if (THEMES.has(id)) {
			downloads.set(id, (downloads.get(id) ?? 0) + 1);
			response.writeHead(200, {
				'content-type': 'application/x-chrome-extension',
			});
			return response.end(THEMES.get(id).bytes);
		}
	}
	response.writeHead(404);
	response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const OWN = ownTheme(PORT);
const storeURL = ({ id }) =>
	`https://chromewebstore.google.com/detail/theme-probe/${id}`;
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

/** the store tab's frame, once its page shows `text` (any settled text without one) */
async function storeFrame(page, text) {
	const start = Date.now();
	while (Date.now() - start < 30000) {
		const frame = await activeFrame(page);
		const shown = await frame
			?.evaluate(() => document.getElementById('action')?.textContent)
			.catch(() => null);
		if (
			shown &&
			(text === undefined
				? shown !== 'Loading' && shown !== 'Working'
				: shown === text)
		)
			return frame;
		await sleep(200);
	}
	return activeFrame(page);
}

const pageLog = (frame) => frame.evaluate(() => window.__log).catch(() => null);
const prompted = (page) =>
	page.evaluate(() => !!document.getElementById('passkeyPrompt'));
const answerDialog = async (page, label) => {
	await sleep(700);
	await page.click(`#passkeyPrompt button:text-is("${label}")`);
	await until(page, () => !document.getElementById('passkeyPrompt'), Boolean);
};

/** start hearing the host's onTheme: each call's theme in window.__themes */
const hearThemes = (page) =>
	page.evaluate(() => {
		window.__themes = [];
		window.controller.extensions.onTheme((theme) =>
			window.__themes.push(theme),
		);
	});
const heard = (page) => page.evaluate(() => window.__themes);
/** the last theme heard, once it is `id` (null: the default) */
const heardTheme = (page, id) =>
	until(
		page,
		() => window.__themes?.at(-1),
		(theme) => (id === null ? theme === null : theme?.extensionId === id),
	);

/** what each of a theme's images is in the host page: [key, scale, protocol, width] */
const imageWidths = (page, images) =>
	page.evaluate(async (images) => {
		const width = (url) =>
			new Promise((resolve) => {
				const img = new Image();
				img.onload = () => resolve(img.naturalWidth);
				img.onerror = () => resolve(-1);
				img.src = url;
			});
		const out = [];
		for (const [key, value] of Object.entries(images))
			for (const [scale, url] of typeof value === 'string'
				? [['', value]]
				: Object.entries(value))
				out.push([key, scale, new URL(url).protocol, await width(url)]);
		return out;
	}, images);

/** the store's hosts are the suite's server, for every page of `page`'s context */
const storeTransport = (page) =>
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
	);

async function run(mode, base) {
	const page = await openDemo(browser, base, {}, storeTransport);
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	await hearThemes(page);
	ok(
		`${mode}: onTheme tells the default theme (null) at once`,
		JSON.stringify(
			await until(
				page,
				() => window.__themes,
				(list) => list?.length > 0,
			),
		) === '[null]',
		JSON.stringify(await heard(page)),
	);

	// ---- Omni: an MV2 theme, installable, installed on the click alone
	await submitLanding(page, storeURL(OMNI));
	let frame = await storeFrame(page, 'Add to Chrome');
	let log = await pageLog(frame);
	ok(
		`${mode}: the store sees a Manifest V2 theme installable`,
		JSON.stringify(log) === '[["getAll",[]],["status","installable"]]',
		JSON.stringify(log),
	);
	await sleep(5500);
	const quiet = await evaluateQuietly(
		frame,
		`new Promise((resolve) => chrome.webstorePrivate.beginInstallWithManifest3(
			{ id: ${JSON.stringify(OMNI.id)}, manifest: ${JSON.stringify(OMNI.text)} },
			(result) => resolve({ result, error: chrome.runtime.lastError?.message ?? null })))`,
	);
	ok(
		`${mode}: a theme's install with no click answers user_gesture_required`,
		quiet?.result === 'user_gesture_required' && !(await prompted(page)),
		JSON.stringify(quiet),
	);
	const omniDownloads = downloads.get(OMNI.id) ?? 0;
	await frame.click('#action');
	frame = await storeFrame(page, 'Remove from Chrome');
	log = await pageLog(frame);
	ok(
		`${mode}: Add to Chrome installs the theme with no dialog: begin '', completeInstall, onInstalled (theme)`,
		!(await prompted(page)) &&
			JSON.stringify(log.find((entry) => entry[0] === 'begin')) ===
				'["begin","",null]' &&
			JSON.stringify(log.find((entry) => entry[0] === 'complete')) ===
				'["complete",null]' &&
			JSON.stringify(log.find((entry) => entry[0] === 'onInstalled')) ===
				JSON.stringify(['onInstalled', OMNI.id, 'theme']) &&
			JSON.stringify(log.at(-1)) === '["status","enabled"]' &&
			downloads.get(OMNI.id) - omniDownloads === 1,
		JSON.stringify(log),
	);
	const omni = await heardTheme(page, OMNI.id);
	ok(
		`${mode}: the host hears the theme: its names, Chrome's colors, tints and properties unchanged`,
		omni?.id === `chrome-theme:${OMNI.id}` &&
			omni.name === OMNI.manifest.name &&
			omni.version === '1.0.3' &&
			omni.source === 'webstore' &&
			omni.enabled === true &&
			JSON.stringify(omni.theme.colors) ===
				JSON.stringify(OMNI.manifest.theme.colors) &&
			JSON.stringify(omni.theme.tints) ===
				JSON.stringify(OMNI.manifest.theme.tints) &&
			JSON.stringify(omni.theme.properties) === '{}',
		JSON.stringify(omni && { ...omni, theme: undefined }),
	);
	const omniImages = omni ? await imageWidths(page, omni.theme.images) : [];
	ok(
		`${mode}: each of its images is a blob: URL of the host page that loads`,
		JSON.stringify(omniImages.map(([key]) => key).sort()) ===
			JSON.stringify(Object.keys(OMNI.manifest.theme.images).sort()) &&
			omniImages.every(
				([, scale, protocol, width]) =>
					scale === '' && protocol === 'blob:' && width > 0,
			),
		JSON.stringify(omniImages),
	);

	// ---- Latte replaces it: the old theme is off, then gone
	await submitOmni(page, storeURL(LATTE));
	frame = await storeFrame(page, 'Add to Chrome');
	await frame.click('#action');
	frame = await storeFrame(page, 'Remove from Chrome');
	const replaced = await frame.evaluate(
		async (old) => ({
			all: await chrome.management.getAll(),
			old: await chrome.webstorePrivate.getExtensionStatus(old),
		}),
		OMNI.id,
	);
	ok(
		`${mode}: a second theme replaces the first: getAll answers as Chrome 157's`,
		JSON.stringify(replaced.all) === JSON.stringify(NATIVE_AFTER_REPLACE),
		JSON.stringify(replaced.all),
	);
	ok(
		`${mode}: the replaced theme's status is disabled`,
		replaced.old === 'disabled',
		replaced.old,
	);
	const latte = await heardTheme(page, LATTE.id);
	ok(
		`${mode}: the host hears the new theme (colors only, no images)`,
		latte?.name === LATTE.manifest.name &&
			JSON.stringify(latte.theme.colors) ===
				JSON.stringify(LATTE.manifest.theme.colors) &&
			JSON.stringify(latte.theme.images) === '{}' &&
			JSON.stringify(latte.theme.tints) === '{}',
		JSON.stringify(latte && latte.name),
	);
	await submitOmni(page, storeURL(OMNI));
	frame = await storeFrame(page, 'Add to Chrome');
	log = await pageLog(frame);
	const listed = await page.evaluate(async () =>
		(await window.controller.extensions.themes()).map((theme) => [
			theme.extensionId,
			theme.enabled,
		]),
	);
	ok(
		`${mode}: once the document that installed it is gone, the replaced theme is uninstalled`,
		log
			.filter((entry) => entry[0] === 'getAll')
			.every(
				(entry) =>
					JSON.stringify(entry[1]) === JSON.stringify([[LATTE.id, true]]),
			) &&
			JSON.stringify(log.at(-1)) === '["status","installable"]' &&
			JSON.stringify(listed) === JSON.stringify([[LATTE.id, true]]),
		JSON.stringify({ log, listed }),
	);

	// ---- a reload of the host: still shown, still installed
	await page.reload();
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	await hearThemes(page);
	const kept = await heardTheme(page, LATTE.id);
	ok(
		`${mode}: after a reload of the host, onTheme tells the installed theme`,
		kept?.name === LATTE.manifest.name &&
			(await heard(page)).length === 1 &&
			(await page.evaluate(
				async () => (await window.controller.extensions.theme())?.extensionId,
			)) === LATTE.id,
		JSON.stringify(await heard(page)),
	);
	await submitLanding(page, storeURL(LATTE));
	frame = await storeFrame(page, 'Remove from Chrome');
	ok(
		`${mode}: after the reload the store offers Remove from Chrome`,
		JSON.stringify((await pageLog(frame)).at(-1)) === '["status","enabled"]',
		JSON.stringify(await pageLog(frame)),
	);

	// ---- Remove from Chrome: the host asks, Remove uninstalls it
	await frame.click('#action');
	await until(page, () => !!document.getElementById('passkeyPrompt'), Boolean);
	const title = await page.evaluate(
		() => document.getElementById('passkeyPromptTitle')?.textContent ?? null,
	);
	ok(
		`${mode}: Remove from Chrome asks the host Remove "<name>"?`,
		title === `Remove "${LATTE.manifest.name}"?`,
		String(title),
	);
	await answerDialog(page, 'Remove');
	frame = await storeFrame(page, 'Add to Chrome');
	log = await pageLog(frame);
	ok(
		`${mode}: Remove uninstalls it: onUninstalled, and the host hears the default theme`,
		log.some(
			(entry) => entry[0] === 'onUninstalled' && entry[1] === LATTE.id,
		) &&
			JSON.stringify(log.find((entry) => entry[0] === 'uninstall')) ===
				'["uninstall",null]' &&
			(await heardTheme(page, null)) === null,
		JSON.stringify(log),
	);

	// ---- the suite's own signed theme, installed by the host
	const ran = backgroundRan;
	const info = await page.evaluate(
		async (bytes) => {
			const { extensions } = window.controller;
			const info = await extensions.install(new Uint8Array(bytes));
			return { info, actions: await extensions.actions() };
		},
		[...OWN.bytes],
	);
	const own = await heardTheme(page, OWN.id);
	ok(
		`${mode}: the signed theme installs from its CRX3, its name and description localized`,
		info.info.id === OWN.id &&
			info.info.type === 'theme' &&
			own?.name === 'Suite Theme' &&
			own.description === 'A theme of the suite.' &&
			own.source === 'package',
		JSON.stringify({ info: info.info.name, own: own?.name }),
	);
	ok(
		`${mode}: its colors, tints and properties are the manifest's, unchanged`,
		JSON.stringify(own?.theme.colors) === JSON.stringify(OWN_THEME.colors) &&
			JSON.stringify(own.theme.tints) === JSON.stringify(OWN_THEME.tints) &&
			JSON.stringify(own.theme.properties) ===
				JSON.stringify(OWN_THEME.properties),
		JSON.stringify(own?.theme),
	);
	const ownImages = own ? await imageWidths(page, own.theme.images) : [];
	ok(
		`${mode}: its new tab page image and its images per scale load, a missing one left out`,
		JSON.stringify(ownImages) ===
			JSON.stringify([
				['theme_ntp_background', '', 'blob:', 40],
				['theme_frame', '100_percent', 'blob:', 10],
				['theme_frame', '200_percent', 'blob:', 20],
			]),
		JSON.stringify(ownImages),
	);
	ok(
		`${mode}: nothing of it is granted or runs: no permissions, content scripts, background or button`,
		JSON.stringify(info.info.permissions) === '[]' &&
			JSON.stringify(info.info.hostPermissions) === '[]' &&
			info.info.contentScripts === 0 &&
			info.info.background === 'none' &&
			info.info.hasAction === false &&
			info.actions.length === 0 &&
			[
				'permissions',
				'host_permissions',
				'background',
				'content_scripts',
				'declarative_net_request',
				'action',
				'web_accessible_resources',
			].every(
				(key) =>
					!(key in info.info.manifest) &&
					info.info.warnings.some((warning) => warning.includes(`"${key}"`)),
			),
		JSON.stringify(info.info),
	);
	ok(
		`${mode}: the theme it replaced (installed by no store document) went at once`,
		JSON.stringify(
			await page.evaluate(async () =>
				(await window.controller.extensions.list()).map((item) => item.id),
			),
		) === JSON.stringify([OWN.id]),
	);
	await submitOmni(page, OTHER);
	let other = null;
	for (let tries = 0; tries < 100 && !other; tries++) {
		const found = await activeFrame(page);
		other = await found
			?.evaluate(() =>
				document.readyState === 'complete' &&
				document.title &&
				!document.title.includes('Chrome Web Store')
					? {
							title: document.title,
							ran: document.documentElement.dataset.themeRan ?? null,
						}
					: null,
			)
			.catch(() => null);
		if (!other) await sleep(200);
	}
	await sleep(1500);
	const ranLater = await (
		await activeFrame(page)
	)
		?.evaluate(() => document.documentElement.dataset.themeRan ?? null)
		.catch(() => 'gone');
	ok(
		`${mode}: its content script does not run and its rule blocks nothing`,
		!!other && other.ran === null && ranLater === null,
		JSON.stringify({ other, ranLater }),
	);
	ok(
		`${mode}: its background never ran`,
		backgroundRan === ran,
		String(backgroundRan - ran),
	);
	/** what a tab shows of one of its files: the document's type and title, once it is the file's */
	const shows = async (path) => {
		const typed = `chrome-extension://${OWN.id}/${path}`;
		await submitOmni(page, typed);
		await until(
			page,
			() => document.querySelector('#omni input').value,
			(value) => value === typed,
			20000,
		);
		await sleep(1500);
		return (await activeFrame(page))
			?.evaluate(() => ({
				href: location.href,
				type: document.contentType,
				title: document.title,
				text: document.body?.innerText.slice(0, 80) ?? '',
			}))
			.catch((error) => String(error));
	};
	const served = {
		page: await shows('page.html'),
		image: await shows('images/ntp.png'),
	};
	ok(
		`${mode}: its pages are not served (nothing of them runs), its pictures are`,
		served.page?.title !== 'ran' &&
			/A theme has no pages/.test(served.page?.text) &&
			served.image?.type === 'image/png',
		JSON.stringify(served),
	);

	// ---- Reset to default
	await page.evaluate(() => window.controller.extensions.resetTheme());
	ok(
		`${mode}: resetTheme() uninstalls every theme and the host hears the default`,
		(await heardTheme(page, null)) === null &&
			(await page.evaluate(
				async () => (await window.controller.extensions.themes()).length,
			)) === 0 &&
			(await page.evaluate(
				async () => (await window.controller.extensions.list()).length,
			)) === 0,
	);
	await page.context().close();
}

// ---- the demo's default theme ---------------------------------------------

const SHOOTING_STAR = 'joaodcepoceejhgkojhmnjknhaikcgoi';
const OMNI_THEME = `chrome-theme:${OMNI.id}`;

/** the demo with `defaults` as its config's `defaultThemes` (undefined: the key left out, the page's own list) */
const withDefaults = (defaults) => async (page) => {
	await storeTransport(page);
	await page.route('**/config.js', async (route) => {
		const answer = await route.fetch();
		const config = JSON.parse(
			(await answer.text())
				.replace(/^window\.STOMP_CONFIG = /, '')
				.replace(/;\s*$/, ''),
		);
		delete config.defaultThemes;
		if (defaults) config.defaultThemes = defaults;
		await route.fulfill({
			response: answer,
			body: `window.STOMP_CONFIG = ${JSON.stringify(config)};\n`,
		});
	});
};

/** what the page has of the themes: the theme system's, the worker's, the seed's marker, Default's backgrounds */
const themeState = (page) =>
	page.evaluate(async (id) => {
		const root = document.documentElement;
		const look = (element) => {
			const style = element && getComputedStyle(element);
			return style && [style.backgroundColor, style.backgroundImage];
		};
		return {
			listed: PMTheme.list()
				.filter((theme) => theme.source !== 'builtin')
				.map((theme) => [theme.id, theme.name, theme.source]),
			shown: PMTheme.current().id,
			theme: root.getAttribute('data-pm-theme'),
			custom: root.hasAttribute('data-pm-custom'),
			choice: localStorage.getItem('stomp-demo:theme'),
			seeded: localStorage.getItem('stomp-demo:themes-seeded'),
			worker: (await window.controller.extensions.themes()).map((theme) => [
				theme.extensionId,
				theme.enabled,
			]),
			chromeTheme: await window.controller.extensions.theme(),
			info: await window.controller.extensions.get(id),
			// the page, the home page's title bar and its card
			look: [
				look(document.body),
				look(document.querySelector('#landing .head')),
				look(document.querySelector('#landing .listing')),
			],
		};
	}, OMNI.id);

const booted = (page) =>
	page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);

/** a tab on a fixture page, so the bar and its menu are up */
async function browsing(page) {
	await submitLanding(page, OTHER);
	await page.waitForFunction(
		() =>
			!document.getElementById('browser').classList.contains('hidden') &&
			!document.getElementById('toolMenu').hidden,
		null,
		{ timeout: 30000 },
	);
}

/** the menu's Settings page, its theme picker drawn */
async function openPicker(page) {
	await page.click('#toolMenu');
	await sleep(300);
	await page.click('#menuSettings');
	await page.waitForSelector('#spThemes .spThemePick');
}

/** the Themes submenu's rows and the picker's, each [id, checked] */
async function themeLists(page) {
	await page.click('#toolMenu');
	await sleep(300);
	await page.hover('#menuThemes');
	await page.waitForSelector('.extSubmenu [data-theme]');
	const menu = await page.$$eval('.extSubmenu [data-theme]', (rows) =>
		rows.map((row) => [row.dataset.theme, row.getAttribute('aria-checked')]),
	);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await sleep(300);
	await openPicker(page);
	const picker = await page.$$eval('#spThemes .spThemePick', (picks) =>
		picks.map((pick) => [
			pick.dataset.theme,
			pick.getAttribute('aria-checked'),
		]),
	);
	return { menu, picker };
}

/** the Themes submenu's Reset to default: whether it is off, and a click on it when it is on */
async function resetFromMenu(page) {
	await page.click('#toolMenu');
	await sleep(300);
	await page.hover('#menuThemes');
	const reset = '.extSubmenu [data-command="resetTheme"]';
	await page.waitForSelector(reset);
	const disabled = await page.$eval(reset, (row) => row.disabled);
	if (disabled) {
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	} else await page.click(reset);
	await sleep(300);
	return disabled;
}

/** the theme shown, once the worker and the theme system are past a Reset */
const afterReset = (page) =>
	until(
		page,
		async (id) => ({
			shown: PMTheme.current().id,
			listed: PMTheme.list()
				.filter((theme) => theme.source !== 'builtin')
				.map((theme) => theme.id),
			worker: (await window.controller.extensions.themes()).map((theme) => [
				theme.extensionId,
				theme.enabled,
			]),
			info: !!(await window.controller.extensions.get(id)),
		}),
		(value) => value?.shown === 'default',
		30000,
		OMNI.id,
	);

async function defaults() {
	// Default's look in a profile no default theme reaches (the run's config)
	const plain = await openDemo(browser, HOST);
	const defaultLook = (await themeState(plain)).look;
	await plain.context().close();

	const page = await openDemo(browser, HOST, {}, withDefaults([OMNI.id]));
	page.on('pageerror', (error) => errors.push(`defaults: ${error.message}`));
	const omniDownloads = downloads.get(OMNI.id) ?? 0;
	const downloaded = () => (downloads.get(OMNI.id) ?? 0) - omniDownloads;
	await until(
		page,
		() =>
			!!localStorage.getItem('stomp-demo:themes-seeded') &&
			PMTheme.list().some((theme) => theme.source === 'webstore'),
		Boolean,
	);
	let now = await themeState(page);
	ok(
		'defaults: a fresh profile has the default theme installed after boot, off, with Default shown',
		JSON.stringify(now.listed) ===
			JSON.stringify([[OMNI_THEME, OMNI.manifest.name, 'webstore']]) &&
			now.shown === 'default' &&
			now.theme === null &&
			!now.custom &&
			now.choice === null &&
			now.seeded === JSON.stringify([OMNI.id]) &&
			JSON.stringify(now.worker) === JSON.stringify([[OMNI.id, false]]) &&
			now.chromeTheme === null &&
			now.info?.type === 'theme' &&
			now.info.enabled === false &&
			downloaded() === 1,
		JSON.stringify({ ...now, look: undefined, info: now.info?.enabled }),
	);
	ok(
		"defaults: the page keeps Default's backgrounds, those of a profile with no default theme",
		JSON.stringify(now.look) === JSON.stringify(defaultLook),
		JSON.stringify({ now: now.look, defaultLook }),
	);
	await browsing(page);
	const lists = await themeLists(page);
	const builtins = [
		['default', 'true'],
		['light', 'false'],
		['dark', 'false'],
		['systemya-light', 'false'],
		['system', 'false'],
	];
	ok(
		'defaults: the Themes submenu and the picker list it unchecked, Default checked',
		JSON.stringify(lists.menu) ===
			JSON.stringify([...builtins, [OMNI_THEME, 'false']]) &&
			JSON.stringify(lists.picker) ===
				JSON.stringify([...builtins, [OMNI_THEME, 'false']]),
		JSON.stringify(lists),
	);

	await page.goto(HOST);
	await booted(page);
	await sleep(4000); // past the seed's idle callback
	now = await themeState(page);
	ok(
		'defaults: after a reload it is still installed and off, and not downloaded again',
		JSON.stringify(now.listed.map(([id]) => id)) ===
			JSON.stringify([OMNI_THEME]) &&
			now.shown === 'default' &&
			!now.custom &&
			JSON.stringify(now.worker) === JSON.stringify([[OMNI.id, false]]) &&
			JSON.stringify(now.look) === JSON.stringify(defaultLook) &&
			downloaded() === 1,
		JSON.stringify({ ...now, look: undefined, info: undefined }),
	);

	// Remove in the picker, then a reload: it stays removed
	await browsing(page);
	await openPicker(page);
	await page.click(`.spThemeRemove[data-theme="${OMNI_THEME}"]`);
	await until(
		page,
		async (id) =>
			!PMTheme.list().some((theme) => theme.source !== 'builtin') &&
			!(await window.controller.extensions.get(id)),
		Boolean,
		30000,
		OMNI.id,
	);
	await page.goto(HOST);
	await booted(page);
	await sleep(4000);
	now = await themeState(page);
	ok(
		'defaults: removed and reloaded, it does not come back',
		now.listed.length === 0 &&
			now.worker.length === 0 &&
			now.info === null &&
			now.shown === 'default' &&
			now.seeded === JSON.stringify([OMNI.id]) &&
			JSON.stringify(now.look) === JSON.stringify(defaultLook) &&
			downloaded() === 1,
		JSON.stringify({ ...now, look: undefined }),
	);
	await page.context().close();

	// Reset to default: off while Default is shown, though a theme is
	// installed; on another theme it shows Default, and uninstalls the theme
	// shown when it is the Web Store one, never one that is not shown
	const fresh = await openDemo(browser, HOST, {}, withDefaults([OMNI.id]));
	fresh.on('pageerror', (error) => errors.push(`defaults: ${error.message}`));
	await until(
		fresh,
		() => !!localStorage.getItem('stomp-demo:themes-seeded'),
		Boolean,
	);
	await browsing(fresh);
	const offAtDefault = await resetFromMenu(fresh);
	ok(
		'defaults: on a fresh profile Reset to default is off',
		offAtDefault === true &&
			(await fresh.evaluate(() => PMTheme.current().id)) === 'default',
		String(offAtDefault),
	);
	await fresh.evaluate(() => PMTheme.apply('light'));
	const onAtLight = await resetFromMenu(fresh);
	const fromLight = await afterReset(fresh);
	ok(
		'defaults: Reset from Light shows Default and leaves the installed theme that is not shown',
		onAtLight === false &&
			fromLight?.shown === 'default' &&
			JSON.stringify(fromLight.listed) === JSON.stringify([OMNI_THEME]) &&
			JSON.stringify(fromLight.worker) === JSON.stringify([[OMNI.id, false]]),
		JSON.stringify({ onAtLight, fromLight }),
	);
	await fresh.evaluate((id) => PMTheme.apply(id), OMNI_THEME);
	const shownBefore = await fresh.evaluate(() => ({
		shown: PMTheme.current().id,
		custom: document.documentElement.hasAttribute('data-pm-custom'),
	}));
	const onAtTheme = await resetFromMenu(fresh);
	const fromTheme = await until(
		fresh,
		async (id) => ({
			shown: PMTheme.current().id,
			custom: document.documentElement.hasAttribute('data-pm-custom'),
			body: getComputedStyle(document.body).backgroundColor,
			listed: PMTheme.list().filter((theme) => theme.source !== 'builtin')
				.length,
			info: !!(await window.controller.extensions.get(id)),
		}),
		(value) => value?.shown === 'default' && !value.listed && !value.info,
		30000,
		OMNI.id,
	);
	ok(
		'defaults: after the default theme is applied, Reset shows Default and uninstalls it',
		shownBefore.shown === OMNI_THEME &&
			shownBefore.custom &&
			onAtTheme === false &&
			fromTheme?.shown === 'default' &&
			!fromTheme.custom &&
			fromTheme.body === defaultLook[0][0] &&
			fromTheme.listed === 0 &&
			!fromTheme.info,
		JSON.stringify({ shownBefore, onAtTheme, fromTheme }),
	);
	await fresh.goto(HOST);
	await booted(fresh);
	await sleep(4000);
	now = await themeState(fresh);
	ok(
		'defaults: reset away and reloaded, it does not come back',
		now.listed.length === 0 &&
			now.worker.length === 0 &&
			now.shown === 'default' &&
			JSON.stringify(now.look) === JSON.stringify(defaultLook),
		JSON.stringify({ ...now, look: undefined }),
	);
	await fresh.context().close();

	// the page's own list: Shooting Star (pink), asked of the update service
	// (the suite's store has no such package, so the download fails, as it
	// would offline)
	const before = asked.length;
	const own = await openDemo(browser, HOST, {}, withDefaults(undefined));
	own.on('pageerror', (error) => errors.push(`defaults: ${error.message}`));
	const start = Date.now();
	while (Date.now() - start < 20000 && asked.length === before)
		await sleep(200);
	await sleep(1500);
	now = await themeState(own);
	const status = await own.evaluate(
		() => document.getElementById('logMsg').textContent,
	);
	ok(
		'defaults: with no list in the config the page asks for Shooting Star (pink); a failed download changes nothing and is not marked offered',
		JSON.stringify(asked.slice(before)) === JSON.stringify([SHOOTING_STAR]) &&
			now.listed.length === 0 &&
			now.worker.length === 0 &&
			now.shown === 'default' &&
			now.seeded === null &&
			JSON.stringify(now.look) === JSON.stringify(defaultLook) &&
			/^Ready/.test(status),
		JSON.stringify({
			asked: asked.slice(before),
			status,
			...now,
			look: undefined,
		}),
	);
	await own.context().close();
}

await run('isolated', HOST);
await run('same-origin', PROXY);
await defaults();
server.close();
await done(browser, errors);
