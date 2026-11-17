// The service worker is not stopped under a controller. Chrome stops a
// service worker no event has reached for 30 seconds, whatever its pages
// show or hold open, and the first thing a page or its host did after
// sitting idle then paid for a worker start and a handshake. A controller
// sends the worker a message every 20 seconds, on a worker's clock (a
// hidden tab's own timers run once a minute after five minutes). Here a
// page sits idle for 45 seconds under each kind of controller and its
// worker is still the one it started with: same-origin, isolated, and a
// controller that hosts its transport in the page.
//
// With a site pool (docs/site-pool.md) the page is shown from a slot's
// origin, whose agent runs a worker of its own: that worker is the one
// checked to be the shown document's (a slot's when the run has slot
// ports), running from the start to the end. The hub starts a spare
// slot's agent once the page is idle (SiteHub.warm), and that worker's
// version first reports itself stopped and then starts: a version is
// stopped when it reports stopping or stopped after it ran.
//
// A worker a debugger is attached to is never stopped, and Playwright
// attaches to every worker, so each case runs in a Chrome of its own that
// is spoken to over the DevTools protocol with only the page attached.
// IDLE_MS is how long the page sits (45000); HIDDEN=1 puts another tab in
// front of it first (with IDLE_MS=400000 that is the measurement past the
// five minutes after which a hidden tab's timers are held back).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	CHROME,
	done,
	FIXTURE,
	HOST,
	ok,
	PORT,
	PROXY,
	sleep,
	SLOT_PORTS,
	waitForServer,
} from '../lib.mjs';

const IDLE_MS = Number(process.env.IDLE_MS) || 45000;
const HIDDEN = process.env.HIDDEN === '1';

/** a Chrome with one page attached: { evaluate, send, on, close } */
async function chrome() {
	const profile = mkdtempSync(`${tmpdir()}/sw-keepalive-`);
	const child = spawn(
		CHROME,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--remote-debugging-port=0',
			`--user-data-dir=${profile}`,
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	);
	const gone = () => {
		child.kill();
		rmSync(profile, { recursive: true, force: true });
	};
	// a loaded machine starts Chrome slowly: a Chrome that never says where
	// it listens is a failed case with its own words, not a silent exit
	const endpoint = await new Promise((resolve, reject) => {
		let text = '';
		let found = false;
		const fail = (why) => {
			if (found) return;
			gone();
			reject(new Error(`${why}: ${text.slice(-300)}`));
		};
		child.stderr.on('data', (chunk) => {
			text += chunk;
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
			if (!match || found) return;
			found = true;
			resolve(match[1]);
		});
		child.on('exit', (code) => fail(`Chrome exited (${code})`));
		setTimeout(() => fail('no DevTools endpoint in 60 s'), 60000);
	});
	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = () => {
			gone();
			reject(new Error('the DevTools socket did not open'));
		};
	});
	let ids = 0;
	const pending = new Map();
	const listeners = [];
	socket.onmessage = (event) => {
		const message = JSON.parse(event.data);
		const waiting = message.id && pending.get(message.id);
		if (waiting) {
			pending.delete(message.id);
			if (message.error) waiting.reject(new Error(message.error.message));
			else waiting.resolve(message.result);
		} else for (const listener of listeners) listener(message);
	};
	const call = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = ++ids;
			pending.set(id, { resolve, reject });
			socket.send(
				JSON.stringify({
					id,
					method,
					params,
					...(sessionId ? { sessionId } : {}),
				}),
			);
		});
	const { targetId } = await call('Target.createTarget', {
		url: 'about:blank',
	});
	const { sessionId } = await call('Target.attachToTarget', {
		targetId,
		flatten: true,
	});
	// the page's frames in processes of their own (a site pool's slot,
	// docs/site-pool.md), each attached once (a frame, not a worker: the
	// worker stays free of a debugger)
	const frameSessions = new Map();
	/** the first frame matching `pattern` that answers `expression`: { value, url } */
	const frameEvaluate = async (pattern, expression) => {
		const { targetInfos } = await call('Target.getTargets');
		for (const target of targetInfos) {
			if (target.type !== 'iframe' || !pattern.test(target.url)) continue;
			if (!frameSessions.has(target.targetId))
				frameSessions.set(
					target.targetId,
					(
						await call('Target.attachToTarget', {
							targetId: target.targetId,
							flatten: true,
						})
					).sessionId,
				);
			const { result } = await call(
				'Runtime.evaluate',
				{ expression, returnByValue: true },
				frameSessions.get(target.targetId),
			);
			if (result?.value !== undefined)
				return { value: result.value, url: target.url };
		}
		return null;
	};
	return {
		send: (method, params) => call(method, params, sessionId),
		browser: call,
		on: (listener) => listeners.push(listener),
		frameEvaluate,
		async evaluate(expression) {
			const { result, exceptionDetails } = await call(
				'Runtime.evaluate',
				{ expression, awaitPromise: true, returnByValue: true },
				sessionId,
			);
			if (exceptionDetails)
				throw new Error(
					`${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`,
				);
			return result.value;
		},
		async close() {
			socket.close();
			child.kill();
			await new Promise((resolve) => child.on('exit', resolve));
			rmSync(profile, { recursive: true, force: true });
		},
	};
}

/** poll `expression` in the page until it is true (false after `tries` quarter seconds) */
async function until(page, expression, tries = 240) {
	for (let i = 0; i < tries; i++) {
		if (await page.evaluate(expression).catch(() => false)) return true;
		await sleep(250);
	}
	return false;
}

// the proxied page's title, read through its frame (same origin with the
// host page in the same-origin demo and under transport-host.html; the
// isolated demo's host cannot read it and waits for the frame's address)
const TITLE = (scope) => `(() => {
	for (const frame of document.querySelectorAll('iframe')) {
		try {
			if (new RegExp('/${scope}/[\\\\w-]+/html/').test(frame.contentWindow.location.href))
				return frame.contentDocument.title;
		} catch (error) {
			// another origin's frame
		}
	}
	return null;
})()`;

/**
 * the demo at `base` with hist-1.html in its first tab: the port of the
 * origin whose worker serves it, null when it did not load
 */
async function demo(page, base) {
	await page.send('Page.navigate', { url: base });
	await until(
		page,
		`/^(Ready|Error)/.test(document.getElementById('logMsg')?.textContent ?? '')`,
	);
	await page.evaluate(`(() => {
		const form = document.getElementById('mainForm');
		form.url.value = ${JSON.stringify(`${FIXTURE}pages/hist-1.html`)};
		form.requestSubmit();
	})()`);
	if (base !== PROXY)
		// the frame is another site's, its worker the host's: the controller
		// says where it is
		return (await until(
			page,
			`/hist-1\\.html$/.test(window.controller?.frames?.at(-1)?.url ?? '')`,
		))
			? PORT
			: null;
	// the frame is the host's origin without a site pool, and a slot's (in a
	// process of its own) with one
	for (let i = 0; i < 240; i++) {
		if ((await page.evaluate(TITLE('stomp')).catch(() => null)) === 'HIST 1')
			return PORT;
		const shown = await page
			.frameEvaluate(/\/stomp\/[\w-]+\/html\//, 'document.title')
			.catch(() => null);
		if (shown?.value === 'HIST 1') return new URL(shown.url).port;
		await sleep(250);
	}
	return null;
}

/** transport-host.html with an in-page transport and hist-1.html in a frame: the fixture's port (its worker's), null when it did not load */
async function inPage(page) {
	const query = new URLSearchParams({
		wisp: `ws://127.0.0.1:${PORT}/wisp/`,
		transport: 'instance',
	});
	await page.send('Page.navigate', {
		url: `${FIXTURE}pages/transport-host.html?${query}`,
	});
	await until(page, 'window.__th?.ready === true');
	await page.evaluate(`(async () => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const origin = location.origin.replace('127.0.0.1', 'localhost');
		await window.controller.createFrame(element).go(origin + '/pages/hist-1.html');
	})()`);
	return (await until(page, `${TITLE('neutral')} === 'HIST 1'`)) &&
		(await page.evaluate('window.__th.host')) === 'page'
		? new URL(FIXTURE).port
		: null;
}

await waitForServer(PROXY);

const cases = [
	['same-origin', (page) => demo(page, PROXY)],
	['isolated', (page) => demo(page, HOST)],
	['in-page transport', inPage],
];

const results = await Promise.all(
	cases.map(async ([name, open]) => {
		let page;
		try {
			page = await chrome();
			await page.send('Page.enable');
			// the port of the origin whose worker serves the shown document
			const shown = await open(page);
			const loaded = shown !== null;
			// the proxy's workers (the host origin's, and with a site pool
			// each slot's agent's, a spare's too), as the browser reports
			// them: every change of each one's running status from here on,
			// with the version's status
			const changes = [];
			const statuses = new Map();
			const ran = new Set();
			const stops = [];
			const started = Date.now();
			page.on((message) => {
				if (message.method !== 'ServiceWorker.workerVersionUpdated') return;
				for (const version of message.params.versions) {
					// the proxy's, not a worker of the browser's own extensions
					if (!version.scriptURL.startsWith('http')) continue;
					if (statuses.get(version.versionId) === version.runningStatus)
						continue;
					statuses.set(version.versionId, version.runningStatus);
					const change = [
						Math.round((Date.now() - started) / 100) / 10,
						new URL(version.scriptURL).port,
						version.runningStatus,
						version.status,
					];
					changes.push(change);
					if (
						version.runningStatus === 'starting' ||
						version.runningStatus === 'running'
					)
						ran.add(version.versionId);
					else if (ran.has(version.versionId)) stops.push(change);
				}
			});
			await page.send('ServiceWorker.enable');
			if (HIDDEN) {
				const front = await page.browser('Target.createTarget', {
					url: 'about:blank',
				});
				await page.browser('Target.activateTarget', {
					targetId: front.targetId,
				});
			}
			await sleep(IDLE_MS);
			const visibility = await page.evaluate('document.visibilityState');
			const last = [...new Set(statuses.values())];
			return { name, loaded, shown, changes, stops, last, visibility };
		} catch (error) {
			return { name, error: String(error) };
		} finally {
			await page?.close();
		}
	}),
);

for (const {
	name,
	loaded,
	shown,
	changes,
	stops,
	last,
	visibility,
	error,
} of results) {
	ok(
		`${name}: a page loads`,
		loaded === true,
		JSON.stringify({ loaded, error }),
	);
	ok(
		`${name}: after ${IDLE_MS / 1000} s with nothing happening the worker has not been stopped`,
		JSON.stringify(last) === '["running"]' && stops?.length === 0,
		JSON.stringify({ visibility, changes }),
	);
	// the shown document's worker: running when the page sat down and never
	// after reported anything else (with a site pool, a slot's worker kept
	// running by the hub's clock, SiteHub.tick)
	const own = (changes ?? []).filter(([, port]) => port === shown);
	ok(
		`${name}: the worker of the shown document runs for the ${IDLE_MS / 1000} s${
			name === 'same-origin' && SLOT_PORTS.length
				? ' (a slot of the site pool)'
				: ''
		}`,
		own.length > 0 &&
			own.every(([, , status]) => status === 'running') &&
			(name !== 'same-origin' ||
				!SLOT_PORTS.length ||
				SLOT_PORTS.includes(Number(shown))),
		JSON.stringify({ shown, slots: SLOT_PORTS, own }),
	);
}

await done(null);
