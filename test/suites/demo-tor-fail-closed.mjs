// Tor mode fails closed: whatever goes wrong with the in-browser Tor client
// (docs/tor-over-wisp.md), no request of a proxied page reaches the network
// outside Tor. The suite's server runs Tor mode's own client code
// (demo/public/tor-client/: the transport, the SharedWorker, the service
// with its Wisp links and its relay check) with tor-js replaced by
// test/offline-tor-stand-in.mjs (STOMP_TOR_CLIENT=stand-in-arti), whose
// "Tor streams" reach the fixture through the run's Wisp server, and which
// the suite breaks on purpose (its `tor-stand-in-control` mode). The page
// each case asks for is the fixture's /echo-headers?k=<key>, which records
// every request that reaches it: with the client broken, any record is a
// request that went past Tor. Neither the stand-in nor this suite reaches
// the Tor network; test/tor-client-smoke.mjs runs the real client.
//
// Also here: bootstrap progress and the reason it is blocked or failed,
// shown on the page (the client's link failures, and arti's own events
// through `bootstrapEvents` as the stand-in gives them: tor-js has no such
// call yet), a Tor tab that stays in Tor mode when another tab turns it
// off, a Tor tab's site data across its reload, and the shared client's
// life (extendedLifetime, a new session on it), its circuit display and
// Forget Tor state.
/* global TOR_REQUESTED, DIRECTORY */
import {
	activeFrame,
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
	waitForServer,
} from '../lib.mjs';
import { GUARD_FINGERPRINT } from '../offline-tor-stand-in.mjs';

await waitForServer(PROXY);
const browser = await launch();
const errors = [];

let made = 0;
const key = (name) => `tor-closed-${name}-${Date.now().toString(36)}-${made++}`;
/** the fixture's page that records each request for it */
const target = (k) => `${FIXTURE}echo-headers?k=${k}&html`;
/** the request that reached the fixture for `k`, or null */
const reached = async (k) =>
	(await fetch(`${FIXTURE}echo-headers/recorded?k=${k}`)).json();

async function until(page, read, want, limit = 25000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < limit) {
		value = await page.evaluate(read).catch(() => null);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const read = () => ({
	status: document.getElementById('logMsg')?.textContent ?? '',
	tooltip: document.getElementById('torLabel')?.title ?? '',
	requested: TOR_REQUESTED,
	directory: DIRECTORY,
	controller: !!window.controller,
	client: window.__pmTorClient ?? null,
});

/** how the stand-in breaks in `context` ('' for not at all) */
async function breakClient(context, mode) {
	const page = await context.newPage();
	await page.goto(`${PROXY}api/tor`);
	await page.evaluate(
		(mode) =>
			new Promise((resolve, reject) => {
				const open = indexedDB.open('tor-stand-in-control', 1);
				open.onupgradeneeded = () => open.result.createObjectStore('kv');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const tx = open.result.transaction('kv', 'readwrite');
					tx.objectStore('kv').put(mode, 'mode');
					tx.oncomplete = () => {
						open.result.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		mode,
	);
	await page.close();
}

/**
 * A demo page whose controller is up and, in Tor mode, whose client said
 * something
 */
async function torPage(context, query = '?tor=1') {
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}${query}`);
	const state = await until(
		page,
		read,
		(value) => value?.controller && (!value.requested || value.client !== null),
	);
	return { page, state };
}

/** the proxied frame's title, or null */
async function shownTitle(page) {
	const frame = await activeFrame(page);
	return frame ? frame.evaluate(() => document.title).catch(() => null) : null;
}

/**
 * Ask for the fixture's page in a new tab, give it `ms`, and say whether it
 * reached the fixture
 */
async function askFor(page, name, ms = 6000) {
	const k = key(name);
	await submitLanding(page, target(k));
	await sleep(ms);
	return { k, record: await reached(k), title: await shownTitle(page) };
}

// The suite's own check: with the client working, the page arrives, over
// the stand-in's "Tor streams"
{
	const context = await browser.newContext();
	const { page, state } = await torPage(context);
	const ready = await until(page, read, (value) =>
		/^Ready \(Tor connected\)/.test(value?.status),
	);
	const k = key('working');
	await submitLanding(page, target(k));
	const frame = await waitActive(page, () => document.title === 'landed').catch(
		() => null,
	);
	ok(
		'a working client: Tor mode is on and the page arrives over it',
		state.requested === true &&
			ready?.client?.state === 'ready' &&
			!!frame &&
			(await reached(k)) !== null,
		JSON.stringify({ state, ready: ready?.status }),
	);
	await context.close();
}

// Bootstrap that never ends: the request waits for Tor, and nothing goes
// past it, in this tab, in a second tab of the same client, or after a
// reload of the first (the client, which outlives the page, still stuck)
{
	const context = await browser.newContext();
	await breakClient(context, 'hang');
	const { page } = await torPage(context);
	const first = await askFor(page, 'hang');
	const state = await page.evaluate(read);
	ok(
		'bootstrap still running: the request waits, and nothing reaches the site',
		first.record === null &&
			first.title !== 'landed' &&
			state.client?.state === 'bootstrapping' &&
			/^Tor is connecting/.test(state.tooltip),
		JSON.stringify({ first, tooltip: state.tooltip, client: state.client }),
	);
	const { page: second, state: secondState } = await torPage(context);
	const other = await askFor(second, 'hang-second-tab');
	ok(
		'a second Tor tab shares the stuck client and sends nothing past it',
		other.record === null &&
			secondState.requested === true &&
			secondState.client?.instance === state.client?.instance,
		JSON.stringify({ other, first: state.client, second: secondState.client }),
	);
	await second.close();
	await page.reload();
	const reloaded = await until(
		page,
		read,
		(value) => value?.controller && value.client !== null,
	);
	const after = await askFor(page, 'hang-reload');
	ok(
		'a reload while bootstrapping stays in Tor mode and sends nothing past it',
		reloaded.requested === true &&
			reloaded.directory === state.directory &&
			after.record === null,
		JSON.stringify({ reloaded, after }),
	);
	await context.close();
}

// Every link to a relay fails at the Wisp server: the page says why, not
// arti's generic error, and nothing goes past Tor. Once the network is
// back, the next request starts the client again and arrives over it.
{
	const context = await browser.newContext();
	await breakClient(context, 'unreachable');
	const { page } = await torPage(context);
	const failed = await until(
		page,
		read,
		(value) => value?.client?.state === 'failed',
	);
	// (the status line says so until a tab's load takes it over)
	const said = (
		await until(
			page,
			read,
			(value) => /Tor could not connect/.test(value?.status),
			10000,
		)
	)?.status;
	const asked = await askFor(page, 'unreachable', 5000);
	const shown = await page.evaluate(read);
	ok(
		'bootstrap failure says what blocks it: no relay answered through the Wisp server',
		failed?.client?.blocked?.kind === 'cant-reach-tor' &&
			/No Tor relay answered through the Wisp server \(\d+ links ended with/.test(
				failed?.client?.summary,
			) &&
			/bootstrap failed/.test(failed?.client?.error) &&
			/Tor could not connect: No Tor relay answered/.test(said) &&
			/^Tor could not connect: No Tor relay answered/.test(shown?.tooltip),
		JSON.stringify({ client: failed?.client, said, tooltip: shown?.tooltip }),
	);
	ok(
		'bootstrap failure: nothing reaches the site',
		asked.record === null && asked.title === 'Tor could not connect',
		JSON.stringify(asked),
	);
	await breakClient(context, '');
	const k = key('recovered');
	await page.click('#home').catch(() => {});
	await submitLanding(page, target(k));
	const frame = await waitActive(page, () => document.title === 'landed').catch(
		() => null,
	);
	const recovered = await page.evaluate(read);
	ok(
		'after a failure the next request starts Tor again and arrives over it',
		!!frame &&
			(await reached(k)) !== null &&
			recovered.client?.state === 'ready',
		JSON.stringify(recovered.client),
	);
	await context.close();
}

// arti's own bootstrap events (bootstrapEvents, the stand-in's: tor-js has
// none yet): progress in Tor Browser's phases, and its blocker while it
// holds, then ready
{
	const context = await browser.newContext();
	await breakClient(context, 'events');
	const { page } = await torPage(context);
	const blocked = await until(
		page,
		read,
		(value) => value?.client?.blocked?.kind === 'clock-skewed',
	);
	const ready = await until(
		page,
		read,
		(value) => value?.client?.state === 'ready',
	);
	ok(
		"arti's bootstrap events: progress, then the blocker shown while it holds",
		blocked?.client?.state === 'bootstrapping' &&
			blocked.client.progress === 50 &&
			blocked.client.summary === 'Loading relay descriptors' &&
			/Tor is connecting \(50%\): Loading relay descriptors\. Blocked: Clock is skewed/.test(
				blocked.tooltip,
			),
		JSON.stringify(blocked),
	);
	ok(
		'the blocker goes once bootstrap completes',
		ready?.client?.state === 'ready' &&
			!ready.client.blocked &&
			/^Ready \(Tor connected\)/.test(ready.status),
		JSON.stringify(ready),
	);
	await context.close();
}

// Bootstrapped, but no circuit builds (a failed guard): each request fails
// in Tor, in every tab, and none goes past it
{
	const context = await browser.newContext();
	await breakClient(context, 'circuits');
	const { page } = await torPage(context);
	await until(page, read, (value) => value?.client?.state === 'ready');
	const { page: second } = await torPage(context);
	const [one, two] = await Promise.all([
		askFor(page, 'circuits'),
		askFor(second, 'circuits-second-tab'),
	]);
	ok(
		'no circuit builds: requests fail in Tor, in both tabs, and none reaches the site',
		one.record === null &&
			two.record === null &&
			one.title !== 'landed' &&
			two.title !== 'landed',
		JSON.stringify({ one, two }),
	);
	await context.close();
}

// A client that dials the site itself rather than a relay (a broken or
// tampered arti): the service's relay check refuses the link, and the page
// hears of the refusal
{
	const context = await browser.newContext();
	await breakClient(context, 'direct');
	const { page } = await torPage(context);
	await until(page, read, (value) => value?.client?.state === 'ready');
	const asked = await askFor(page, 'direct');
	const state = await until(
		page,
		read,
		(value) => (value?.client?.refused ?? 0) > 0,
		5000,
	);
	ok(
		'a link to anything but a relay is refused: nothing reaches the site',
		asked.record === null &&
			asked.title !== 'landed' &&
			state?.client?.refused > 0,
		JSON.stringify({ asked, client: state?.client }),
	);
	await context.close();
}

// A Tor tab stays in Tor mode when another tab turns Tor off: the saved
// choice is the origin's, and the Tor tab's reload must not bring it back
// outside Tor (pm/profile.js)
{
	const context = await browser.newContext();
	const toggleTor = async (page) => {
		await page.click('#settingsTab');
		await page.click('#menuProxy');
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
			page.click('#tor'),
		]);
	};
	const { page: torTab } = await torPage(context, '');
	await toggleTor(torTab);
	const on = await until(torTab, read, (value) => value?.requested === true);
	const { page: other, state: otherState } = await torPage(context, '');
	await toggleTor(other);
	const off = await until(other, read, (value) => value?.requested === false);
	await torTab.reload();
	const after = await until(torTab, read, (value) => value?.controller);
	const k = key('sticky');
	await submitLanding(other, target(k));
	await waitActive(other, () => document.title === 'landed').catch(() => null);
	ok(
		'turning Tor off in one tab leaves another Tor tab in Tor mode across its reload',
		on?.requested === true &&
			otherState.requested === true &&
			off?.requested === false &&
			after?.requested === true &&
			after.directory === on.directory &&
			(await reached(k)) !== null,
		JSON.stringify({ on, otherState, off, after }),
	);
	// its own toggle does take it out
	await toggleTor(torTab);
	const left = await until(torTab, read, (value) => value?.requested === false);
	await torTab.reload();
	const stays = await until(torTab, read, (value) => value?.controller);
	ok(
		"a Tor tab's own toggle turns it off for good",
		left?.requested === false && stays?.requested === false,
		JSON.stringify({ left, stays }),
	);
	await context.close();
}

// A Tor tab's site data across its reload: the Tor session goes on (its
// cookie, localStorage and IndexedDB are there again), and a normal tab
// open beside it never sees them, before or after the reload
{
	const context = await browser.newContext();
	const write = async (mode) => {
		document.cookie = `mode=${mode}; max-age=3600; path=/`;
		localStorage.setItem('mode', mode);
		await new Promise((resolve, reject) => {
			const open = indexedDB.open(`${mode}db`);
			open.onupgradeneeded = () => open.result.createObjectStore('s');
			open.onsuccess = () => {
				open.result.close();
				resolve();
			};
			open.onerror = () => reject(open.error);
		});
	};
	const look = async () => ({
		cookie: document.cookie,
		local: localStorage.getItem('mode'),
		dbs: (await indexedDB.databases()).map((info) => info.name).sort(),
	});
	const site = `${FIXTURE}pages/bookmark-a.html`;
	const open = async (page) => {
		await page.click('#home').catch(() => {});
		await submitLanding(page, site);
		return waitActive(page, () => document.title === 'Bookmark A');
	};
	const normal = await context.newPage();
	normal.on('pageerror', (error) => errors.push(error.message));
	await normal.goto(`${PROXY}?notor`);
	await until(normal, read, (value) => /^Ready/.test(value?.status));
	await (await open(normal)).evaluate(write, 'normal');
	const { page: tor } = await torPage(context);
	await until(tor, read, (value) => value?.client?.state === 'ready');
	await (await open(tor)).evaluate(write, 'tor');
	await tor.reload();
	await until(tor, read, (value) => value?.client?.state === 'ready');
	const torSees = await (await open(tor)).evaluate(look);
	const normalSees = await (await open(normal)).evaluate(look);
	await normal.reload();
	await until(normal, read, (value) => /^Ready/.test(value?.status));
	const normalAfter = await (await open(normal)).evaluate(look);
	ok(
		"a Tor tab's reload keeps its session's site data, and only its own",
		/mode=tor/.test(torSees.cookie) &&
			!/mode=normal/.test(torSees.cookie) &&
			torSees.local === 'tor' &&
			torSees.dbs.includes('tordb') &&
			!torSees.dbs.includes('normaldb'),
		JSON.stringify(torSees),
	);
	ok(
		"the normal tab beside it never sees the Tor tab's data, before or after its own reload",
		[normalSees, normalAfter].every(
			(seen) =>
				/mode=normal/.test(seen.cookie) &&
				!/mode=tor/.test(seen.cookie) &&
				seen.local === 'normal' &&
				!seen.dbs.includes('tordb'),
		),
		JSON.stringify({ normalSees, normalAfter }),
	);
	await context.close();
}

// The shared client's life, its state and its circuit display. The
// SharedWorker is started with extendedLifetime (src/transport/
// sharedWorker.ts): a reload and a navigation of the origin's only page get
// the same client back, bootstrapped already. A new Tor session (the last
// Tor tab closed, a new one opened) gets that client too, but none of the
// last session's circuits. The menu's Tor circuit for this site shows the
// guard of the active tab's site's circuits, read from arti's guard state
// and the consensus the client keeps (the stand-in writes both as arti
// does); Forget Tor state empties the client's store and starts it again.
{
	const STORE = 'stomp-tor-client-stand-in';
	/** the stand-in client's store (tor-js's IndexedDB in its place): its keys and its count of bootstraps */
	const store = (page) =>
		page.evaluate(
			(name) =>
				new Promise((resolve, reject) => {
					const open = indexedDB.open(name, 1);
					open.onupgradeneeded = () => open.result.createObjectStore('kv');
					open.onerror = () => reject(open.error);
					open.onsuccess = () => {
						const db = open.result;
						const kv = db.transaction('kv', 'readonly').objectStore('kv');
						const keys = kv.getAllKeys();
						const started = kv.get('stand-in:started');
						keys.transaction.oncomplete = () => {
							db.close();
							resolve({
								keys: keys.result.map(String).sort(),
								started: Number(started.result ?? 0),
							});
						};
					};
				}),
			STORE,
		);
	/** the circuit display for the active tab, opened from the menu, once it shows `want` */
	const circuitShown = async (page, want) => {
		await page.click('#toolMenu');
		await page.click('#menuTorCircuit');
		const shown = await until(
			page,
			() => {
				const box = document.querySelector('.extSubmenu .torCircuit');
				return box
					? {
							text: box.innerText,
							guard: box.dataset.guard,
							site: box.dataset.site,
							circuit: window.__pmTorCircuit?.circuit ?? null,
						}
					: null;
			},
			(value) => want.test(value?.text ?? ''),
			10000,
		);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		return shown;
	};
	const landed = async (page, name) => {
		const k = key(name);
		await page.click('#home').catch(() => {});
		await submitLanding(page, target(k));
		const frame = await waitActive(
			page,
			() => document.title === 'landed',
		).catch(() => null);
		return !!frame && (await reached(k)) !== null;
	};

	const context = await browser.newContext();
	const { page } = await torPage(context);
	const first = await until(
		page,
		read,
		(value) => value?.client?.state === 'ready',
	);
	const before = await store(page);
	await page.reload();
	const reloaded = await until(
		page,
		read,
		(value) => value?.controller && value.client !== null,
	);
	await page.goto(`${PROXY}api/tor`);
	await page.goto(`${PROXY}?tor=1`);
	const back = await until(
		page,
		read,
		(value) => value?.controller && value.client !== null,
	);
	const after = await store(page);
	ok(
		'the shared Tor client outlives a reload and a navigation (extendedLifetime): the same client, ready, no bootstrap again',
		!!first?.client?.instance &&
			reloaded?.client?.instance === first.client.instance &&
			back?.client?.instance === first.client.instance &&
			reloaded.client.state === 'ready' &&
			back.client.state === 'ready' &&
			before.started >= 1 &&
			after.started === before.started,
		JSON.stringify({
			first: first?.client,
			reloaded: reloaded?.client,
			back: back?.client,
			before,
			after,
		}),
	);

	const loaded = await landed(page, 'circuit');
	const circuit = await circuitShown(page, /StandInGuard/);
	ok(
		"Tor circuit for this site: the guard of the site's circuits from arti's guard state, its nickname and fingerprint from the consensus, and the site's circuit in use",
		loaded &&
			circuit?.guard === GUARD_FINGERPRINT &&
			/Circuit for 127\.0\.0\.1/.test(circuit.text) &&
			/StandInGuard \$01020304 127\.0\.0\.1:\d+/.test(circuit.text) &&
			/in use since .+, [1-9]\d* streams?/.test(circuit.text) &&
			/not told by the Tor client/.test(circuit.text) &&
			circuit.circuit?.guardFrom === 'state' &&
			!!circuit.site,
		JSON.stringify(circuit),
	);

	// the last Tor tab closes, and a new session's tab gets the same client
	// (it outlived the page) but a circuit of its own for the same site
	const since = circuit?.circuit?.since;
	await page.close();
	await sleep(500);
	const { page: next } = await torPage(context);
	const nextState = await until(
		next,
		read,
		(value) => value?.client?.state === 'ready',
	);
	const again = (await landed(next, 'circuit-new-session'))
		? await circuitShown(next, /in use since/)
		: null;
	ok(
		'a new Tor session gets the client that outlived the last one, but none of its circuits',
		nextState?.client?.instance === first?.client?.instance &&
			!!since &&
			!!again?.circuit?.since &&
			again.circuit.since > since,
		JSON.stringify({ since, again, instance: nextState?.client?.instance }),
	);

	// Forget Tor state: the store emptied, the client started again (a
	// bootstrap of its own), and a page loads over it, its guard kept again
	const kept = await store(next);
	await next.click('#toolMenu');
	await next.click('#menuForgetTorState');
	const forgotten = await until(
		next,
		() => window.__pmTorForgottenState ?? null,
		(value) => value !== null,
		10000,
	);
	const restarted = await until(
		next,
		read,
		(value) => value?.client?.state === 'ready',
	);
	const emptied = await store(next);
	const relanded = await landed(next, 'after-forget');
	const keptAgain = await store(next);
	ok(
		"Forget Tor state empties the client's store and starts it again with no guard",
		kept.keys.includes('state:guards') &&
			forgotten?.forgotten >= kept.keys.length &&
			!emptied.keys.includes('state:guards') &&
			!emptied.keys.some((name) => name.startsWith('dir:consensus:')) &&
			emptied.started === 1 &&
			restarted?.client?.instance === first?.client?.instance,
		JSON.stringify({ kept, forgotten, emptied, client: restarted?.client }),
	);
	ok(
		'after Forget Tor state a page loads over the new client, which keeps its guard again',
		relanded && keptAgain.keys.includes('state:guards'),
		JSON.stringify({ relanded, keptAgain }),
	);
	await context.close();
}

await browser.close();
ok('no page errors', errors.length === 0, JSON.stringify(errors));
done();
