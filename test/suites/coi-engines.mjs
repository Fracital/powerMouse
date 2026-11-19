// Cross-origin isolation through the proxy in more than Chrome
// (docs/same-origin-policy.md, "Cross-origin isolation"). Engines differ
// (src/isolation.ts IsolationEngine): a page that sends COOP same-origin
// and COEP require-corp is isolated in every browser with an embedder
// policy; one with COEP credentialless only where the browser has that
// value (Chrome and Firefox, not WebKit); a frame of an isolated page that
// gives up the `cross-origin-isolated` permission, or that is of another
// origin, is not isolated in Chrome and is in Firefox and WebKit, which
// have no such permission; a Document-Isolation-Policy isolates only in
// Chrome; a credentialless frame is Chrome's alone. The host's page and
// what the service worker serves say `require-corp`, which every one of them
// honours, and the service worker decides each document by the rules of the
// browser it runs in, which the controller's document asks the browser
// (src/controller/isolationProbe.ts).
//
// Each kind of page (test/pages/coi-engines.js) reports what it, its
// worker, a blob: worker of it (classic and module) and (one kind) its
// frames read of `crossOriginIsolated` and SharedArrayBuffer, and whether a
// blob: script of it ran, natively and through the demo in both modes, and
// every part must read as natively:
// - in Chrome, always, with the embedder policy the host's page and a
//   proxied document were served with;
// - in WebKit (WebKitGTK's MiniBrowser driven by WebKitWebDriver, in a
//   headless weston of the suite's own), where those are installed;
//   WEBKIT_MINIBROWSER names another MiniBrowser;
// - in Firefox (headless, over WebDriver BiDi), where it is installed and
//   not on CI; FIREFOX names another binary.
// A part that cannot run says SKIP. A difference left is on KNOWN, with why.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
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
const OTHER = FIXTURE.replace('127.0.0.1', 'localhost').replace(/\/$/, '');
const KINDS = {
	// (and its frames: test/pages/coi-engines.js FRAMES)
	'COOP and COEP require-corp': {
		headers: [COOP, 'cross-origin-embedder-policy:require-corp'],
		frames: true,
	},
	'COOP and COEP credentialless': {
		headers: [COOP, 'cross-origin-embedder-policy:credentialless'],
	},
	'no headers': { headers: [] },
	'Document-Isolation-Policy isolate-and-require-corp': {
		headers: ['document-isolation-policy:isolate-and-require-corp'],
	},
};
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

let run = 0;
const pageURL = ({ headers, frames }) =>
	`${FIXTURE}coi/doc?script=/pages/coi-engines.js&k=e${++run}${headers
		.map((header) => `&h=${encodeURIComponent(header)}`)
		.join('')}${frames ? `&frames=${encodeURIComponent(OTHER)}` : ''}`;

/** a report's parts, by name: the page, its workers, each of its frames' */
const parts = (report) => {
	const named = new Map();
	const add = (prefix, of) => {
		for (const part of [
			'page',
			'worker',
			'blobWorker',
			'blobModuleWorker',
			'blobScript',
		])
			named.set(`${prefix}${part}`, of?.[part]);
	};
	add('', report);
	for (const [name, frame] of Object.entries(report?.frames ?? {}))
		if (typeof frame === 'object' && frame) add(`frame ${name}: `, frame);
		else named.set(`frame ${name}`, frame);
	return named;
};

// Differences known and left, by engine, mode and part (a part's name ends
// with it), with why. One that now reads as natively fails too: take it off.
// (none left: a blob: worker of a frame of another site's page started in
// Firefox and WebKit once the page hands its Blob's bytes to the service
// worker, which cannot read that blob: URL there)
const KNOWN = {};

/** every part of what a page read through the proxy reads as it did natively */
function compare(engine, mode, kind, want, got) {
	const wanted = parts(want);
	const gotten = parts(got);
	for (const part of new Set([...wanted.keys(), ...gotten.keys()])) {
		const a = JSON.stringify(wanted.get(part));
		const b = JSON.stringify(gotten.get(part));
		const detail = `native ${a}, proxied ${b}`;
		const label = `${engine} ${mode}: ${kind}: ${part}`;
		const known = Object.entries(KNOWN[engine] ?? {}).find(
			([at]) =>
				at.startsWith(`${mode}: `) && part.endsWith(at.slice(mode.length + 2)),
		)?.[1];
		if (known && a !== b)
			ok(`${label} differs, a known difference: ${known}`, true, detail);
		else if (known)
			ok(
				`${label} reads as natively: take it off the known list`,
				false,
				detail,
			);
		else ok(`${label} reads as natively`, a === b, detail);
	}
}

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

for (const [name, kind] of Object.entries(KINDS)) {
	const nativePage = await browser.newPage();
	await nativePage.goto(pageURL(kind));
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
		await submitLanding(page, pageURL(kind));
		const got = await chromeReport(page);
		compare('Chrome', mode, name, want, got);
		const proxied = served.find((response) => /\/html\//.test(response.url()));
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

const which = (name) =>
	(process.env.PATH ?? '')
		.split(':')
		.map((dir) => join(dir, name))
		.find((path) => existsSync(path));

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

const LANDING_READY = "document.getElementById('logMsg')?.textContent || ''";
const submitScript = (url) =>
	`const form = document.getElementById('mainForm'); form.url.value = ${JSON.stringify(url)}; form.requestSubmit();`;
const REPORT = 'window.__coiEngine ? JSON.stringify(window.__coiEngine) : null';

/**
 * Every kind natively and through the demo in both modes, in a browser
 * `session` opens: `{ go(url), evaluate(expression), report() }`, closed by
 * `close()`
 */
async function compareEngine(engine, open) {
	for (const [mode, base] of MODES) {
		const session = await open();
		try {
			await session.go(base);
			const host = await session.evaluate('self.crossOriginIsolated');
			ok(
				`${engine} ${mode}: the host's page is cross-origin isolated`,
				host === true,
				host,
			);
		} finally {
			await session.close();
		}
	}
	for (const [name, kind] of Object.entries(KINDS)) {
		const url = pageURL(kind);
		const session = await open();
		let want;
		try {
			await session.go(url);
			want = await session.report();
		} finally {
			await session.close();
		}
		ok(
			`${engine} natively, a page with ${name} reported`,
			want && typeof want === 'object',
			JSON.stringify(want),
		);
		for (const [mode, base] of MODES) {
			const proxied = await open();
			let got;
			try {
				await proxied.go(base);
				for (let i = 0; i < 90; i++) {
					const text = await proxied.evaluate(LANDING_READY);
					if (/^(Ready|Error)/.test(text)) break;
					await sleep(500);
				}
				await proxied.evaluate(`(() => { ${submitScript(url)} })()`);
				got = await proxied.report();
			} finally {
				await proxied.close();
			}
			compare(engine, mode, name, want, got);
		}
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
const driverBinary = which('WebKitWebDriver');
const westonBinary = which('weston');
const runtimeDir = process.env.XDG_RUNTIME_DIR;

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
		// the MiniBrowser loads the fixture and the demo only; WebKit's own
		// bubblewrap sandbox cannot start inside another one (a Firejail's
		// stand-in bwrap), and its web process dies there before any page
		WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
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
	/** a session of a fresh MiniBrowser */
	const open = async () => {
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
		if (!id) throw new Error(`no WebKit session: ${JSON.stringify(session)}`);
		const evaluate = (expression) =>
			call('POST', `/session/${id}/execute/sync`, {
				script: `return ${expression}`,
				args: [],
			});
		const frame = (index) =>
			call('POST', `/session/${id}/frame`, { id: index });
		const parent = () => call('POST', `/session/${id}/frame/parent`, {});
		/** the report of the page, or of the first frame below it that has one */
		const look = async (depth) => {
			const own = await evaluate(REPORT);
			if (typeof own === 'string') return JSON.parse(own);
			if (depth > 2) return null;
			const count = await evaluate('window.frames.length');
			for (let i = 0; i < count; i++) {
				await frame(i);
				const found = await look(depth + 1);
				await parent();
				if (found) return found;
			}
			return null;
		};
		return {
			go: (url) => call('POST', `/session/${id}/url`, { url }),
			evaluate,
			report: async () => {
				for (let i = 0; i < 120; i++) {
					const found = await look(0);
					if (found) return found;
					await sleep(500);
				}
				return null;
			},
			close: () => call('DELETE', `/session/${id}`).catch(() => {}),
		};
	};
	try {
		await compareEngine('WebKit', open);
	} finally {
		driver.kill('SIGTERM');
		weston.kill('SIGTERM');
	}
}

// ---- Firefox ----

const firefoxBinary = process.env.FIREFOX ?? which('firefox');

if (!firefoxBinary || (process.env.CI && !process.env.FIREFOX))
	console.log(
		`SKIP coi-engines Firefox part: ${firefoxBinary ? 'CI (FIREFOX names a binary to run it there)' : 'no firefox (FIREFOX names one)'}`,
	);
else {
	const port = await freePort();
	const profile = mkdtempSync(join(tmpdir(), 'stomp-coi-engines-ff-'));
	const firefox = spawn(
		firefoxBinary,
		[
			'--headless',
			'--no-remote',
			'--profile',
			profile,
			`--remote-debugging-port=${port}`,
			'about:blank',
		],
		{ stdio: 'ignore' },
	);
	let socket = null;
	for (let i = 0; i < 120 && !socket; i++) {
		await sleep(500);
		try {
			const attempt = new WebSocket(`ws://127.0.0.1:${port}/session`);
			await new Promise((resolve, reject) => {
				attempt.onopen = resolve;
				attempt.onerror = reject;
			});
			socket = attempt;
		} catch (error) {
			// not listening yet
		}
	}
	try {
		if (!socket) throw new Error('Firefox never offered WebDriver BiDi');
		let id = 0;
		const pending = new Map();
		socket.onmessage = (event) => {
			const message = JSON.parse(event.data);
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		};
		const send = (method, params = {}) =>
			new Promise((resolve) => {
				const n = ++id;
				pending.set(n, resolve);
				socket.send(JSON.stringify({ id: n, method, params }));
			});
		await send('session.new', { capabilities: {} });
		const evaluateIn = async (context, expression) => {
			const answer = await send('script.evaluate', {
				expression,
				target: { context },
				awaitPromise: false,
				resultOwnership: 'none',
			});
			return answer.result?.result?.value ?? null;
		};
		const open = async () => {
			const created = await send('browsingContext.create', { type: 'tab' });
			const context = created.result.context;
			/** the report of the page, or of the first frame below it that has one */
			const look = async (node) => {
				const own = await evaluateIn(node.context, REPORT);
				if (typeof own === 'string') return JSON.parse(own);
				for (const child of node.children ?? []) {
					const found = await look(child);
					if (found) return found;
				}
				return null;
			};
			return {
				go: (url) =>
					send('browsingContext.navigate', { context, url, wait: 'complete' }),
				evaluate: (expression) => evaluateIn(context, expression),
				report: async () => {
					for (let i = 0; i < 120; i++) {
						const tree = await send('browsingContext.getTree', {
							root: context,
						});
						for (const node of tree.result?.contexts ?? []) {
							const found = await look(node);
							if (found) return found;
						}
						await sleep(500);
					}
					return null;
				},
				close: () => send('browsingContext.close', { context }),
			};
		};
		await compareEngine('Firefox', open);
	} finally {
		socket?.close();
		firefox.kill('SIGTERM');
		await sleep(1000);
		rmSync(profile, { recursive: true, force: true });
	}
}

await done(browser);
