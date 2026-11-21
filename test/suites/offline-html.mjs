// offline.html (scripts/build-offline.mjs, the end of `npm run build`): the
// build's file, opened from file: with this run's demo server as its wisp
// server, and no service worker anywhere. The controller comes up, a
// fixture page loads through the worker emulated in the page with its
// stylesheet, image and script, and its own fetch and XMLHttpRequest, a
// link, back, forward, reload, a GET form, a POST form and a location write
// of its script all work, and its document reads the pages' mode (Settings,
// Page appearance) for prefers-color-scheme; nothing reaches the fixture but
// through the wisp server. A site's own features (test/pages/offline-sites.html:
// suggestions for what is typed by fetch and XMLHttpRequest, localStorage,
// sessionStorage, pushState and Back, a frame of its own, a WebSocket to the
// fixture's echo, a worker of its script and one of a blob: URL) give the
// same report offline as on the served demo.
//
// The demo server serves the file and its SHA-256 at /offline.html, and the
// home page's Download, left of Fork us on GitHub, saves it with the page's
// wisp server written in and nothing else changed: the server's own, and
// one the deployment's config names, whose saved file boots from file: and
// loads the fixture through it. A demo server whose file is missing builds
// it itself (503 with Retry-After until then, then the bytes of the build's
// file), and a page that names that server's /offline.html, another
// origin's, as STOMP_ASSETS.offline saves it with its own wisp server.
// With Tor on, Download still writes the direct wisp server, and in a
// sandboxed frame (a host's copy of the page) it saves only with
// allow-downloads. The file has Tor mode of its own: a build with the
// stand-in for the Tor network (test/offline-tor-stand-in.mjs) turns it on,
// its client in a worker of the page bootstraps, a fixture page loads on
// its streams, and the client's IndexedDB is kept across a reload.
// Settings saves a relay without writing it into the URL; restart and reload
// both use it even if the storage write was lost. The default theme is marked
// offered in each file: page (it would come from the Web Store), and every
// stream the wisp server opened (the runner's WISP_LOG) went to this host.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	omni,
	openDemo,
	OUT,
	PORT,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const file = `${root}build/offline.html`;
if (!existsSync(file))
	throw new Error('build/offline.html is not there: `npm run build` writes it');
const WISP = `ws://127.0.0.1:${PORT}/wisp/`;
const opened = `${pathToFileURL(file).href}?wisp=${encodeURIComponent(WISP)}`;

// the default themes main.js offers once, as offered already
const defaults = JSON.parse(
	/const DEFAULT_THEMES[^?]*\?[^:]*:\s*(\[[^\]]*\])/
		.exec(readFileSync(`${root}demo/public/pm/main.js`, 'utf8'))[1]
		.replaceAll("'", '"'),
);
const offeredAlready = (ids) => {
	if (window === top && location.protocol === 'file:')
		try {
			localStorage.setItem('stomp-demo:themes-seeded', JSON.stringify(ids));
		} catch {
			// no storage: nothing is kept either
		}
};

const browser = await launch();
// (no emulated preference: the pages' mode is what the frames read)
const page = await browser.newPage({
	viewport: { width: 1280, height: 800 },
	colorScheme: null,
});
await page.addInitScript(offeredAlready, defaults);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
// every request the page and its frames make, but the file's own copies
const asked = [];
page.on('request', (request) => {
	const url = request.url();
	if (!/^(file|blob|data):/.test(url)) asked.push(url);
});
const sockets = [];
page.on('websocket', (socket) => sockets.push(socket.url()));

const ready = async (on = page) => {
	await on.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg')?.textContent),
		null,
		{ timeout: 60000 },
	);
	return on.evaluate(() => document.getElementById('logMsg').textContent);
};

/**
 * the newest document of the tab titled `title` (each document has a frame
 * of its own); `any`: in a frame of any URL (the served demo's)
 */
async function documentTitled(title, timeout = 30000, on = page, any = false) {
	for (const end = Date.now() + timeout; Date.now() < end;) {
		const frames = on
			.frames()
			.filter((frame) => any || frame.url() === 'about:srcdoc')
			.reverse();
		for (const frame of frames) {
			const seen = await frame.evaluate(() => document.title).catch(() => '');
			if (seen === title) return frame;
		}
		await sleep(100);
	}
	return null;
}
const until = (frame, fn) =>
	frame
		.waitForFunction(fn, null, { timeout: 20000 })
		.then(() => true)
		.catch(() => false);

await page.goto(opened);
const status = await ready();
ok(
	'the controller comes up from file: with no service worker',
	status === 'Ready',
	status,
);
ok(
	'no service worker controls or was registered for the page',
	await page.evaluate(
		async () =>
			navigator.serviceWorker.controller === null &&
			(await navigator.serviceWorker.getRegistrations().catch(() => []))
				.length === 0,
	),
);

// the home page's commit list: no avatar, which with no server of the file's
// own would be the visitor's machine asking GitHub's avatar host
await page
	.waitForFunction(() => document.querySelector('#commitList li'), null, {
		timeout: 10000,
	})
	.catch(() => {});
const avatars = await page.evaluate(() => ({
	rows: document.querySelectorAll('#commitList li').length,
	images: document.querySelectorAll('#commitList img').length,
	spans: document.querySelectorAll('#commitList span.commitAvatar').length,
}));
ok(
	'the commit list has no avatars, an empty span in each row, and the file names no avatar host',
	avatars.rows > 0 &&
		avatars.images === 0 &&
		avatars.spans === avatars.rows &&
		!readFileSync(file, 'utf8').includes('avatars.githubusercontent.com'),
	JSON.stringify(avatars),
);

const one = `${FIXTURE}pages/offline-html.html`;
const before = (await (await fetch(`${FIXTURE}requests`)).json()).length;
await submitLanding(page, one);
let frame = await documentTitled('Offline page one');
ok('a fixture page loads', !!frame);
if (frame) {
	ok(
		'its stylesheet, image and script load',
		(await until(
			frame,
			() =>
				getComputedStyle(document.getElementById('heading')).color ===
					'rgb(0, 128, 0)' &&
				document.getElementById('picture').naturalWidth === 40 &&
				document.body.dataset.script === '/pages/offline-html.html',
		)) || (await frame.evaluate(() => document.body.outerHTML.slice(0, 300))),
	);
	ok(
		'the address bar shows the page',
		(await omni(page)) === one,
		await omni(page),
	);
	// the pages' mode reaches the document's own frame, as it reaches the
	// demo's frames (the color-scheme of the tab's element)
	const reads = async (dark) => {
		await page.evaluate(
			(mode) => globalThis.PMTheme.setPageMode(mode),
			dark ? 'dark' : 'light',
		);
		return frame
			.waitForFunction(
				(dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
				dark,
				{ timeout: 10000 },
			)
			.then(() => true)
			.catch(() => false);
	};
	const pageModes = [await reads(true), await reads(false)];
	await page.evaluate(() => globalThis.PMTheme.setPageMode('theme'));
	ok(
		"the page's document reads the pages' mode, dark and then light",
		pageModes.every(Boolean),
		JSON.stringify(pageModes),
	);
	const served = (await (await fetch(`${FIXTURE}requests`)).json()).slice(
		before,
	);
	ok(
		'the fixture served the page and its loads, through the wisp server',
		[
			'/pages/offline-html.html',
			'/pages/offline-html.css',
			'/pages/offline-html.svg',
			'/pages/offline-html.js',
		].every((path) => served.includes(path)),
		served.join(' '),
	);

	// the page's own fetch and XMLHttpRequest (run as the page's script).
	// (Their response's url reads empty: a Response the page makes has none,
	// and the inject reads the browser's)
	await frame.evaluate(() => {
		const script = document.createElement('script');
		script.textContent = `(async () => {
			const response = await fetch('offline-html.css');
			const request = new XMLHttpRequest();
			request.open('GET', 'offline-html.css');
			request.send();
			await new Promise((resolve) => { request.onloadend = resolve; });
			window.fetched = [response.status, (await response.text()).includes('#heading'), request.status, request.responseText.includes('#heading')];
		})().catch((error) => { window.fetched = String(error); })`;
		document.head.append(script);
	});
	await until(frame, () => window.fetched);
	const fetched = await frame.evaluate(() => window.fetched);
	ok(
		"the page's fetch and XMLHttpRequest reach its site",
		JSON.stringify(fetched) === JSON.stringify([200, true, 200, true]),
		JSON.stringify(fetched),
	);

	await frame.click('#next');
	frame = await documentTitled('Offline page two');
	ok(
		'a link goes to the next page',
		!!frame && (await omni(page)) === `${FIXTURE}pages/offline-html-2.html`,
		await omni(page),
	);

	await page.click('#toolBack');
	frame = await documentTitled('Offline page one');
	ok(
		'back goes to the first page',
		!!frame && (await omni(page)) === one,
		await omni(page),
	);

	await page.click('#toolForward');
	frame = await documentTitled('Offline page two');
	ok('forward goes to the second page again', !!frame, await omni(page));

	await page.click('#toolBack');
	frame = await documentTitled('Offline page one');
	await frame?.evaluate(() => {
		window.beforeReload = true;
	});
	await page.click('#toolReload');
	let fresh = false;
	for (let i = 0; i < 100 && !fresh; i++) {
		frame = await documentTitled('Offline page one');
		fresh =
			!!frame &&
			!(await frame.evaluate(() => window.beforeReload).catch(() => true));
		if (!fresh) await sleep(100);
	}
	ok('reload makes the page again', fresh);

	await frame?.click('#searchButton');
	frame = await documentTitled('Offline page two');
	ok(
		'a GET form sends its fields in the query',
		!!frame &&
			(await until(
				frame,
				() => document.getElementById('query').textContent === 'first query',
			)) &&
			(await omni(page)) ===
				`${FIXTURE}pages/offline-html-2.html?q=first+query`,
		await omni(page),
	);

	await page.click('#toolBack');
	frame = await documentTitled('Offline page one');
	await frame?.click('#postButton');
	frame = await documentTitled('Offline posted');
	const posted = await frame
		?.evaluate(() => [
			document.getElementById('method').textContent,
			document.getElementById('body').textContent,
		])
		.catch(() => null);
	ok(
		'a POST form sends its body',
		posted?.[0] === 'POST' && posted?.[1] === 'q=posted+value',
		JSON.stringify(posted),
	);

	// a location write of the page's script
	await frame?.evaluate(() => {
		const script = document.createElement('script');
		script.textContent =
			"location.href = '/pages/offline-html-2.html?q=script'";
		document.head.append(script);
	});
	frame = await documentTitled('Offline page two');
	ok(
		"the page's script navigates it",
		!!frame &&
			(await until(
				frame,
				() => document.getElementById('query').textContent === 'script',
			)) &&
			(await omni(page)) === `${FIXTURE}pages/offline-html-2.html?q=script`,
		await omni(page),
	);
}

// ---- what a site does, offline as on the served demo: suggestions for
// what is typed by fetch and XMLHttpRequest, localStorage and
// sessionStorage, pushState and Back, a frame of its own, a WebSocket and
// two workers (test/pages/offline-sites.html)
const SITE = `${FIXTURE}pages/offline-sites.html`;
async function siteReport(on, any) {
	await submitLanding(on, SITE);
	const frame = await documentTitled('Offline sites', 30000, on, any);
	if (!frame) return null;
	const report = await frame
		.waitForFunction(() => document.body.dataset.report, null, {
			timeout: 30000,
		})
		.then(async (handle) => JSON.parse(await handle.jsonValue()))
		.catch(() => null);
	await frame.click('#box');
	await frame.type('#box', 'we', { delay: 50 });
	const suggested = await frame
		.waitForFunction(
			() => {
				const items = [...document.querySelectorAll('#suggestions li')];
				return items.length === 3 && items.map((item) => item.textContent);
			},
			null,
			{ timeout: 20000 },
		)
		.then((handle) => handle.jsonValue())
		.catch(() => null);
	return { ...report, suggested };
}
const SITE_REPORT = {
	localStorage: [null, 'kept'],
	sessionStorage: 'session',
	pushState: ['?pushed=1', 1, ''],
	frame: [
		'Offline sites frame',
		'/pages/offline-sites-frame.html',
		'?from=parent',
		'Offline sites',
	],
	webSocket: ['/ws-echo', true],
	worker: ['hello', 4, '/pages/offline-sites-worker.js'],
	blobWorker: 42,
	suggested: ['weather 0', 'weather in paris 1', 'web 2'],
};
const offlineSite = await siteReport(page, false);
const servedDemo = await openDemo(browser);
const servedSite = await siteReport(servedDemo, true);
await servedDemo.close();
ok(
	'a site works offline as on the served demo: suggestions by fetch and XMLHttpRequest, storage, pushState and Back, its frame, a WebSocket and its workers',
	JSON.stringify(offlineSite) === JSON.stringify(servedSite) &&
		JSON.stringify(servedSite) === JSON.stringify(SITE_REPORT),
	JSON.stringify({ offlineSite, servedSite }),
);

const fixtureOrigin = new URL(FIXTURE).origin;
ok(
	'nothing reaches the fixture but through the wisp server',
	!asked.some((url) => url.startsWith(fixtureOrigin)) &&
		sockets.some((url) => url.startsWith(WISP)),
	JSON.stringify({
		direct: asked.filter((url) => url.startsWith(fixtureOrigin)).slice(0, 3),
		sockets,
	}),
);

// ---- /offline.html and the home page's Download
const served = await fetch(`${HOST}offline.html`);
const servedText = await served.text();
const servedSha = await (await fetch(`${HOST}offline.html.sha256`)).text();
const builtSha = createHash('sha256').update(readFileSync(file)).digest('hex');
ok(
	'the demo server serves offline.html as the build wrote it, with its SHA-256',
	served.status === 200 &&
		/^text\/html/.test(served.headers.get('content-type')) &&
		served.headers.get('etag') === `"${builtSha}"` &&
		served.headers.get('access-control-allow-origin') === '*' &&
		served.headers.get('access-control-expose-headers') === 'ETag' &&
		createHash('sha256').update(servedText).digest('hex') === builtSha &&
		servedSha === `${builtSha}  offline.html\n`,
	JSON.stringify({
		status: served.status,
		type: served.headers.get('content-type'),
		etag: served.headers.get('etag'),
		servedSha,
		builtSha,
	}),
);
const revalidated = await fetch(`${HOST}offline.html`, {
	// (fetch sends no-cache with a conditional request unless told otherwise)
	headers: { 'if-none-match': `"${builtSha}"`, 'cache-control': 'max-age=0' },
});
ok('and answers a revalidation with 304', revalidated.status === 304);

const SLOT = /<script type="application\/json" id="pm-wisp">([^<]*)<\/script>/;
const slotOf = (text) => JSON.parse(SLOT.exec(text)?.[1] ?? 'null');
const unslotted = (text) => text.replace(SLOT, '');
let saved = 0;
/** what Download on `on` saves: its name, where it is now, its text */
async function download(on) {
	const [got] = await Promise.all([
		on.waitForEvent('download', { timeout: 30000 }),
		on.click('#offlineDownload .git'),
	]);
	const path = `${OUT}offline-html-download-${++saved}.html`;
	await got.saveAs(path);
	return {
		name: got.suggestedFilename(),
		path,
		text: readFileSync(path, 'utf8'),
	};
}
// (main.js's wispURL, a global of the page's script)
const configuredWisp = (on) =>
	on.evaluate('new URL(wispURL(), location.href).href');

const demo = await openDemo(browser);
const placed = await demo.evaluate(() => {
	const box = (element) => element?.getBoundingClientRect().toJSON();
	return {
		download: box(document.querySelector('#offlineDownload .git')),
		fork: box(
			document.querySelector(
				'a[href="https://github.com/Fracital/powerMouse"] .git',
			),
		),
		icon: document.querySelector('#offlineDownload img')?.naturalWidth,
	};
});
ok(
	'Download sits left of Fork us on GitHub, in its row and at its size',
	!!placed.download &&
		!!placed.fork &&
		placed.download.right <= placed.fork.left &&
		placed.fork.left - placed.download.right < 20 &&
		Math.abs(placed.download.top - placed.fork.top) < 1 &&
		Math.abs(placed.download.height - placed.fork.height) < 1 &&
		Math.abs(placed.download.width - placed.fork.width) < 1 &&
		placed.icon === 24,
	JSON.stringify(placed),
);
// the demo page's direct wisp server: its own origin's, as it dials there
// (docs/dialing.md; its classic tabs on localhost were isolated, with the
// proxy and its wisp server on 127.0.0.1)
const DIRECT = `ws://${new URL(HOST).host}/wisp/`;
const own = await download(demo);
const ownWisp = await configuredWisp(demo);
ok(
	"Download saves offline.html with the server's own wisp server in it, and nothing else changed",
	own.name === 'offline.html' &&
		slotOf(own.text) === ownWisp &&
		ownWisp === DIRECT &&
		unslotted(own.text) === unslotted(servedText),
	JSON.stringify({ name: own.name, saved: slotOf(own.text), ownWisp }),
);
await demo.close();

// a deployment whose config names another wisp server (STOMP_WISP_URL)
const CUSTOM = `${WISP}?deployment=custom`;
const custom = await openDemo(browser, HOST, {}, (on) =>
	on.route('**/config.js', async (route) => {
		const response = await route.fetch();
		await route.fulfill({
			response,
			body: `${await response.text()}window.STOMP_CONFIG.wisp = ${JSON.stringify(CUSTOM)};\n`,
		});
	}),
);
const theirs = await download(custom);
ok(
	"Download saves offline.html with the config's wisp server in it",
	slotOf(theirs.text) === CUSTOM &&
		(await configuredWisp(custom)) === CUSTOM &&
		unslotted(theirs.text) === unslotted(servedText),
	JSON.stringify({ saved: slotOf(theirs.text) }),
);
await custom.close();

// Tor mode (the in-browser client's place taken by the suites' stand-in,
// epoxy over the demo's /wisp/: STOMP_TOR_CLIENT=stand-in, test/run.mjs):
// Download still writes the direct wisp server (the file's Tor mode
// tunnels through it too) and the file is the served one
const tor = await openDemo(browser, `${HOST}?tor=1`);
const torSaved = await download(tor);
const torTitle = await tor.getAttribute('#offlineDownload', 'title');
ok(
	'with Tor on, Download writes the direct wisp server',
	(await tor.evaluate('TOR_REQUESTED && TOR_CLIENT')) &&
		slotOf(torSaved.text) === DIRECT &&
		!/no Tor mode/.test(torTitle ?? '') &&
		unslotted(torSaved.text) === unslotted(servedText),
	JSON.stringify({ saved: slotOf(torSaved.text), title: torTitle }),
);
await tor.close();

// a host that frames the page in a sandbox (a page of its own origin, as
// SystemYA's /app/ frames its /ui/; Chrome's local network checks keep a
// page of another origin the route makes from framing this one): Download
// saves with allow-downloads, and Chrome refuses the save without it
const SHELL = `${HOST}offline-html-shell`;
async function framedDownload(sandbox) {
	const on = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await on.route(SHELL, (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><iframe sandbox="${sandbox}" src="/" style="width:1240px;height:760px;border:0"></iframe>`,
		}),
	);
	await on.goto(SHELL);
	const frame = await (await on.waitForSelector('iframe')).contentFrame();
	await frame.waitForSelector('#offlineDownload .git', { state: 'visible' });
	const got = on
		.waitForEvent('download', { timeout: 10000 })
		.then((download) => download.suggestedFilename())
		.catch(() => null);
	await frame.click('#offlineDownload .git');
	const name = await got;
	await on.close();
	return name;
}
const allowed = await framedDownload(
	'allow-scripts allow-same-origin allow-downloads',
);
const refused = await framedDownload('allow-scripts allow-same-origin');
ok(
	'in a sandboxed frame Download saves with allow-downloads, and not without it',
	allowed === 'offline.html' && refused === null,
	JSON.stringify({ allowed, refused }),
);

// a demo server with no offline.html builds it itself: 503 until then
const freePort = () =>
	new Promise((done) => {
		const probe = createServer().listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
const coldPort = await freePort();
const coldFile = `${OUT}offline-html-cold/offline.html`;
rmSync(coldFile, { force: true });
const cold = spawn(process.execPath, [`${root}demo/server.js`], {
	env: {
		...process.env,
		PORT: String(coldPort),
		STOMP_OFFLINE_FILE: coldFile,
		STOMP_SITE_POOL: '0',
	},
	stdio: ['ignore', 'ignore', 'inherit'],
});
const COLD = `http://127.0.0.1:${coldPort}/`;
let coldBytes = null;
const coldAnswers = [];
try {
	await waitForServer(`${COLD}api/status`);
	for (const end = Date.now() + 60000; Date.now() < end;) {
		const answer = await fetch(`${COLD}offline.html`);
		coldAnswers.push(
			`${answer.status} ${answer.headers.get('retry-after') ?? ''}`,
		);
		if (answer.status === 200) {
			coldBytes = Buffer.from(await answer.arrayBuffer());
			break;
		}
		await answer.arrayBuffer();
		await sleep(250);
	}
	ok(
		"a demo server with no offline.html builds it: 503 with Retry-After, then the build's bytes",
		/^503 \d+$/.test(coldAnswers[0]) &&
			!!coldBytes &&
			coldBytes.equals(readFileSync(file)) &&
			existsSync(coldFile),
		JSON.stringify({
			answers: [...new Set(coldAnswers)],
			size: coldBytes?.length,
		}),
	);

	// a page that names that server's file, another origin's: its own wisp
	const across = await openDemo(browser, HOST, {}, (on) =>
		on.addInitScript((url) => {
			globalThis.STOMP_ASSETS = { offline: url };
		}, `${COLD}offline.html`),
	);
	const fetchedFrom = [];
	across.on('request', (request) => {
		if (request.url().includes('offline.html')) fetchedFrom.push(request.url());
	});
	const acrossWisp = await configuredWisp(across);
	const fromThere = await download(across);
	ok(
		"Download saves another origin's offline.html with this page's wisp server",
		fetchedFrom.includes(`${COLD}offline.html`) &&
			slotOf(fromThere.text) === acrossWisp &&
			new URL(acrossWisp).port === PORT &&
			!!coldBytes &&
			unslotted(fromThere.text) === unslotted(coldBytes.toString('utf8')),
		JSON.stringify({ fetchedFrom, saved: slotOf(fromThere.text), acrossWisp }),
	);
	await across.close();
} finally {
	cold.kill('SIGTERM');
}

// the saved file, opened from file: as it is: it tunnels through that one
const away = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await away.addInitScript(offeredAlready, defaults);
const awaySockets = [];
away.on('websocket', (socket) => awaySockets.push(socket.url()));
const awayAsked = [];
away.on('request', (request) => {
	if (!/^(file|blob|data):/.test(request.url())) awayAsked.push(request.url());
});
await away.goto(pathToFileURL(theirs.path).href);
const awayStatus = await ready(away);
const awayBefore = (await (await fetch(`${FIXTURE}requests`)).json()).length;
await submitLanding(away, one);
const awayFrame = await documentTitled('Offline page one', 30000, away);
const awayServed = (await (await fetch(`${FIXTURE}requests`)).json()).slice(
	awayBefore,
);
ok(
	'the saved file boots from file: and loads the fixture through its wisp server',
	awayStatus === 'Ready' &&
		!!awayFrame &&
		awayServed.includes('/pages/offline-html.html') &&
		awaySockets.some((url) => url.startsWith(CUSTOM)) &&
		!awayAsked.some((url) => url.startsWith(fixtureOrigin)),
	JSON.stringify({ awayStatus, awaySockets, served: awayServed.slice(0, 4) }),
);
await away.close();

// Saving starts a new document and drops ?wisp=, even when the saved value
// is not yet visible to the new document's localStorage.
const savedWisp = `${WISP}?settings=1`;
await page.addInitScript(() => {
	if (window === top && location.protocol === 'file:')
		localStorage.removeItem('stomp-demo:wisp');
});
await page.evaluate(() => {
	globalThis.beforeSettingsRestart = true;
	document.getElementById('menuSettings').click();
});
await page.waitForSelector('#spWisp', { timeout: 10000 });
await page.fill('#spWisp', savedWisp);
await page.click('#spWispSave');
const again = await (
	await page.waitForFunction(
		() => {
			const status = document.getElementById('logMsg')?.textContent ?? '';
			return (
				!globalThis.beforeSettingsRestart &&
				!!window.controller &&
				/^(Ready|Loaded|Error)/.test(status) &&
				status
			);
		},
		null,
		{ timeout: 60000 },
	)
).jsonValue();
const restarted = await page.evaluate(() => ({
	current: globalThis.STOMP_OFFLINE?.wisp.current,
	stored: localStorage.getItem('stomp-demo:wisp'),
}));
ok(
	'Settings keeps the wisp server across restart when localStorage is unavailable',
	/^(Ready|Loaded)/.test(again) &&
		!new URL(page.url()).searchParams.has('wisp') &&
		restarted.current === savedWisp &&
		restarted.stored === null,
	`${again} ${page.url()} ${JSON.stringify(restarted)}`,
);
await submitLanding(page, one);
ok(
	'a page loads through the saved wisp server',
	!!(await documentTitled('Offline page one')) && sockets.includes(savedWisp),
	JSON.stringify({ omni: await omni(page), sockets }),
);
await page.reload({ waitUntil: 'domcontentloaded' });
ok(
	'the Settings choice survives a manual reload',
	(await page.evaluate(() => globalThis.STOMP_OFFLINE.wisp.current)) ===
		savedWisp,
);

// Tor mode in the file: tor-js's place taken by the stand-in (a Tor stream
// is the run's wisp server's TCP stream to 127.0.0.1), the rest as the file
// runs it: the toggle, the client in a worker of the page, its port, its
// Wisp streams and its refusal of anything not in a consensus, epoxy on
// its streams in the page, its IndexedDB
const torFile = `${OUT}offline-tor.html`;
execFileSync(
	process.execPath,
	[
		`${root}scripts/build-offline.mjs`,
		'--tor-stand-in',
		'--no-adblock',
		'--out',
		torFile,
	],
	{ stdio: 'ignore' },
);
const torPage = await browser.newPage({
	viewport: { width: 1280, height: 800 },
});
await torPage.addInitScript(offeredAlready, defaults);
torPage.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
await torPage.goto(
	`${pathToFileURL(torFile).href}?wisp=${encodeURIComponent(WISP)}&tor=1`,
);
const torReady = await ready(torPage);
const torBox = await torPage.evaluate(() => ({
	checked: document.getElementById('tor').checked,
	disabled: document.getElementById('tor').disabled,
	unavailable: document
		.getElementById('torLabel')
		.hasAttribute('data-unavailable'),
}));
ok(
	'offline.html has Tor mode: the toggle is on and offered, and the client in its worker bootstraps',
	torReady === 'Ready (Tor connected)' &&
		torBox.checked &&
		!torBox.disabled &&
		!torBox.unavailable,
	JSON.stringify({ torReady, torBox }),
);
const standIn = () =>
	torPage.evaluate(
		() =>
			new Promise((resolve) => {
				const open = indexedDB.open('stomp-tor-client-stand-in');
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const store = open.result
						.transaction('kv', 'readonly')
						.objectStore('kv');
					const keys = store.getAllKeys();
					const started = store.get('stand-in:started');
					keys.onsuccess = () =>
						(started.onsuccess = () =>
							resolve({ keys: keys.result, started: started.result }));
				};
			}),
	);
await submitLanding(torPage, one);
const torFrame = await documentTitled('Offline page one', 30000, torPage);
const kept = await standIn();
ok(
	"a fixture page loads in Tor mode, on the client's streams",
	!!torFrame &&
		kept?.keys.includes(`dir:consensus:stand-in-${new URL(FIXTURE).port}`),
	JSON.stringify({ title: !!torFrame, kept }),
);
await torPage.reload();
await ready(torPage);
const torAgain = await standIn();
ok(
	"the client's IndexedDB is kept across a reload",
	kept?.started === '1' && torAgain?.started === '2',
	JSON.stringify({ kept: kept?.started, again: torAgain?.started }),
);
await torPage.close();

// every stream the wisp server opened went to this host (the fixture, the
// demo server) or to the resolver the file asks for ECH configs (its
// echDns, as the demo's own pages do): no default theme, list or anything
// else from outside
await sleep(500);
const LOCAL = /^(127\.0\.0\.1|localhost|\[?::1\]?|cloudflare-dns\.com)$/;
const streams = process.env.WISP_LOG
	? readFileSync(process.env.WISP_LOG, 'utf8')
			.split('\n')
			.map((line) => / stream \d+ open to (.+):(\d+)$/.exec(line)?.[1])
			.filter(Boolean)
	: null;
ok(
	'every wisp stream went to this host or the ECH resolver',
	!!streams?.length && streams.every((host) => LOCAL.test(host)),
	JSON.stringify(
		streams && [...new Set(streams)].filter((host) => !LOCAL.test(host)),
	),
);

await done(browser, errors);
