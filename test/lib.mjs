// Shared helpers for the browser suites in test/suites/. A suite is a plain
// script: it prints one `PASS name` / `FAIL name - detail` line per check and
// exits non-zero when anything failed, so it can be run on its own against a
// running demo server (`PORT=8080 node test/suites/back.mjs`) or by
// test/run.mjs, which starts the servers and runs every suite one at a time.
//
// Environment:
//   PORT     demo server port (default 8090). http://localhost:PORT/ is the
//            host page in origin-isolation mode (proxy on 127.0.0.1);
//            http://127.0.0.1:PORT/ opens the same-origin controller.
//   FIXTURE  base URL of test/fixture.mjs (default http://127.0.0.1:8084/)
//   CHROME   Chrome binary (default /usr/bin/google-chrome)
//   SHOTS    when set, suites write screenshots to test/out/
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

export const PORT = process.env.PORT || '8090';
export const HOST = `http://localhost:${PORT}/`;
export const PROXY = `http://127.0.0.1:${PORT}/`;
export const FIXTURE = process.env.FIXTURE || 'http://127.0.0.1:8084/';
export const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The controller options of the run's rewriter, for a suite that builds its
 * own controllers. The wasm core is the only rewriter now, selected with no
 * option, so this is empty; it is kept (spread into a controller's options)
 * so the suites that used it read the same whether or not they still need it.
 */
export const REWRITER = {};

let failures = 0;

/** one check; `detail` is printed after the name so a failure explains itself */
export function ok(name, condition, detail = '') {
	if (!condition) failures++;
	console.log(
		(condition ? 'PASS ' : 'FAIL ') + name + (detail ? ` - ${detail}` : ''),
	);
	return !!condition;
}

/** close the browser, print the verdict, exit with the failure count */
export async function done(browser, extra = []) {
	if (extra.length) console.log('page errors:', extra);
	await browser?.close();
	console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
	process.exit(failures ? 1 : 0);
}

export async function waitForServer(url, tries = 60) {
	for (let i = 0; ; i++) {
		try {
			await fetch(url);
			return;
		} catch (error) {
			if (i >= tries) throw new Error(`no server at ${url}`, { cause: error });
			await sleep(500);
		}
	}
}

/**
 * The environment of a Chrome on Linux that finds no audio device, input or
 * output, as on a CI runner: no PulseAudio server to reach, and an ALSA
 * configuration that names no device. (Chrome has a switch for fake devices,
 * `--use-fake-device-for-media-stream`, with `=device-count=0` for no camera,
 * and none for no microphone.)
 */
export const NO_AUDIO = {
	PULSE_SERVER: 'unix:/nonexistent/pulse',
	ALSA_CONFIG_PATH: '/dev/null',
};

/**
 * Headless Chrome. Every hostname except the loopback ones fails to resolve,
 * so a request that bypasses the proxy fails loudly instead of silently
 * reaching the real site. `*.localhost` stays resolvable too: the WPT suites
 * use www.localhost as a same-site, cross-origin host for the fixture.
 */
/**
 * `args`: more Chrome flags (e.g. an autoplay policy for media suites).
 * `scrollbars`: draw scrollbars as a user's Chrome does; Playwright hides them
 * in headless mode (`--hide-scrollbars`), and a bug that needs one never shows.
 * `env`: environment variables for Chrome on top of this process's (see
 * NO_AUDIO).
 */
export async function launch(
	args = [],
	{ scrollbars = false, env = null } = {},
) {
	return chromium.launch({
		executablePath: CHROME,
		headless: true,
		...(env ? { env: { ...process.env, ...env } } : {}),
		args: [
			'--no-sandbox',
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
			...args,
		],
		...(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
	});
}

// Chrome in a mount namespace where no real device is reachable: every
// camera node is /dev/null, /dev/snd is empty, the system bus (Bluetooth
// devices) is out of sight, and the only sound server is a PipeWire one
// started here with its session manager, which finds no hardware. Any step
// that fails ends the launch (set -e): Chrome never starts beside real
// devices. Each process dies with its parent, so nothing outlives the
// launcher.
const PRIVATE_SOUND = `#!/bin/sh
exec unshare -Urm --kill-child sh -c '
set -e
for v in /dev/video*; do
	if [ -e "$v" ]; then mount --bind /dev/null "$v"; fi
done
if [ -d /dev/snd ]; then mount -t tmpfs none /dev/snd; fi
if [ -d /run/dbus ]; then mount -t tmpfs none /run/dbus; fi
unset DBUS_SESSION_BUS_ADDRESS PIPEWIRE_REMOTE PIPEWIRE_RUNTIME_DIR PULSE_RUNTIME_PATH
export XDG_RUNTIME_DIR="$0" PULSE_SERVER="unix:$0/pulse/native" ALSA_CONFIG_PATH=/dev/null
setpriv --pdeathsig KILL pipewire >"$0/pipewire.log" 2>&1 &
setpriv --pdeathsig KILL pipewire-pulse >"$0/pulse.log" 2>&1 &
i=0
while [ ! -S "$0/pulse/native" ]; do
	i=$((i + 1))
	[ "$i" -lt 100 ]
	sleep 0.1
done
setpriv --pdeathsig KILL wireplumber >"$0/wireplumber.log" 2>&1 &
setpriv --pdeathsig KILL "$@"
' "$STOMP_SOUND_DIR" "$STOMP_SOUND_CHROME" "$@"
`;

/**
 * Headless Chrome whose devices can change: fake devices never do, and a
 * test must never reach the machine's real ones. Its only sound server is
 * a private PipeWire one without hardware (see PRIVATE_SOUND), which is
 * given one virtual microphone, and it has no camera. `plug()` adds a
 * virtual output; Chrome on Linux notices it when a page next lists the
 * devices. Null where that cannot be had (no pipewire, pipewire-pulse,
 * wireplumber, pactl, unshare or setpriv, no user namespaces, or a server
 * that has any device not made here), as on a CI runner.
 */
export async function launchPrivateSound(args = []) {
	let dir = null;
	let browser = null;
	try {
		for (const tool of ['pipewire', 'pipewire-pulse', 'wireplumber', 'pactl'])
			execFileSync(tool, ['--version'], { stdio: 'ignore' });
		execFileSync(
			'unshare',
			['-Urm', 'setpriv', '--pdeathsig', 'KILL', 'true'],
			{
				stdio: 'ignore',
			},
		);
		// a short path: a socket's is at most 107 bytes
		const where = (dir = mkdtempSync(join(tmpdir(), 'stomp-sound-')));
		const wrapper = join(where, 'chrome');
		writeFileSync(wrapper, PRIVATE_SOUND);
		chmodSync(wrapper, 0o755);
		browser = await chromium.launch({
			executablePath: wrapper,
			headless: true,
			env: {
				...process.env,
				STOMP_SOUND_DIR: where,
				STOMP_SOUND_CHROME: CHROME,
			},
			args: [
				'--no-sandbox',
				'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
				...args,
			],
		});
		const pactl = (...command) =>
			execFileSync('pactl', command, {
				env: { ...process.env, PULSE_SERVER: `unix:${where}/pulse/native` },
				encoding: 'utf8',
			});
		const sink = (...properties) =>
			pactl('load-module', 'module-null-sink', ...properties);
		sink('media.class=Audio/Source/Virtual', 'sink_name=microphone');
		// the session manager has looked for hardware by now: every device
		// of the server must be one made here, or nothing is run on it
		await sleep(1000);
		const names = ['sources', 'sinks'].flatMap((kind) =>
			pactl('list', 'short', kind)
				.split('\n')
				.filter(Boolean)
				.map((line) => line.split('\t')[1]),
		);
		if (
			!names.includes('microphone') ||
			names.some(
				(name) => !/^(auto_null|microphone|output\d+)(\.monitor)?$/.test(name),
			)
		)
			throw new Error(`devices not made here: ${names.join(', ')}`);
		let outputs = 0;
		const launched = browser;
		return {
			browser,
			plug: () => sink(`sink_name=output${++outputs}`),
			close: async () => {
				await launched.close();
				rmSync(where, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await browser?.close().catch(() => {});
		if (dir) rmSync(dir, { recursive: true, force: true });
		return null;
	}
}

/**
 * The demo behind a server that adds headers to every document it serves:
 * a host with policy headers of its own (a Content-Security-Policy, a
 * Permissions-Policy), which the demo's server has no switch for.
 * `headers(port)` makes them for the front's port, so a policy can name its
 * own origins. The demo picks its mode and its origins from the page's
 * address, so both work through the front: resolves to `proxy` (the
 * same-origin controller), `host` (the isolated host page) and `close()`.
 */
export async function demoBehind(headers) {
	const demo = Number(PORT);
	let added = {};
	const front = createServer((req, res) => {
		const upstream = request(
			{
				host: '127.0.0.1',
				port: demo,
				path: req.url,
				method: req.method,
				headers: req.headers,
			},
			(answer) => {
				const document = /text\/html/.test(
					answer.headers['content-type'] ?? '',
				);
				res.writeHead(answer.statusCode, {
					...answer.headers,
					...(document ? added : {}),
				});
				answer.pipe(res);
			},
		);
		upstream.on('error', () => res.destroy());
		req.pipe(upstream);
	});
	// the wisp socket, as it came
	front.on('upgrade', (req, socket, head) => {
		const upstream = connect(demo, '127.0.0.1', () => {
			let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
			for (let i = 0; i < req.rawHeaders.length; i += 2)
				text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
			upstream.write(`${text}\r\n`);
			upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
	});
	// every interface: localhost may resolve to ::1
	await new Promise((resolve) => front.listen(0, resolve));
	const { port } = front.address();
	added = headers(port);
	return {
		proxy: `http://127.0.0.1:${port}/`,
		host: `http://localhost:${port}/`,
		close: () => {
			front.closeAllConnections();
			front.close();
		},
	};
}

/**
 * Every request the browser makes in `context`, from any page, frame, worker
 * or service worker, WebSocket handshakes included, each classified: `worker`
 * (the proxy origin under the scope, served by the service worker), `proxy`
 * (the proxy origin outside it: the demo's own files, its wisp socket),
 * `host` (the isolated host page's origin), `raw` (any other origin: it
 * reached the network without the proxy) or `local` (data:, blob:, about:).
 * A raw request to a target a proxied page named is a bypass. Requests are
 * recorded from the call on; `raw()` lists the raw ones.
 */
export async function recordRequests(context, { scope = '/stomp/' } = {}) {
	const proxy = new URL(PROXY);
	const host = new URL(HOST);
	const log = [];
	const classify = (url) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			return 'local';
		}
		if (!/^(https?|wss?):$/.test(parsed.protocol)) return 'local';
		if (parsed.host === proxy.host)
			return parsed.pathname.startsWith(scope) ? 'worker' : 'proxy';
		if (parsed.host === host.host) return 'host';
		return 'raw';
	};
	const add = (url, type, source) =>
		log.push({ url, type, source, kind: classify(url) });
	context.on('request', (request) => {
		let source;
		if (request.serviceWorker()) source = 'service-worker';
		else
			try {
				source = request.frame().parentFrame() ? 'frame' : 'page';
			} catch (error) {
				source = 'worker';
			}
		add(request.url(), request.resourceType(), source);
	});
	// Playwright reports no worklet module request (measured): every page,
	// and every frame in a process of its own, is watched over CDP too. An
	// audio worklet's module request shows in neither (measured): not
	// recorded
	const watched = new WeakSet();
	const watchTarget = async (target, source) => {
		if (watched.has(target)) return;
		watched.add(target);
		try {
			const session = await context.newCDPSession(target);
			session.on('Network.requestWillBeSent', ({ request, type }) =>
				add(request.url, type ?? 'other', `${source}-cdp`),
			);
			await session.send('Network.enable');
		} catch (error) {
			// a frame in its parent's process has no session of its own
		}
	};
	const watch = (page) => {
		page.on('websocket', (socket) => add(socket.url(), 'websocket', 'page'));
		watchTarget(page, 'page');
		page.on('framenavigated', (frame) => {
			if (frame.parentFrame()) watchTarget(frame, 'frame');
		});
	};
	for (const page of context.pages()) watch(page);
	context.on('page', watch);
	// Playwright reports no request of a shared worker (measured): those
	// targets are watched over CDP, each through its own session
	const browser = context.browser();
	if (browser) {
		const cdp = await browser.newBrowserCDPSession();
		let id = 0;
		cdp.on('Target.targetCreated', async ({ targetInfo }) => {
			if (targetInfo.type !== 'shared_worker') return;
			try {
				const { sessionId } = await cdp.send('Target.attachToTarget', {
					targetId: targetInfo.targetId,
					flatten: false,
				});
				await cdp.send('Target.sendMessageToTarget', {
					sessionId,
					message: JSON.stringify({ id: ++id, method: 'Network.enable' }),
				});
			} catch (error) {
				// the worker went before it could be watched
			}
		});
		cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
			const { method, params } = JSON.parse(message);
			if (method === 'Network.requestWillBeSent')
				add(params.request.url, params.type ?? 'other', 'shared-worker');
		});
		await cdp.send('Target.setDiscoverTargets', { discover: true });
		context.on('close', () => cdp.detach().catch(() => {}));
	}
	return {
		log,
		raw: () => log.filter((entry) => entry.kind === 'raw'),
	};
}

/** a page on the demo's landing screen with the controller ready */
export async function openDemo(browser, base = HOST, viewport = {}) {
	await waitForServer(base);
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800, ...viewport },
	});
	const errors = [];
	const stacks = [];
	page.on('pageerror', (error) => {
		errors.push(error.message);
		stacks.push(error.stack || error.message);
	});
	page.errors = errors;
	// the same errors with their stacks, in the same order
	page.errorStacks = stacks;
	await page.goto(base);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	return page;
}

/**
 * The uncaught errors of a page loaded natively (pages, frames and dedicated
 * workers report through `pageerror`), as a live list of messages
 */
export function trackErrors(page) {
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	return errors;
}

/**
 * The errors a proxied load raised that the native load of the same page did
 * not: `proxied` minus `native`, message by message, so an error the page
 * throws natively too (a probe's own TypeError) is not the proxy's. With
 * `stacks` (the proxied errors' stacks, in order) each comes with its stack.
 */
export function proxiedOnlyErrors(native, proxied, stacks = []) {
	const left = new Map();
	for (const message of native) left.set(message, (left.get(message) ?? 0) + 1);
	const extra = [];
	proxied.forEach((message, i) => {
		const count = left.get(message) ?? 0;
		if (count) left.set(message, count - 1);
		else extra.push(stacks[i] ?? message);
	});
	return extra;
}

export function screenshot(page, name) {
	if (!process.env.SHOTS) return Promise.resolve();
	mkdirSync(OUT, { recursive: true });
	return page.screenshot({
		path: `${OUT}${name}.png`,
		animations: 'disabled',
		timeout: 60000,
	});
}

/** the visible tab's frame (hidden tabs keep display, so look at the class) */
export async function activeFrame(page) {
	const handle = await page.$('.frame:not(.hidden)');
	return handle ? handle.contentFrame() : null;
}

/** poll the active proxied frame until `pred` (evaluated inside it) holds */
export async function waitActive(page, pred, timeout = 40000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const frame = await activeFrame(page);
		if (frame) {
			try {
				if (await frame.evaluate(pred)) return frame;
			} catch (error) {
				// the frame is navigating; try again
			}
		}
		await sleep(250);
	}
	throw new Error('frame condition timeout');
}

export const omni = (page) =>
	page.evaluate(() => document.querySelector('#omni input').value);

export const onLanding = (page) =>
	page.evaluate(
		() =>
			!document.getElementById('landing').classList.contains('hidden') &&
			!document.body.classList.contains('recents'),
	);

/** type a URL into the landing form (opens a new tab) */
export const submitLanding = (page, url) =>
	page.evaluate((u) => {
		const form = document.getElementById('mainForm');
		form.url.value = u;
		form.requestSubmit();
	}, url);

/** type a URL into the omnibox (navigates the active tab) */
export const submitOmni = (page, url) =>
	page.evaluate((u) => {
		const form = document.getElementById('omni');
		form.url.value = u;
		form.requestSubmit();
	}, url);

/** bounding boxes of every element matching `selector`, rounded */
export const rects = (page, selector) =>
	page.evaluate(
		(sel) =>
			[...document.querySelectorAll(sel)].map((element) => {
				const r = element.getBoundingClientRect();
				return [
					Math.round(r.left),
					Math.round(r.top),
					Math.round(r.width),
					Math.round(r.height),
				];
			}),
		selector,
	);

export const near = (a, b, tolerance) =>
	a.length === b.length &&
	a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= tolerance));

/** click a Wikipedia article link inside the active frame that is not in `visited` */
export async function clickWikipediaLink(page, visited) {
	const frame = await waitActive(
		page,
		`[...document.links].some((x) => /^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/[^:#?]+$/.test(x.href) && !${JSON.stringify(visited)}.includes(x.href) && !/Main_Page|Wikipedia$/.test(x.href))`,
	);
	await frame.evaluate((v) => {
		const a = [...document.links].find(
			(x) =>
				/^https:\/\/en\.wikipedia\.org\/wiki\/[^:#?]+$/.test(x.href) &&
				!v.includes(x.href) &&
				!/Main_Page|Wikipedia$/.test(x.href),
		);
		a.click();
	}, visited);
}
