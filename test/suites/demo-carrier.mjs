// The demo shows what its wisp connection rides (the controller's
// `carrier`, src/transport/wispWebTransport.ts), with a relay of holyWisp's
// design (test/wisp-wt.mjs) in front of the demo's holyWisp named as the
// session's discovery document, in the isolated and the same-origin mode:
//  - UDP up, the session's document answering 600 ms late (a session up
//    well after the WebSocket, as on stomp.fracit.al): the first start
//    rides it, and once a page is open, the controller's `carrier` is
//    WebTransport to the session's URL and About's Transport row says
//    WebTransport (UDP) with it;
//  - the session lost and UDP gone with it: the next page rides the
//    WebSocket, a `carrier` event says so and the row follows, saying why
//    not UDP;
//  - UDP blocked from the start: the WebSocket, and why.
// The menu has no carrier line and its button no UDP or TCP tag (About's
// row says it once).
// Each of those is on the host's console in KrunkNative's manner, a plain
// `[wisp]` line per event (src/transport/transportLog.ts), and none of the
// old two-tone lines. With WebTransport off (`?wt=0`, the live demo's
// STOMP_WISP_WEBTRANSPORT=0) the carrier is still the WebSocket, About says
// WebSocket (TCP) with WebTransport off, and the console has one `[wisp]`
// line, the WebSocket's, and no `[net]` line. The verbose mode
// (`?transportdebug`, or localStorage['stomp:debug-transport'] = '1' on the
// host's origin) adds a `[net]` line for each connection, and only then;
// About's Transport log row says how to turn it on.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const browser = await launch();
const errors = [];

/** poll `read` (a function of the page) until `want(value)`, else the last value */
async function until(page, read, want, timeout = 20000, arg = undefined) {
	const start = Date.now();
	let value;
	while (Date.now() - start < timeout) {
		value = await page.evaluate(read, arg).catch(() => undefined);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

/** poll the suite's own `test()` until true (or `timeout`) */
async function eventually(test, timeout = 10000) {
	const start = Date.now();
	while (Date.now() - start < timeout && !test()) await sleep(150);
	return test();
}

/** `text` as a RegExp source that matches it literally */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** the old two-tone console lines, which none of the transport's is now */
const BADGE_LINE = /%c (STomp transport|Transport) %c/;

/**
 * Keeps the transport's lines of the page's console (`[wisp]`, `[net]`)
 * on `page.notes`, and whether a two-tone transport line was printed
 */
function keepNotes(page) {
	page.notes = [];
	page.badgeLines = false;
	page.on('console', (message) => {
		const text = message.text();
		if (/^\[(wisp|net)\] /.test(text))
			page.notes.push({ type: message.type(), text });
		if (BADGE_LINE.test(text)) page.badgeLines = true;
	});
}

/** the demo at `base`, its config naming the relay's document */
const demo = (base) =>
	openDemo(browser, base, {}, (page) => {
		keepNotes(page);
		return page.route('**/config.js', async (route) => {
			const response = await route.fetch();
			const text = await response.text();
			const config = JSON.parse(
				text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
			);
			await route.fulfill({
				response,
				body: `window.STOMP_CONFIG = ${JSON.stringify({
					...config,
					webTransport: { discovery: relay.discovery },
				})};\n`,
			});
		});
	});

/**
 * Records the controller's `carrier` events on `window.carrierEvents`
 * (the demo's `window.controller`, StompController or the remote one)
 */
const followCarrier = (page) =>
	page.evaluate(() => {
		window.carrierEvents = [];
		window.controller.addEventListener('carrier', (event) =>
			window.carrierEvents.push(event.detail),
		);
	});

/** the `carrier` events since followCarrier */
const carrierEvents = (page) => page.evaluate(() => window.carrierEvents);

/** the controller's carrier once it is `want` (its `carrier`), else the last */
const carrierIs = (page, want) =>
	until(
		page,
		() => window.controller?.carrier ?? null,
		(value) => value?.carrier === want,
	);

/** About's row `fact` (its data-fact), once `want(text)` */
async function aboutRow(page, fact, want = (value) => !!value) {
	await page.click('#toolMenu');
	await page.click('#menuAbout');
	const text = await until(
		page,
		(fact) =>
			document.querySelector(`#shieldsPage [data-fact="${fact}"] dd`)
				?.textContent ?? '',
		want,
		5000,
		fact,
	);
	await page.keyboard.press('Escape');
	await sleep(200);
	return text;
}

/** About's Transport row, once it says `expect` */
const transportRow = (page, expect) =>
	aboutRow(page, 'transport', (value) => !!value?.includes(expect));

/** no carrier tag on the menu button, no carrier line atop the menu */
const noMenuCarrier = (page) =>
	page.evaluate(
		() =>
			!document.getElementById('carrierTag') &&
			!document.getElementById('menuCarrier') &&
			!document.querySelector('#toolMenu span, #pmMenu > :not(button)'),
	);

/** the console lines, for a failure's detail */
const notesOf = (page) => JSON.stringify(page.notes);

for (const [mode, base] of [
	['isolated', HOST],
	['same origin', PROXY],
]) {
	// UDP up: WebTransport
	{
		relay.udpBlocked = false;
		relay.documentDelay = 600;
		const page = await demo(base);
		page.on('pageerror', (error) => errors.push(error.message));
		await followCarrier(page);
		// the bar, with its menu button, shows once a page is open
		await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
		const carrier = await carrierIs(page, 'webtransport');
		relay.documentDelay = 0;
		ok(
			`${mode}: the first start rides the session that came after the WebSocket, as the controller's carrier says, timed`,
			carrier?.carrier === 'webtransport' &&
				carrier.url.includes(relay.url) &&
				Number.isFinite(carrier.ms),
			JSON.stringify(carrier),
		);
		const row = await transportRow(page, 'WebTransport (UDP)');
		ok(
			`${mode}: About's Transport row says WebTransport (UDP) to the session`,
			/; Wisp over WebTransport \(UDP\) to \S+, \d+ ms$/.test(row ?? '') &&
				row.includes(relay.url),
			row,
		);
		ok(
			`${mode}: the menu has no carrier line and its button no UDP or TCP tag`,
			await noMenuCarrier(page),
		);
		const established = new RegExp(
			`^\\[wisp\\] WebTransport session established in \\d+ ms: wisp transport WebTransport \\(UDP/QUIC\\) to ${literal(relay.url)} \\(\\w[\\w-]*, HTTP/3 on\\)$`,
		);
		ok(
			`${mode}: the console says WebTransport was tried and the session established, how fast and to where, in plain [wisp] lines`,
			page.notes.some((note) =>
				/^\[wisp\] trying the WebTransport transport to /.test(note.text),
			) &&
				page.notes.some(
					(note) => note.type === 'info' && established.test(note.text),
				) &&
				!page.badgeLines,
			notesOf(page),
		);

		// the relay restarts and UDP is gone: the next page rides the
		// WebSocket, and the demo follows
		relay.udpBlocked = true;
		relay.cut();
		await submitLanding(page, `${FIXTURE}pages/walk-2.html`);
		const changed = await carrierIs(page, 'websocket');
		// the first choice's event can be before followCarrier (a warm
		// transport): the switch's says what it left
		const events = await carrierEvents(page);
		ok(
			`${mode}: once the session is gone and UDP with it, a carrier event says the WebSocket after WebTransport, and why not UDP`,
			changed?.carrier === 'websocket' &&
				!!changed.why &&
				events.at(-1)?.carrier === 'websocket' &&
				events.at(-1).previous === 'webtransport',
			JSON.stringify(events),
		);
		const after = await transportRow(page, 'WebSocket (TCP)');
		ok(
			`${mode}: About's row follows: WebSocket (TCP), and why not UDP`,
			/; Wisp over WebSocket \(TCP\) to \S+, \d+ ms; not UDP: \S/.test(
				after ?? '',
			),
			after,
		);
		ok(
			`${mode}: the console says the session ended, the reconnect and the switch to the WebSocket`,
			page.notes.some((note) =>
				/^\[wisp\] WebTransport session ended after \d+ s \(/.test(note.text),
			) &&
				page.notes.some(
					(note) =>
						note.text ===
						'[wisp] reconnecting now (the wisp connection was lost)',
				) &&
				page.notes.some(
					(note) =>
						note.text === '[wisp] switched from WebTransport to WebSocket',
				),
			notesOf(page),
		);
		await page.context().close();
	}

	// UDP blocked from the start: the WebSocket
	{
		relay.udpBlocked = true;
		const page = await demo(base);
		page.on('pageerror', (error) => errors.push(error.message));
		await submitLanding(page, `${FIXTURE}pages/walk-3.html`);
		const carrier = await carrierIs(page, 'websocket');
		ok(
			`${mode} UDP blocked: the controller's carrier is the WebSocket, with why not UDP`,
			carrier?.carrier === 'websocket' && !!carrier.why,
			JSON.stringify(carrier),
		);
		const row = await transportRow(page, 'WebSocket (TCP)');
		ok(
			`${mode} UDP blocked: About's row says WebSocket (TCP), and why not UDP`,
			/; Wisp over WebSocket \(TCP\) to \S+, \d+ ms; not UDP: \S/.test(
				row ?? '',
			),
			row,
		);
		ok(
			`${mode} UDP blocked: the console says WebTransport was unavailable and why, then the WebSocket it connects to`,
			page.notes.some((note) =>
				/^\[wisp\] WebTransport unavailable \(.+\), trying the next transport; WebTransport again /.test(
					note.text,
				),
			) &&
				page.notes.some(
					(note) =>
						note.type === 'info' &&
						/^\[wisp\] connecting to ws:\/\/\S+ \(wisp transport WebSocket \(TCP\); \w[\w-]*, HTTP\/3 on\)$/.test(
							note.text,
						),
				) &&
				!page.badgeLines,
			notesOf(page),
		);
		await page.context().close();
	}

	// WebTransport off (the live demo's STOMP_WISP_WEBTRANSPORT=0): TCP all
	// the same, one [wisp] line and no [net] line
	{
		const page = await openDemo(browser, `${base}?wt=0`, {}, keepNotes);
		page.on('pageerror', (error) => errors.push(error.message));
		await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
		const carrier = await carrierIs(page, 'websocket');
		const row = await transportRow(page, 'WebSocket (TCP)');
		ok(
			`${mode} WebTransport off: About's row says WebSocket (TCP), WebTransport off`,
			/ over ws:\/\/.*; Wisp over WebSocket \(TCP\) to ws:\/\/.*, \d+ ms; not UDP: WebTransport off$/.test(
				row ?? '',
			),
			row,
		);
		ok(
			`${mode} WebTransport off: the menu has no carrier line and its button no tag`,
			await noMenuCarrier(page),
		);
		ok(
			`${mode} WebTransport off: the controller's carrier is the WebSocket, timed, with the transport and HTTP/3`,
			carrier?.carrier === 'websocket' &&
				carrier.why === 'off' &&
				Number.isFinite(carrier.ms) &&
				typeof carrier.transport === 'string' &&
				carrier.http3 === true,
			JSON.stringify(carrier),
		);
		ok(
			`${mode} WebTransport off: the console has one [wisp] line, the WebSocket's with the transport and HTTP/3, and no [net] line`,
			page.notes.length === 1 &&
				page.notes[0].type === 'info' &&
				/^\[wisp\] connecting to ws:\/\/\S+\/wisp\/ \(wisp transport WebSocket \(TCP\), WebTransport off; \w[\w-]*, HTTP\/3 on\)$/.test(
					page.notes[0].text,
				) &&
				!page.badgeLines,
			notesOf(page),
		);
		const hint = await aboutRow(page, 'transportlog');
		ok(
			`${mode} WebTransport off: About's Transport log row says the log is off and how to turn it on`,
			/^Off; \?transportdebug, or localStorage\['stomp:debug-transport'\] = '1'/.test(
				hint,
			),
			hint,
		);
		await page.context().close();
	}

	// the verbose mode: a [net] line for each connection, with what it rides
	{
		const page = await openDemo(
			browser,
			`${base}?wt=0&transportdebug`,
			{},
			keepNotes,
		);
		page.on('pageerror', (error) => errors.push(error.message));
		await submitLanding(page, `${FIXTURE}pages/walk-1.html`);
		await carrierIs(page, 'websocket');
		const fixture = new URL(FIXTURE).origin;
		const site = new RegExp(
			`^\\[net\\] HTTP/1\\.1 to ${literal(fixture)}: a Wisp TCP stream, on the WebSocket \\(TCP\\)(; partition .+)?$`,
		);
		ok(
			`${mode} verbose: a [net] line for the connection to the site, HTTP/1.1 over a Wisp TCP stream on the WebSocket`,
			await eventually(() => page.notes.some((note) => site.test(note.text))),
			notesOf(page),
		);
		const hint = await aboutRow(page, 'transportlog');
		ok(
			`${mode} verbose: About's Transport log row says the log is on`,
			/^On: /.test(hint),
			hint,
		);
		await page.context().close();
	}
}

// the verbose mode from the host origin's storage, which the proxy origin's
// does not give: the isolated host on localhost, its proxy on 127.0.0.1
for (const [where, origin, on] of [
	['the host', 'localhost', true],
	['the proxy', '127.0.0.1', false],
]) {
	const context = await browser.newContext();
	await context.addInitScript((origin) => {
		if (location.hostname === origin)
			localStorage.setItem('stomp:debug-transport', '1');
	}, origin);
	const page = await context.newPage();
	keepNotes(page);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${HOST}?wt=0`);
	await page.waitForFunction(
		() => document.getElementById('logMsg').textContent === 'Ready',
		null,
		{ timeout: 45000 },
	);
	await submitLanding(page, `${FIXTURE}pages/walk-2.html`);
	await carrierIs(page, 'websocket');
	const verbose = await eventually(
		() => page.notes.some((note) => note.text.startsWith('[net] HTTP/')),
		on ? 10000 : 2000,
	);
	ok(
		`localStorage['stomp:debug-transport'] = '1' on ${where}'s origin ${on ? 'turns' : 'does not turn'} the verbose mode on`,
		verbose === on,
		notesOf(page),
	);
	await context.close();
}

relay.udpBlocked = false;
await relay.close();
await done(browser, errors);
