// A small WebDriver BiDi client for a stock Firefox (playwright-core drives
// only Playwright's own patched build): Firefox started headless with
// --remote-debugging-port on a fresh profile of its own, and a session on
// its /session WebSocket. Only what test/firefox/ needs: tabs, navigation,
// evaluation in a tab or any frame below it, the console and the page's
// errors, keys, clicks, screenshots and a downloads folder.
//
// launchFirefox() resolves null (after printing SKIP) where no Firefox is
// installed (FIREFOX names a binary). It never touches a profile it did not
// make, and kills only the process it started.
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const firefoxBinary = () =>
	process.env.FIREFOX ??
	(process.env.PATH ?? '')
		.split(':')
		.map((dir) => join(dir, 'firefox'))
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

// What the fresh profile starts with: no first-run pages or telemetry, a
// downloads folder of its own that needs no dialog, and every request that
// is not to this machine sent to a proxy nothing listens on, so a request
// that bypasses STomp fails loudly (as the Chrome suites' host resolver
// rules make it fail)
const basePrefs = (downloads) => ({
	'browser.shell.checkDefaultBrowser': false,
	'browser.startup.homepage_override.mstone': 'ignore',
	'datareporting.policy.dataSubmissionEnabled': false,
	'toolkit.telemetry.reportingpolicy.firstRun': false,
	'browser.download.dir': downloads,
	'browser.download.folderList': 2,
	'browser.download.useDownloadDir': true,
	'browser.download.always_ask_before_handling_new_types': false,
	'browser.download.start_downloads_in_tmp_dir': false,
	'network.proxy.type': 1,
	'network.proxy.http': '127.0.0.1',
	'network.proxy.http_port': 9,
	'network.proxy.ssl': '127.0.0.1',
	'network.proxy.ssl_port': 9,
	'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, [::1]',
	'network.proxy.allow_hijacking_localhost': false,
	'network.proxy.share_proxy_settings': false,
});

/**
 * A headless Firefox and a BiDi session on it, or null when there is no
 * Firefox. `prefs` are added to the profile's.
 */
export async function launchFirefox({ prefs = {}, onLog } = {}) {
	const binary = firefoxBinary();
	if (!binary) {
		console.log('SKIP firefox: no firefox binary (FIREFOX names one)');
		return null;
	}
	const profile = mkdtempSync(join(tmpdir(), 'stomp-firefox-'));
	const downloads = join(profile, 'downloads');
	mkdirSync(downloads);
	writeFileSync(
		join(profile, 'user.js'),
		Object.entries({ ...basePrefs(downloads), ...prefs })
			.map(
				([key, value]) =>
					`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});\n`,
			)
			.join(''),
	);
	const port = await freePort();
	const child = spawn(
		binary,
		[
			'-headless',
			'--no-remote',
			'-profile',
			profile,
			`--remote-debugging-port=${port}`,
			'about:blank',
		],
		{
			stdio: ['ignore', 'ignore', 'pipe'],
			env: {
				...process.env,
				MOZ_CRASHREPORTER_DISABLE: '1',
				// the parent's chrome context, where platformMessages() reads
				// what the console service has heard
				MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',
			},
		},
	);
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-4000);
	});
	let socket = null;
	for (let i = 0; i < 240 && !socket && child.exitCode === null; i++) {
		await sleep(250);
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
	const kill = () => {
		if (child.exitCode === null) child.kill('SIGKILL');
	};
	// a run killed or timed out takes its Firefox with it
	process.once('exit', () => {
		kill();
		rmSync(profile, { recursive: true, force: true });
	});
	if (!socket) {
		kill();
		rmSync(profile, { recursive: true, force: true });
		throw new Error(`Firefox never offered WebDriver BiDi: ${stderr}`);
	}
	let id = 0;
	const pending = new Map();
	const listeners = new Map();
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id !== undefined) {
			const settle = pending.get(message.id);
			pending.delete(message.id);
			settle?.(message);
			return;
		}
		for (const listener of listeners.get(message.method) ?? [])
			listener(message.params);
	};
	socket.onclose = () => {
		for (const settle of pending.values())
			settle({ error: 'closed', message: 'the BiDi socket closed' });
		pending.clear();
	};
	/** a command's result; throws its error */
	const send = (method, params = {}, timeout = 60000) =>
		new Promise((resolve, reject) => {
			const n = ++id;
			const timer = setTimeout(() => {
				pending.delete(n);
				reject(new Error(`${method} timed out`));
			}, timeout);
			pending.set(n, (message) => {
				clearTimeout(timer);
				if (message.error)
					reject(
						new Error(`${method}: ${message.error} ${message.message ?? ''}`),
					);
				else resolve(message.result);
			});
			socket.send(JSON.stringify({ id: n, method, params }));
		});
	const on = (method, listener) => {
		if (!listeners.has(method)) listeners.set(method, []);
		listeners.get(method).push(listener);
	};
	const session = await send('session.new', {
		capabilities: { alwaysMatch: { acceptInsecureCerts: true } },
	});
	await send('session.subscribe', { events: ['log.entryAdded'] });
	/** every console message and page error, with the context it came from */
	const logs = [];
	on('log.entryAdded', (entry) => {
		const item = {
			level: entry.level,
			type: entry.type,
			text: entry.text,
			context: entry.source?.context,
			stack: entry.stackTrace?.callFrames
				?.slice(0, 4)
				.map(
					(frame) => `${frame.functionName}@${frame.url}:${frame.lineNumber}`,
				)
				.join(' < '),
		};
		logs.push(item);
		onLog?.(item);
	});

	/**
	 * `fn(...args)` (a function, or its source) in `context`, awaited, its
	 * value through JSON. `sandbox` evaluates in a realm of its own, as an
	 * extension's content script sees the page; else in the page's own.
	 */
	const call = async (context, fn, args = [], { sandbox, activate } = {}) => {
		const result = await send('script.callFunction', {
			functionDeclaration: `async function (json) { const value = await (${fn})(...JSON.parse(json)); return value === undefined ? 'undefined' : JSON.stringify(value); }`,
			arguments: [{ type: 'string', value: JSON.stringify(args) }],
			target: sandbox ? { context, sandbox } : { context },
			awaitPromise: true,
			resultOwnership: 'none',
			userActivation: !!activate,
		});
		if (result.type === 'exception')
			throw new Error(
				`in page: ${result.exceptionDetails?.text ?? JSON.stringify(result.exceptionDetails)}`,
			);
		const value = result.result?.value;
		return value === 'undefined' || value === undefined
			? undefined
			: JSON.parse(value);
	};

	/** every browsing context below (and including) `root`, flat, with depth */
	const contexts = async (root) => {
		const tree = await send('browsingContext.getTree', { root });
		const flat = [];
		const walk = (node, depth, parent) => {
			flat.push({ context: node.context, url: node.url, depth, parent });
			for (const child of node.children ?? [])
				walk(child, depth + 1, node.context);
		};
		for (const node of tree.contexts) walk(node, 0, null);
		return flat;
	};

	/** a new tab: `{ context, go, eval, frames, find, ... }` */
	const newTab = async ({ width = 1280, height = 800 } = {}) => {
		const { context } = await send('browsingContext.create', { type: 'tab' });
		await send('browsingContext.setViewport', {
			context,
			viewport: { width, height },
		});
		const tab = {
			context,
			go: (url, wait = 'complete') =>
				send('browsingContext.navigate', { context, url, wait }, 90000),
			reload: () =>
				send('browsingContext.reload', { context, wait: 'complete' }, 90000),
			eval: (fn, ...args) => call(context, fn, args),
			activateEval: (fn, ...args) =>
				call(context, fn, args, { activate: true }),
			frames: () => contexts(context),
			/** fn(...args) in a frame of the tab (any depth) */
			in: (frame, fn, ...args) => call(frame, fn, args),
			/** the same with a user activation, as a click of the user's gives one */
			activeIn: (frame, fn, ...args) =>
				call(frame, fn, args, { activate: true }),
			/**
			 * the browsing context of the frame `selector` names in the top
			 * document (its iframe's window, as BiDi serializes a window), or
			 * null
			 */
			frameOf: async (selector) => {
				const result = await send('script.callFunction', {
					functionDeclaration: `function (sel) { const element = document.querySelector(sel); return element ? element.contentWindow : null; }`,
					arguments: [{ type: 'string', value: selector }],
					target: { context },
					awaitPromise: false,
					resultOwnership: 'none',
				});
				return result.result?.type === 'window'
					? result.result.value.context
					: null;
			},
			/**
			 * the first frame of the tab (outermost first) where `fn` gives a
			 * truthy value: `{ context, url, value }`, or null after `timeout`
			 */
			find: async (
				fn,
				{ timeout = 30000, args = [], skipTop = false } = {},
			) => {
				const end = Date.now() + timeout;
				do {
					for (const frame of await contexts(context).catch(() => [])) {
						if (skipTop && frame.depth === 0) continue;
						try {
							const value = await call(frame.context, fn, args);
							if (value) return { ...frame, value };
						} catch (error) {
							// navigating, or gone
						}
					}
					await sleep(250);
				} while (Date.now() < end);
				return null;
			},
			/** wait until `fn` holds in the tab's top document */
			until: async (fn, { timeout = 30000, args = [] } = {}) => {
				const end = Date.now() + timeout;
				do {
					try {
						const value = await call(context, fn, args);
						if (value) return value;
					} catch (error) {
						// navigating
					}
					await sleep(250);
				} while (Date.now() < end);
				return null;
			},
			/** keys pressed in order, as a user types them (WebDriver's key values: U+E007 is Enter, U+E009 Control) */
			keys: async (keys, modifiers = []) => {
				const actions = [];
				for (const key of modifiers)
					actions.push({ type: 'keyDown', value: key });
				for (const key of keys) {
					actions.push({ type: 'keyDown', value: key });
					actions.push({ type: 'keyUp', value: key });
				}
				for (const key of [...modifiers].reverse())
					actions.push({ type: 'keyUp', value: key });
				await send('input.performActions', {
					context,
					actions: [{ type: 'key', id: 'keyboard', actions }],
				});
			},
			/** a real click at the middle of `selector` in the top document */
			click: async (selector) => {
				const box = await call(
					context,
					(sel) => {
						const element = document.querySelector(sel);
						if (!element) return null;
						element.scrollIntoView({ block: 'center' });
						const rect = element.getBoundingClientRect();
						return {
							x: Math.round(rect.left + rect.width / 2),
							y: Math.round(rect.top + rect.height / 2),
						};
					},
					[selector],
				);
				if (!box) throw new Error(`nothing matches ${selector}`);
				await send('input.performActions', {
					context,
					actions: [
						{
							type: 'pointer',
							id: 'mouse',
							parameters: { pointerType: 'mouse' },
							actions: [
								{ type: 'pointerMove', x: box.x, y: box.y },
								{ type: 'pointerDown', button: 0 },
								{ type: 'pointerUp', button: 0 },
							],
						},
					],
				});
				await send('input.releaseActions', { context });
			},
			screenshot: async (path) => {
				const { data } = await send('browsingContext.captureScreenshot', {
					context,
				});
				if (path) writeFileSync(path, Buffer.from(data, 'base64'));
				return data;
			},
			close: () => send('browsingContext.close', { context }).catch(() => {}),
		};
		return tab;
	};

	/**
	 * What the console service has heard about content since `since` (ms
	 * since the epoch), read in the parent's chrome context: the platform's
	 * own messages too (a Security Error, a blocked load), which a page's
	 * console API and errors in log.entryAdded need not include. `{ category, error, text, source }` each.
	 */
	const platformMessages = async (since = 0) => {
		const tree = await send('browsingContext.getTree', {
			'moz:scope': 'chrome',
			maxDepth: 0,
		});
		const answer = await send('script.evaluate', {
			expression: `JSON.stringify(Services.console.getMessageArray().filter((m) => m instanceof Ci.nsIScriptError && !m.isFromChromeContext && m.timeStamp >= ${Number(since)}).map((m) => ({ category: m.category, error: !(m.flags & (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)), text: m.errorMessage, source: m.sourceName })))`,
			target: { context: tree.contexts[0].context },
			awaitPromise: false,
		});
		return JSON.parse(answer.result?.value ?? '[]');
	};

	return {
		send,
		on,
		logs,
		platformMessages,
		profile,
		downloads,
		session,
		version: session.capabilities?.browserVersion,
		newTab,
		contexts,
		call,
		close: async () => {
			try {
				await Promise.race([send('browser.close', {}, 5000), sleep(5000)]);
			} catch (error) {
				// gone already
			}
			socket.close();
			for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
			kill();
			rmSync(profile, { recursive: true, force: true });
		},
	};
}
