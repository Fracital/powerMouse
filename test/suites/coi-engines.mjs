// Cross-origin isolation through the proxy in more than Chrome
// (docs/same-origin-policy.md, "Cross-origin isolation"). A page that sends
// COOP same-origin and COEP require-corp is isolated in every browser with
// an embedder policy; one with COEP credentialless only where the browser
// has that value (Chrome and Firefox, not WebKit). The proxy isolates a page
// only inside a host's page that is isolated, and a host isolated by
// `credentialless` is not isolated at all in WebKit: there a game that needs
// SharedArrayBuffer (blockshooter.club) failed through the proxy and ran
// natively. The host's page and what the service worker serves now say
// `require-corp`, which every one of them honours.
//
// Each kind of page (test/pages/coi-engines.js) reports what it and its
// worker read of `crossOriginIsolated` and SharedArrayBuffer, natively and
// through the demo in both modes:
// - in Chrome, always, with the embedder policy the host's page and a
//   proxied document were served with;
// - in WebKit (WebKitGTK's MiniBrowser driven by WebKitWebDriver, in a
//   headless weston of the suite's own), where those are installed; the
//   suite says SKIP for that part otherwise. WEBKIT_MINIBROWSER names
//   another MiniBrowser.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const COOP = 'cross-origin-opener-policy:same-origin';
const KINDS = {
	'COOP and COEP require-corp': [
		COOP,
		'cross-origin-embedder-policy:require-corp',
	],
	'COOP and COEP credentialless': [
		COOP,
		'cross-origin-embedder-policy:credentialless',
	],
	'no headers': [],
};
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

// Cases known to differ from WebKit, by why. A case on the list that now
// reads as natively fails too: take it off.
const WEBKIT_KNOWN_BY_REASON = {
	"the service worker judges a page's isolation by Chrome's rules, under which COEP credentialless isolates; WebKit has no credentialless, and every frame of an isolated host is isolated there":
		[
			'COOP and COEP credentialless: page',
			'COOP and COEP credentialless: worker',
		],
	"WebKit isolates every frame of an isolated page and its workers: the inject answers for the document the shell says is not isolated, and a worker knows nothing of its owner's isolation":
		['no headers: worker'],
};
const WEBKIT_KNOWN = new Map(
	Object.entries(WEBKIT_KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

let run = 0;
const pageURL = (headers) =>
	`${FIXTURE}coi/doc?script=/pages/coi-engines.js&k=e${++run}${headers
		.map((header) => `&h=${encodeURIComponent(header)}`)
		.join('')}`;

// ---- Chrome ----

const browser = await launch();

async function chromeReport(page) {
	for (let i = 0; i < 240; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__coiEngine)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

for (const [mode, base] of MODES) {
	const host = await fetch(base);
	ok(
		`${mode}: the host's page is served with COEP require-corp, which WebKit honours too`,
		host.headers.get('cross-origin-embedder-policy') === 'require-corp',
		host.headers.get('cross-origin-embedder-policy'),
	);
}

for (const [name, headers] of Object.entries(KINDS)) {
	const nativePage = await browser.newPage();
	await nativePage.goto(pageURL(headers));
	const want = await chromeReport(nativePage);
	await nativePage.context().close();
	ok(
		`Chrome natively, a page with ${name} reported`,
		want !== null,
		JSON.stringify(want),
	);
	for (const [mode, base] of MODES) {
		const page = await openDemo(browser, base);
		const served = [];
		page.on('response', (response) => {
			if (response.request().resourceType() === 'document')
				served.push(response);
		});
		await submitLanding(page, pageURL(headers));
		const got = await chromeReport(page);
		const proxied = served.find((response) => /\/html\//.test(response.url()));
		ok(
			`Chrome ${mode}: a page with ${name} reads as natively`,
			JSON.stringify(got) === JSON.stringify(want),
			`native ${JSON.stringify(want)}, proxied ${JSON.stringify(got)}`,
		);
		const policy = proxied
			? await proxied.headerValue('cross-origin-embedder-policy')
			: null;
		ok(
			`Chrome ${mode}: the proxied document of a page with ${name} is served with COEP require-corp`,
			policy === 'require-corp',
			policy,
		);
		await page.context().close();
	}
}

// ---- WebKit ----

const MINIBROWSERS = [
	process.env.WEBKIT_MINIBROWSER,
	'/usr/libexec/webkit2gtk-4.1/MiniBrowser',
	'/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
	'/usr/libexec/webkitgtk-6.0/MiniBrowser',
].filter(Boolean);
const miniBrowser = MINIBROWSERS.find((path) => existsSync(path));
const which = (name) =>
	(process.env.PATH ?? '')
		.split(':')
		.map((dir) => join(dir, name))
		.find((path) => existsSync(path));
const driverBinary = which('WebKitWebDriver');
const westonBinary = which('weston');
const runtimeDir = process.env.XDG_RUNTIME_DIR;

function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

if (!miniBrowser || !driverBinary || !westonBinary || !runtimeDir)
	console.log(
		`SKIP coi-engines WebKit part: needs WebKitWebDriver, a WebKitGTK MiniBrowser, weston and XDG_RUNTIME_DIR (${JSON.stringify({ miniBrowser, driverBinary, westonBinary, runtimeDir })})`,
	);
else {
	// a compositor of the suite's own with no output: nothing reaches a display
	const socket = `stomp-coi-engines-${process.pid}`;
	const weston = spawn(
		westonBinary,
		['--backend=headless', `--socket=${socket}`, '--idle-time=0'],
		{ stdio: 'ignore' },
	);
	const env = {
		...process.env,
		WAYLAND_DISPLAY: socket,
		GDK_BACKEND: 'wayland',
	};
	delete env.DISPLAY;
	for (let i = 0; i < 40 && !existsSync(join(runtimeDir, socket)); i++)
		await sleep(250);
	const driverPort = await freePort();
	const driver = spawn(driverBinary, [`--port=${driverPort}`], {
		stdio: 'ignore',
		env,
	});
	const call = async (method, path, body) => {
		for (let i = 0; ; i++) {
			try {
				const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
					method,
					headers: { 'content-type': 'application/json' },
					body: body ? JSON.stringify(body) : undefined,
				});
				return (await response.json()).value;
			} catch (error) {
				if (i > 80) throw error;
				await sleep(250);
			}
		}
	};
	/** a session of a fresh MiniBrowser, `use` run with it, then closed */
	const withSession = async (use) => {
		const session = await call('POST', '/session', {
			capabilities: {
				alwaysMatch: {
					'webkitgtk:browserOptions': {
						binary: miniBrowser,
						args: ['--automation'],
					},
				},
			},
		});
		const id = session?.sessionId;
		if (!id) return `no session: ${JSON.stringify(session)}`;
		const evaluate = (script) =>
			call('POST', `/session/${id}/execute/sync`, { script, args: [] });
		try {
			return await use({
				go: (url) => call('POST', `/session/${id}/url`, { url }),
				evaluate,
				frame: (index) => call('POST', `/session/${id}/frame`, { id: index }),
				parent: () => call('POST', `/session/${id}/frame/parent`, {}),
			});
		} finally {
			await call('DELETE', `/session/${id}`).catch(() => {});
		}
	};
	const REPORT =
		'return window.__coiEngine ? JSON.stringify(window.__coiEngine) : null';
	/** the report of the page, or of the first frame below it that has one */
	const webkitReport = async (session) => {
		const look = async (depth) => {
			const own = await session.evaluate(REPORT);
			if (typeof own === 'string') return JSON.parse(own);
			if (depth > 2) return null;
			const count = await session.evaluate('return window.frames.length');
			for (let i = 0; i < count; i++) {
				await session.frame(i);
				const found = await look(depth + 1);
				await session.parent();
				if (found) return found;
			}
			return null;
		};
		for (let i = 0; i < 120; i++) {
			const found = await look(0);
			if (found) return found;
			await sleep(500);
		}
		return null;
	};

	const compare = (label, want, got) => {
		for (const part of ['page', 'worker']) {
			const name = `${label}: ${part}`;
			const same = JSON.stringify(want?.[part]) === JSON.stringify(got?.[part]);
			const known = WEBKIT_KNOWN.get(name.replace(/^[^:]*: /, ''));
			const detail = `native ${JSON.stringify(want?.[part])}, proxied ${JSON.stringify(got?.[part])}`;
			if (known && !same)
				ok(
					`WebKit ${name} differs, a known difference: ${known}`,
					true,
					detail,
				);
			else if (known)
				ok(
					`WebKit ${name} reads as natively: take it off the known list`,
					false,
					detail,
				);
			else ok(`WebKit ${name} reads as natively`, same, detail);
		}
	};

	try {
		for (const [mode, base] of MODES) {
			const host = await withSession(async (session) => {
				await session.go(base);
				return session.evaluate('return self.crossOriginIsolated');
			});
			ok(
				`WebKit ${mode}: the host's page is cross-origin isolated`,
				host === true,
				host,
			);
		}
		for (const [name, headers] of Object.entries(KINDS)) {
			const url = pageURL(headers);
			const want = await withSession(async (session) => {
				await session.go(url);
				return webkitReport(session);
			});
			ok(
				`WebKit natively, a page with ${name} reported`,
				want && typeof want === 'object',
				JSON.stringify(want),
			);
			for (const [mode, base] of MODES) {
				const got = await withSession(async (session) => {
					await session.go(base);
					for (let i = 0; i < 90; i++) {
						const text = await session.evaluate(
							"return document.getElementById('logMsg')?.textContent || ''",
						);
						if (/^(Ready|Error)/.test(text)) break;
						await sleep(500);
					}
					await session.evaluate(
						`const form = document.getElementById('mainForm'); form.url.value = ${JSON.stringify(url)}; form.requestSubmit();`,
					);
					return webkitReport(session);
				});
				compare(`${mode}: ${name}`, want, got);
			}
		}
	} finally {
		driver.kill('SIGTERM');
		weston.kill('SIGTERM');
	}
}

await done(browser);
