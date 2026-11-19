// A reload of the demo revalidates the page and nothing STomp or the
// transport loads. The controller asks for the workers it starts and the
// blocker's module by the hash of each file (`transportWorker.js?<hash>`,
// src/version.ts TRANSPORT_WORKER), the page names its scripts and its
// stylesheet so, and the transport's directory is named by the hash of its
// package's files (`/epoxy/<hash>/index.mjs`, so epoxy.wasm and stomp-h3
// beside it are under the same hash); the demo keeps each for good. Each of
// them used to be a revalidation, and the transport worker's, the module's
// and its wasm's came one after another before the transport could start.
// The page and the service worker's script still revalidate: they are what
// says which build is current. In isolation mode the host's controller frame
// and its script are asked for by their hashes too
// (`controllerFrame.html?<hash>&script=controllerFrame.js%3F<hash>`), kept
// for good, and a reload revalidates neither. The plain names keep working, no-cache, and
// so does an old hash: a page of the build before a deploy is never told to
// keep the new file under it.
import { done, HOST, launch, ok, openDemo, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const asked = [];
const page = await openDemo(browser, PROXY, {}, (tab) =>
	tab.context().on('request', async (request) => {
		const entry = { url: request.url(), conditional: false };
		asked.push(entry);
		try {
			const headers = await request.allHeaders();
			entry.conditional =
				'if-none-match' in headers || 'if-modified-since' in headers;
		} catch {
			// gone with its page
		}
	}),
);
await page.evaluate(() => window.controller.wait());
// the rewrite workers, the blocker and the carrier host start after ready
await sleep(2000);
const cold = asked.map(({ url }) => url);
asked.length = 0;
await page.reload();
await page.waitForFunction(
	() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
	null,
	{ timeout: 45000 },
);
await page.evaluate(() => window.controller.wait());
await sleep(2000);

const path = (url) => new URL(url).pathname;
const HASH = '[0-9a-f]{16}';
const named = (pattern) => cold.find((url) => pattern.test(url));
const files = {
	transportWorker: named(new RegExp(`/stomp/transportWorker\\.js\\?${HASH}$`)),
	rewriteWorker: named(new RegExp(`/stomp/rewriteWorker\\.js\\?${HASH}$`)),
	blocker: named(new RegExp(`/stomp/blocker\\.wasm\\?${HASH}$`)),
	controller: named(new RegExp(`/stomp/Controller\\.js\\?${HASH}$`)),
	epoxy: named(new RegExp(`/epoxy/${HASH}/index\\.mjs$`)),
	epoxyWasm: named(new RegExp(`/epoxy/${HASH}/epoxy\\.wasm$`)),
};
ok(
	"the controller asks for its workers and the blocker by their hashes, the page for its scripts, and epoxy and its wasm come from the package's hash",
	Object.values(files).every(Boolean),
	JSON.stringify(files),
);
// what the page loads from STomp's directory, the transports' and its own
// scripts; the images its stylesheet names are the stylesheet's business
const ours = (url) =>
	/^\/(stomp|epoxy|libcurl)\/|^\/pm\/main\.(js|css)$/.test(path(url));
const revalidated = asked.filter(
	({ url, conditional }) =>
		conditional && ours(url) && path(url) !== '/stomp/serviceWorker.js',
);
ok(
	'a reload revalidates none of them',
	revalidated.length === 0 && asked.length > 0,
	JSON.stringify(revalidated.map(({ url }) => path(url))),
);
ok(
	'the page itself is asked again',
	asked.some(({ url, conditional }) => path(url) === '/' && conditional),
	JSON.stringify(asked.slice(0, 3)),
);

const cacheControl = async (url) =>
	(await fetch(url)).headers.get('cache-control');
const kept = 'public, max-age=31536000, immutable';
const served = {};
for (const [name, url] of Object.entries(files))
	if (url) served[name] = await cacheControl(url);
const stale = files.epoxy?.replace(
	new RegExp(`/${HASH}/`),
	'/0000000000000000/',
);
const elsewhere = {
	plainWorker: await cacheControl(`${PROXY}stomp/transportWorker.js`),
	oldWorker: await cacheControl(
		`${PROXY}stomp/transportWorker.js?0000000000000000`,
	),
	plainEpoxy: await cacheControl(`${PROXY}epoxy/index.mjs`),
	oldEpoxy: stale ? await cacheControl(stale) : null,
	page: await cacheControl(PROXY),
	serviceWorker: await cacheControl(`${PROXY}stomp/serviceWorker.js`),
};
ok(
	'each is served immutable under its own hash',
	Object.values(served).length === Object.keys(files).length &&
		Object.values(served).every((value) => value === kept),
	JSON.stringify(served),
);
ok(
	'the plain names, another hash, the page and the service worker are served no-cache',
	Object.values(elsewhere).every((value) => value === 'no-cache'),
	JSON.stringify(elsewhere),
);
ok(
	'nothing threw loading the page',
	page.errors.length === 0,
	JSON.stringify(page.errors),
);

// isolation mode: the host page on another origin, its controller in a frame
// of the proxy's
{
	const seen = [];
	const host = await openDemo(browser, HOST, {}, (tab) =>
		tab.context().on('request', async (request) => {
			const entry = { url: request.url(), conditional: false };
			seen.push(entry);
			try {
				const headers = await request.allHeaders();
				entry.conditional =
					'if-none-match' in headers || 'if-modified-since' in headers;
			} catch {
				// gone with its page
			}
		}),
	);
	await host.evaluate(() => window.controller.wait());
	await sleep(1000);
	const frame = seen.find(({ url }) =>
		new RegExp(
			`/stomp/controllerFrame\\.html\\?${HASH}&script=controllerFrame\\.js%3F${HASH}$`,
		).test(url),
	)?.url;
	const script = seen.find(({ url }) =>
		new RegExp(`/stomp/controllerFrame\\.js\\?${HASH}$`).test(url),
	)?.url;
	ok(
		'isolation mode asks for the controller frame and its script by their hashes',
		!!frame && !!script,
		JSON.stringify(
			seen.map(({ url }) => url).filter((url) => /Frame/.test(url)),
		),
	);
	seen.length = 0;
	await host.reload();
	await host.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	await host.evaluate(() => window.controller.wait());
	await sleep(1000);
	const again = seen.filter(
		({ url, conditional }) =>
			conditional && /\/stomp\/controllerFrame\./.test(url),
	);
	const headers = {
		frame: frame && (await cacheControl(frame)),
		script: script && (await cacheControl(script)),
		plainFrame: await cacheControl(
			`${PROXY}stomp/controllerFrame.html?script=controllerFrame.js`,
		),
		plainScript: await cacheControl(`${PROXY}stomp/controllerFrame.js`),
	};
	ok(
		'the frame and its script are kept for good, a reload revalidates neither, and their plain names are served no-cache',
		again.length === 0 &&
			headers.frame === kept &&
			headers.script === kept &&
			headers.plainFrame === 'no-cache' &&
			headers.plainScript === 'no-cache',
		JSON.stringify({ again: again.map(({ url }) => url), headers }),
	);
	ok(
		'nothing threw loading the isolated host',
		host.errors.length === 0,
		JSON.stringify(host.errors),
	);
}
await done(browser);
