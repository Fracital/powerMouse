// Browsers beside Chrome for a suite (coi-engines, uncontrolled-modules,
// sync-engines): WebKitGTK's MiniBrowser driven by WebKitWebDriver, in a
// headless weston of the suite's own, where those are installed
// (WEBKIT_MINIBROWSER names another MiniBrowser), and Firefox, headless
// over WebDriver BiDi, where it is installed and not on CI (FIREFOX names
// another binary). A session opens a fresh browser tab: `{ go(url),
// evaluate(expression), report(), close() }`, where `report()` waits for
// the first document of the tab (the page or a frame below it) whose
// `expression` reads as a JSON string, and gives it parsed (null when none
// came). An engine that cannot run says SKIP.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './lib.mjs';

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

/** open `url` through the demo at `base` in `session`, as a user would on its landing page */
export async function proxiedGo(session, base, url) {
	await session.go(base);
	for (let i = 0; i < 90; i++) {
		const text = await session.evaluate(LANDING_READY);
		if (/^(Ready|Error)/.test(text)) break;
		await sleep(500);
	}
	await session.evaluate(
		`(() => { const form = document.getElementById('mainForm'); form.url.value = ${JSON.stringify(url)}; form.requestSubmit(); })()`,
	);
}

/** run `run(open)` in WebKit, with sessions whose report is `expression`'s */
export async function withWebKit(suite, expression, run) {
	const miniBrowser = [
		process.env.WEBKIT_MINIBROWSER,
		'/usr/libexec/webkit2gtk-4.1/MiniBrowser',
		'/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
		'/usr/libexec/webkitgtk-6.0/MiniBrowser',
	]
		.filter(Boolean)
		.find((path) => existsSync(path));
	const driverBinary = which('WebKitWebDriver');
	const westonBinary = which('weston');
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (!miniBrowser || !driverBinary || !westonBinary || !runtimeDir) {
		console.log(
			`SKIP ${suite} WebKit part: needs WebKitWebDriver, a WebKitGTK MiniBrowser, weston and XDG_RUNTIME_DIR (${JSON.stringify({ miniBrowser, driverBinary, westonBinary, runtimeDir })})`,
		);
		return;
	}
	// a compositor of the suite's own with no output: nothing reaches a display
	const socket = `stomp-${suite}-${process.pid}`;
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
	const report = `(() => { const value = ${expression}; return value ? JSON.stringify(value) : null; })()`;
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
			const own = await evaluate(report);
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
					// (from the top: a frame the last look entered may have navigated)
					await frame(null);
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
		await run(open);
	} finally {
		driver.kill('SIGTERM');
		weston.kill('SIGTERM');
	}
}

/** run `run(open)` in Firefox, with sessions whose report is `expression`'s */
export async function withFirefox(suite, expression, run) {
	const firefoxBinary = process.env.FIREFOX ?? which('firefox');
	if (!firefoxBinary || (process.env.CI && !process.env.FIREFOX)) {
		console.log(
			`SKIP ${suite} Firefox part: ${firefoxBinary ? 'CI (FIREFOX names a binary to run it there)' : 'no firefox (FIREFOX names one)'}`,
		);
		return;
	}
	const port = await freePort();
	const profile = mkdtempSync(join(tmpdir(), `stomp-${suite}-ff-`));
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
	const report = `(() => { const value = ${expression}; return value ? JSON.stringify(value) : null; })()`;
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
				const own = await evaluateIn(node.context, report);
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
		await run(open);
	} finally {
		socket?.close();
		firefox.kill('SIGTERM');
		await sleep(1000);
		rmSync(profile, { recursive: true, force: true });
	}
}
